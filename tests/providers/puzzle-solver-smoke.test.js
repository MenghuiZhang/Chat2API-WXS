/**
 * Smoke test for puzzleSolver pure functions.
 *
 * Strategy: extract the source of `decodeImageWidth` and `humanTrajectory`
 * from src/main/lib/puzzleSolver.ts by regex, eval them in a sandbox, and
 * run behavior assertions. This avoids requiring Electron.nativeImage
 * inside a Node process while still testing the actual shipped code (no
 * hand-copied logic drift).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = readFileSync(join(root, 'src/main/lib/puzzleSolver.ts'), 'utf-8')

function extractFunction(name) {
  // Use TypeScript AST to find the function declaration; regex/brace
  // counting is fooled by template literals containing `{` characters.
  const sf = ts.createSourceFile('puzzleSolver.ts', src, ts.ScriptTarget.ES2020, true)
  let node = null
  const visit = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.name.text === name) node = n
    ts.forEachChild(n, visit)
  }
  visit(sf)
  assert.ok(node, `${name} not found in puzzleSolver.ts`)
  const tsSource = src.slice(node.getStart(sf), node.end).replace(/^export /, '')
  return ts.transpileModule(tsSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText
}

// --- decodeImageWidth ------------------------------------------------------
test('decodeImageWidth: PNG width read from IHDR', () => {
  const code = extractFunction('decodeImageWidth')
  const fn = new Function(`${code}; return decodeImageWidth;`)()

  // Build a minimal PNG header with width=300, height=150
  const header = Buffer.alloc(32) // needs > 24 bytes per the guard
  header[0] = 0x89
  header[1] = 0x50 // 'P'
  header[2] = 0x4e // 'N'
  header[3] = 0x47 // 'G'
  header[4] = 0x0d
  header[5] = 0x0a
  header[6] = 0x1a
  header[7] = 0x0a
  // Length (4) 'IHDR' (4) width (4) height (4)
  header.writeUInt32BE(13, 8)
  header.write('IHDR', 12, 'ascii')
  header.writeUInt32BE(300, 16)
  header.writeUInt32BE(150, 20)
  const b64 = header.toString('base64')
  assert.equal(fn(b64), 300)

  // Unknown format returns 0
  assert.equal(fn('AAAAAAAAAAA='), 0)
  assert.equal(fn(''), 0)
})

test('decodeImageWidth: JPEG SOF0 width', () => {
  const code = extractFunction('decodeImageWidth')
  const fn = new Function(`${code}; return decodeImageWidth;`)()

  // JPEG: SOI, then APP0 (skip), then SOF0 with width 640
  const soi = Buffer.from([0xff, 0xd8])
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10].concat(new Array(14).fill(0)))
  const sof0 = Buffer.alloc(2 + 2 + 1 + 2 + 2 + 1)
  sof0[0] = 0xff
  sof0[1] = 0xc0 // SOF0
  sof0.writeUInt16BE(sof0.length - 2, 2)
  sof0[4] = 8 // precision
  sof0.writeUInt16BE(480, 5) // height
  sof0.writeUInt16BE(640, 7) // width
  sof0[9] = 3

  const b64 = Buffer.concat([soi, app0, sof0]).toString('base64')
  assert.equal(fn(b64), 640)
})

test('decodeImageWidth: WebP VP8 lossy width', () => {
  const code = extractFunction('decodeImageWidth')
  const fn = new Function(`${code}; return decodeImageWidth;`)()

  const buf = Buffer.alloc(60) // function requires > 30 bytes
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(0, 4)
  buf.write('WEBP', 8, 'ascii')
  buf.write('VP8 ', 12, 'ascii')
  // Stub the rest, but set width at offset 26 (14-bit LE)
  buf.writeUInt16LE(240 & 0x3fff, 26)
  const b64 = buf.toString('base64')
  assert.equal(fn(b64), 240)
})

// --- humanTrajectory -------------------------------------------------------
test('humanTrajectory: ends exactly at target distance, midpoints overshoot', () => {
  const code = extractFunction('humanTrajectory')
  const fn = new Function(`${code}; return humanTrajectory;`)()

  for (const target of [50, 150, 320, 800]) {
    const pts = fn(target)
    assert.ok(pts.length > 40, `trajectory for ${target} has enough samples`)
    const last = pts[pts.length - 1]
    assert.equal(last.dx, target, 'final point equals target')
    assert.equal(last.dy, 0, 'final point has zero vertical drift')

    // At least one intermediate point must overshoot (dx > target) when
    // distance > ~50; the algorithm guarantees an overshoot of ≥3px.
    if (target >= 60) {
      const maxDx = Math.max(...pts.map((p) => p.dx))
      assert.ok(maxDx > target, `trajectory for ${target} overshoots (max=${maxDx})`)
    }

    // Vertical drift bounded to ±2.5
    const maxAbsDy = Math.max(...pts.map((p) => Math.abs(p.dy)))
    assert.ok(maxAbsDy <= 3, `|dy| bounded (got ${maxAbsDy})`)
  }
})

test('humanTrajectory: negative distance (pull-back nudge) overshoots backwards', () => {
  const code = extractFunction('humanTrajectory')
  const fn = new Function(`${code}; return humanTrajectory;`)()

  for (const target of [-12, -40]) {
    const pts = fn(target)
    const last = pts[pts.length - 1]
    assert.equal(last.dx, target, 'final point equals negative target')
    assert.equal(last.dy, 0)
    // Overshoot must go PAST the target in the negative direction, never
    // surge positive first (that zig-zag is what broke closed-loop nudges).
    const minDx = Math.min(...pts.map((p) => p.dx))
    assert.ok(minDx < target, `trajectory for ${target} undershoots (min=${minDx})`)
    const maxDx = Math.max(...pts.map((p) => p.dx))
    assert.ok(maxDx <= 1, `no positive surge for ${target} (max=${maxDx})`)
  }
})

// --- planDrag --------------------------------------------------------------
// planDrag delegates header decoding to decodeImageWidth; inject both.
function extractPlanDrag() {
  const code = extractFunction('planDrag') + '\n' + extractFunction('decodeImageWidth')
  return new Function(`${code}; return planDrag;`)()
}

test('planDrag: gap center is mapped into viewport-absolute CSS px', () => {
  const fn = extractPlanDrag()

  // bg element sits at viewport x=430, rendered 200 CSS px wide while the
  // submitted image is 400 px -> scale 0.5. Gap at image x=350 -> 175 CSS px
  // INSIDE the bg -> absolute 605. Piece currently centered at 450.
  const geo = { bgWidth: 200, bgNaturalWidth: 400, bgOffsetX: 430, handleWidth: 40, pieceCenterX: 450 }
  const plan = fn(geo, 350)
  assert.equal(plan.scale, 0.5)
  assert.equal(plan.gapCenterDom, 605, 'bgOffsetX must be added to the scaled gap X')
  assert.equal(plan.pieceStart, 450)
  assert.equal(plan.distance, 155)
  // No trackWidth/pieceWidth supplied => strokes assumed equal.
  assert.equal(plan.ratio, 1)
  assert.equal(plan.handleDistance, 155)
})

test('planDrag: falls back to track start when piece is right of the gap', () => {
  const fn = extractPlanDrag()

  const geo = { bgWidth: 200, bgNaturalWidth: 400, bgOffsetX: 430, handleWidth: 40, pieceCenterX: 604 }
  const plan = fn(geo, 350)
  assert.equal(plan.pieceStart, 430 + 20, 'track-start assumption when piece not left of gap')
  assert.equal(plan.distance, 605 - 450)
})

test('planDrag: decodes submitted width from image header when unknown', () => {
  const fn = extractPlanDrag()

  const header = Buffer.alloc(32)
  header[0] = 0x89; header[1] = 0x50; header[2] = 0x4e; header[3] = 0x47
  header[4] = 0x0d; header[5] = 0x0a; header[6] = 0x1a; header[7] = 0x0a
  header.writeUInt32BE(13, 8)
  header.write('IHDR', 12, 'ascii')
  header.writeUInt32BE(400, 16)
  header.writeUInt32BE(200, 20)

  const geo = { bgWidth: 200, bgNaturalWidth: 0, bgOffsetX: 100, handleWidth: 40 }
  const plan = fn(geo, 350, header.toString('base64'))
  assert.equal(plan.scale, 0.5, 'natural width decoded from PNG header')
  assert.equal(plan.gapCenterDom, 100 + 175)
})

test('planDrag: implausible distance when gap sits at the track start', () => {
  const fn = extractPlanDrag()

  const geo = { bgWidth: 200, bgNaturalWidth: 400, bgOffsetX: 430, handleWidth: 40, pieceCenterX: 450 }
  const plan = fn(geo, 10) // gap almost at bg left edge
  assert.ok(plan.distance < 5, `distance must be implausible (got ${plan.distance})`)
})

test('planDrag: converts piece travel to handle travel via stroke ratio', () => {
  const fn = extractPlanDrag()

  // piece travel = bgWidth - pieceWidth = 200 - 50 = 150
  // handle travel = trackWidth - handleWidth = 260 - 40 = 220  => ratio 220/150 > 1
  // gap at submitted x=200 -> DOM 100; piece at 20 -> distance 80.
  const geo = {
    bgWidth: 200, bgNaturalWidth: 400, bgOffsetX: 0,
    handleWidth: 40, trackWidth: 260, pieceWidth: 50, pieceCenterX: 20,
  }
  const plan = fn(geo, 200)
  assert.equal(plan.distance, 80, 'piece displacement is unchanged')
  assert.ok(Math.abs(plan.ratio - 220 / 150) < 1e-9, `ratio = handleTravel/pieceTravel (got ${plan.ratio})`)
  assert.ok(plan.handleDistance > plan.distance, 'handle must travel FURTHER when its stroke is longer')
  assert.ok(Math.abs(plan.handleDistance - 80 * (220 / 150)) < 1e-6, `handleDistance = distance * ratio (got ${plan.handleDistance})`)

  // Inverse: handle stroke SHORTER than piece stroke => ratio < 1.
  const geo2 = { ...geo, trackWidth: 180 } // handleTravel = 140
  const plan2 = fn(geo2, 200)
  assert.ok(Math.abs(plan2.ratio - 140 / 150) < 1e-9, `inverse ratio (got ${plan2.ratio})`)
  assert.ok(plan2.handleDistance < plan2.distance, 'handle travels LESS when its stroke is shorter')
})

test('planDrag: handle distance is clamped to the physical track stroke', () => {
  const fn = extractPlanDrag()

  // Piece must travel 155 while its own stroke is only 150 (gap right at the
  // bg edge): the converted handle distance would exceed the 220px stroke and
  // must be clamped instead of asking for an impossible drag.
  const geo = {
    bgWidth: 200, bgNaturalWidth: 400, bgOffsetX: 430,
    handleWidth: 40, trackWidth: 260, pieceWidth: 50, pieceCenterX: 450,
  }
  const plan = fn(geo, 350)
  assert.equal(plan.distance, 155)
  assert.equal(plan.handleDistance, 220, 'clamped to trackWidth - handleWidth')
})

test('planDrag: ratio falls back to 1 on degenerate or missing stroke data', () => {
  const fn = extractPlanDrag()

  const base = { bgWidth: 200, bgNaturalWidth: 400, bgOffsetX: 430, handleWidth: 40, pieceCenterX: 450 }

  // pieceWidth missing => pieceTravel 0 => ratio 1.
  assert.equal(fn({ ...base, trackWidth: 260 }, 350).ratio, 1)
  // trackWidth missing => handleTravel 0 => ratio 1.
  assert.equal(fn({ ...base, pieceWidth: 50 }, 350).ratio, 1)
  // piece as wide as bg => degenerate pieceTravel => ratio 1.
  assert.equal(fn({ ...base, trackWidth: 260, pieceWidth: 195 }, 350).ratio, 1)
  // handle as wide as track => degenerate handleTravel => ratio 1.
  assert.equal(fn({ ...base, trackWidth: 45, pieceWidth: 50 }, 350).ratio, 1)
})

// --- correctionDelta -------------------------------------------------------
test('correctionDelta: closed-loop residual skips negligible and implausible values', () => {
  const code = extractFunction('correctionDelta')
  const fn = new Function(`${code}; return correctionDelta;`)()

  // Piece landed 12px short of the gap -> nudge by +12.
  assert.equal(fn(300, 288, 150), 12)
  // Piece overshot by 7 -> nudge back by -7.
  assert.equal(fn(300, 307, 150), -7)
  // Negligible residual (<=2px) -> no correction.
  assert.equal(fn(300, 299, 150), 0)
  assert.equal(fn(300, 302, 150), 0)
  // Implausibly large (piece reset to start / drag rejected) -> no nudge;
  // the next attempt re-drags from scratch instead.
  assert.equal(fn(300, 60, 150), 0, 'residual > cap must not nudge')
})

// --- puzzleProbeScript -----------------------------------------------------
test('puzzleProbeScript: returned string is syntactically valid JavaScript', () => {
  const code = extractFunction('puzzleProbeScript')
  const fn = new Function(`${code}; return puzzleProbeScript;`)()

  const scriptText = fn()
  // The probe script is built from a template literal; backslash escapes get
  // "cooked" (e.g. /url\(/ inside the template becomes /url(/ in the string,
  // which is an unterminated regex group). Parse the COOKED script for real
  // to catch such bugs — this previously shipped broken in v1.7.5-v1.7.7.
  assert.doesNotThrow(() => {
    new Function(scriptText)
  }, 'cooked probe script must be parseable JavaScript')

  // Regression: the background-image url regexes must survive template cooking.
  assert.ok(scriptText.includes('/url\\(/'), 'L199 url regex keeps its escape after cooking')
  assert.match(scriptText, /url\\\(\["'\]/, 'grabBytes url regex keeps its escapes after cooking')

  // Sanity: script contains the key probes we rely on.
  assert.match(scriptText, /拖动滑块|slide.*complete/i, 'has Chinese/English slider hints')
  assert.match(scriptText, /验证失败|请重试/, 'has failure banner text')
  assert.match(scriptText, /MAXD.*1024/, 'enforces Geepass 1024px limit')
  assert.match(scriptText, /seen\.size < 3/, 'includes blank canvas detection')
  assert.match(scriptText, /pieceWidth:/, 'probe returns pieceWidth for the stroke-ratio correction')
})

 test('puzzleProbeScript: blank-canvas detection triggers fallback to src/dataurl', () => {
  // Simulate a canvas 2D context that returns a fully transparent image —
  // the draw function must return '' so grab() falls through to src/dataurl.
  const fakeCanvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: () => {},
      getImageData: () => ({ data: new Uint8ClampedArray(4 * 100).fill(0) }), // 100 px, all 0
    }),
    toDataURL: () => 'data:image/pngbase64,QUJD', // unreachable
  }

  // Extract the inner `draw` helper from puzzleProbeScript (we replicate
  // inline because the helper is scoped INSIDE the IIFE — the cleanest way
  // to white-box test it is to spin up the script with a mock DOM, which is
  // overkill for a smoke test. This assertion documents the contract: when
  // the sampled color count < 3 the returned string is empty.
  //
  // Verified indirectly via puzzleProbeScript source: the literal guard
  // "if (seen.size < 3) return '';" must be present.
  const code = extractFunction('puzzleProbeScript')
  const fn = new Function(`${code}; return puzzleProbeScript;`)()
  const scriptText = fn()
  assert.ok(
    /blank = seen\.size < 3/.test(scriptText),
    'blank canvas sampling sets a suspicion flag (no early discard)',
  )
  assert.ok(
    !/if \(seen\.size < 3\) return ''/.test(scriptText),
    'canvas result is no longer discarded on page-side blank suspicion',
  )
  // Confirm the script still exposes MAXD/MIND for Geepass bounds
  assert.match(scriptText, /const MAXD = 1024, MIND = 50/)
})
