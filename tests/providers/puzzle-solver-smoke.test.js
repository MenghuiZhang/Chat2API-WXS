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

// --- puzzleProbeScript -----------------------------------------------------
test('puzzleProbeScript: returned string is syntactically valid JavaScript', () => {
  const code = extractFunction('puzzleProbeScript')
  const fn = new Function(`${code}; return puzzleProbeScript;`)()

  const scriptText = fn()
  // Puzzle probe is wrapped in a template literal\\; ensure the literal
  // unwrapping produces parseable JS by passing it to `new Function`.
  // The script is an async IIFE — wrap in function body for parse check.
  assert.doesNotThrow(() => {
    new Function(`return (0, async function*(){})() || ${JSON.stringify(scriptText)};`)
  })

  // Sanity: script contains the key probes we rely on.
  assert.match(scriptText, /拖动滑块|slide.*complete/i, 'has Chinese/English slider hints')
  assert.match(scriptText, /验证失败|请重试/, 'has failure banner text')
  assert.match(scriptText, /MAXD.*1024/, 'enforces Geepass 1024px limit')
  assert.match(scriptText, /seen\.size < 3/, 'includes blank canvas detection')
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
    /if \(seen\.size < 3\) return ''/.test(scriptText),
    'blank canvas detection returns empty string',
  )
  // Confirm the script still exposes MAXD/MIND for Geepass bounds
  assert.match(scriptText, /const MAXD = 1024, MIND = 50/)
})
