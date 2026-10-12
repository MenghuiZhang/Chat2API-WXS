/**
 * Shared puzzle-slider (Aliyun puzzle captcha) solver.
 *
 * The same puzzle captcha ("访问验证 / 拖动滑块完成拼图") can appear both on
 * the risk-control punish page (see proxy/captchaWindow.ts) and inline on
 * the chat.qwen.ai register/login pages (see oauth/qwenRegister.ts). This
 * module probes any WebContents for the puzzle background + drag handle,
 * recognizes the gap through Geepass and drags the handle with a human-like
 * trajectory. Callers supply their own "solved" verification when the host
 * page has a specific success signal.
 */

import type { WebContents, WebFrameMain } from 'electron'
import { isGeepassEnabled, recognizeSlide } from './geepass'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface PuzzleGeometry {
  /** Drag handle center in main-frame viewport coordinates */
  x: number
  y: number
  handleWidth: number
  /** Full draggable track width in DOM pixels */
  trackWidth: number
  /** Background canvas/img width in DOM pixels */
  bgWidth: number
  /** Background image natural (pixel) width as submitted to Geepass */
  bgNaturalWidth: number
  /** Base64 of the background image (no data: prefix) */
  bgImage: string
  /** Base64 of the puzzle-piece/slider image (no data: prefix), if present */
  slideImage?: string
  /** Background left edge X in main-frame viewport coordinates */
  bgOffsetX: number
}

/**
 * Probe for the Aliyun punish puzzle slider inside one frame: a background
 * image/canvas with a gap plus a drag handle. Extracts both images as base64
 * so the main process can send them to Geepass for gap recognition.
 */
export function puzzleProbeScript(): string {
  return `
    (() => {
      // Candidate drag handles for the Aliyun puzzle slider.
      const handleSelectors = [
        '.nc-lang-cnt [class*="btn_slide"]',
        '[class*="slidetounlock"] [class*="btn"]',
        '.btn_slide',
        '[id^="nc_"][id$="_n1z"]',
        '.nc_iconfont.btn_slide',
        '[class*="slide-btn"]',
        '[class*="slider-btn"]',
        '[class*="drag"]',
      ];
      let handle = null;
      for (const s of handleSelectors) {
        const el = document.querySelector(s);
        if (el) { const b = el.getBoundingClientRect(); if (b.width >= 5 && b.height >= 5) { handle = el; break; } }
      }
      if (!handle) return null;

      // Locate the puzzle background: canvas or img near the handle.
      let bg = null;
      const canvases = Array.from(document.querySelectorAll('canvas'));
      for (const c of canvases) {
        const b = c.getBoundingClientRect();
        if (b.width > 100 && b.height > 60) { bg = c; break; }
      }
      if (!bg) {
        const imgs = Array.from(document.querySelectorAll('img'));
        for (const im of imgs) {
          const b = im.getBoundingClientRect();
          if (b.width > 100 && b.height > 60 && (b.width / b.height) > 1.5) { bg = im; break; }
        }
      }
      if (!bg) return null;

      const hb = handle.getBoundingClientRect();
      const bgb = bg.getBoundingClientRect();
      const track = handle.closest('.slidetounlock, .nc-lang-cnt, [class*="track"]') || handle.parentElement;
      const tb = track ? track.getBoundingClientRect() : bgb;

      // Extract base64 images. Geepass requires width/height within
      // [50, 1024], so downscale (or upscale tiny pieces) to fit and report
      // the SUBMITTED width so the main process can scale coordinates back.
      const MAXD = 1024, MIND = 50;
      const fitScale = (w, h) => {
        let s = Math.min(MAXD / w, MAXD / h, 1);
        const sMin = Math.max(MIND / w, MIND / h);
        if (s < sMin) s = sMin;
        return s;
      };
      const grab = (el, natW, natH, scaleOverride) => {
        const s = scaleOverride || fitScale(natW, natH);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(natW * s));
        c.height = Math.max(1, Math.round(natH * s));
        c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
        return { b64: c.toDataURL('image/png').split(',')[1] || '', w: c.width };
      };

      let bgImage = '';
      let bgSubmittedWidth = 0;
      let bgScale = 1;
      try {
        const natW = bg.tagName === 'CANVAS' ? bg.width : (bg.naturalWidth || bgb.width);
        const natH = bg.tagName === 'CANVAS' ? bg.height : (bg.naturalHeight || bgb.height);
        bgScale = fitScale(natW, natH);
        const g = grab(bg, natW, natH, bgScale);
        bgImage = g.b64;
        bgSubmittedWidth = g.w;
      } catch (e) { return null; }
      if (!bgImage || bgImage.length < 100) return null;

      // Optional small puzzle-piece image (second image for type 20111).
      // Use the SAME scale as the background so Geepass can match them.
      let slideImage = '';
      const allImgs = Array.from(document.querySelectorAll('img'));
      for (const im of allImgs) {
        const b = im.getBoundingClientRect();
        if (b.width > 10 && b.width < 120 && b.height > 10 && b.height < 120 && im !== bg) {
          try {
            const g2 = grab(im, im.naturalWidth || b.width, im.naturalHeight || b.height, bgScale);
            if (g2.b64.length > 100) { slideImage = g2.b64; break; }
          } catch (e) { /* tainted; skip */ }
        }
      }

      return {
        x: hb.x + hb.width / 2,
        y: hb.y + hb.height / 2,
        handleWidth: hb.width,
        trackWidth: tb.width,
        bgWidth: bgb.width,
        bgNaturalWidth: bgSubmittedWidth,
        bgOffsetX: bgb.x,
        bgImage,
        slideImage: slideImage || undefined,
      };
    })()
  `
}

/** Locate the puzzle slider across all frames of the given webContents. */
export async function locatePuzzle(wc: WebContents): Promise<PuzzleGeometry | null> {
  if (wc.isDestroyed()) return null
  const visited = new Set<string>()

  const walk = async (frame: WebFrameMain, offsetX: number, offsetY: number): Promise<PuzzleGeometry | null> => {
    const key = `${frame.processId}:${frame.routingId}`
    if (visited.has(key)) return null
    visited.add(key)

    try {
      const geo = await frame.executeJavaScript(puzzleProbeScript())
      if (geo && typeof geo.x === 'number' && geo.bgImage) {
        return { ...geo, x: geo.x + offsetX, y: geo.y + offsetY, bgOffsetX: geo.bgOffsetX + offsetX }
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

  return walk(wc.mainFrame, 0, 0)
}

/**
 * Generate a human-like drag trajectory: cubic ease-out toward the end,
 * slight overshoot past the target then small corrections back, with
 * y-axis jitter. NoCaptcha scores the movement curve, so straight-line
 * constant-speed drags are rejected.
 */
export function humanTrajectory(distance: number): Array<{ dx: number; dy: number }> {
  const points: Array<{ dx: number; dy: number }> = []
  const steps = 45 + Math.floor(Math.random() * 30)
  const overshoot = Math.min(12, 3 + Math.random() * 5 + distance * 0.015)
  let yDrift = 0

  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const eased = 1 - Math.pow(1 - t, 3)
    const dx = eased * (distance + overshoot)
    yDrift += (Math.random() - 0.5) * 0.9
    yDrift = Math.max(-2.5, Math.min(2.5, yDrift))
    points.push({ dx, dy: yDrift })
  }

  // Correct back from the overshoot in a few small moves.
  const corrSteps = 4 + Math.floor(Math.random() * 4)
  for (let i = 1; i <= corrSteps; i++) {
    const t = i / corrSteps
    points.push({
      dx: distance + overshoot * (1 - t) + (Math.random() - 0.5) * 0.6,
      dy: yDrift * (1 - t),
    })
  }
  points.push({ dx: distance, dy: 0 })
  return points
}

/** Drag a slider handle with synthetic-but-trusted input events. */
export async function dragHandle(
  wc: WebContents,
  geo: { x: number; y: number; handleWidth: number; trackWidth: number },
  distanceOverride?: number,
): Promise<void> {
  const distance = Math.max(
    20,
    distanceOverride != null
      ? Math.round(distanceOverride)
      : geo.trackWidth - geo.handleWidth - 1,
  )
  const startX = Math.round(geo.x)
  const startY = Math.round(geo.y)

  // Approach the handle first, then press down after a short dwell.
  wc.sendInputEvent({ type: 'mouseMove', x: startX, y: startY + 30, clickCount: 0 })
  await sleep(80 + Math.random() * 120)
  wc.sendInputEvent({ type: 'mouseMove', x: startX, y: startY, clickCount: 0 })
  await sleep(120 + Math.random() * 200)
  wc.sendInputEvent({ type: 'mouseDown', x: startX, y: startY, button: 'left', clickCount: 1 })
  await sleep(60 + Math.random() * 120)

  const trajectory = humanTrajectory(distance)
  for (let i = 0; i < trajectory.length; i++) {
    if (wc.isDestroyed()) return
    const { dx, dy } = trajectory[i]
    wc.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(startX + dx),
      y: Math.round(startY + dy),
      clickCount: 0,
    })
    // Variable cadence with occasional micro-pauses.
    await sleep(6 + Math.random() * 14)
    if (Math.random() < 0.04) await sleep(40 + Math.random() * 60)
  }

  // Hold briefly at the end before releasing (humans don't snap-release).
  await sleep(80 + Math.random() * 150)
  wc.sendInputEvent({
    type: 'mouseUp',
    x: Math.round(startX + distance),
    y: startY,
    button: 'left',
    clickCount: 1,
  })
}

export interface SolvePuzzleOptions {
  /** Progress messages (shown in the host UI / registration status). */
  onStatus?: (message: string) => void
  /** Custom "solved?" check run after each drag (host-page specific). */
  verifySolved?: () => Promise<boolean>
  /** Drag attempts before giving up (default 2). */
  maxAttempts?: number
}

/**
 * Solve a puzzle-slider captcha on the given webContents via Geepass.
 * Returns false immediately when Geepass is disabled or no puzzle is
 * present, so callers can poll it cheaply while waiting for page state.
 */
export async function solvePuzzle(wc: WebContents, options: SolvePuzzleOptions = {}): Promise<boolean> {
  if (!isGeepassEnabled() || wc.isDestroyed()) return false
  const geo = await locatePuzzle(wc)
  if (!geo || !geo.bgImage) return false

  const onStatus = options.onStatus || (() => {})
  onStatus('检测到拼图验证，Geepass 正在识别缺口…')

  let result
  try {
    result = await recognizeSlide({
      bgImage: geo.bgImage,
      slideImage: geo.slideImage,
      type: geo.slideImage ? 20111 : 20110,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.warn('[PuzzleSolver] Geepass recognition failed:', msg)
    onStatus(`Geepass 识别失败: ${msg}`)
    return false
  }

  // Scale the recognized gap X (submitted image pixels) to DOM pixels; the
  // handle starts at the left edge, grip centered on the gap.
  const scale = geo.bgNaturalWidth > 0 ? geo.bgWidth / geo.bgNaturalWidth : 1
  const distance = result.x * scale - geo.handleWidth / 2
  if (!Number.isFinite(distance) || distance < 5) {
    console.warn('[PuzzleSolver] Implausible distance', distance, 'result', result)
    onStatus('Geepass 识别结果异常，请手动拖动滑块')
    return false
  }
  console.log(`[PuzzleSolver] gap x=${result.x} scale=${scale.toFixed(3)} distance=${distance.toFixed(1)}`)
  onStatus('Geepass 识别成功，正在拖动滑块…')

  const defaultVerify = async (): Promise<boolean> => {
    await sleep(1800 + Math.random() * 700)
    if (wc.isDestroyed()) return true
    // Puzzle gone (modal dismissed / page navigated) means solved.
    if (!(await locatePuzzle(wc))) return true
    try {
      const body = await wc.executeJavaScript(`document.body ? (document.body.innerText || '') : ''`)
      return /验证成功|验证通过|校验成功|验证已完成/.test(String(body || ''))
    } catch {
      return false
    }
  }
  const verify = options.verifySolved || defaultVerify
  const maxAttempts = options.maxAttempts ?? 2

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (wc.isDestroyed()) return false
    const fresh = (await locatePuzzle(wc)) || geo
    // Gap may have refreshed after a failed attempt; re-recognize.
    let d = distance
    if (attempt > 1 && fresh.bgImage && fresh.bgImage !== geo.bgImage) {
      try {
        const r2 = await recognizeSlide({
          bgImage: fresh.bgImage,
          slideImage: fresh.slideImage,
          type: fresh.slideImage ? 20111 : 20110,
        })
        const scale2 = fresh.bgNaturalWidth > 0 ? fresh.bgWidth / fresh.bgNaturalWidth : 1
        const d2 = r2.x * scale2 - fresh.handleWidth / 2
        if (Number.isFinite(d2) && d2 >= 5) d = d2
      } catch (error) {
        console.warn('[PuzzleSolver] Retry recognition failed:', error)
      }
    }
    await sleep(300 + Math.random() * 400)
    await dragHandle(wc, fresh, d)
    if (await verify()) {
      console.log('[PuzzleSolver] Puzzle solved')
      onStatus('拼图验证通过')
      return true
    }
  }

  onStatus('Geepass 自动验证未通过，请手动拖动滑块')
  return false
}
