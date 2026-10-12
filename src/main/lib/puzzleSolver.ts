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
  /** How the drag handle was detected (selector/text/structure) — diagnostics */
  handleFound?: string
  /** How the background bytes were obtained (canvas/dataurl/fetch) */
  bgVia?: string
}

/**
 * Probe for the Aliyun punish puzzle slider inside one frame: a background
 * image/canvas with a gap plus a drag handle. Extracts both images as base64
 * so the main process can send them to Geepass for gap recognition.
 */
export function puzzleProbeScript(): string {
  return `
    (async () => {
      const vis = (el) => {
        if (!el) return false;
        const b = el.getBoundingClientRect();
        if (b.width < 5 || b.height < 5) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };

      // --- Background candidates: landscape img/canvas --------------------
      const bgCands = Array.from(document.querySelectorAll('img, canvas')).filter((el) => {
        const b = el.getBoundingClientRect();
        return b.width >= 120 && b.height >= 60 && (b.width / b.height) > 1.4 && vis(el);
      });
      if (!bgCands.length) return { error: 'no-bg' };

      // --- 1. Known selectors ---------------------------------------------
      const handleSelectors = [
        '.nc-lang-cnt [class*="btn_slide"]',
        '[class*="slidetounlock"] [class*="btn"]',
        '.btn_slide',
        '[id^="nc_"][id$="_n1z"]',
        '.nc_iconfont.btn_slide',
        '[class*="slide-btn"]',
        '[class*="slider-btn"]',
        '[class*="slide_btn"]',
        '[class*="btn-slide"]',
        '[class*="drag"]',
      ];
      let handle = null;
      let how = 'selector';
      for (const s of handleSelectors) {
        let els = [];
        try { els = Array.from(document.querySelectorAll(s)); } catch (e) { els = []; }
        for (const el of els) { if (vis(el)) { handle = el; break; } }
        if (handle) break;
      }

      // --- 2. Text scan: the hint line sits inside / next to the track ----
      if (!handle && document.body) {
        how = 'text';
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const t = (node.nodeValue || '').trim();
          if (!t || t.length > 40) continue;
          if (!/拖动滑块|滑动完成|向右滑动|drag.*slider|slide.*complete|slide.*verify/i.test(t)) continue;
          let el = node.parentElement;
          for (let up = 0; up < 5 && el; up++) {
            const b = el.getBoundingClientRect();
            if (b.width > 120 && b.height >= 24 && b.height <= 90) {
              const kids = Array.from(el.querySelectorAll('*')).filter((c) => {
                const cb = c.getBoundingClientRect();
                return cb.width >= 18 && cb.width <= 90 && cb.height >= 18 && cb.height <= 90 && vis(c);
              });
              if (kids.length) {
                kids.sort((a, b2) => a.getBoundingClientRect().x - b2.getBoundingClientRect().x);
                handle = kids[0];
                break;
              }
            }
            el = el.parentElement;
          }
          if (handle) break;
        }
      }

      // --- 3. Structural scan near the background: square knob in a bar ---
      if (!handle) {
        how = 'structure';
        const bgRects = bgCands.map((el) => el.getBoundingClientRect());
        const near = (b) => bgRects.some((r) => {
          const dy = Math.max(r.top - b.bottom, b.top - r.bottom, 0);
          const dx = Math.max(r.left - b.right, b.left - r.right, 0);
          return dy < 350 && dx < 200;
        });
        const bars = Array.from(document.querySelectorAll('div,section,span')).filter((el) => {
          const b = el.getBoundingClientRect();
          return b.width > 150 && b.height >= 26 && b.height <= 70 && (b.width / b.height) > 3 && vis(el) && near(b);
        });
        for (const bar of bars) {
          const kids = Array.from(bar.querySelectorAll('*')).filter((c) => {
            const cb = c.getBoundingClientRect();
            const ratio = cb.width / Math.max(1, cb.height);
            return cb.width >= 18 && cb.width <= 80 && ratio > 0.6 && ratio < 1.7 && vis(c);
          });
          if (kids.length) {
            kids.sort((a, b2) => a.getBoundingClientRect().x - b2.getBoundingClientRect().x);
            handle = kids[0];
            break;
          }
        }
      }
      if (!handle) return { error: 'no-handle', bgFound: bgCands.length };

      const hb = handle.getBoundingClientRect();
      const dist = (el) => {
        const b = el.getBoundingClientRect();
        const dx = Math.max(b.left - hb.right, hb.left - b.right, 0);
        const dy = Math.max(b.top - hb.bottom, hb.top - b.bottom, 0);
        return Math.hypot(dx, dy);
      };
      bgCands.sort((a, b) => dist(a) - dist(b));
      const bg = bgCands[0];
      const bgb = bg.getBoundingClientRect();

      const track =
        handle.closest('.slidetounlock, .nc-lang-cnt, [class*="track"], [class*="slider"]') ||
        handle.parentElement;
      const tb = track ? track.getBoundingClientRect() : bgb;

      // --- Image extraction with fallbacks ---------------------------------
      // Geepass requires width/height within [50, 1024]; downscale (or
      // upscale tiny pieces) to fit and report the SUBMITTED width so the
      // main process can scale coordinates back.
      const MAXD = 1024, MIND = 50;
      const fitScale = (w, h) => {
        let s = Math.min(MAXD / w, MAXD / h, 1);
        const sMin = Math.max(MIND / w, MIND / h);
        if (s < sMin) s = sMin;
        return s;
      };
      const draw = (el, natW, natH, s) => {
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(natW * s));
        c.height = Math.max(1, Math.round(natH * s));
        c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
        return c.toDataURL('image/png').split(',')[1] || '';
      };
      // Fallback when drawImage throws (tainted canvas) or yields nothing:
      // hand the ORIGINAL bytes over; the main process then decodes the real
      // pixel width from the image header and scales coordinates itself.
      const grab = async (el, natW, natH, s) => {
        let b64 = '';
        try { b64 = draw(el, natW, natH, s); } catch (e) { b64 = ''; }
        if (b64 && b64.length > 100) return { b64, w: Math.max(1, Math.round(natW * s)), via: 'canvas' };
        if (el.tagName === 'IMG') {
          const src = el.currentSrc || el.src || '';
          if (src.startsWith('data:')) {
            const i = src.indexOf(',');
            if (i > 0) return { b64: src.slice(i + 1), w: 0, via: 'dataurl' };
          } else if (/^https?:/.test(src)) {
            try {
              const resp = await fetch(src, { credentials: 'include' });
              if (resp.ok) {
                const buf = await resp.arrayBuffer();
                let bin = '';
                const u8 = new Uint8Array(buf);
                for (let i = 0; i < u8.length; i += 0x8000) {
                  bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
                }
                return { b64: btoa(bin), w: 0, via: 'fetch' };
              }
            } catch (e) { /* cors; fall through */ }
          }
        }
        return { b64: '', w: 0, via: 'none' };
      };

      const natW = bg.tagName === 'CANVAS' ? bg.width : (bg.naturalWidth || Math.round(bgb.width));
      const natH = bg.tagName === 'CANVAS' ? bg.height : (bg.naturalHeight || Math.round(bgb.height));
      const g = await grab(bg, natW, natH, fitScale(natW, natH));
      if (!g.b64 || g.b64.length < 100) {
        return { error: 'bg-extract-failed', handleFound: how, bgTag: bg.tagName, bgSrc: String(bg.src || '').slice(0, 120) };
      }

      // Optional small puzzle-piece image (second image for type 20111).
      let slideImage = '';
      const pieces = Array.from(document.querySelectorAll('img')).filter((im) => {
        const b = im.getBoundingClientRect();
        return im !== bg && b.width > 10 && b.width < 140 && b.height > 10 && b.height < 140 && vis(im);
      });
      for (const im of pieces) {
        const b = im.getBoundingClientRect();
        const g2 = await grab(im, im.naturalWidth || Math.round(b.width), im.naturalHeight || Math.round(b.height), 1);
        if (g2.b64.length > 100) { slideImage = g2.b64; break; }
      }

      return {
        x: hb.x + hb.width / 2,
        y: hb.y + hb.height / 2,
        handleWidth: hb.width,
        trackWidth: tb.width,
        bgWidth: bgb.width,
        bgNaturalWidth: g.w,
        bgOffsetX: bgb.x,
        bgImage: g.b64,
        bgVia: g.via,
        handleFound: how,
        slideImage: slideImage || undefined,
      };
    })()
  `
}

/** Locate the puzzle slider across all frames of the given webContents. */
export async function locatePuzzle(
  wc: WebContents,
  diagnostics?: string[],
): Promise<PuzzleGeometry | null> {
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
      if (diagnostics && geo && geo.error) {
        diagnostics.push(
          `frame(${String(frame.url).slice(0, 60)}): ${geo.error}${geo.handleFound ? '/' + geo.handleFound : ''}${geo.bgVia ? '/' + geo.bgVia : ''}`,
        )
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

/**
 * Decode the pixel width from a base64 image header (PNG / JPEG / WebP).
 * Used when the page handed over ORIGINAL bytes (canvas drawImage failed),
 * so the main process can still compute the DOM<->pixel scale. Returns 0
 * when the format is unrecognized.
 */
export function decodeImageWidth(b64: string): number {
  try {
    const buf = Buffer.from(b64.slice(0, 2048), 'base64')
    // PNG: IHDR width at byte 16 (big endian)
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return buf.readUInt32BE(16)
    }
    // JPEG: walk markers until SOF0-SOF15 (skip C4/C8/CC)
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let o = 2
      while (o + 9 < buf.length) {
        if (buf[o] !== 0xff) { o++; continue }
        const marker = buf[o + 1]
        if (marker === 0xff) { o++; continue }
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return buf.readUInt16BE(o + 7)
        }
        const len = buf.readUInt16BE(o + 2)
        o += 2 + len
      }
      return 0
    }
    // WebP: VP8 (lossy) width at 26 (14 bits LE); VP8L at 21+ (14 bits)
    if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fourcc = buf.toString('ascii', 12, 16)
      if (fourcc === 'VP8 ') return buf.readUInt16LE(26) & 0x3fff
      if (fourcc === 'VP8L') {
        const b = buf.readUInt32LE(21)
        return (b & 0x3fff) + 1
      }
      if (fourcc === 'VP8X') return (buf.readUInt8(24) | (buf.readUInt8(25) << 8) | (buf.readUInt8(26) << 16)) + 1
    }
    return 0
  } catch {
    return 0
  }
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
  const diagnostics: string[] = []
  const geo = await locatePuzzle(wc, diagnostics)
  if (!geo || !geo.bgImage) {
    if (diagnostics.length) console.log('[PuzzleSolver] probe:', diagnostics.join(' | '))
    return false
  }

  const onStatus = options.onStatus || (() => {})
  onStatus('检测到拼图验证，Geepass 正在识别缺口…')
  console.log(
    `[PuzzleSolver] puzzle found via=${geo.handleFound || 'selector'} bgVia=${geo.bgVia || 'canvas'} bgW=${geo.bgWidth} submitted=${geo.bgNaturalWidth} handle=${geo.handleWidth} track=${geo.trackWidth}`,
  )

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
  // handle starts at the left edge, grip centered on the gap. When the page
  // handed over ORIGINAL bytes (bgVia dataurl/fetch) the submitted width is
  // 0, so decode the real pixel width from the image header instead.
  const natural = geo.bgNaturalWidth > 0 ? geo.bgNaturalWidth : decodeImageWidth(geo.bgImage) || geo.bgWidth
  const scale = natural > 0 ? geo.bgWidth / natural : 1
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
        const nat2 = fresh.bgNaturalWidth > 0 ? fresh.bgNaturalWidth : decodeImageWidth(fresh.bgImage) || fresh.bgWidth
        const scale2 = nat2 > 0 ? fresh.bgWidth / nat2 : 1
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
