/**
 * In-App Login Manager
 * Manages in-app browser window for OAuth login and token extraction
 */

import { BrowserWindow, session, Session, WebContents } from 'electron'
import { EventEmitter } from 'events'
import { ProviderType } from './types'
import { TokenExtractionConfig, getTokenExtractionConfig, TokenSource } from './tokenExtractionConfig'
import { runQwenRegistration, QWEN_REGISTER_URL } from './qwenRegister'
import { applySessionProxy } from '../lib/clashProxy'

export interface InAppLoginResult {
  success: boolean
  credentials?: Record<string, string>
  accountInfo?: {
    userId?: string
    email?: string
    name?: string
    avatar?: string
    quota?: number
    used?: number
    expiresAt?: number
  }
  error?: string
}

export interface TokenFoundEvent {
  key: string
  value: string
  allCookies?: Record<string, string>
}

export interface InAppLoginOptions {
  providerId: string
  providerType: ProviderType
  timeout?: number
  proxyMode?: 'system' | 'none'
  /** 'register' triggers the automatic account-registration flow (qwen-ai only) */
  mode?: 'login' | 'register'
}

const DEFAULT_TIMEOUT = 300000 // 5 minutes
const MIN_LOGIN_TIME = 5000 // Minimum time before checking tokens (5 seconds)
const MAX_LOAD_RETRIES = 3 // Maximum number of retry attempts for page loading
const LOAD_RETRY_DELAY = 2000 // Delay between retry attempts (ms)
// When the automatic registration flow fails, keep the window open for a
// grace period so the user can finish manually AND the retained puzzle
// watcher keeps solving freshly-refreshed captchas ("换图后接着认证"); then
// auto-fail instead of hanging until the full login timeout expires. The
// window is closed on completion, so this grace bounds the watcher's life.
const REGISTER_FAIL_GRACE_MS = 120000

// Common User-Agent string for the in-app login window.
// Many provider websites reject or block the default Electron User-Agent,
// causing ERR_CONNECTION_CLOSED or similar errors. Using a standard
// Chrome User-Agent avoids this.
const IN_APP_LOGIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

export class InAppLoginManager extends EventEmitter {
  private loginWindow: BrowserWindow | null = null
  private loginSession: Session | null = null
  private foundTokens: Map<string, string> = new Map()
  private config: TokenExtractionConfig | null = null
  private isCompleted: boolean = false
  private timeoutId: NodeJS.Timeout | null = null
  private resolvePromise: ((result: InAppLoginResult) => void) | null = null
  private loginStartTime: number = 0
  private lastTokenCheckTime: number = 0
  private options: InAppLoginOptions | null = null
  private loadRetryCount: number = 0
  private tokenCheckRunning: boolean = false
  private tokenCheckQueued: boolean = false
  private registerFailTimer: NodeJS.Timeout | null = null

  constructor() {
    super()
  }

  async startLogin(options: InAppLoginOptions): Promise<InAppLoginResult> {
    if (this.loginWindow) {
      return {
        success: false,
        error: 'A login window is already open',
      }
    }

    this.config = getTokenExtractionConfig(options.providerType)
    if (!this.config) {
      return {
        success: false,
        error: `No token extraction config found for provider: ${options.providerType}`,
      }
    }

    this.foundTokens.clear()
    this.isCompleted = false
    this.loginStartTime = Date.now()
    this.lastTokenCheckTime = 0
    this.options = options
    this.loadRetryCount = 0

    return new Promise((resolve) => {
      this.resolvePromise = resolve

      this.timeoutId = setTimeout(() => {
        this.complete({
          success: false,
          error: 'Login timeout',
        })
      }, options.timeout || DEFAULT_TIMEOUT)

      this.emit('status', { status: 'starting', message: 'Opening login window...' })

      this.createLoginWindow()
      this.setupTokenInterception()
    })
  }

  private createLoginWindow(): void {
    if (!this.config) return

    const partition = `persist:oauth-${Date.now()}`
    this.loginSession = session.fromPartition(partition)

    // Set a standard Chrome User-Agent on the session to avoid being
    // blocked by provider websites that reject Electron's default UA.
    this.loginSession.setUserAgent(IN_APP_LOGIN_UA)

    // Apply the configured upstream proxy (manual URL or local Clash client)
    // to the login session so registration/login egresses through it. When
    // upstream proxy is disabled keep the legacy behavior: 'none' forces a
    // direct connection, otherwise the system proxy is used.
    applySessionProxy(this.loginSession)
      .then((info) => {
        if (!info.active && this.options?.proxyMode === 'none') {
          return this.loginSession?.setProxy({ mode: 'direct' })
        }
        if (info.active) {
          console.log(`[InAppLogin] Upstream proxy applied: ${info.url} (${info.source})`)
        }
      })
      .catch((error) => {
        console.error('[InAppLogin] Failed to set proxy:', error)
      })

    this.loginWindow = new BrowserWindow({
      width: 500,
      height: 700,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition,
        webSecurity: true,
        javascript: true,
      },
      title: this.config.windowTitle || 'Login',
      autoHideMenuBar: true,
    })

    this.loginWindow.once('ready-to-show', () => {
      this.loginWindow?.show()
      this.emit('status', { status: 'ready', message: 'Login window ready - please log in' })

      if (this.options?.mode === 'register') {
        this.startRegistrationFlow()
      }
    })

    this.loginWindow.on('closed', () => {
      if (this.isCompleted) return

      // Race guard: the token may already have been captured and the manager
      // may be awaiting adapter.validateToken() (a network call that can take
      // a few seconds). If we fail immediately here, completeWithSuccess()
      // arriving afterwards is dropped (isCompleted already true) and the
      // renderer sees "Login window was closed" even though the account was
      // registered and validated successfully. Give pending validation a
      // grace period to complete the flow first.
      if (this.foundTokens.size > 0) {
        console.log(
          '[InAppLogin] Window closed while token validation is pending; waiting for validation result before failing...'
        )
        setTimeout(() => {
          if (!this.isCompleted) {
            console.log('[InAppLogin] Validation grace period expired after window close; completing as failure')
            this.complete({
              success: false,
              error: 'Login window was closed',
            })
          }
        }, 20_000)
        return
      }

      this.complete({
        success: false,
        error: 'Login window was closed',
      })
    })

    // Handle page load failures (e.g. ERR_CONNECTION_CLOSED)
    this.loginWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      // Ignore sub-frame errors and non-primary frame errors
      if (this.isCompleted) return

      console.error('[InAppLogin] did-fail-load:', { errorCode, errorDescription, validatedURL })

      // Ignore errors for sub-frames (isMainFrame would be checked via event)
      // ERR_ABORTED (-3) is usually triggered by navigation during page load
      // and is not a real error we need to retry.
      if (errorCode === -3) {
        console.log('[InAppLogin] Ignoring ERR_ABORTED (-3), likely navigation')
        return
      }

      this.loadRetryCount++
      if (this.loadRetryCount <= MAX_LOAD_RETRIES) {
        console.log(`[InAppLogin] Retrying page load (attempt ${this.loadRetryCount}/${MAX_LOAD_RETRIES})...`)
        this.emit('status', {
          status: 'pending',
          message: `Connection failed, retrying (${this.loadRetryCount}/${MAX_LOAD_RETRIES})...`,
        })

        setTimeout(() => {
          if (this.isCompleted) return
          if (!this.loginWindow || this.loginWindow.isDestroyed()) return

          this.loginWindow.loadURL(this.getStartUrl()).catch((error) => {
            if (this.loadRetryCount >= MAX_LOAD_RETRIES) {
              this.complete({
                success: false,
                error: `Failed to load login page: ${error.message}`,
              })
            }
          })
        }, LOAD_RETRY_DELAY)
      } else {
        this.complete({
          success: false,
          error: `Failed to load login page after ${MAX_LOAD_RETRIES} retries: ${errorDescription} (${errorCode})`,
        })
      }
    })

    this.loadUrlWithRetry()
  }

  /**
   * The URL to load initially: the register page when running the
   * auto-registration flow, otherwise the provider's login URL.
   */
  private getStartUrl(): string {
    if (this.options?.mode === 'register' && this.options.providerType === 'qwen-ai') {
      return QWEN_REGISTER_URL
    }
    return this.config?.loginUrl || ''
  }

  /**
   * Automatic account-registration flow (currently qwen-ai only).
   * Runs inside the visible login window; on failure the window stays open
   * so the user can complete registration manually.
   */
  private startRegistrationFlow(): void {
    if (!this.loginWindow || this.loginWindow.isDestroyed()) return
    if (this.options?.providerType !== 'qwen-ai') {
      this.emit('status', {
        status: 'pending',
        message: 'Auto-registration is only supported for Qwen AI, please register manually',
      })
      return
    }

    const wc = this.loginWindow.webContents
    runQwenRegistration({
      webContents: wc,
      emitStatus: (message: string) => {
        if (this.isCompleted) return
        this.emit('status', { status: 'pending', message })
      },
    })
      .then(({ address }) => {
        console.log('[InAppLogin] Registration flow completed for', address)
        if (this.isCompleted) return
        this.emit('status', {
          status: 'pending',
          message: `注册成功 (${address})，正在完成登录...`,
        })
        // Token capture is handled by the regular interception; nudge a check.
        this.delayedTokenCheck()
      })
      .catch((error) => {
        console.error('[InAppLogin] Registration flow failed:', error)
        if (this.isCompleted) return
        const message = error instanceof Error ? error.message : String(error)
        this.emit('status', {
          status: 'pending',
          message: `自动注册失败: ${message} — 可在窗口中手动完成注册`,
        })
        // Do not leave the caller (batch/auto-refill loop) hanging until the
        // full login timeout: auto-fail after a short grace period unless a
        // token was captured (manual completion) in the meantime.
        if (this.registerFailTimer) clearTimeout(this.registerFailTimer)
        this.registerFailTimer = setTimeout(() => {
          this.registerFailTimer = null
          if (this.isCompleted || this.foundTokens.size > 0) return
          console.log('[InAppLogin] Registration failure grace period expired; completing as failure')
          this.complete({
            success: false,
            error: `自动注册失败: ${message}`,
          })
        }, REGISTER_FAIL_GRACE_MS)
      })
  }

  /**
   * Load the login URL with retry on failure
   */
  private loadUrlWithRetry(): void {
    if (!this.config || !this.loginWindow) return

    this.loginWindow.loadURL(this.getStartUrl()).catch((error) => {
      // This catch handles synchronous loadURL rejection.
      // The did-fail-load event handles most connection errors with retry logic.
      if (this.isCompleted) return

      console.error('[InAppLogin] loadURL rejected:', error.message)

      this.loadRetryCount++
      if (this.loadRetryCount <= MAX_LOAD_RETRIES) {
        console.log(`[InAppLogin] Retrying page load (attempt ${this.loadRetryCount}/${MAX_LOAD_RETRIES})...`)
        this.emit('status', {
          status: 'pending',
          message: `Connection failed, retrying (${this.loadRetryCount}/${MAX_LOAD_RETRIES})...`,
        })

        setTimeout(() => {
          if (this.isCompleted) return
          if (!this.loginWindow || this.loginWindow.isDestroyed()) return

          this.loginWindow.loadURL(this.getStartUrl()).catch((err) => {
            if (this.loadRetryCount >= MAX_LOAD_RETRIES) {
              this.complete({
                success: false,
                error: `Failed to load login page: ${err.message}`,
              })
            }
          })
        }, LOAD_RETRY_DELAY)
      } else {
        this.complete({
          success: false,
          error: `Failed to load login page: ${error.message}`,
        })
      }
    })
  }

  private setupTokenInterception(): void {
    if (!this.loginSession || !this.config) return

    // Intercept response headers to capture Set-Cookie headers
    // This is needed for HttpOnly + Secure cookies that may not be accessible via cookies.get()
    this.loginSession.webRequest.onHeadersReceived((details, callback) => {
      if (this.isCompleted) {
        callback({})
        return
      }

      const setCookieHeaders = details.responseHeaders?.['set-cookie'] || details.responseHeaders?.['Set-Cookie']
      if (setCookieHeaders && Array.isArray(setCookieHeaders)) {
        for (const cookieHeader of setCookieHeaders) {
          console.log('[InAppLogin] Set-Cookie header:', cookieHeader.substring(0, 100))
          
          const cookieParts = cookieHeader.split(';')
          const nameValue = cookieParts[0]?.trim()
          if (nameValue) {
            const equalIndex = nameValue.indexOf('=')
            if (equalIndex > 0) {
              const name = nameValue.substring(0, equalIndex)
              let value = nameValue.substring(equalIndex + 1)
              
              // Remove surrounding quotes from the value (RFC 6265 allows quoted cookie values)
              if (value.startsWith('"') && value.endsWith('"')) {
                value = value.slice(1, -1)
                console.log('[InAppLogin] Removed quotes from cookie value:', name)
              }
              
              for (const source of this.config!.tokenSources) {
                if (source.type === 'cookie' && name === source.key) {
                  console.log('[InAppLogin] Found target cookie in Set-Cookie header:', name)
                  if (this.isValidToken(value)) {
                    console.log('[InAppLogin] Cookie token is valid from Set-Cookie header')
                    this.foundTokens.set(source.key, value)
                    this.emit('tokenFound', { key: source.key, value: value })
                  }
                }
              }
            }
          }
        }
      }

      callback({})
    })

    this.loginSession.webRequest.onBeforeSendHeaders((details, callback) => {
      if (this.isCompleted) {
        callback({ requestHeaders: details.requestHeaders })
        return
      }

      if (!this.hasMinTimePassed()) {
        callback({ requestHeaders: details.requestHeaders })
        return
      }

      const authHeader = details.requestHeaders['Authorization'] || details.requestHeaders['authorization']
      if (authHeader) {
        for (const source of this.config!.tokenSources) {
          if (source.type === 'networkHeader' && this.urlMatchesPattern(details.url, source.urlPattern)) {
            let token = authHeader
            if (source.extractPattern) {
              const match = authHeader.match(new RegExp(source.extractPattern))
              if (match && match[1]) {
                token = match[1]
              }
            } else if (authHeader.startsWith('Bearer ')) {
              token = authHeader.substring(7)
            }
            if (this.isValidToken(token)) {
              this.foundTokens.set(source.key, token)
              this.emit('tokenFound', { key: source.key, value: token })
            }
          }
        }
      }

      callback({ requestHeaders: details.requestHeaders })
    })

    this.loginSession.webRequest.onBeforeRequest((details, callback) => {
      if (this.isCompleted || !this.config) {
        callback({})
        return
      }

      if (!this.hasMinTimePassed()) {
        callback({})
        return
      }

      const requestBodySources = this.config.tokenSources.filter((source) => source.type === 'requestBody')
      if (requestBodySources.length === 0 || !details.uploadData) {
        callback({})
        return
      }

      const body = details.uploadData
        .map((item) => item.bytes ? Buffer.from(item.bytes).toString('utf8') : '')
        .join('')

      for (const source of requestBodySources) {
        if (!this.urlMatchesPattern(details.url, source.urlPattern)) continue
        if (!this.hasRequiredTokens(source)) continue

        const value = this.extractRequestBodyValue(body, source.key)
        if (value && this.isValidToken(value)) {
          console.log('[InAppLogin] Found target request body value:', source.key)
          this.foundTokens.set(source.key, value)
          this.emit('tokenFound', { key: source.key, value })
        }
      }

      callback({})
    })

    this.loginSession.cookies.on('changed', async (_event, cookie, _cause, removed) => {
      if (this.isCompleted || removed) return

      console.log('[InAppLogin] Cookie changed:', { name: cookie.name, value: cookie.value ? cookie.value.substring(0, 50) + '...' : 'null', removed })

      if (!this.hasMinTimePassed()) {
        console.log('[InAppLogin] Min time not passed, skipping cookie check')
        return
      }

      for (const source of this.config!.tokenSources) {
        if (source.type === 'cookie' && cookie.name === source.key) {
          console.log('[InAppLogin] Cookie matches source key:', source.key)
          if (this.isValidToken(cookie.value)) {
            console.log('[InAppLogin] Cookie token is valid, emitting tokenFound')
            this.foundTokens.set(source.key, cookie.value)
            // Collect all cookies so the manager can pass them to validateToken
            try {
              const allBrowserCookies = await this.loginSession.cookies.get({})
              const targetDomains = this.config?.targetDomains || []
              let cookiesToSearch = allBrowserCookies
              for (const domain of targetDomains) {
                try {
                  const domainCookies = await this.loginSession.cookies.get({ domain })
                  for (const dc of domainCookies) {
                    if (!cookiesToSearch.find(c => c.name === dc.name)) {
                      cookiesToSearch.push(dc)
                    }
                  }
                } catch (e) {
                  console.log(`[InAppLogin] Error getting cookies for domain ${domain}:`, e)
                }
              }
              const allCookiesObj: Record<string, string> = {}
              for (const c of cookiesToSearch) {
                if (c.value) {
                  allCookiesObj[c.name] = c.value
                }
              }
              this.emit('tokenFound', { key: source.key, value: cookie.value, allCookies: allCookiesObj })
            } catch (e) {
              console.log('[InAppLogin] Error collecting cookies on cookie changed:', e)
              this.emit('tokenFound', { key: source.key, value: cookie.value })
            }
          } else {
            console.log('[InAppLogin] Cookie token is invalid:', cookie.value ? cookie.value.substring(0, 50) : 'null')
          }
        }
      }

      console.log('[InAppLogin] Checking all cookies after change')
      await this.checkForTokens()
    })

    this.loginWindow?.webContents.on('did-finish-load', () => {
      console.log('[InAppLogin] Page finished loading, starting token checks')
      this.delayedTokenCheck()
    })

    this.loginWindow?.webContents.on('did-navigate-in-page', () => {
      console.log('[InAppLogin] Page navigated, starting delayed token check')
      this.delayedTokenCheck()
    })
  }


  private urlMatchesPattern(url: string, pattern?: string): boolean {
    if (!pattern) return true
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
    return new RegExp(`^${escaped}$`).test(url)
  }

  private extractRequestBodyValue(body: string, key: string): string | null {
    if (!body) return null

    try {
      const parsed = JSON.parse(body)
      const value = parsed?.[key]
      if (typeof value === 'string' && value) return value
    } catch {
      // Fall back to form/urlencoded parsing below.
    }

    const params = new URLSearchParams(body)
    const value = params.get(key)
    return value || null
  }

  private hasRequiredTokens(source: TokenSource): boolean {
    if (!source.requiredTokens || source.requiredTokens.length === 0) return true
    return source.requiredTokens.every((key) => this.foundTokens.has(key))
  }

  private hasMinTimePassed(): boolean {
    return Date.now() - this.loginStartTime >= MIN_LOGIN_TIME
  }

  private delayedTokenCheck(): void {
    const now = Date.now()
    if (now - this.lastTokenCheckTime < 2000) return
    this.lastTokenCheckTime = now

    setTimeout(() => {
      if (this.isCompleted) return
      if (!this.loginWindow || this.loginWindow.isDestroyed()) return
      if (this.loginWindow.webContents.isDestroyed()) return
      if (this.hasMinTimePassed()) {
        this.checkForTokens()
      }
    }, 1000)
  }

  private isValidToken(value: string): boolean {
    console.log('[InAppLogin] Checking token validity:', value.length, value.substring(0, 20))
    
    if (!value || value.length < 5) {
      console.log('[InAppLogin] Token rejected: too short or empty')
      return false
    }
    
    // Check for JWT format (3 parts) or JWE format (5 parts)
    if (value.startsWith('eyJ')) {
      const parts = value.split('.')
      
      // JWE format (5 parts) - used by Perplexity and some other providers
      if (parts.length === 5) {
        console.log('[InAppLogin] Token appears to be JWE format (5 parts)')
        // JWE tokens are encrypted, we can't decode them, but they're valid if properly formatted
        if (value.length >= 100) {
          console.log('[InAppLogin] Token accepted as valid JWE')
          return true
        }
        console.log('[InAppLogin] JWE token rejected: too short')
        return false
      }
      
      // JWT format (3 parts)
      if (parts.length === 3) {
        try {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
          console.log('[InAppLogin] JWT payload:', payload)
          
          // Reject guest accounts
          if (payload.email && payload.email.includes('@guest.com')) {
            console.log('[InAppLogin] Token rejected: guest account')
            return false
          }
          
          if (payload && (payload.app_id || payload.sub || payload.exp || payload.id || payload.user_id || payload.uid || payload.email)) {
            console.log('[InAppLogin] Token accepted as valid JWT')
            return true
          }
        } catch {
          console.log('[InAppLogin] Token rejected: invalid JWT')
          return false
        }
      }
    }
    
    // Accept long tokens (>= 64 chars) - includes base64 chars like / + and *
    if (value.length >= 64 && /^[a-zA-Z0-9_\-+/*]+$/.test(value)) {
      console.log('[InAppLogin] Token accepted as long token')
      return true
    }
    
    // Accept medium tokens (32-63 chars) - includes base64 chars and *
    if (value.length >= 32 && value.length < 64 && /^[a-zA-Z0-9_\-+/*]+$/.test(value)) {
      console.log('[InAppLogin] Token accepted as medium token')
      return true
    }
    
    // Accept Base64-encoded tokens (may contain = padding and /)
    // This handles tokens like "SME5/AEwvmtjSu4XO18SYg=="
    if (value.length >= 20 && /^[a-zA-Z0-9_\-+/]+=*$/.test(value)) {
      console.log('[InAppLogin] Token accepted as Base64 token')
      return true
    }
    
    // Accept any token that looks like a valid string (at least 5 chars, no spaces)
    // This handles short tokens like userId
    if (value.length >= 5 && !/\s/.test(value)) {
      console.log('[InAppLogin] Token accepted as generic token')
      return true
    }
    
    console.log('[InAppLogin] Token rejected: does not match any pattern')
    return false
  }

  private async checkForTokens(): Promise<void> {
    if (!this.loginWindow || this.isCompleted || !this.config) return

    if (this.loginWindow.isDestroyed()) {
      console.log('[InAppLogin] Window is destroyed, skipping token check')
      return
    }

    const webContents = this.loginWindow.webContents
    if (webContents.isDestroyed()) {
      console.log('[InAppLogin] webContents is destroyed, skipping token check')
      return
    }

    if (this.tokenCheckRunning) {
      // A previous check is still in flight (e.g. waiting on a hung
      // executeJavaScript); re-queue a single retry so cookie changes
      // arriving during the in-flight check are not missed.
      if (!this.tokenCheckQueued) {
        this.tokenCheckQueued = true
        setTimeout(() => {
          this.tokenCheckQueued = false
          if (!this.isCompleted) void this.checkForTokens()
        }, 600)
      }
      return
    }
    this.tokenCheckRunning = true

    const localStorageSources = this.config.tokenSources.filter((s) => s.type === 'localStorage')
    const cookieSources = this.config.tokenSources.filter((s) => s.type === 'cookie')

    if (localStorageSources.length === 0 && cookieSources.length === 0) {
      this.tokenCheckRunning = false
      return
    }

    console.log('[InAppLogin] Checking tokens, localStorage:', localStorageSources.map(s => s.key), 'cookies:', cookieSources.map(s => s.key))

    try {
      // Cookie sources use pure Electron APIs (no page JavaScript), so they
      // still work when the renderer main thread is blocked by anti-bot
      // scripts. Check them BEFORE probing localStorage.
      await this.checkCookieTokens(cookieSources)

      for (const source of localStorageSources) {
        if (webContents.isDestroyed() || this.isCompleted) {
          console.log('[InAppLogin] webContents destroyed or login completed, stopping token check')
          return
        }
        const script = `
          (function() {
            try {
              const value = localStorage.getItem('${source.key}');
              console.log('[InAppLogin] localStorage.getItem("${source.key}"):', value);
              return value || null;
            } catch (e) {
              console.error('[InAppLogin] Error reading localStorage:', e);
              return null;
            }
          })()
        `
        const value = await this.executeWithTimeout<string>(webContents, script, 3000)
        console.log('[InAppLogin] Got value from localStorage:', source.key, value ? value.substring(0, 50) + '...' : 'null')

        if (source.key === 'user_detail_agent' && value) {
          try {
            const parsed = JSON.parse(value)
            const realUserID = parsed.realUserID || parsed.id
            if (realUserID) {
              console.log('[InAppLogin] Found realUserID from user_detail_agent:', realUserID)
              this.foundTokens.set('realUserID', String(realUserID))
              this.emit('tokenFound', { key: 'realUserID', value: String(realUserID) })
            }
          } catch (e) {
            console.error('[InAppLogin] Error parsing user_detail_agent:', e)
          }
          continue
        }

        let tokenValue = value
        if (value && value.startsWith('{') && value.endsWith('}')) {
          try {
            const parsed = JSON.parse(value)
            if (parsed.value) {
              tokenValue = parsed.value
              console.log('[InAppLogin] Extracted token from JSON:', tokenValue.substring(0, 50) + '...')
            }
          } catch (e) {
            console.error('[InAppLogin] Error parsing JSON token:', e)
          }
        }

        if (tokenValue && typeof tokenValue === 'string' && this.isValidToken(tokenValue)) {
          console.log('[InAppLogin] Token found and valid from localStorage:', source.key)
          const emitKey = source.key === '_token' ? 'token' : source.key
          this.foundTokens.set(emitKey, tokenValue)

          // For providers that need cookies (e.g. Qwen AI), collect all browser
          // cookies and attach them to the tokenFound event so the manager can
          // pass them to validateToken alongside the token.
          if (this.loginSession) {
            try {
              const allBrowserCookies = await this.loginSession.cookies.get({})
              const targetDomains = this.config?.targetDomains || []
              let cookiesToSearch = allBrowserCookies
              for (const domain of targetDomains) {
                try {
                  const domainCookies = await this.loginSession.cookies.get({ domain })
                  for (const dc of domainCookies) {
                    if (!cookiesToSearch.find(c => c.name === dc.name)) {
                      cookiesToSearch.push(dc)
                    }
                  }
                } catch (e) {
                  console.log(`[InAppLogin] Error getting cookies for domain ${domain}:`, e)
                }
              }
              const allCookiesObj: Record<string, string> = {}
              for (const c of cookiesToSearch) {
                if (c.value) {
                  allCookiesObj[c.name] = c.value
                }
              }
              console.log('[InAppLogin] Attaching allCookies to localStorage tokenFound:', Object.keys(allCookiesObj).length, 'cookies')
              this.emit('tokenFound', { key: emitKey, value: tokenValue, allCookies: allCookiesObj })
            } catch (e) {
              console.log('[InAppLogin] Error collecting cookies for localStorage token:', e)
              this.emit('tokenFound', { key: emitKey, value: tokenValue })
            }
          } else {
            this.emit('tokenFound', { key: emitKey, value: tokenValue })
          }
        }
      }

    } catch (error) {
      console.error('[InAppLogin] Error in checkForTokens:', error)
    } finally {
      this.tokenCheckRunning = false
    }
  }

  /**
   * Cookie-based token sources checked via pure Electron APIs (no page
   * JavaScript involved), so this works even when the renderer main thread
   * is blocked (e.g. by the Baxia WAF punish page inside the login window).
   */
  private async checkCookieTokens(cookieSources: TokenSource[]): Promise<void> {
    if (cookieSources.length === 0 || !this.loginSession) return

    const allCookies = await this.loginSession.cookies.get({})
    console.log('[InAppLogin] All cookies count:', allCookies.length)

    const targetDomains = this.config?.targetDomains || []
    let cookiesToSearch = allCookies

    for (const domain of targetDomains) {
      try {
        const domainCookies = await this.loginSession.cookies.get({ domain })
        for (const dc of domainCookies) {
          if (!cookiesToSearch.find((c) => c.name === dc.name)) {
            cookiesToSearch.push(dc)
          }
        }
      } catch (e) {
        console.log(`[InAppLogin] Error getting cookies for domain ${domain}:`, e)
      }
    }

    for (const source of cookieSources) {
      const cookie = cookiesToSearch.find((c) => c.name === source.key)
      if (!cookie) {
        console.log('[InAppLogin] Cookie not found:', source.key)
        continue
      }

      console.log('[InAppLogin] Found cookie:', source.key, cookie.value ? cookie.value.substring(0, 50) + '...' : 'null')
      if (cookie.value && this.isValidToken(cookie.value)) {
        console.log('[InAppLogin] Token found and valid from cookie:', source.key, 'emitting tokenFound event')
        const allCookiesObj: Record<string, string> = {}
        for (const c of cookiesToSearch) {
          if (c.value) {
            allCookiesObj[c.name] = c.value
          }
        }
        this.foundTokens.set(source.key, cookie.value)
        this.emit('tokenFound', { key: source.key, value: cookie.value, allCookies: allCookiesObj })
      } else {
        console.log('[InAppLogin] Cookie token is invalid:', source.key, cookie.value ? cookie.value.substring(0, 50) : 'null')
      }
    }
  }

  /**
   * executeJavaScript hangs forever when the renderer main thread is blocked
   * (anti-bot/WAF scripts). Bound it with a timeout so token checks keep
   * making progress via the cookie branch.
   */
  private async executeWithTimeout<T>(
    webContents: WebContents,
    script: string,
    timeoutMs: number
  ): Promise<T | null> {
    return Promise.race([
      webContents.executeJavaScript(script) as Promise<T>,
      new Promise<T | null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ])
  }

  completeWithSuccess(
    credentials: Record<string, string>,
    accountInfo?: InAppLoginResult['accountInfo'],
  ): void {
    this.complete({
      success: true,
      credentials,
      accountInfo,
    })
  }

  private complete(result: InAppLoginResult): void {
    if (this.isCompleted) return
    this.isCompleted = true

    if (this.timeoutId) {
      clearTimeout(this.timeoutId)
      this.timeoutId = null
    }

    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.close()
    }

    this.cleanup()

    if (this.resolvePromise) {
      this.resolvePromise(result)
      this.resolvePromise = null
    }

    this.emit('complete', result)
  }

  private cleanup(): void {
    if (this.registerFailTimer) {
      clearTimeout(this.registerFailTimer)
      this.registerFailTimer = null
    }

    if (this.loginSession) {
      try {
        this.loginSession.webRequest.onBeforeSendHeaders(() => {})
        this.loginSession.webRequest.onBeforeRequest(() => {})
        this.loginSession.webRequest.onHeadersReceived(() => {})
        this.loginSession.cookies.removeAllListeners()
      } catch (error) {
        console.error('[InAppLogin] Error cleaning up session:', error)
      }
      this.loginSession = null
    }

    this.loginWindow = null
    this.config = null
    this.loadRetryCount = 0
  }

  cancel(): void {
    if (!this.isCompleted) {
      this.complete({
        success: false,
        error: 'Login cancelled by user',
      })
    }
  }

  isWindowOpen(): boolean {
    return this.loginWindow !== null && !this.loginWindow.isDestroyed()
  }

  destroy(): void {
    this.cancel()
    this.removeAllListeners()
  }
}

export const inAppLoginManager = new InAppLoginManager()

export default InAppLoginManager
