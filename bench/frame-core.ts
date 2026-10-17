// What Mapper itself does for each frame of a scene with a recorded track, timed in Node with no browser: the timeline's
// state, the camera, the line drawn so far (`slicePath`) and the head's position and heading (`pointAt`, three times: the
// head, and the look-ahead point the overlay's angle uses, which the studio asks for at the head and a step on). A leg of
// 10,000 points is compared with a leg of 256 points and with a plain line leg. The map's own work (tiling the line,
// drawing it) is not here; `npm run bench:render -- --track` covers that.
// Usage: npm run bench:core [-- --write]

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  buildRoute,
  buildTimeline,
  cameraAt,
  defaultProject,
  pointAt,
  slicePath,
  trackKey,
  type LngLat,
  type Project,
  type Scene,
  type SeaPaths,
} from '../src/core/index.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const DOC = path.join(ROOT, 'docs', 'render-speed.md')
const SECTION = '## Recorded track, core cost per frame (Stage 10)'
const PASSES = 40
/** A tenth of a 60 Hz display tick: what the 10,000-point leg may add to a frame before it needs a second look. */
const LIMIT_US = 1600
const PIRAEUS: LngLat = [23.6466, 37.942]
const RHODES: LngLat = [28.2278, 36.451]
const TRACK_ID = '0123456789ab'
const M_PER_DEG = 111_320

/** The seeded generator the tests use, so every run draws the same track. */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

/** `n` points from Piraeus to Rhodes, each but the ends moved up to `noise` metres east and north. */
function line(n: number, noise: number): LngLat[] {
  const rand = lcg(1)
  return Array.from({ length: n }, (_, k) => {
    const t = k / (n - 1)
    const lng = PIRAEUS[0] + (RHODES[0] - PIRAEUS[0]) * t
    const lat = PIRAEUS[1] + (RHODES[1] - PIRAEUS[1]) * t
    if (k === 0 || k === n - 1 || noise === 0) return [lng, lat]
    return [
      lng + ((rand() * 2 - 1) * noise) / (M_PER_DEG * Math.cos((lat * Math.PI) / 180)),
      lat + ((rand() * 2 - 1) * noise) / M_PER_DEG,
    ]
  })
}

function sceneFor(mode: 'line' | 'track', camera: 'glide' | 'follow'): Scene {
  const base: Project = defaultProject({ id: '6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', name: 'Bench', now: '2026-10-17T00:00:00.000Z', output: { height: 1080 } })
  const scene = base.scenes[0]!
  return {
    ...scene,
    look: { ...scene.look, theme: 'blank' },
    stops: [
      { id: 'a', name: 'Piraeus', at: PIRAEUS, pause: 0, sign: 'always' },
      { id: 'b', name: 'Rhodes', at: RHODES, pause: 0, sign: 'always' },
    ],
    legs: [mode === 'track' ? { mode: 'track', track: TRACK_ID, via: [] } : { mode: 'line', via: [] }],
    camera: camera === 'follow' ? { mode: 'follow', easing: 'smooth', follow: { zoom: 9 } } : { mode: 'glide', easing: 'smooth' },
  }
}

interface Row {
  label: string
  camera: string
  frames: number
  /** buildRoute, buildTimeline and the first cameraAt (which builds the follow track), in ms, once per scene. */
  setupMs: number
  /** Median over the passes of the per-frame cost, in microseconds. */
  frameUs: number
  /** The fastest pass, in microseconds. */
  bestUs: number
}

function measure(label: string, points: LngLat[] | undefined, camera: 'glide' | 'follow'): Row {
  const scene = sceneFor(points ? 'track' : 'line', camera)
  const seaPaths: SeaPaths = points ? { [trackKey(TRACK_ID)]: { status: 'ok', path: points, knots: [] } } : {}
  const aspect = '16:9'
  const fps = { num: 25, den: 1 } as const
  const setupStart = performance.now()
  const route = buildRoute(scene, seaPaths)
  if (points && route.legs[0]!.path.length !== points.length) throw new Error(`the route has ${route.legs[0]!.path.length} points, not the track's ${points.length}`)
  const timeline = buildTimeline(scene, fps, route)
  cameraAt(scene, aspect, route, timeline, 0)
  const setupMs = performance.now() - setupStart

  const frames = timeline.totalFrames
  const step = route.length * 0.002
  let sink = 0
  const pass = (): number => {
    const start = performance.now()
    for (let n = 0; n < frames; n++) {
      const state = timeline.stateAt(n)
      const shot = cameraAt(scene, aspect, route, timeline, n)
      const drawn = slicePath(route, state.distance)
      const head = pointAt(route, state.distance)
      const ahead = pointAt(route, Math.min(route.length, state.distance + step))
      sink += shot.center[0] + drawn.length + head.legIndex + ahead.heading
    }
    return ((performance.now() - start) * 1000) / frames
  }
  pass() // warm the JIT
  const samples = Array.from({ length: PASSES }, pass).sort((a, b) => a - b)
  if (Number.isNaN(sink)) throw new Error('the frame loop produced NaN')
  return { label, camera, frames, setupMs, frameUs: samples[Math.floor(samples.length / 2)]!, bestUs: samples[0]! }
}

function writeDoc(section: string): void {
  const current = existsSync(DOC) ? readFileSync(DOC, 'utf8') : '# Render speed\n'
  const start = current.indexOf(SECTION)
  let next: string
  if (start === -1) next = `${current.trimEnd()}\n\n${section}\n`
  else {
    const after = current.indexOf('\n## ', start + SECTION.length)
    next = `${current.slice(0, start)}${section}\n${after === -1 ? '' : current.slice(after)}`
  }
  writeFileSync(DOC, next)
}

const { values } = parseArgs({ options: { write: { type: 'boolean', default: false } } })
const rows: Row[] = []
for (const camera of ['glide', 'follow'] as const) {
  rows.push(measure('line leg', undefined, camera))
  rows.push(measure('track leg, 256 points', line(256, 0), camera))
  rows.push(measure('track leg, 10,000 points', line(10_000, 100), camera))
}

const table = [
  '| Leg | Camera | Frames | Setup, once | Per frame, median | Per frame, best |',
  '|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.label} | ${r.camera} | ${r.frames} | ${r.setupMs.toFixed(1)} ms | ${r.frameUs.toFixed(1)} µs | ${r.bestUs.toFixed(1)} µs |`),
].join('\n')
const verdicts = (['glide', 'follow'] as const).map((camera) => {
  const base = rows.find((r) => r.camera === camera && r.label === 'track leg, 256 points')!
  const big = rows.find((r) => r.camera === camera && r.label === 'track leg, 10,000 points')!
  const extra = big.frameUs - base.frameUs
  return `- ${camera} camera: the 10,000-point leg costs ${big.frameUs.toFixed(1)} µs a frame, ${extra.toFixed(1)} µs more than 256 points${big.frameUs > LIMIT_US ? ` (OVER the ${LIMIT_US} µs limit)` : ''}`
})
const body = [table, '', ...verdicts].join('\n')
process.stdout.write(`${body}\n`)

if (values.write) {
  writeDoc(
    [
      SECTION,
      '',
      '`npm run bench:core` times, in Node with no browser, what Mapper does for each frame of a 13 s scene at 25 fps (325',
      'frames): `timeline.stateAt`, `cameraAt`, `slicePath` and two `pointAt` calls (the head and the look-ahead point the',
      'overlay\'s angle uses). The scene is Piraeus to Rhodes on one leg: a plain line leg, a track leg of 256 points on a',
      'straight line, and a track leg of 10,000 points each moved up to 100 m off it. Setup is `buildRoute`, `buildTimeline`',
      'and the first `cameraAt`, which builds the follow camera\'s path for the whole scene, and is paid once. The map\'s own',
      'work, tiling and drawing the line, is not in these numbers.',
      '',
      `- Date: ${new Date().toISOString().slice(0, 10)}`,
      `- Node ${process.version}, ${PASSES} timed passes over all frames after one warm-up pass`,
      `- Limit: ${LIMIT_US} µs a frame, a tenth of a 16 ms display tick`,
      '',
      body,
      '',
    ].join('\n'),
  )
  process.stderr.write(`Wrote ${DOC}\n`)
}
