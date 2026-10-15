import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  decodeLand,
  haversineKm,
  headingDeg,
  landIndex,
  routeSea,
  seaLegKey,
  toXY,
  type LngLat,
  type SeaPath,
} from '../../src/core/index.js'

const land = landIndex(decodeLand(readFileSync(new URL('../../data/land-10m.bin', import.meta.url))))

const pathKm = (path: LngLat[]): number => {
  let km = 0
  for (let i = 1; i < path.length; i++) km += haversineKm(path[i - 1]!, path[i]!)
  return km
}

/** Stop connectors are short, and everything between them is at sea by the raw land polygons. */
function atSeaBetweenConnectors(path: LngLat[]): void {
  const first = path.findIndex((p) => !land.isLand(p))
  let last = path.length - 1
  while (last >= 0 && land.isLand(path[last]!)) last--
  expect(first).toBeGreaterThanOrEqual(0)
  expect(haversineKm(path[0]!, path[first]!)).toBeLessThan(30)
  expect(haversineKm(path[path.length - 1]!, path[last]!)).toBeLessThan(30)
  const hits: LngLat[] = []
  for (let i = first; i < last; i++) {
    const a = path[i]!
    const b = path[i + 1]!
    const n = Math.max(1, Math.ceil(haversineKm(a, b) / 0.2))
    for (let k = 0; k <= n; k++) {
      const p: LngLat = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]
      if (land.isLand(p)) hits.push(p)
    }
  }
  expect(hits).toEqual([])
}

const ok = (r: SeaPath): SeaPath => {
  expect(r.reason).toBeUndefined()
  expect(r.status).toBe('ok')
  return r
}

/** Absolute heading change from segment (k-1, k) to (k, k+1), in degrees. */
const turnAt = (path: LngLat[], k: number): number => {
  const a = headingDeg(toXY(path[k - 1]!), toXY(path[k]!))
  const b = headingDeg(toXY(path[k]!), toXY(path[k + 1]!))
  const d = Math.abs(b - a) % 360
  return d > 180 ? 360 - d : d
}

const piraeus: LngLat = [23.6466, 37.942]
const rhodes: LngLat = [28.2278, 36.451]
const southOfAmorgos: LngLat = [26.0, 36.3]

describe('routeSea', () => {
  it('keeps Athens to Mykonos at sea', () => {
    const from: LngLat = [23.7275, 37.9838]
    const to: LngLat = [25.3289, 37.4467]
    const r = ok(routeSea(from, to, [], land))
    expect(r.path[0]).toEqual(from)
    expect(r.path.at(-1)).toEqual(to)
    expect(r.knots).toEqual([0, r.path.length - 1])
    atSeaBetweenConnectors(r.path)
    expect(pathKm(r.path)).toBeLessThan(1.6 * haversineKm(from, to))
    expect(r.crossesLand).toBeUndefined()
  })

  it('keeps Barcelona to Marseille at sea', () => {
    const from: LngLat = [2.1734, 41.3851]
    const to: LngLat = [5.3698, 43.2965]
    const r = ok(routeSea(from, to, [], land))
    atSeaBetweenConnectors(r.path)
    expect(pathKm(r.path)).toBeLessThan(1.6 * haversineKm(from, to))
  })

  it('falls back for a landlocked pair', () => {
    expect(routeSea([7.4474, 46.948], [14.4378, 50.0755], [], land)).toEqual({
      status: 'fallback',
      reason: 'The start stop is more than 30 km from the sea',
      path: [],
      knots: [],
    })
  })

  it('names a via point that is too far from the sea', () => {
    expect(routeSea(piraeus, rhodes, [{ at: southOfAmorgos }, { at: [7.4474, 46.948] }], land).reason).toBe(
      'Via point 2 is more than 30 km from the sea',
    )
  })

  it('falls back when no sea joins the stops', () => {
    // Baku on the Caspian to Batumi on the Black Sea.
    expect(routeSea([49.8671, 40.4093], [41.6168, 41.6168], [], land)).toEqual({
      status: 'fallback',
      reason: 'No sea route found between the start stop and the end stop',
      path: [],
      knots: [],
    })
  })

  it('passes through via points at their knots', () => {
    const r = ok(routeSea(piraeus, rhodes, [{ at: southOfAmorgos }], land))
    expect(r.knots).toHaveLength(3)
    expect(r.path[r.knots[1]!]).toEqual(southOfAmorgos)
    expect(r.path[0]).toEqual(piraeus)
    expect(r.path.at(-1)).toEqual(rhodes)
    atSeaBetweenConnectors(r.path)
  })

  it('keeps a sharp via as a corner', () => {
    const sharp = ok(routeSea(piraeus, rhodes, [{ at: southOfAmorgos, sharp: true }], land))
    expect(turnAt(sharp.path, sharp.knots[1]!)).toBeGreaterThan(20)
    const smooth = ok(routeSea(piraeus, rhodes, [{ at: southOfAmorgos }], land))
    expect(turnAt(smooth.path, smooth.knots[1]!)).toBeLessThan(5)
  })

  it('visits a via point on land and reports crossesLand', () => {
    const naxos: LngLat = [25.45, 37.05]
    const r = ok(routeSea(piraeus, rhodes, [{ at: naxos }], land))
    expect(r.path[r.knots[1]!]).toEqual(naxos)
    expect(r.crossesLand).toBeDefined()
  })

  it('routes Suva to Apia across 180°', () => {
    const r = ok(routeSea([178.4419, -18.1416], [-171.7513, -13.8333], [], land))
    for (let i = 1; i < r.path.length; i++) expect(Math.abs(r.path[i]![0] - r.path[i - 1]![0])).toBeLessThan(1)
    expect(r.path.at(-1)).toEqual([-171.7513 + 360, -13.8333])
    atSeaBetweenConnectors(r.path)
  })

  it('samples a single open-water span and lands its knots on the controls', () => {
    // Open sea south of Crete, in clear sight of each other.
    const from: LngLat = [24.0, 34.0]
    const mid: LngLat = [24.5, 34.1]
    const to: LngLat = [25.0, 34.0]
    const straight = ok(routeSea(from, to, [], land))
    expect(straight.path.length).toBeGreaterThan(2)
    expect(straight.path.at(-1)).toEqual(to)
    const cornered = ok(routeSea(from, to, [{ at: mid, sharp: true }], land))
    expect(cornered.path[cornered.knots[1]!]).toEqual(mid)
    expect(cornered.path.at(-1)).toEqual(to)
    expect(cornered.path.every((p) => p !== undefined)).toBe(true)
  })

  it('returns a two-point path for identical ends', () => {
    const p: LngLat = [25.3289, 37.4467]
    expect(routeSea(p, p, [], land)).toEqual({ status: 'ok', path: [p, p], knots: [0, 1] })
  })

  it('routes Barcelona to Marseille in under 1.5 s', () => {
    const t0 = performance.now()
    ok(routeSea([2.1734, 41.3851], [5.3698, 43.2965], [], land))
    expect(performance.now() - t0).toBeLessThan(1500)
  })

  it('seaLegKey is stable and input-sensitive', () => {
    const key = seaLegKey(piraeus, rhodes, [{ at: southOfAmorgos }])
    expect(key).toMatch(/^[0-9a-f]{16}$/)
    expect(seaLegKey(piraeus, rhodes, [{ at: southOfAmorgos }])).toBe(key)
    expect(seaLegKey(piraeus, rhodes, [{ at: southOfAmorgos, sharp: false }])).toBe(key)
    expect(seaLegKey(piraeus, rhodes, [{ at: southOfAmorgos, sharp: true }])).not.toBe(key)
  })
})
