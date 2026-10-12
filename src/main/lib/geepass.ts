/**
 * Geepass (geepass.cn) captcha-recognition client.
 *
 * Recognizes slide-captcha gaps from base64 images and (optionally) returns
 * a human-like drag trajectory. Used by the captcha window to solve puzzle
 * sliders automatically.
 *
 * API: POST https://api.geepass.cn/api/recognize/captcha
 * Types:
 *   - 20110: single-image gap detection (field `image`, optional `slide`)
 *   - 20111: two-image slider (fields `slide_image` + `bg_image`)
 * Response: { code, msg, data: { data: { target: [x1,y1,x2,y2] | [cx,cy], tracks?: [[x,y],...] } } }
 */

import axios from 'axios'
import { ConfigManager } from '../store/config'
import type { GeepassConfig } from '../../shared/types'

const API_URL = 'https://api.geepass.cn/api/recognize/captcha'

export interface GeepassResult {
  /** Gap center X in bg-image pixel coordinates (center:true mode) */
  x: number
  /** Gap center Y in bg-image pixel coordinates */
  y: number
  /** Optional drag trajectory points from the API (type 20400 style) */
  tracks?: Array<[number, number]>
  /** Raw recognition time in ms */
  time?: number
}

export class GeepassError extends Error {
  code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

const ERROR_MESSAGES: Record<number, string> = {
  10001: '参数错误',
  10002: '余额不足',
  10003: '无权限',
  10004: '无此产品类型',
  10005: '网络拥塞',
  10006: '数据包过载',
  10007: '服务繁忙',
  10008: '网络错误',
  10011: '无效的 Token',
  10012: '不支持的请求方法',
  10013: '服务器内部异常',
  10014: '无法识别的内容',
  10015: '无可用专线',
}

/** Whether Geepass recognition is configured and enabled. */
export function isGeepassEnabled(): boolean {
  const config = ConfigManager.get()
  const gp = config.geepass
  return !!gp?.enabled && !!gp.token?.trim()
}

/** Get the effective Geepass config (with defaults filled in). */
export function getGeepassConfig(): GeepassConfig {
  const gp = ConfigManager.get().geepass
  return {
    enabled: gp?.enabled ?? false,
    token: gp?.token ?? '',
    type: gp?.type ?? 20110,
  }
}

export interface RecognizeSlideOptions {
  /** Base64 of the background image (without data: prefix) */
  bgImage: string
  /** Base64 of the slider/puzzle-piece image (required for type 20111) */
  slideImage?: string
  /** Recognition type; defaults to the configured value */
  type?: 20110 | 20111
  /** Slider image offset inside the background (usually 0) */
  x?: number
  y?: number
  /** Request a drag trajectory (extra cost, type 20400 semantics) */
  wantTracks?: boolean
  /** Whether the background is obfuscated (Geetest v3 style) */
  obs?: boolean
  timeoutMs?: number
}

/**
 * Recognize the gap position of a slide captcha.
 * Returns the gap center in background-image pixel coordinates.
 */
export async function recognizeSlide(options: RecognizeSlideOptions): Promise<GeepassResult> {
  const cfg = getGeepassConfig()
  const token = cfg.token.trim()
  if (!token) {
    throw new GeepassError(-1, 'Geepass token 未配置')
  }

  const type = options.type ?? cfg.type
  const payload: Record<string, unknown> = { token, type, center: true }
  if (type === 20111) {
    // Two-image slider: slide_image + bg_image (+ optional x/y offset, obs)
    if (!options.slideImage) {
      throw new GeepassError(-1, '类型 20111 需要提供滑块图 (slide_image)')
    }
    payload.slide_image = options.slideImage
    payload.bg_image = options.bgImage
    if (options.x) payload.x = options.x
    if (options.y) payload.y = options.y
    if (options.obs) payload.obs = true
  } else {
    // Single-image gap detection: the field is named `image`; an optional
    // `slide` image disambiguates when multiple gaps exist.
    payload.image = options.bgImage
    if (options.slideImage) payload.slide = options.slideImage
  }
  if (options.wantTracks) payload.num = 40

  let resp
  try {
    resp = await axios.post(API_URL, payload, {
      timeout: options.timeoutMs ?? 15000,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    throw new GeepassError(-2, `Geepass 请求失败: ${msg}`)
  }

  const body = resp.data
  const code = Number(body?.code)
  if (code !== 10000) {
    const known = ERROR_MESSAGES[code]
    throw new GeepassError(code, known ? `Geepass 错误 (${code}): ${known}` : `Geepass 错误 (${code}): ${body?.msg || '未知'}`)
  }

  const inner = body?.data?.data
  const target = inner?.target
  if (!Array.isArray(target) || target.length < 2) {
    throw new GeepassError(-3, `Geepass 响应缺少 target: ${JSON.stringify(body?.data)?.slice(0, 200)}`)
  }

  const result: GeepassResult = {
    x: Number(target[0]),
    y: Number(target[1]),
    time: Number(body?.data?.time) || undefined,
  }
  const tracks = inner?.tracks
  if (Array.isArray(tracks) && tracks.length > 0) {
    result.tracks = tracks as Array<[number, number]>
  }
  return result
}

/**
 * Lightweight connectivity/token check used by the settings dialog "test"
 * button. Sends a tiny 1x1 image; a 10014 (unrecognizable) response still
 * proves the token is valid, while 10011 means the token is wrong.
 */
export async function testGeepassToken(token: string): Promise<{ success: boolean; message: string }> {
  const trimmed = token.trim()
  if (!trimmed) return { success: false, message: 'Token 为空' }

  // 64x64 white PNG — Geepass requires width/height within [50, 1024], so a
  // 1x1 image is rejected as a parameter error. A 10014 (unrecognizable)
  // response still proves the token is valid.
  const tinyPng =
    'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAXklEQVR4nO3PMQ0AMAzAsPInvYLYYVWKESTzjhsd8KsBrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BbQHKU9LC7/CP1AAAAABJRU5ErkJggg=='

  try {
    const resp = await axios.post(
      API_URL,
      { token: trimmed, type: 20110, image: tinyPng, center: true },
      { timeout: 15000, headers: { 'Content-Type': 'application/json' } }
    )
    const code = Number(resp.data?.code)
    if (code === 10000) return { success: true, message: 'Token 有效，服务连接正常' }
    if (code === 10011) return { success: false, message: '无效的 Token' }
    if (code === 10002) return { success: false, message: '余额不足' }
    if (code === 10014) return { success: true, message: 'Token 有效（测试图无法识别属正常）' }
    const known = ERROR_MESSAGES[code]
    return { success: false, message: known ? `错误 (${code}): ${known}` : `错误 (${code}): ${resp.data?.msg || '未知'}` }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { success: false, message: `连接失败: ${msg}` }
  }
}
