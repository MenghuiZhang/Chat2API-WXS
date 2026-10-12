/**
 * Embedded Clash (mihomo) core manager.
 *
 * Subscription nodes are usually vless/trojan/ssr with REALITY/TLS which
 * Node/Electron cannot dial natively. To "use the parsed nodes" without
 * requiring the user to run a separate Clash client, we embed the mihomo
 * (Clash Meta) core as a child process:
 *
 *   1. Download the mihomo release asset for the current platform once into
 *      <userData>/clash-core/ (zip on Windows, single-binary gz elsewhere;
 *      override with CHAT2API_MIHOMO_ZIP_URL).
 *   2. Download the Clash subscription YAML and prepend a mixed-port header.
 *   3. Spawn `mihomo -d <workDir> -f <config>` and wait for the mixed port.
 *   4. The rest of the app treats http://127.0.0.1:<port> as upstream proxy.
 *
 * The core is stopped when the upstream proxy is disabled or the app quits.
 */

import { app } from 'electron'
import { spawn, execFile, ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import axios from 'axios'
import { probePort, fetchClashSubscriptionText, parseClashProxyNames } from './clashProxy'

export interface EmbeddedClashState {
  running: boolean
  port?: number
  /** Subscription URL the running core was started with */
  subscriptionUrl?: string
  /** Node name the running core dials (empty = subscription default) */
  selectedNode?: string
  binaryPath?: string
  error?: string
}

let child: ChildProcess | null = null
let state: EmbeddedClashState = { running: false }
let startLock: Promise<{ ok: boolean; port?: number; error?: string }> | null = null

export function getEmbeddedState(): EmbeddedClashState {
  return { ...state }
}

function workDir(): string {
  return path.join(app.getPath('userData'), 'clash-core')
}

function binaryPath(): string {
  return path.join(workDir(), process.platform === 'win32' ? 'mihomo.exe' : 'mihomo')
}

function archTag(): string {
  switch (process.arch) {
    case 'arm64':
      return 'arm64'
    case 'ia32':
      return '386'
    default:
      return 'amd64'
  }
}

/** Pick a currently free TCP port on 127.0.0.1. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

/** Release asset OS tag for the current platform. */
function osTag(): string {
  switch (process.platform) {
    case 'win32':
      return 'windows'
    case 'darwin':
      return 'darwin'
    default:
      return 'linux'
  }
}

/** Release archive extension: zip on Windows, single-binary gz elsewhere. */
function assetExt(): string {
  return process.platform === 'win32' ? 'zip' : 'gz'
}

/** Pick the plain release asset (e.g. mihomo-linux-amd64-v1.19.32.gz). */
function pickAsset(names: string[]): string {
  const re = new RegExp(`^mihomo-${osTag()}-${archTag()}-v[\\d.]+\\.${assetExt()}$`)
  return names.find((n) => re.test(n)) || ''
}

/** Fallback (no api.github.com): scrape the releases page for the asset URL. */
async function resolveZipUrlViaHtml(): Promise<string> {
  const page = await axios.get('https://github.com/MetaCubeX/mihomo/releases/latest', {
    timeout: 20000,
    proxy: false,
    responseType: 'text',
    transformResponse: [(d) => d],
    headers: { 'User-Agent': 'chat2api' },
    maxRedirects: 5,
  })
  const html = String(page.data || '')
  const tagMatch = html.match(/expanded_assets\/(v[\d.]+[^\s"']*)/)
  if (!tagMatch) return ''
  const tag = tagMatch[1]
  const assets = await axios.get(`https://github.com/MetaCubeX/mihomo/releases/expanded_assets/${tag}`, {
    timeout: 20000,
    proxy: false,
    responseType: 'text',
    transformResponse: [(d) => d],
    headers: { 'User-Agent': 'chat2api' },
  })
  const names = [...String(assets.data || '').matchAll(/(mihomo-(?:windows|linux|darwin)-[\w.-]+\.(?:zip|gz))/g)].map(
    (m) => m[1]
  )
  const zip = pickAsset([...new Set(names)])
  return zip ? `https://github.com/MetaCubeX/mihomo/releases/download/${tag}/${zip}` : ''
}

/** Download the mihomo binary zip from GitHub releases and extract it. */
async function ensureBinary(): Promise<{ ok: boolean; error?: string }> {
  const bin = binaryPath()
  if (fs.existsSync(bin)) return { ok: true }

  const dir = workDir()
  fs.mkdirSync(dir, { recursive: true })

  let zipUrl = process.env.CHAT2API_MIHOMO_ZIP_URL || ''
  if (!zipUrl) {
    try {
      const api = await axios.get('https://api.github.com/repos/MetaCubeX/mihomo/releases/latest', {
        timeout: 20000,
        proxy: false,
        headers: { 'User-Agent': 'chat2api', Accept: 'application/vnd.github+json' },
      })
      const assets: Array<{ name?: string; browser_download_url?: string }> = api.data?.assets || []
      const zip = pickAsset(assets.map((a) => a.name || ''))
      zipUrl = assets.find((a) => a.name === zip)?.browser_download_url || ''
    } catch {
      /* fall through to HTML fallback below */
    }
  }
  if (!zipUrl) {
    try {
      zipUrl = await resolveZipUrlViaHtml()
    } catch {
      /* fall through to error below */
    }
  }
  if (!zipUrl) {
    return {
      ok: false,
      error: `无法获取 mihomo 下载地址（GitHub 不可达）。可手动下载 mihomo-${osTag()}-${archTag()} 发布包（.${assetExt()}）并将内核重命名为 ${path.basename(bin)} 放入 ${dir}，或设置环境变量 CHAT2API_MIHOMO_ZIP_URL`,
    }
  }

  const zipPath = path.join(dir, 'mihomo-core' + (/\.gz(\?|$)/.test(zipUrl) ? '.gz' : '.zip'))
  try {
    const resp = await axios.get(zipUrl, {
      timeout: 120000,
      proxy: false,
      responseType: 'arraybuffer',
      headers: { 'User-Agent': 'chat2api' },
      maxRedirects: 5,
    })
    fs.writeFileSync(zipPath, Buffer.from(resp.data))
  } catch (e) {
    return { ok: false, error: `mihomo 核心下载失败: ${e instanceof Error ? e.message : String(e)}` }
  }

  // Extract: .gz archives hold the single binary; .zip needs unpacking.
  const extractDir = path.join(dir, 'extracted')
  fs.rmSync(extractDir, { recursive: true, force: true })
  try {
    if (zipPath.endsWith('.gz')) {
      const zlib = await import('node:zlib')
      fs.writeFileSync(bin, zlib.gunzipSync(fs.readFileSync(zipPath)))
    } else {
      fs.mkdirSync(extractDir, { recursive: true })
      if (process.platform === 'win32') {
        await new Promise<void>((resolve, reject) => {
          execFile(
            'powershell.exe',
            [
              '-NoProfile',
              '-Command',
              `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`,
            ],
            { timeout: 60000 },
            (err) => (err ? reject(err) : resolve())
          )
        })
      } else {
        await new Promise<void>((resolve, reject) => {
          execFile('unzip', ['-o', zipPath, '-d', extractDir], { timeout: 60000 }, (err) =>
            err ? reject(err) : resolve()
          )
        })
      }
      // Locate the executable inside the extracted tree and move it into place.
      const found: string[] = []
      const walk = (d: string) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, entry.name)
          if (entry.isDirectory()) walk(p)
          else found.push(p)
        }
      }
      walk(extractDir)
      const exe =
        found.find((f) => path.basename(f).toLowerCase().includes('mihomo')) ||
        found.find((f) => !path.extname(f)) ||
        found[0]
      if (!exe) {
        return { ok: false, error: '解压后未找到 mihomo 可执行文件' }
      }
      fs.copyFileSync(exe, bin)
      fs.rmSync(extractDir, { recursive: true, force: true })
    }
  } catch (e) {
    return { ok: false, error: `解压 mihomo 失败: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(bin, 0o755)
    } catch {
      /* ignore */
    }
  }
  fs.rmSync(zipPath, { force: true })
  return { ok: true }
}

/** Build the mihomo config: mixed-port header + the subscription YAML. */
async function writeConfig(
  subscriptionUrl: string,
  port: number,
  selectedNode: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetchClashSubscriptionText(subscriptionUrl)
  if (res.error || !res.text) {
    return { ok: false, error: res.error || '订阅下载失败' }
  }
  if (!res.text.includes('proxies:')) {
    return { ok: false, error: '订阅内容中未找到 proxies 节点列表' }
  }
  const header = [
    `mixed-port: ${port}`,
    'allow-lan: false',
    'mode: rule',
    'log-level: warning',
    'ipv6: false',
    "external-controller: ''",
    '',
  ].join('\n')

  // Subscriptions often declare their own mixed-port/mode/etc. at top
  // level; drop every key we override so the header wins (no dup keys).
  const OVERRIDDEN = new Set([
    'mixed-port',
    'port',
    'socks-port',
    'http-port',
    'redir-port',
    'tproxy-port',
    'allow-lan',
    'mode',
    'log-level',
    'ipv6',
    'external-controller',
    'external-ui',
  ])
  const filteredBody = res.text
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.trim()) return true
      if (line.length - line.trimStart().length !== 0) return true
      const m = line.match(/^([\w.-]+):/)
      return !(m && OVERRIDDEN.has(m[1]))
    })
    .join('\n')
  let body = filteredBody

  // When a specific node is selected, prepend our own select group and a
  // catch-all rule so ALL traffic exits through that node.
  if (selectedNode) {
    const names = parseClashProxyNames(res.text)
    if (!names.includes(selectedNode)) {
      return { ok: false, error: `订阅中不存在节点「${selectedNode}」，请重新解析节点列表` }
    }
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`
    const group = [
      'proxy-groups:',
      '- name: CHAT2API-SELECT',
      '  type: select',
      `  proxies: [${q(selectedNode)}]`,
      '',
    ].join('\n')
    if (body.includes('proxy-groups:')) {
      body = body.replace('proxy-groups:', group)
    } else {
      body += '\n' + group
    }
    const catchAll = 'rules:\n- MATCH,CHAT2API-SELECT\n'
    if (/^rules:/m.test(body)) {
      body = body.replace(/^rules:/m, catchAll)
    } else {
      body += '\n' + catchAll
    }
  }

  fs.mkdirSync(workDir(), { recursive: true })
  fs.writeFileSync(path.join(workDir(), 'config.yaml'), header + body, 'utf-8')
  return { ok: true }
}

function stopChild(): void {
  if (child) {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
    child = null
  }
  state = { running: false }
}

/** Stop the embedded core (idempotent). */
export function stopEmbeddedClash(): void {
  stopChild()
}

/**
 * Ensure the embedded mihomo core is running and dialed to the given
 * subscription. Restarts when the subscription URL changes.
 */
export function ensureEmbeddedClash(
  subscriptionUrl: string,
  selectedNode = ''
): Promise<{ ok: boolean; port?: number; error?: string }> {
  if (
    state.running &&
    state.port &&
    child &&
    !child.killed &&
    state.subscriptionUrl === subscriptionUrl &&
    (state.selectedNode || '') === selectedNode
  ) {
    return probePort(state.port, 500).then((alive) =>
      alive ? { ok: true, port: state.port } : (stopChild(), doStart(subscriptionUrl, selectedNode))
    )
  }
  if (startLock) return startLock
  startLock = doStart(subscriptionUrl, selectedNode).finally(() => {
    startLock = null
  })
  return startLock
}

async function doStart(
  subscriptionUrl: string,
  selectedNode: string
): Promise<{ ok: boolean; port?: number; error?: string }> {
  stopChild()

  const binRes = await ensureBinary()
  if (!binRes.ok) {
    state = { running: false, error: binRes.error }
    return { ok: false, error: binRes.error }
  }

  let port = 0
  try {
    port = await findFreePort()
  } catch (e) {
    return { ok: false, error: `无法分配本地端口: ${e instanceof Error ? e.message : String(e)}` }
  }

  const cfgRes = await writeConfig(subscriptionUrl, port, selectedNode)
  if (!cfgRes.ok) {
    state = { running: false, error: cfgRes.error }
    return { ok: false, error: cfgRes.error }
  }

  const bin = binaryPath()
  try {
    child = spawn(bin, ['-d', workDir(), '-f', path.join(workDir(), 'config.yaml')], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    state = { running: false, error: `mihomo 启动失败: ${e instanceof Error ? e.message : String(e)}` }
    return { ok: false, error: state.error }
  }

  const log = (data: Buffer) => {
    const line = data.toString('utf-8').trim()
    if (line) console.log(`[EmbeddedClash] ${line.slice(0, 300)}`)
  }
  child.stdout?.on('data', log)
  child.stderr?.on('data', log)
  child.once('exit', (code) => {
    console.log(`[EmbeddedClash] mihomo exited with code ${code}`)
    child = null
    state = { running: false }
  })

  // Wait for the mixed port to accept connections.
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (await probePort(port, 400)) {
      state = { running: true, port, subscriptionUrl, selectedNode, binaryPath: bin }
      console.log(
        `[EmbeddedClash] mihomo dialing subscription on 127.0.0.1:${port}` +
          (selectedNode ? ` via node "${selectedNode}"` : '')
      )
      return { ok: true, port }
    }
    if (!child || child.killed) break
    await new Promise((r) => setTimeout(r, 300))
  }

  const err = 'mihomo 启动后混合端口未就绪（20s 超时），请查看日志'
  stopChild()
  state = { running: false, error: err }
  return { ok: false, error: err }
}

/**
 * Reconcile the embedded core with the current configuration:
 * stop it when the upstream proxy is disabled / not clash-sourced,
 * restart it when the subscription URL changed while running.
 */
export async function syncEmbeddedClash(): Promise<void> {
  try {
    const { ConfigManager } = await import('../store/config')
    const cfg = ConfigManager.get().upstreamProxy
    const shouldRun =
      !!cfg?.enabled &&
      (cfg.source === 'clash' || cfg.source === 'embedded') &&
      !!cfg.subscriptionUrl?.trim()
    if (!shouldRun) {
      if (state.running) stopChild()
      return
    }
    const sub = cfg.subscriptionUrl!.trim()
    const node = cfg.selectedNode?.trim() || ''
    if (
      state.running &&
      (state.subscriptionUrl !== sub || (state.selectedNode || '') !== node)
    ) {
      await ensureEmbeddedClash(sub, node)
    } else if (!state.running) {
      await ensureEmbeddedClash(sub, node)
    }
  } catch (e) {
    console.warn('[EmbeddedClash] sync failed:', e instanceof Error ? e.message : String(e))
  }
}
