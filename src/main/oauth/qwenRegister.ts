/**
 * Qwen AI (chat.qwen.ai) automatic account registration.
 *
 * Flow:
 *  1. Create a temporary mailbox via the Cloudflare Temp Email admin API.
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
  waitForVerificationCode,
} from './tempMail'

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
 * Run the full registration automation inside the already-open login window.
 * Throws on unrecoverable failures; the caller keeps the window open so the
 * user can finish manually.
 */
export async function runQwenRegistration(deps: QwenRegisterDeps): Promise<{ address: string }> {
  const { webContents: wc, emitStatus } = deps

  // 1. Create the temp mailbox first so `sinceTs` predates the code email.
  emitStatus('正在创建临时邮箱...')
  const temp = await createTempAddress()
  console.log('[QwenRegister] Temp address created:', temp.address)
  emitStatus(`临时邮箱: ${temp.address}`)
  const sinceTs = Date.now() - 5000

  // 2. Navigate to the register page.
  const currentUrl = wcAlive(wc) ? wc.getURL() : ''
  if (!currentUrl.includes('mode=register')) {
    emitStatus('正在打开注册页面...')
    await wc.loadURL(REGISTER_URL)
  }

  // 3. Wait for the email input and fill it.
  emitStatus('正在填写邮箱...')
  const emailReady = await waitForCondition(wc, EMAIL_INPUT_JS, 30000)
  if (!emailReady) {
    throw new Error('注册页面加载失败：未找到邮箱输入框')
  }
  const filled = await exec<boolean>(wc, fillNativeValueJs(temp.address))
  if (!filled) {
    throw new Error('无法填写邮箱输入框')
  }
  await sleep(300)

  // 4. Click 继续 to send the verification code.
  const continueReady = await waitForCondition(wc, CONTINUE_BUTTON_JS, 10000)
  if (!continueReady) {
    throw new Error('未找到可用的「继续」按钮')
  }
  emitStatus('正在提交邮箱，等待验证码邮件...')
  await exec<boolean>(wc, `(function(){ const b = ${CONTINUE_BUTTON_JS}; if (b) { b.click(); return true } return false })()`)

  // 5. Wait for the 6 digit inputs to appear (confirms the code was sent).
  const digitsReady = await waitForCondition(wc, `${DIGIT_INPUTS_JS}.length >= 6`, 30000)
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
