import { toXY, type XY } from './geo.js'
import type { LngLat } from './schema.js'

export const SAMPLES_PER_SPAN = 24
const ALPHA = 0.5

export const dist = (a: XY, b: XY) => Math.hypot(b[0] - a[0], b[1] - a[1])

export function lerp(a: XY, b: XY, t: number): XY {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

/** One point of the centripetal Catmull-Rom span from p1 to p2, by the Barry-Goldman pyramid. `u` is in [0, 1]. */
function catmullRom(p0: XY, p1: XY, p2: XY, p3: XY, u: number): XY {
  const t1 = dist(p0, p1) ** ALPHA
  const t2 = t1 + dist(p1, p2) ** ALPHA
  const t3 = t2 + dist(p2, p3) ** ALPHA
  const t = t1 + (t2 - t1) * u
  const a1 = lerp(p0, p1, (t - 0) / t1)
  const a2 = lerp(p1, p2, (t - t1) / (t2 - t1))
  const a3 = lerp(p2, p3, (t - t2) / (t3 - t2))
  const b1 = lerp(a1, a2, (t - 0) / t2)
  const b2 = lerp(a2, a3, (t - t1) / (t3 - t1))
  return lerp(b1, b2, (t - t1) / (t2 - t1))
}

/**
 * Sample a smooth curve through `points`, which must be distinct from their neighbours. Two points give a
 * straight segment. Each span gets `samplesPerSpan` samples, and `points[i]` is sample `i × samplesPerSpan`.
 */
export function curveThrough(points: XY[], samplesPerSpan = SAMPLES_PER_SPAN): XY[] {
  if (points.length < 3) return points
  const first = points[0]!
  const last = points[points.length - 1]!
  const second = points[1]!
  const beforeLast = points[points.length - 2]!
  const ctrl: XY[] = [
    [2 * first[0] - second[0], 2 * first[1] - second[1]],
    ...points,
    [2 * last[0] - beforeLast[0], 2 * last[1] - beforeLast[1]],
  ]
  const out: XY[] = []
  for (let i = 1; i < ctrl.length - 2; i++) {
    out.push(ctrl[i]!) // exact control point
    for (let k = 1; k < samplesPerSpan; k++) {
      out.push(catmullRom(ctrl[i - 1]!, ctrl[i]!, ctrl[i + 1]!, ctrl[i + 2]!, k / samplesPerSpan))
    }
  }
  out.push(last)
  return out
}

/** A stop or via point, unwrapped. */
export interface Control {
  at: LngLat
  sharp: boolean
}

/**
 * Sample one curve through `controls`, with a corner at each sharp point. Returns the
 * samples and, for each control, the index of its sample. Coincident neighbours share one.
 */
export function sampleChain(controls: Control[]): { xy: XY[]; at: number[] } {
  // Merge coincident neighbours: the curve needs distinct points.
  const points: XY[] = []
  const sharp: boolean[] = []
  const owner: number[] = []
  for (const c of controls) {
    const xy = toXY(c.at)
    const prev = points[points.length - 1]
    if (prev && prev[0] === xy[0] && prev[1] === xy[1]) sharp[sharp.length - 1] ||= c.sharp
    else {
      points.push(xy)
      sharp.push(c.sharp)
    }
    owner.push(points.length - 1)
  }
  // Everything coincides: a zero-length line that still has both ends.
  if (points.length === 1) return { xy: [points[0]!, points[0]!], at: controls.map((_, i) => (i === 0 ? 0 : 1)) }

  // Split at interior sharp points. Neighbouring runs share their corner sample.
  const xy: XY[] = []
  const pointAtSample: number[] = [0]
  let runStart = 0
  for (let i = 1; i < points.length; i++) {
    if (i < points.length - 1 && !sharp[i]) continue
    const run = points.slice(runStart, i + 1)
    const step = run.length < 3 ? 1 : SAMPLES_PER_SPAN
    const offset = Math.max(xy.length - 1, 0)
    for (let j = 1; j < run.length; j++) pointAtSample[runStart + j] = offset + j * step
    const samples = curveThrough(run)
    xy.push(...(xy.length === 0 ? samples : samples.slice(1)))
    runStart = i
  }
  return { xy, at: owner.map((o) => pointAtSample[o]!) }
}
