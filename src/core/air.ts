import { clampLat, toLngLat, toXY, unwrapLng, type XY } from './geo.js'
import type { LngLat } from './schema.js'

/** Spans per air leg. */
export const AIR_SAMPLES = 64
/** The least bow of an air leg at its middle, as a fraction of its Mercator chord. */
export const AIR_BOW = 0.15

type Vec3 = [number, number, number]

const RAD = Math.PI / 180

function toVec([lng, lat]: LngLat): Vec3 {
  const cl = Math.cos(lat * RAD)
  return [cl * Math.cos(lng * RAD), cl * Math.sin(lng * RAD), Math.sin(lat * RAD)]
}

function toLngLatVec(v: Vec3): LngLat {
  return [Math.atan2(v[1], v[0]) / RAD, Math.atan2(v[2], Math.hypot(v[0], v[1])) / RAD]
}

/** `AIR_SAMPLES + 1` points of the great circle from a to b, unwrapped step by step from a, latitudes clamped. */
function greatCircle(a: LngLat, b: LngLat): LngLat[] {
  const va = toVec(a)
  const vb = toVec(b)
  const cos = Math.min(1, Math.max(-1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]))
  const omega = Math.acos(cos)
  const sin = Math.sin(omega)
  const out: LngLat[] = []
  let prevLng = a[0]
  for (let i = 0; i <= AIR_SAMPLES; i++) {
    const t = i / AIR_SAMPLES
    let p: LngLat
    if (sin < 1e-9) {
      // Nearly coincident or antipodal: no single great circle, so go straight in degrees.
      p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
    } else {
      const wa = Math.sin((1 - t) * omega) / sin
      const wb = Math.sin(t * omega) / sin
      p = toLngLatVec([wa * va[0] + wb * vb[0], wa * va[1] + wb * vb[1], wa * va[2] + wb * vb[2]])
    }
    prevLng = unwrapLng(prevLng, p[0])
    out.push([prevLng, clampLat(p[1])])
  }
  return out
}

/** One bowed arc from a to b, both ends exact. */
function arc(a: LngLat, b: LngLat): LngLat[] {
  const pa = toXY(a)
  const pb = toXY(b)
  const dx = pb[0] - pa[0]
  const dy = pb[1] - pa[1]
  const len = Math.hypot(dx, dy)
  if (len === 0) return [a, a]
  const g = greatCircle(a, b).map(toXY)
  // Unit normal to the chord, toward the nearer pole. North is −y, and y ≤ 0.5 is the northern hemisphere.
  let n: XY = [-dy / len, dx / len]
  const north = (pa[1] + pb[1]) / 2 <= 0.5
  if (north ? n[1] > 0 : n[1] < 0) n = [-n[0], -n[1]]
  const gm = g[AIR_SAMPLES / 2]!
  const s = (gm[0] - pa[0]) * n[0] + (gm[1] - pa[1]) * n[1]
  const extra = Math.max(0, AIR_BOW * len - s)
  const out = g.map((p, i): LngLat => {
    const k = extra * Math.sin((Math.PI * i) / AIR_SAMPLES)
    const [lng, lat] = toLngLat([p[0] + n[0] * k, p[1] + n[1] * k])
    return [lng, clampLat(lat)]
  })
  out[0] = a
  out[AIR_SAMPLES] = b
  return out
}

/**
 * A flight through `controls`, which are unwrapped and in order. Each leg is a great circle bowed toward the
 * nearer pole so it reads as a flight on a Mercator map. The path is unwrapped and continuous, and
 * `path[knots[i]]` is exactly `controls[i]`.
 */
export function airPath(controls: LngLat[]): { path: LngLat[]; knots: number[] } {
  if (controls.length === 0) return { path: [], knots: [] }
  const path: LngLat[] = [controls[0]!]
  const knots = [0]
  for (let i = 1; i < controls.length; i++) {
    path.push(...arc(controls[i - 1]!, controls[i]!).slice(1))
    knots.push(path.length - 1)
  }
  return { path, knots }
}
