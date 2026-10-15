import { describe, expect, it } from 'vitest'
import { AIR_BOW, AIR_SAMPLES, airPath, toXY, unwrapLng, type LngLat } from '../../src/core/index.js'

const ATHENS: LngLat = [23.7275, 37.9838]
const SANTORINI: LngLat = [25.4317, 36.4166]
const SYDNEY: LngLat = [151.177, -33.946]
const AUCKLAND: LngLat = [174.785, -37.008]
const LONDON: LngLat = [-0.45, 51.47]
const LOS_ANGELES: LngLat = [-118.41, 33.94]
const SUVA: LngLat = [178.4419, -18.1416]
const APIA_UNWRAPPED: LngLat = [188.2487, -13.8333]

/** Offset of the arc's midpoint from the chord, along `normalY` (−1 for north, +1 for south), over the chord length. */
function midOffset(a: LngLat, b: LngLat, normalY: -1 | 1): number {
  const { path } = airPath([a, b])
  const pa = toXY(a)
  const pb = toXY(b)
  const dx = pb[0] - pa[0]
  const dy = pb[1] - pa[1]
  const len = Math.hypot(dx, dy)
  let n: [number, number] = [-dy / len, dx / len]
  if (Math.sign(n[1]) !== normalY) n = [-n[0], -n[1]]
  const m = toXY(path[AIR_SAMPLES / 2]!)
  return ((m[0] - pa[0]) * n[0] + (m[1] - pa[1]) * n[1]) / len
}

/** The great-circle midpoint of a and b, by unit vectors. */
function gcMidpoint(a: LngLat, b: LngLat): LngLat {
  const rad = Math.PI / 180
  const v = ([lng, lat]: LngLat) => [Math.cos(lat * rad) * Math.cos(lng * rad), Math.cos(lat * rad) * Math.sin(lng * rad), Math.sin(lat * rad)]
  const va = v(a)
  const vb = v(b)
  const s = [va[0]! + vb[0]!, va[1]! + vb[1]!, va[2]! + vb[2]!]
  const lng = Math.atan2(s[1]!, s[0]!) / rad
  const lat = Math.atan2(s[2]!, Math.hypot(s[0]!, s[1]!)) / rad
  return [unwrapLng(a[0], lng), lat]
}

describe('airPath', () => {
  it('starts and ends exactly on the controls', () => {
    const { path, knots } = airPath([ATHENS, SANTORINI])
    expect(path[0]).toEqual(ATHENS)
    expect(path[path.length - 1]).toEqual(SANTORINI)
    expect(path).toHaveLength(AIR_SAMPLES + 1)
    expect(knots).toEqual([0, AIR_SAMPLES])
  })

  it('bows a short northern flight north', () => {
    expect(midOffset(ATHENS, SANTORINI, -1)).toBeGreaterThanOrEqual(AIR_BOW * 0.99)
  })

  it('bows a southern flight south', () => {
    expect(midOffset(SYDNEY, AUCKLAND, 1)).toBeGreaterThanOrEqual(AIR_BOW * 0.99)
  })

  it('adds no bow to a long arc that already curves enough', () => {
    const { path } = airPath([LONDON, LOS_ANGELES])
    const mid = path[AIR_SAMPLES / 2]!
    const want = gcMidpoint(LONDON, LOS_ANGELES)
    expect(mid[0]).toBeCloseTo(want[0], 9)
    expect(mid[1]).toBeCloseTo(want[1], 9)
  })

  it('crosses the antimeridian continuously', () => {
    const { path } = airPath([SUVA, APIA_UNWRAPPED])
    for (let i = 1; i < path.length; i++) expect(Math.abs(path[i]![0] - path[i - 1]![0])).toBeLessThan(2)
    expect(path[path.length - 1]).toEqual(APIA_UNWRAPPED)
  })

  it('puts knots on via points', () => {
    const controls: LngLat[] = [ATHENS, SANTORINI, [25.1442, 35.3387]]
    const { path, knots } = airPath(controls)
    expect(knots).toEqual([0, 64, 128])
    knots.forEach((k, i) => expect(path[k]).toEqual(controls[i]))
  })

  it('gives [A, A] for coincident ends', () => {
    const { path, knots } = airPath([ATHENS, ATHENS])
    expect(path).toEqual([ATHENS, ATHENS])
    expect(knots).toEqual([0, 1])
  })

  it('exports the tuning values', () => {
    expect(AIR_SAMPLES).toBe(64)
    expect(AIR_BOW).toBe(0.15)
  })
})
