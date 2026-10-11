/**
 * Cloudflare Temp Email client (dreamhunter2333/cloudflare_temp_email)
 *
 * Used by the Qwen AI auto-registration flow to obtain a disposable mailbox,
 * then fetch the verification-code email sent by Qwen.
 *
 * The service endpoint, admin password and mailbox domain are NOT bundled
 * with the app. Users configure them in the "Temp Mail Settings" dialog and
 * the values are stored locally in the app config (`tempMail`).
 *
 * Admin endpoints are authenticated with the `x-admin-auth` header.
 */

import axios from 'axios'
import { storeManager } from '../store/store'
import type { TempMailConfig } from '../../shared/types'

/**
 * Read the user-configured temp-mail settings (raw stored values).
 * There are intentionally NO bundled defaults.
 */
export function getTempMailConfig(): TempMailConfig {
  const stored = (storeManager.getConfig() as { tempMail?: Partial<TempMailConfig> }).tempMail
  return {
    apiUrl: (stored?.apiUrl || '').trim(),
    adminPassword: stored?.adminPassword || '',
    domain: (stored?.domain || '').trim(),
  }
}

/** True when every required field has been configured by the user. */
export function isTempMailConfigured(): boolean {
  const cfg = getTempMailConfig()
  return Boolean(cfg.apiUrl && cfg.adminPassword && cfg.domain)
}

/**
 * Return the config, or throw a descriptive error prompting the user to
 * open the Temp Mail Settings dialog first.
 */
export function requireTempMailConfig(): TempMailConfig {
  const cfg = getTempMailConfig()
  if (!cfg.apiUrl || !cfg.adminPassword || !cfg.domain) {
    throw new Error(
      'Temp mail service is not configured. Open "Temp Mail Settings" (临时邮箱设置) and fill in the API URL, admin password and mailbox domain first.',
    )
  }
  return cfg
}

export interface TempAddress {
  address: string
  jwt: string
  addressId: number
}

export interface TempMailMessage {
  id: number
  created_at: string
  raw: string
  source?: string
  subject?: string
}

function adminHeaders(): Record<string, string> {
  return {
    'x-admin-auth': requireTempMailConfig().adminPassword,
    'Content-Type': 'application/json',
  }
}

/** Prefix used by `randomName()`; addresses starting with it are ours. */
export const TEMP_ADDRESS_PREFIX = 'chat2api'

function randomName(): string {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `${TEMP_ADDRESS_PREFIX}${ts}${rand}`
}

/**
 * Create a new temporary mailbox address via the admin API.
 */
export async function createTempAddress(name?: string): Promise<TempAddress> {
  const cfg = requireTempMailConfig()
  const addressName = name || randomName()
  const resp = await axios.post(
    `${cfg.apiUrl.replace(/\/+$/, '')}/admin/new_address`,
    { enablePrefix: false, name: addressName, domain: cfg.domain },
    { headers: adminHeaders(), timeout: 20000 },
  )
  const data = resp.data
  if (!data?.address) {
    throw new Error(`Temp mail: unexpected new_address response: ${JSON.stringify(data).slice(0, 200)}`)
  }
  return {
    address: data.address,
    jwt: data.jwt || '',
    addressId: data.address_id ?? 0,
  }
}

export interface ExistingTempAddress {
  address: string
  addressId: number
  mailCount: number
  createdAt: string
}

/**
 * List existing mailbox addresses via the admin API (newest first).
 * `query` filters server-side by address substring (e.g. "chat2api").
 */
export async function listTempAddresses(query?: string, limit = 100): Promise<ExistingTempAddress[]> {
  const cfg = requireTempMailConfig()
  const resp = await axios.get(`${cfg.apiUrl.replace(/\/+$/, '')}/admin/address`, {
    headers: adminHeaders(),
    params: {
      limit,
      offset: 0,
      ...(query ? { query } : {}),
    },
    timeout: 20000,
  })
  const results = (resp.data?.results || []) as Array<{
    id?: number
    name?: string
    created_at?: string
    mail_count?: number
  }>
  return results
    .filter((r) => typeof r.name === 'string' && r.name.includes('@'))
    .map((r) => ({
      address: r.name as string,
      addressId: r.id ?? 0,
      mailCount: r.mail_count ?? 0,
      createdAt: r.created_at || '',
    }))
}

/**
 * Return an existing, still-unused `chat2api*` mailbox when one is
 * available; otherwise create a new one.
 *
 * "Unused" means no stored account has already registered with that email
 * address (accounts keep the temp address in their `email` field). Mail
 * polling uses the admin endpoint, so a reused address needs no JWT.
 */
export async function getOrCreateTempAddress(): Promise<TempAddress & { reused: boolean }> {
  try {
    const existing = await listTempAddresses(TEMP_ADDRESS_PREFIX)
    const usedEmails = new Set(
      storeManager
        .getAccounts()
        .map((a) => (a.email || '').trim().toLowerCase())
        .filter(Boolean),
    )
    const free = existing.find((a) => !usedEmails.has(a.address.trim().toLowerCase()))
    if (free) {
      console.log(`[TempMail] Reusing existing mailbox: ${free.address}`)
      return { address: free.address, jwt: '', addressId: free.addressId, reused: true }
    }
    if (existing.length > 0) {
      console.log(
        `[TempMail] All ${existing.length} existing chat2api mailbox(es) are already bound to accounts; creating a new one`,
      )
    }
  } catch (e) {
    console.warn(
      '[TempMail] Failed to list existing addresses, falling back to creating a new one:',
      e instanceof Error ? e.message : e,
    )
  }
  const created = await createTempAddress()
  return { ...created, reused: false }
}

/**
 * Fetch recent mails for an address (admin endpoint, newest first).
 */
export async function fetchMails(address: string, limit = 5): Promise<TempMailMessage[]> {
  const cfg = requireTempMailConfig()
  const resp = await axios.get(`${cfg.apiUrl.replace(/\/+$/, '')}/admin/mails`, {
    headers: adminHeaders(),
    params: { address, limit, offset: 0 },
    timeout: 20000,
  })
  return (resp.data?.results || []) as TempMailMessage[]
}

function decodePart(partHeaders: string, body: string): string {
  const encMatch = partHeaders.match(/content-transfer-encoding:\s*([a-z0-9\-]+)/i)
  const enc = encMatch ? encMatch[1].toLowerCase() : ''
  if (enc === 'base64') {
    try {
      return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8')
    } catch {
      return body
    }
  }
  if (enc === 'quoted-printable') {
    return body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  }
  return body
}

/**
 * Decode a raw MIME message into readable text (handles multipart and
 * base64 / quoted-printable transfer encodings).
 */
export function decodeMimeMail(raw: string): string {
  if (!raw) return ''
  const sepIdx = raw.indexOf('\r\n\r\n')
  const headers = sepIdx >= 0 ? raw.slice(0, sepIdx) : ''
  const body = sepIdx >= 0 ? raw.slice(sepIdx + 4) : raw

  const boundaryMatch = headers.match(/boundary="?([^";\r\n]+)"?/i)
  if (boundaryMatch) {
    let text = ''
    const parts = body.split('--' + boundaryMatch[1]).slice(1)
    for (const part of parts) {
      const pi = part.indexOf('\r\n\r\n')
      if (pi < 0) continue
      const partHeaders = part.slice(0, pi)
      const partBody = part.slice(pi + 4)
      // Only take text parts (skip attachments etc.)
      if (/content-type:\s*text\//i.test(partHeaders) || !/content-type:/i.test(partHeaders)) {
        text += decodePart(partHeaders, partBody) + '\n'
      }
    }
    if (text.trim()) return text
  }
  return decodePart(headers, body)
}

/**
 * Extract the 6-digit verification code from the decoded email body.
 * Qwen mails render the code as `<div class="code-box" dir="ltr">092174</div>`.
 */
export function extractVerificationCode(text: string): string | null {
  if (!text) return null

  // Primary: Qwen's code-box markup
  const codeBox = text.match(/code-box[^>]*>\s*(\d{6})\s*</i)
  if (codeBox) return codeBox[1]

  // Secondary: code near the word "验证码" / "verification code"
  const nearKeyword = text.match(/(?:验证码|verification\s*code)[^0-9]{0,120}(\d{6})/i)
  if (nearKeyword) return nearKeyword[1]

  // Fallback: any 6-digit number that is not CSS noise like 000000
  const candidates = Array.from(text.matchAll(/\b(\d{6})\b/g))
  for (const m of candidates) {
    if (m[1] !== '000000') return m[1]
  }
  return null
}

function parseCreatedAt(value: string): number {
  // Server returns UTC strings like "2026-10-10 07:50:44"
  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  const ts = Date.parse(normalized.endsWith('Z') ? normalized : normalized + 'Z')
  return Number.isNaN(ts) ? 0 : ts
}

/**
 * Poll the mailbox until a verification-code email arrives (newer than
 * `sinceTs`), then return the extracted code.
 */
export async function waitForVerificationCode(
  address: string,
  options: {
    sinceTs?: number
    timeoutMs?: number
    pollMs?: number
    onPoll?: (attempt: number) => void
  } = {},
): Promise<string> {
  const sinceTs = options.sinceTs ?? Date.now() - 30_000
  const timeoutMs = options.timeoutMs ?? 180_000
  const pollMs = options.pollMs ?? 4_000
  const deadline = Date.now() + timeoutMs
  let attempt = 0

  while (Date.now() < deadline) {
    attempt++
    options.onPoll?.(attempt)
    try {
      const mails = await fetchMails(address, 5)
      for (const mail of mails) {
        const created = mail.created_at ? parseCreatedAt(mail.created_at) : 0
        if (created && created < sinceTs) continue
        const text = decodeMimeMail(mail.raw || '')
        const code = extractVerificationCode(text)
        if (code) return code
      }
    } catch (e) {
      console.warn('[TempMail] poll error:', e instanceof Error ? e.message : e)
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  throw new Error(`Temp mail: no verification code received for ${address} within ${Math.round(timeoutMs / 1000)}s`)
}
