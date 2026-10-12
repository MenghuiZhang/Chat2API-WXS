/**
 * Qwen AI risk-control (Aliyun Baxia WAF) captcha helper.
 *
 * When chat.qwen.ai returns the WAF punish payload
 * ({"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::..."],"data":{"url":"...punish..."}})
 * the only way to unblock the session is to solve the slider captcha in a real
 * browser context. This module opens a small BrowserWindow (persistent
 * partition) seeded with the account cookies, loads the punish URL, waits for
 * the user to slide, then harvests the refreshed cookies (including the WAF
 * trust cookies) and persists them back into the account credentials so the
 * pending request can be retried automatically.
 */

import { BrowserWindow, session } from 'electron'
import type { Session, WebFrameMain } from 'electron'
import { AccountManager } from '../store/accounts'
import { normalizeCookies } from '../lib/qwenAiAuth'
import { isGeepassEnabled } from '../lib/geepass'
import { dragHandle, locatePuzzle, solvePuzzle } from '../lib/puzzleSolver'
import { applySessionProxy } from '../lib/clashProxy'

const PARTITION = 'persist:qwen-ai-captcha'
const PUNISH_URL_RE = /_____tmd_____|\bpunish\b/

/** One pending captcha window per account to avoid duplicates. */
const pending = new Map<string, Promise<string | null>>()

/**
 * Open the captcha verification window for an account.
 * Resolves with the merged cookie string when the user completed the
 * verification, or null when the window was closed without solving it.
 */
export function openQwenAiCaptchaWindow(accountId: string, punishUrl?: string): Promise<string | null> {
  const existing = pending.get(accountId)
  if (existing) return existing
  const promise = runCaptchaWindow(accountId, punishUrl || '').finally(() => {
    pending.delete(accountId)
  })
  pending.set(accountId, promise)
  return promise
}

async function runCaptchaWindow(accountId: string, punishUrl: string): Promise<string | null> {
  const account = AccountManager.getById(accountId, true)
  if (!account) {
    console.warn('[QwenCaptcha] Account not found:', accountId)
    return null
  }

  const sess = session.fromPartition(PARTITION)
  // Route the captcha window through the configured upstream proxy (Clash etc.)
  // so the verification happens from the same egress IP as the API requests.
  try {
    await applySessionProxy(sess)
  } catch (error) {
    console.warn('[QwenCaptcha] Failed to apply upstream proxy:', error)
  }
  // Legacy in-app-login accounts may store cookies as a name -> value object;
  // normalize to a Cookie header string before seeding/merging.
  const existingCookies = normalizeCookies(
    (account.credentials as Record<string, unknown>).cookies ??
      (account.credentials as Record<string, unknown>).cookie
  )
  await seedCookies(sess, existingCookies)

  const win = new BrowserWindow({
    width: 560,
    height: 720,
    title: 'Qwen AI 风控验证',
    autoHideMenuBar: true,
    webPreferences: {
      session: sess,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  return new Promise<string | null>((resolve) => {
    let settled = false
    let pollTimer: NodeJS.Timeout | undefined
    let autoSlideRunning = false
    let autoSlideAttempted = false

    const triggerAutoSlide = () => {
      if (autoSlideRunning || settled || win.isDestroyed()) return
      autoSlideRunning = true
      attemptAutoSlide(win)
        .then((ok) => {
          if (!ok && !settled && !win.isDestroyed()) {
            void setBarStatus(win, '自动滑动未通过，请手动完成滑块后点击下方绿色按钮')
          }
        })
        .catch((error) => {
          console.error('[QwenCaptcha] Auto slide error:', error)
        })
        .finally(() => {
          autoSlideRunning = false
        })
    }

    const finish = async (solved: boolean) => {
      if (settled) return
      settled = true
      if (pollTimer) clearInterval(pollTimer)
      let merged: string | null = null
      if (solved) {
        merged = await collectAndMergeCookies(sess, existingCookies)
        if (merged) {
          try {
            AccountManager.update(accountId, {
              credentials: { ...account.credentials, cookies: merged },
            })
            console.log('[QwenCaptcha] Cookies refreshed for account', accountId)
          } catch (error) {
            console.error('[QwenCaptcha] Failed to persist refreshed cookies:', error)
          }
        } else {
          console.warn('[QwenCaptcha] Verification reported solved but no cookies collected')
        }
      }
      if (!win.isDestroyed()) win.close()
      resolve(merged)
    }

    const targetUrl = punishUrl || 'https://chat.qwen.ai'
    const startedWithPunish = PUNISH_URL_RE.test(targetUrl)

    // A redirect away from the punish flow means the captcha was accepted.
    win.webContents.on('did-navigate', (_event, url) => {
      if (startedWithPunish && !PUNISH_URL_RE.test(url)) {
        console.log('[QwenCaptcha] Redirected away from punish page, treating as solved:', url)
        void finish(true)
      }
    })

    win.webContents.on('did-fail-load', (_event, code, desc, url, isMainFrame) => {
      if (isMainFrame && url === targetUrl) {
        console.warn('[QwenCaptcha] Failed to load punish url, falling back to chat page:', code, desc)
        win.loadURL('https://chat.qwen.ai').catch(() => {})
      }
    })

    win.webContents.on('dom-ready', () => {
      win.webContents.executeJavaScript(injectConfirmBarScript()).catch(() => {})
      // First automatic attempt shortly after the captcha page is ready.
      if (!autoSlideAttempted) {
        autoSlideAttempted = true
        setTimeout(triggerAutoSlide, 2000 + Math.floor(Math.random() * 1500))
      }
    })

    win.on('closed', () => {
      void finish(false)
    })

    pollTimer = setInterval(() => {
      if (settled || win.isDestroyed()) return
      win.webContents
        .executeJavaScript(pollStateScript())
        .then(
          (state: {
            done?: boolean
            hasSlider?: boolean
            successText?: boolean
            autoRequested?: boolean
          }) => {
            if (state?.done) {
              void finish(true)
            } else if (state?.successText && state?.hasSlider === false) {
              void finish(true)
            } else if (state?.autoRequested) {
              triggerAutoSlide()
            }
          }
        )
        .catch(() => {
          // Page is navigating; ignore.
        })
    }, 1200)

    win.loadURL(targetUrl).catch((error) => {
      console.error('[QwenCaptcha] loadURL error:', error)
      void finish(false)
    })
  })
}

/** Seed the captcha window session with the account's stored cookies. */
async function seedCookies(sess: Session, cookieStr: string): Promise<void> {
  if (!cookieStr) return
  for (const part of cookieStr.split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const name = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (!name) continue
    try {
      await sess.cookies.set({ url: 'https://chat.qwen.ai', name, value })
    } catch {
      // Ignore individual cookie failures (expired/invalid names).
    }
  }
}

/** Collect qwen.ai cookies from the window session and merge over the old set. */
async function collectAndMergeCookies(sess: Session, existing: string): Promise<string | null> {
  const all = await sess.cookies.get({})
  const relevant = all.filter((cookie) => {
    const domain = (cookie.domain || '').replace(/^\./, '')
    return domain === 'qwen.ai' || domain.endsWith('qwen.ai')
  })
  if (relevant.length === 0) return null

  const map = new Map<string, string>()
  for (const part of existing.split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    map.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim())
  }
  for (const cookie of relevant) {
    map.set(cookie.name, cookie.value)
  }
  return Array.from(map.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

/** Floating control bar: auto-slide button + manual "done" confirmation. */
function injectConfirmBarScript(): string {
  return `
    (() => {
      if (document.getElementById('__captcha_done_bar')) return true;
      if (!document.body) return false;
      const bar = document.createElement('div');
      bar.id = '__captcha_done_bar';
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#16a34a;color:#fff;padding:10px 16px;font:14px/1.5 system-ui,sans-serif;display:flex;align-items:center;gap:12px;box-shadow:0 -2px 8px rgba(0,0,0,.25)';
      const status = document.createElement('span');
      status.style.cssText = 'flex:1;text-align:center;';
      status.textContent = '正在尝试自动滑动…也可手动拖动滑块';
      const autoBtn = document.createElement('button');
      autoBtn.textContent = '自动滑动';
      autoBtn.style.cssText = 'background:#fff;color:#16a34a;border:none;border-radius:6px;padding:6px 14px;font:14px system-ui,sans-serif;cursor:pointer;font-weight:600;';
      autoBtn.addEventListener('click', () => {
        window.__CAPTCHA_AUTO__ = true;
        status.textContent = '正在尝试自动滑动…';
      });
      const doneBtn = document.createElement('button');
      doneBtn.textContent = '完成，返回应用';
      doneBtn.style.cssText = autoBtn.style.cssText;
      doneBtn.addEventListener('click', () => {
        window.__CAPTCHA_DONE__ = true;
        status.textContent = '已收到，正在关闭窗口…';
      });
      window.__setBarStatus = (msg) => { status.textContent = msg; };
      bar.appendChild(autoBtn);
      bar.appendChild(status);
      bar.appendChild(doneBtn);
      document.body.appendChild(bar);
      return true;
    })()
  `
}

/** Poll slider presence / success text / user confirmation + auto-slide flags. */
function pollStateScript(): string {
  return `
    (() => {
      const hasSlider = !!document.querySelector('#nc_1_n1z, #nocaptcha, .nc-container, .scale_text2, [id^="nc_"], iframe[src*="punish"]');
      const body = document.body ? (document.body.innerText || '') : '';
      const successText = /验证成功|验证通过|校验成功|验证已完成/.test(body);
      let autoRequested = false;
      if (window.__CAPTCHA_AUTO__) { autoRequested = true; window.__CAPTCHA_AUTO__ = false; }
      return { done: window.__CAPTCHA_DONE__ === true, hasSlider, successText, autoRequested };
    })()
  `
}

// ==================== Auto slide (NoCaptcha) ====================

interface SliderGeometry {
  /** Handle center in main-frame viewport coordinates. */
  x: number
  y: number
  handleWidth: number
  trackWidth: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Probe for the NoCaptcha slider handle inside one frame. */
function sliderProbeScript(): string {
  return `
    (() => {
      const selectors = ['#nc_1_n1z', '[id^="nc_"][id$="_n1z"]', '.nc_iconfont.btn_slide', '.btn_slide'];
      let handle = null;
      for (const s of selectors) { handle = document.querySelector(s); if (handle) break; }
      if (!handle) return null;
      const hb = handle.getBoundingClientRect();
      if (hb.width < 5 || hb.height < 5) return null;
      const track = handle.closest('.slidetounlock, .nc-lang-cnt') || handle.parentElement;
      const tb = track ? track.getBoundingClientRect() : hb;
      if (tb.width < hb.width + 20) return null;
      return { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2, handleWidth: hb.width, trackWidth: tb.width };
    })()
  `
}

/**
 * Locate the slider across all frames (the punish captcha usually lives in a
 * cross-origin iframe; frameTreeNode offsets convert frame-local coordinates
 * into main-frame viewport coordinates).
 */
async function locateSlider(win: BrowserWindow): Promise<SliderGeometry | null> {
  const visited = new Set<string>()

  const walk = async (frame: WebFrameMain, offsetX: number, offsetY: number): Promise<SliderGeometry | null> => {
    const key = `${frame.processId}:${frame.routingId}`
    if (visited.has(key)) return null
    visited.add(key)

    try {
      const geo = await frame.executeJavaScript(sliderProbeScript())
      if (geo && typeof geo.x === 'number') {
        return {
          x: geo.x + offsetX,
          y: geo.y + offsetY,
          handleWidth: geo.handleWidth,
          trackWidth: geo.trackWidth,
        }
      }
    } catch {
      // Frame may be gone; continue with children.
    }

    for (const child of frame.frames) {
      const node = child.frameTreeNode
      const result = await walk(child, offsetX + (node?.offsetX || 0), offsetY + (node?.offsetY || 0))
      if (result) return result
    }
    return null
  }

  return walk(win.webContents.mainFrame, 0, 0)
}

// ==================== Puzzle captcha (Geepass) ====================
// Puzzle probing / locating / dragging now lives in lib/puzzleSolver so the
// registration flow (oauth/qwenRegister.ts) can reuse the same solver.

/**
 * Solve the puzzle slider via Geepass (shared solver): recognize the gap X
 * in background image pixels, scale to DOM pixels, and drag the handle that
 * distance. Returns true when the captcha reported success afterwards.
 */
async function attemptGeepassSolve(win: BrowserWindow): Promise<boolean> {
  return solvePuzzle(win.webContents, {
    onStatus: (msg) => void setBarStatus(win, msg),
    verifySolved: async () => {
      await sleep(1800 + Math.random() * 900)
      if (win.isDestroyed()) return true
      try {
        const state = await win.webContents.executeJavaScript(pollStateScript())
        return !!(state?.successText || state?.done)
      } catch {
        // Page navigating after success; let the poll timer decide.
        return false
      }
    },
  })
}

async function setBarStatus(win: BrowserWindow, message: string): Promise<void> {
  if (win.isDestroyed()) return
  const escaped = message.replace(/'/g, "\\'")
  try {
    await win.webContents.executeJavaScript(
      `window.__setBarStatus && window.__setBarStatus('${escaped}')`
    )
  } catch {
    // Bar not present; ignore.
  }
}

/**
 * Full auto-slide flow: wait for the slider to appear, drag it, verify via
 * the state poll script, retry up to 3 times. Returns true when the captcha
 * reported success (the poll timer then finishes the window normally).
 *
 * When Geepass is configured and a puzzle-style slider (canvas background +
 * gap) is detected, the gap position is recognized through Geepass and the
 * handle is dragged exactly to the gap instead of the NoCaptcha drag-to-end
 * heuristic (which only works for "slide all the way" captchas).
 */
async function attemptAutoSlide(win: BrowserWindow): Promise<boolean> {
  const geepassOn = isGeepassEnabled()

  // Wait up to ~20s for the slider to render.
  let geo: SliderGeometry | null = null
  let puzzleTried = false
  for (let i = 0; i < 40; i++) {
    if (win.isDestroyed()) return false

    // Puzzle branch first: the Aliyun punish page shows a canvas puzzle with
    // a gap; the NoCaptcha probe may also match its handle, so check puzzle
    // before falling back to the drag-to-end heuristic.
    if (geepassOn && !puzzleTried) {
      const puzzle = await locatePuzzle(win.webContents)
      if (puzzle) {
        puzzleTried = true
        console.log('[QwenCaptcha] Puzzle slider detected, using Geepass recognition')
        const ok = await attemptGeepassSolve(win)
        if (ok) return true
        if (win.isDestroyed()) return false
        // Fall through to the NoCaptcha heuristic below as a last resort.
        void setBarStatus(win, 'Geepass 未通过，尝试普通自动滑动…也可手动拖动')
      }
    }

    geo = await locateSlider(win)
    if (geo) break
    await sleep(500)
  }
  if (!geo) {
    console.log('[QwenCaptcha] Auto slide: slider not found')
    return false
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (win.isDestroyed()) return false
    console.log(`[QwenCaptcha] Auto slide attempt ${attempt}/3`)
    void setBarStatus(win, `正在自动滑动（第 ${attempt} 次）…`)

    await sleep(400 + Math.random() * 600)
    const fresh = attempt === 1 ? geo : (await locateSlider(win)) || geo
    await dragHandle(win.webContents, fresh)

    // Give NoCaptcha time to validate the trajectory server-side.
    await sleep(1800 + Math.random() * 1000)
    if (win.isDestroyed()) return false

    try {
      const state = await win.webContents.executeJavaScript(pollStateScript())
      if (state?.successText || state?.done) {
        console.log('[QwenCaptcha] Auto slide succeeded')
        void setBarStatus(win, '自动滑动成功，窗口即将关闭…')
        return true
      }
    } catch {
      // Page may be navigating after success; let the poll timer decide.
      return false
    }
  }

  console.log('[QwenCaptcha] Auto slide failed after 3 attempts')
  return false
}
