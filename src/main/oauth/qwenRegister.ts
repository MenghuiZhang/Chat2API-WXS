/**
 * Qwen AI (chat.qwen.ai) automatic account registration.
 *
 * Flow:
 *  1. Obtain a temporary mailbox via the Cloudflare Temp Email admin API,
 *     preferring to reuse an existing chat2api* address that is not yet
 *     bound to a stored account; a new one is only created when none is free.
 *  2. Open the in-app login window at https://chat.qwen.ai/auth?mode=register.
 *  3. Fill the temp address into the register form and submit.
 *  4. Poll the temp mailbox for the 6-digit verification code email.
 *  5. Fill the code digits; the form auto-submits and logs the new account in.
 *  6. The regular InAppLoginManager token capture then picks up the JWT from
 *     localStorage, and OAuthManager validates + saves the account as usual.
 */

import { WebContents } from 'electron'
import {
  createTempAddress,
  getOrCreateTempAddress,
  waitForVerificationCode,
} from './tempMail'
import { solvePuzzle, startPuzzleWatcher } from '../lib/puzzleSolver'

export const QWEN_REGISTER_URL = 'https://chat.qwen.ai/auth?mode=register'
const REGISTER_URL = QWEN_REGISTER_URL

export interface QwenRegisterDeps {
  webContents: WebContents
  emitStatus: (message: string) => void
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function wcAlive(wc: WebContents): boolean {
  return !wc.isDestroyed()
}

async function exec<T>(wc: WebContents, script: string, timeoutMs = 8000): Promise<T | null> {
  if (!wcAlive(wc)) return null
  return Promise.race([
    wc.executeJavaScript(script) as Promise<T | null>,
    new Promise<T | null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ])
}

/**
 * Poll the page until the given JS predicate expression returns true.
 */
async function waitForCondition(
  wc: WebContents,
  predicateJs: string,
  timeoutMs: number,
  pollMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!wcAlive(wc)) return false
    const ok = await exec<boolean>(wc, `(function(){ try { return !!(${predicateJs}) } catch(e) { return false } })()`, 5000)
    if (ok) return true
    await sleep(pollMs)
  }
  return false
}

/**
 * Poll the page until the given JS predicate returns true, while watching for
 * the inline puzzle captcha (“访问验证 / 拖动滑块完成拼图”) that Qwen may pop
 * up during registration. When the puzzle appears and Geepass is enabled it
 * is solved automatically; the wait continues until the condition holds or
 * the timeout expires. solvePuzzle returns false fast when Geepass is off or
 * no puzzle is present, so polling overhead stays small.
 */
async function waitForConditionWithPuzzle(
  wc: WebContents,
  predicateJs: string,
  timeoutMs: number,
  emitStatus: (message: string) => void,
  pollMs = 600,
): Promise<boolean> {
  const checkJs = `(function(){ try { return !!(${predicateJs}) } catch(e) { return false } })()`
  const deadline = Date.now() + timeoutMs
  let lastPuzzleAttempt = 0
  while (Date.now() < deadline) {
    if (!wcAlive(wc)) return false
    const ok = await exec<boolean>(wc, checkJs, 5000)
    if (ok) return true

    // Throttled puzzle attempt (solvePuzzle itself takes several seconds
    // when a puzzle is present, so the throttle mainly avoids probe spam).
    const now = Date.now()
    if (now - lastPuzzleAttempt > 4000) {
      lastPuzzleAttempt = now
      const solved = await solvePuzzle(wc, {
        onStatus: emitStatus,
        verifySolved: async () => (await exec<boolean>(wc, checkJs, 5000)) === true,
      })
      if (solved) continue // re-check the condition immediately
    }
    await sleep(pollMs)
  }
  return false
}

const EMAIL_INPUT_JS = `
  (function() {
    const inputs = Array.from(document.querySelectorAll('input'))
    return inputs.find(function(i) {
      if (i.type === 'hidden') return false
      const label = (i.getAttribute('aria-label') || '') + ' ' + (i.placeholder || '')
      return i.type === 'email' || /邮箱|email/i.test(label)
    }) || null
  })()
`

const CONTINUE_BUTTON_JS = `
  (function() {
    const buttons = Array.from(document.querySelectorAll('button'))
    return buttons.find(function(b) {
      const text = (b.textContent || '').trim()
      return /继续|Continue/i.test(text) && !b.disabled
    }) || null
  })()
`

const DIGIT_INPUTS_JS = `document.querySelectorAll('input[aria-label^="Verification code digit"], input[inputmode="numeric"][maxlength="1"]')`

function fillNativeValueJs(value: string): string {
  return `
    (function() {
      const input = ${EMAIL_INPUT_JS};
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      input.focus();
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `
}

function fillDigitsJs(code: string): string {
  return `
    (function() {
      const inputs = Array.from(${DIGIT_INPUTS_JS});
      if (inputs.length < ${code.length}) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const code = ${JSON.stringify(code)};
      for (let i = 0; i < code.length; i++) {
        const input = inputs[i];
        input.focus();
        setter.call(input, code[i]);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: code[i] }));
      }
      return true;
    })()
  `
}

/**
 * Best-effort dismissal of the "please confirm your age" dialog that may
 * appear right after the first login of a new account. The token is already
 * in localStorage at this point, so this is cosmetic but keeps the window
 * usable if the user takes over manually.
 */
async function dismissAgeDialog(wc: WebContents): Promise<void> {
  const hasDialog = await waitForCondition(
    wc,
    `Array.from(document.querySelectorAll('[role="dialog"], dialog')).some(function(d) { return /年龄|age/i.test(d.textContent || '') })`,
    8000,
    500,
  )
  if (!hasDialog) return

  await exec(
    wc,
    `
    (function() {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], dialog'))
      const dialog = dialogs.find(function(d) { return /年龄|age/i.test(d.textContent || '') })
      if (!dialog) return false
      // Pick a birth year if there is a select
      const select = dialog.querySelector('select')
      if (select) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
        const option = Array.from(select.options).find(function(o) { return /^(19|20)\\d\\d$/.test(o.value) })
        if (option) {
          setter.call(select, option.value)
          select.dispatchEvent(new Event('change', { bubbles: true }))
        }
      }
      const buttons = Array.from(dialog.querySelectorAll('button'))
      const continueBtn = buttons.find(function(b) { return /继续|Continue|Confirm/i.test((b.textContent || '').trim()) && !b.disabled })
      if (continueBtn) { continueBtn.click(); return true }
      return false
    })()
    `,
    5000,
  )
}

/**
 * Fill the email input with `address`, submit it, then wait for the 6-digit
 * code inputs to appear — their presence confirms Qwen accepted the address
 * and sent the verification mail.
 *
 * Returns false when the address was rejected (already registered, rate
 * limited, blocked domain, ...). Throws on page-level failures.
 */
async function submitEmailForCode(
  wc: WebContents,
  address: string,
  emitStatus: (message: string) => void,
): Promise<boolean> {
  // Always start from a clean register page: a previously rejected attempt
  // can leave the form in an error state where refilling does nothing.
  const currentUrl = wcAlive(wc) ? wc.getURL() : ''
  if (!currentUrl.includes('mode=register')) {
    emitStatus('正在打开注册页面...')
    await wc.loadURL(REGISTER_URL)
  }

  emitStatus('正在填写邮箱...')
  const emailReady = await waitForCondition(wc, EMAIL_INPUT_JS, 30000)
  if (!emailReady) {
    throw new Error('注册页面加载失败：未找到邮箱输入框')
  }
  const filled = await exec<boolean>(wc, fillNativeValueJs(address))
  if (!filled) {
    throw new Error('无法填写邮箱输入框')
  }
  await sleep(300)

  // Click 继续 to send the verification code.
  const continueReady = await waitForCondition(wc, CONTINUE_BUTTON_JS, 10000)
  if (!continueReady) {
    throw new Error('未找到可用的「继续」按钮')
  }
  emitStatus('正在提交邮箱，等待验证码邮件...')
  await exec<boolean>(wc, `(function(){ const b = ${CONTINUE_BUTTON_JS}; if (b) { b.click(); return true } return false })()`)

  // The inline puzzle captcha often guards this exact transition; allow
  // extra time because Geepass recognition + drag adds several seconds, and
  // a failed attempt refreshes the puzzle for a brand-new image — the whole
  // wait must survive several solve/refresh cycles instead of throwing while
  // the solver is still making progress ("换图后不接着认证" complaint).
  return waitForConditionWithPuzzle(
    wc,
    `${DIGIT_INPUTS_JS}.length >= 6`,
    150000,
    emitStatus,
  )
}

/**
 * Run the full registration automation inside the already-open login window.
 * Throws on unrecoverable failures; the caller keeps the window open so the
 * user can finish manually.
 */
async function runQwenRegistrationInner(deps: QwenRegisterDeps): Promise<{ address: string }> {
  const { webContents: wc, emitStatus } = deps

  // 1. Obtain the temp mailbox first so `sinceTs` predates the code email.
  //    Prefer reusing an existing chat2api* address that is not yet bound
  //    to any stored account; only create a new one when none is free.
  emitStatus('正在获取临时邮箱...')
  let temp = await getOrCreateTempAddress()
  console.log(`[QwenRegister] Temp address ${temp.reused ? 'reused' : 'created'}:`, temp.address)
  emitStatus(`${temp.reused ? '复用临时邮箱' : '临时邮箱'}: ${temp.address}`)
  let sinceTs = Date.now() - 5000

  // 2-5. Fill the address and submit it, waiting for the code inputs.
  let digitsReady = await submitEmailForCode(wc, temp.address, emitStatus)

  // A reused mailbox may already be registered on Qwen's side even though
  // no stored account references it (e.g. the account was deleted). Fall
  // back to a brand-new address once before giving up.
  if (!digitsReady && temp.reused) {
    console.warn('[QwenRegister] Reused address was rejected, creating a new one:', temp.address)
    emitStatus('复用的邮箱可能已被注册，正在新建邮箱重试...')
    temp = { ...(await createTempAddress()), reused: false }
    console.log('[QwenRegister] Temp address created:', temp.address)
    emitStatus(`临时邮箱: ${temp.address}`)
    sinceTs = Date.now() - 5000
    digitsReady = await submitEmailForCode(wc, temp.address, emitStatus)
  }

  if (!digitsReady) {
    // The page may show an error (e.g. address rejected / rate limit)
    throw new Error('提交邮箱后未出现验证码输入框，注册可能被拒绝')
  }

  // 6. Poll the temp mailbox for the code (5 min validity, usually < 30s).
  emitStatus('正在等待验证码邮件...')
  const code = await waitForVerificationCode(temp.address, {
    sinceTs,
    timeoutMs: 180_000,
    pollMs: 4000,
    onPoll: (attempt) => {
      if (attempt % 3 === 0) emitStatus(`正在等待验证码邮件... (${attempt * 4}s)`)
    },
  })
  console.log('[QwenRegister] Verification code received:', code)
  emitStatus('已获取验证码，正在填写...')

  // 7. Fill the code digits (form auto-submits when complete).
  const digitsFilled = await exec<boolean>(wc, fillDigitsJs(code))
  if (!digitsFilled) {
    throw new Error('无法填写验证码输入框')
  }

  // 8. If auto-submit did not happen, click 继续 explicitly.
  await sleep(1500)
  const stillOnAuth = await exec<boolean>(
    wc,
    `location.pathname.indexOf('/auth') >= 0`,
  )
  if (stillOnAuth) {
    await exec<boolean>(wc, `(function(){ const b = ${CONTINUE_BUTTON_JS}; if (b) { b.click(); return true } return false })()`)
  }

  // 9. Wait for the registration to be accepted. Once the code is verified
  //    the page navigates away from /auth, and the regular token
  //    interception in InAppLoginManager captures the JWT and completes the
  //    login (which closes the window). Any of these signals means success.
  //    We deliberately do NOT poll localStorage for the token here, because
  //    completeWithSuccess typically closes the window first, which would
  //    make such a check fail spuriously.
  emitStatus('注册成功，正在等待登录完成...')
  const deadline = Date.now() + 60000
  let accepted = false
  while (Date.now() < deadline) {
    if (!wcAlive(wc)) {
      accepted = true // window closed => login already completed
      break
    }
    const onAuth = await exec<boolean>(wc, `location.pathname.indexOf('/auth') >= 0`)
    if (onAuth === null) {
      accepted = true // webContents destroyed => login already completed
      break
    }
    if (!onAuth) {
      accepted = true // navigated away from the auth page
      break
    }
    // A puzzle captcha may also guard the final submit; the global watcher
    // started in runQwenRegistration solves it inline while we poll here.
    await sleep(1000)
  }

  // Best-effort: dismiss the age-confirmation dialog (cosmetic — the token
  // has already been captured by the regular interception at this point).
  if (wcAlive(wc)) {
    void dismissAgeDialog(wc)
  }

  if (!accepted) {
    throw new Error('验证码已提交，但页面未跳转（可在窗口中手动完成）')
  }

  return { address: temp.address }
}

/**
 * Public entry: runs the registration automation while a global puzzle
 * watcher guards the window for the whole flow — the captcha can pop up at
 * any step (initial form, address submit, code submit), not only inside the
 * two wait loops.
 *
 * Watcher lifetime: it is stopped on SUCCESS (the token is captured and the
 * window closes). On FAILURE the login window is deliberately left open so
 * the user can finish manually — and a fresh puzzle image very often appears
 * right after a failed attempt. Stopping the watcher there is what caused
 * "验证失败重新出了验证图不会接着认证" (the new puzzle sat unattended). We now
 * KEEP the watcher running on failure so it keeps solving any new puzzle; it
 * auto-stops when the window is destroyed.
 */
export async function runQwenRegistration(deps: QwenRegisterDeps): Promise<{ address: string }> {
  const stopWatcher = startPuzzleWatcher(deps.webContents, deps.emitStatus)
  try {
    const result = await runQwenRegistrationInner(deps)
    stopWatcher()
    return result
  } catch (error) {
    console.warn(
      '[QwenRegister] flow failed; keeping puzzle watcher active so the window keeps auto-solving new captchas:',
      error instanceof Error ? error.message : error,
    )
    throw error
  }
}
