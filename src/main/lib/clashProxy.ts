/**
 * Clash subscription parsing + local Clash client detection.
 *
 * "Use a Clash subscription link as proxy" has an important protocol
 * constraint: subscription nodes are usually vless/trojan/ssr/hysteria etc.,
 * which Node/Electron cannot dial directly. The app can only use:
 *   1. A manually specified upstream proxy URL (http/https/socks5), or
 *   2. The *local Clash client's* mixed-port (e.g. 127.0.0.1:7890) when the
 *      user runs Clash/Clash Verge/mihomo locally with the subscription
 *      imported. The subscription URL itself is then only used to list nodes
 *      and confirm which client port is alive.
 *
 * This module therefore:
 *   - Downloads & parses the subscription (plain YAML or base64-encoded),
 *     extracting proxies and the client's mixed-port if present.
 *   - Probes common local Clash ports to find an actually working HTTP proxy.
 *   - Resolves the effective upstream proxy from AppConfig.upstreamProxy.
 */

import net from 'node:net'
import https from 'node:https'
import zlib from 'node:zlib'
import axios from 'axios'
import { ConfigManager } from '../store/config'
import type { ClashProxyNode, UpstreamProxyInfo } from '../../shared/types'

/**
 * Subscription panels are frequently hosted on bare IPs with self-signed
 * certificates (e.g. https://1.2.3.4:5000/...). Certificate validation must
 * be skipped for the subscription download itself, otherwise parsing yields
 * zero nodes with a TLS error.
 */
const subscriptionHttpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: false })

/** Ports commonly used by Clash-family clients as mixed/http proxy port */
const COMMON_CLASH_PORTS = [7890, 7897, 7891, 10808, 10809, 1080, 8888, 9090]

// ==================== Minimal YAML parsing ====================

interface YamlItem {
  [key: string]: unknown
}

/**
 * Minimal YAML parser covering the subset used by Clash subscriptions:
 * top-level keys, list items ("- key: value") at ANY indentation (panels
 * emit them flush-left as often as indented), nested scalar keys of the
 * current list item, and nested sub-blocks (e.g. reality-opts) which are
 * skipped. Inline maps/arrays are not supported (not needed here).
 */
function parseSimpleYaml(text: string): { top: Record<string, unknown>; proxies: YamlItem[] } {
  const lines = text.split(/\r?\n/)
  const top: Record<string, unknown> = {}
  const proxies: YamlItem[] = []

  let currentKey: string | null = null
  let currentItem: YamlItem | null = null
  let itemIndent = -1
  let skipUntilIndent = Infinity

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue

    const indent = rawLine.length - rawLine.trimStart().length
    const line = rawLine.trim()

    // Inside a nested sub-block (e.g. reality-opts): skip deeper lines.
    if (indent >= skipUntilIndent) continue
    skipUntilIndent = Infinity

    // List item start: "- name: xxx" at ANY indentation (panels often emit
    // them flush-left). Must be checked BEFORE the top-level key branch.
    const itemMatch = line.match(/^-\s+([\w.-]+):\s*(.*)$/)
    if (itemMatch) {
      if (currentKey === 'proxies') {
        currentItem = { [itemMatch[1]]: parseScalar(itemMatch[2]) }
        itemIndent = indent
        proxies.push(currentItem)
      }
      continue
    }
    // Flow-style (inline) list item: "- { name: x, server: y, ... }"
    const flowMatch = line.match(/^-\s*\{(.*)\}\s*$/)
    if (flowMatch) {
      if (currentKey === 'proxies') {
        const item = parseFlowMap(flowMatch[1])
        if (item) {
          currentItem = item
          itemIndent = indent
          proxies.push(item)
        }
      }
      continue
    }
    // Bare list item "- value" (e.g. proxy name lists / rules) — ignore
    if (line.startsWith('-')) continue

    // Top-level key (no indentation)
    if (indent === 0) {
      currentItem = null
      itemIndent = -1
      const m = line.match(/^([\w.-]+):\s*(.*)$/)
      if (m) {
        currentKey = m[1]
        if (m[2]) top[currentKey] = parseScalar(m[2])
        else top[currentKey] = currentKey === 'proxies' ? proxies : undefined
      }
      continue
    }

    if (currentKey !== 'proxies') continue

    // Nested key of the current list item: "  port: 443"
    if (currentItem && indent > itemIndent) {
      const kv = line.match(/^([\w.-]+):\s*(.*)$/)
      if (kv) {
        if (kv[2] === '') {
          // Nested map/list block (reality-opts, headers, ...): skip body
          skipUntilIndent = indent + 1
        } else {
          currentItem[kv[1]] = parseScalar(kv[2])
        }
      }
    }
  }

  return { top, proxies }
}

function parseScalar(value: string): unknown {
  const v = value.trim()
  if (v === '' || v === '~' || v === 'null') return null
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^-?\d+$/.test(v)) return Number(v)
  // Strip surrounding quotes
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  return v
}

/** Names of all proxies declared in a subscription YAML text. */
export function parseClashProxyNames(text: string): string[] {
  return parseSimpleYaml(text)
    .proxies.map((p) => String(p.name ?? ''))
    .filter(Boolean)
}

/**
 * Parse a YAML flow mapping body (inside "{ ... }") into key/value pairs.
 * Splits on top-level commas while respecting single/double quotes and
 * nested braces/brackets.
 */
function parseFlowMap(body: string): YamlItem | null {
  const item: YamlItem = {}
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ''
  for (const ch of body) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) parts.push(cur)
  for (const part of parts) {
    const idx = part.indexOf(':')
    if (idx <= 0) continue
    let key = part.slice(0, idx).trim()
    const val = part.slice(idx + 1).trim()
    if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
      key = key.slice(1, -1)
    }
    if (!key) continue
    item[key] = parseScalar(val)
  }
  return Object.keys(item).length ? item : null
}

// ==================== Subscription download & parse ====================

/** Decode a subscription payload: plain YAML, base64 or gzip/deflate text. */
function decodeSubscriptionBody(buf: Buffer, contentType?: string): string {
  // gzip?
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return zlib.gunzipSync(buf).toString('utf-8')
    } catch {
      /* fall through */
    }
  }
  // deflate?
  if (buf.length > 2 && buf[0] === 0x78) {
    try {
      return zlib.inflateSync(buf).toString('utf-8')
    } catch {
      /* fall through */
    }
  }

  const text = buf.toString('utf-8')
  if (text.includes('proxies:') || text.includes('proxy-groups:')) return text

  // Many panels serve base64-encoded YAML
  const trimmed = text.replace(/\s+/g, '')
  if (/^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length > 32) {
    try {
      const decoded = Buffer.from(trimmed, 'base64').toString('utf-8')
      if (decoded.includes('proxies:') || decoded.includes('proxies:')) return decoded
      // base64 of gzip
      const raw = Buffer.from(trimmed, 'base64')
      if (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
        return zlib.gunzipSync(raw).toString('utf-8')
      }
    } catch {
      /* fall through */
    }
  }

  void contentType
  return text
}

export interface ClashSubscriptionInfo {
  /** Node count */
  nodeCount: number
  nodes: ClashProxyNode[]
  /** mixed-port declared in the subscription (rare) */
  mixedPort?: number
  /** Raw error when download/parse failed */
  error?: string
}

export interface ClashSubscriptionText {
  text: string
  error?: string
}

/**
 * Download a subscription and return the decoded YAML text only.
 * Used by the embedded mihomo core to build its own config file.
 */
export async function fetchClashSubscriptionText(url: string): Promise<ClashSubscriptionText> {
  bypassAxiosProxy = true
  let resp
  try {
    resp = await axios.get(url, {
      timeout: 20000,
      responseType: 'arraybuffer',
      headers: { 'User-Agent': 'clash-verge/v1.5.0', Accept: '*/*' },
      proxy: false,
      maxRedirects: 5,
      httpsAgent: url.startsWith('https:') ? subscriptionHttpsAgent : undefined,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { text: '', error: `订阅下载失败: ${msg}` }
  } finally {
    bypassAxiosProxy = false
  }
  try {
    return { text: decodeSubscriptionBody(Buffer.from(resp.data), resp.headers?.['content-type']) }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { text: '', error: `订阅解码失败: ${msg}` }
  }
}

/** Node types Electron/Node can dial directly as an upstream proxy */
const DIRECTLY_USABLE_TYPES = new Set(['http', 'socks5'])

/**
 * Download and parse a Clash subscription URL.
 * Returns the node list; never throws (errors land in `.error`).
 */
export async function fetchClashSubscription(url: string): Promise<ClashSubscriptionInfo> {
  // The subscription itself must be fetched WITHOUT the upstream proxy
  // (chicken-and-egg: the proxy may only be reachable via the subscription,
  // and the global axios interceptor must not route this request).
  bypassAxiosProxy = true
  let resp
  try {
    resp = await axios.get(url, {
      timeout: 20000,
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'clash-verge/v1.5.0',
        Accept: '*/*',
      },
      proxy: false,
      maxRedirects: 5,
      httpsAgent: url.startsWith('https:') ? subscriptionHttpsAgent : undefined,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { nodeCount: 0, nodes: [], error: `订阅下载/解析失败: ${msg}` }
  } finally {
    bypassAxiosProxy = false
  }

  try {

    const text = decodeSubscriptionBody(Buffer.from(resp.data), resp.headers?.['content-type'])
    const { top, proxies } = parseSimpleYaml(text)

    const nodes: ClashProxyNode[] = proxies
      .filter((p) => typeof p.name === 'string' && typeof p.type === 'string')
      .map((p) => {
        const type = String(p.type)
        return {
          name: String(p.name),
          type,
          server: String(p.server ?? ''),
          port: Number(p.port ?? 0),
          usable: DIRECTLY_USABLE_TYPES.has(type),
        }
      })

    const mixedPortRaw = top['mixed-port'] ?? top['port']
    const mixedPort = typeof mixedPortRaw === 'number' ? mixedPortRaw : undefined

    return { nodeCount: nodes.length, nodes, mixedPort }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { nodeCount: 0, nodes: [], error: `订阅解析失败: ${msg}` }
  }
}

// ==================== Local Clash client detection ====================

/** Check whether something accepts TCP connections on 127.0.0.1:port. */
export function probePort(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(port, '127.0.0.1')
  })
}

/** Convert a proxy URL into axios' `proxy` option (http/https only). */
function buildAxiosProxyOption(proxyUrl: string): Record<string, unknown> {
  try {
    const u = new URL(proxyUrl)
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return {
        proxy: {
          host: u.hostname,
          port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)),
          protocol: u.protocol,
          ...(u.username ? { auth: { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } } : {}),
        },
      }
    }
  } catch {
    /* ignore */
  }
  return { proxy: false }
}

/**
 * Check real connectivity of a candidate proxy by requesting a target URL
 * through it. Used by the settings dialog "test" button.
 */
export async function checkUrlThroughProxy(proxyUrl: string, targetUrl: string): Promise<boolean> {
  try {
    const resp = await axios.get(targetUrl, {
      timeout: 10000,
      maxRedirects: 3,
      validateStatus: (s) => s < 500,
      ...buildAxiosProxyOption(proxyUrl),
    })
    return resp.status > 0 && resp.status < 500
  } catch {
    return false
  }
}

/**
 * Find a live local Clash mixed-port. Prefers the port declared in the
 * subscription (if any), then the user override, then common defaults.
 */
export async function detectLocalClashPort(preferred?: number): Promise<number | null> {
  const candidates: number[] = []
  if (preferred) candidates.push(preferred)

  const cfgPort = ConfigManager.get().upstreamProxy?.mixedPort
  if (cfgPort) candidates.push(cfgPort)

  for (const p of COMMON_CLASH_PORTS) {
    if (!candidates.includes(p)) candidates.push(p)
  }

  for (const port of candidates) {
    if (await probePort(port)) return port
  }
  return null
}

// ==================== Effective proxy resolution ====================

/**
 * Resolve the effective upstream proxy from configuration.
 * Result is consumed by Electron sessions (session.setProxy) and axios.
 */
export async function resolveUpstreamProxy(): Promise<UpstreamProxyInfo> {
  const cfg = ConfigManager.get().upstreamProxy
  if (!cfg?.enabled) {
    return { active: false, message: '上游代理未启用' }
  }

  if (cfg.source === 'manual') {
    const url = (cfg.manualUrl || '').trim()
    if (!url) return { active: false, message: '未填写代理地址' }
    try {
      const u = new URL(url)
      if (!['http:', 'https:', 'socks5:', 'socks:'].includes(u.protocol)) {
        return { active: false, message: `不支持的代理协议: ${u.protocol} (仅 http/https/socks5)` }
      }
      const port = Number(u.port)
      if (port && (await probePort(port, 1500)) === false && u.hostname === '127.0.0.1') {
        return { active: false, url, source: 'manual', message: `本地端口 ${port} 未监听，代理可能未运行` }
      }
      return { active: true, url, source: 'manual' }
    } catch {
      return { active: false, message: `代理地址格式无效: ${url}` }
    }
  }

  // source === 'embedded': dial subscription nodes with the built-in core.
  if (cfg.source === 'embedded') {
    const subUrl = cfg.subscriptionUrl?.trim() || ''
    if (!subUrl) {
      return { active: false, source: 'embedded', message: '未填写订阅地址（内置核心拨号需要订阅）' }
    }
    const { ensureEmbeddedClash } = await import('./embeddedClash')
    const started = await ensureEmbeddedClash(subUrl, cfg.selectedNode?.trim() || '')
    if (started.ok && started.port) {
      return {
        active: true,
        url: `http://127.0.0.1:${started.port}`,
        source: `embedded-mihomo (127.0.0.1:${started.port})`,
      }
    }
    return { active: false, source: 'embedded', message: started.error || '内嵌 Clash 核心启动失败' }
  }

  // source === 'clash': locate a live local Clash client port.
  let preferred: number | undefined
  const subUrl = cfg.subscriptionUrl?.trim() || ''
  if (subUrl) {
    const info = await fetchClashSubscription(subUrl)
    if (info.mixedPort) preferred = info.mixedPort
    if (info.error && info.nodeCount === 0) {
      console.warn('[ClashProxy] Subscription parse failed:', info.error)
    }
  }

  const port = await detectLocalClashPort(preferred)
  if (port) {
    return {
      active: true,
      url: `http://127.0.0.1:${port}`,
      source: `clash (127.0.0.1:${port})`,
    }
  }

  // No external Clash client found: dial the subscription nodes ourselves
  // with the embedded mihomo core.
  if (subUrl) {
    const { ensureEmbeddedClash } = await import('./embeddedClash')
    const started = await ensureEmbeddedClash(subUrl, cfg.selectedNode?.trim() || '')
    if (started.ok && started.port) {
      return {
        active: true,
        url: `http://127.0.0.1:${started.port}`,
        source: `clash-embedded (127.0.0.1:${started.port})`,
      }
    }
    return {
      active: false,
      source: 'clash',
      message: started.error || '内嵌 Clash 核心启动失败',
    }
  }

  return {
    active: false,
    source: 'clash',
    message: '未检测到本地 Clash 客户端，且未填写订阅地址（已探测 127.0.0.1 常见混合端口）',
  }
}

/**
 * Cached resolution for hot paths (axios interceptors). Refreshed by
 * `refreshUpstreamProxyCache()` whenever config changes or on an interval.
 */
let cachedProxy: UpstreamProxyInfo | null = null
let cacheTime = 0
const CACHE_TTL_MS = 30_000

export async function getUpstreamProxyCached(): Promise<UpstreamProxyInfo> {
  const now = Date.now()
  if (cachedProxy && now - cacheTime < CACHE_TTL_MS) return cachedProxy
  cachedProxy = await resolveUpstreamProxy()
  cacheTime = now
  return cachedProxy
}

export function invalidateUpstreamProxyCache(): void {
  cachedProxy = null
  cacheTime = 0
}

/** Electron session.setProxy()-compatible config derived from a proxy URL. */
export function toElectronProxyConfig(url: string): { proxyRules: string; proxyBypassRules: string } {
  try {
    const u = new URL(url)
    let scheme = u.protocol.replace(':', '')
    if (scheme === 'socks') scheme = 'socks5'
    const host = u.hostname
    const port = u.port || (scheme === 'http' ? '80' : scheme === 'https' ? '443' : '1080')
    return {
      proxyRules: `${scheme}://${host}:${port}`,
      proxyBypassRules: 'localhost,127.0.0.1,<local>',
    }
  } catch {
    return { proxyRules: url, proxyBypassRules: 'localhost,127.0.0.1,<local>' }
  }
}

/**
 * Apply (or clear) the upstream proxy on an Electron session.
 * Returns a description of what was applied.
 */
export async function applySessionProxy(
  ses: Electron.Session
): Promise<UpstreamProxyInfo> {
  const info = await getUpstreamProxyCached()
  if (info.active && info.url) {
    const { proxyRules, proxyBypassRules } = toElectronProxyConfig(info.url)
    await ses.setProxy({ proxyRules, proxyBypassRules })
    console.log(`[ClashProxy] Session proxy applied: ${proxyRules}`)
  } else {
    await ses.setProxy({ mode: 'direct' })
  }
  return info
}

export { buildAxiosProxyOption }

// ==================== axios global integration ====================

let axiosInterceptorInstalled = false

/**
 * When true the global interceptor skips proxy injection. Used by the
 * subscription fetch itself so it always goes direct.
 */
let bypassAxiosProxy = false

/**
 * Install a global axios request interceptor that routes every outbound
 * request through the configured upstream proxy. Requests that explicitly
 * set their own `proxy` option (including `proxy: false`, used by the
 * subscription fetch itself) are left untouched.
 *
 * Call once during main-process startup.
 */
export function installAxiosUpstreamProxy(): void {
  if (axiosInterceptorInstalled) return
  axiosInterceptorInstalled = true

  axios.interceptors.request.use(async (config) => {
    try {
      if (bypassAxiosProxy) return config
      const cfg = ConfigManager.get().upstreamProxy
      if (!cfg?.enabled) return config
      // Respect explicit per-request proxy settings.
      if ((config as { proxy?: unknown }).proxy !== undefined) return config

      const info = await getUpstreamProxyCached()
      if (!info.active || !info.url) return config

      const u = new URL(info.url)
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        ;(config as { proxy?: unknown }).proxy = {
          host: u.hostname,
          port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)),
          protocol: u.protocol,
          ...(u.username
            ? { auth: { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } }
            : {}),
        }
      }
      // socks5 upstreams are not supported by axios without an extra agent;
      // Electron sessions still honor them via session.setProxy.
    } catch {
      // Never block a request because of proxy resolution issues.
    }
    return config
  })
}
