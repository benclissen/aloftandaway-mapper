import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  AIR_SAMPLES,
  buildRoute,
  clampLat,
  decodeLand,
  effectiveSymbol,
  haversineKm,
  LngLatSchema,
  MAX_LAT,
  headingDeg,
  landIndex,
  nearestOnLeg,
  parseTrackCsv,
  pointAt,
  routeSea,
  seaLegKey,
  slicePath,
  toLngLat,
  toXY,
  trackKey,
  trackToStops,
  unwrapLng,
  type LngLat,
  type RouteLeg,
  type Scene,
  type SeaPath,
  type SeaPaths,
  type ViaPoint,
  type XY,
} from '../../src/core/index.js'
import { emptyProject, greekIslands, pacific, sceneOf, stopsAt } from '../fixtures/projects.js'
import { syntheticLoop } from '../fixtures/tracks.js'

describe('geo', () => {
  test('clampLat keeps a latitude inside the schema, which stops short of MapLibre\'s 85.051129', () => {
    expect(MAX_LAT).toBe(85.0511)
    expect(clampLat(85.051129)).toBe(MAX_LAT)
    expect(clampLat(-85.051129)).toBe(-MAX_LAT)
    expect(clampLat(37.942)).toBe(37.942)
    expect(LngLatSchema.safeParse([0, 85.051129]).success).toBe(false)
    expect(LngLatSchema.safeParse([0, clampLat(85.051129)]).success).toBe(true)
  })

  test('toXY puts lng 0 / lat 0 at the middle of the world and lng 90 a quarter east', () => {
    expect(toXY([0, 0])).toEqual([0.5, 0.5])
    expect(toXY([90, 0])[0]).toBeCloseTo(0.75, 12)
    expect(toXY([-180, 0])[0]).toBe(0)
  })

  test('toXY has y growing south', () => {
    expect(toXY([0, 40])[1]).toBeLessThan(toXY([0, -40])[1])
  })

  test('toLngLat inverts toXY without wrapping', () => {
    for (const p of [[188.25, -13.8], [-171.75, 13.8], [25.3289, 37.4467], [0, 0]] as LngLat[]) {
      const back = toLngLat(toXY(p))
      expect(back[0]).toBeCloseTo(p[0], 9)
      expect(back[1]).toBeCloseTo(p[1], 9)
    }
    expect(toXY([188.25, 0])[0]).toBeGreaterThan(1)
  })

  test('unwrapLng shifts by whole turns to stay within 180 of the previous longitude', () => {
    expect(unwrapLng(178, -172)).toBe(188)
    expect(unwrapLng(-178, 172)).toBe(-188)
    expect(unwrapLng(10, 20)).toBe(20)
    expect(unwrapLng(188, 170)).toBe(170)
    expect(unwrapLng(0, 180)).toBe(180)
    expect(unwrapLng(0, -180)).toBe(-180)
  })

  test('haversineKm gives a quarter of the equator and zero for the same point', () => {
    expect(haversineKm([0, 0], [90, 0])).toBeCloseTo((Math.PI / 2) * 6371, 3)
    expect(haversineKm([12, 34], [12, 34])).toBe(0)
  })

  test('headingDeg is clockwise from north', () => {
    expect(headingDeg([0.5, 0.5], [0.5, 0.4])).toBeCloseTo(0, 9)
    expect(headingDeg([0.5, 0.5], [0.6, 0.5])).toBeCloseTo(90, 9)
    expect(headingDeg([0.5, 0.5], [0.5, 0.6])).toBeCloseTo(180, 9)
    expect(headingDeg([0.5, 0.5], [0.4, 0.5])).toBeCloseTo(270, 9)
  })
})

describe('buildRoute', () => {
  test('two-point line leg is straight with Mercator length', () => {
    const r = buildRoute(sceneOf(stopsAt([[0, 0], [90, 0]])))
    expect(r.legs).toHaveLength(1)
    expect(r.length).toBeCloseTo(0.25, 6)
    expect(r.legs[0]!.path).toEqual([[0, 0], [90, 0]])
    expect(r.legs[0]!.drawnAs).toBe('line')
    expect(r.legs[0]!.cum[0]).toBe(0)
    expect(r.legs[0]!.cum.at(-1)).toBe(r.legs[0]!.length)
  })

  test('via points are passed through', () => {
    const base = sceneOf(stopsAt([[0, 0], [20, 0]]))
    const r = buildRoute({ ...base, legs: [{ mode: 'line', via: [{ at: [10, 10] }] }] })
    const path = r.legs[0]!.path
    expect(path.some(([lng, lat]) => Math.abs(lng - 10) < 1e-9 && Math.abs(lat - 10) < 1e-9)).toBe(true)
    expect(path[0]).toEqual([0, 0])
    expect(path.at(-1)).toEqual([20, 0])
    expect(path).toHaveLength(2 * 24 + 1)
    // The curve bends north of the straight line between the stops.
    expect(Math.max(...path.map(([, lat]) => lat))).toBeGreaterThan(9)
  })

  test('path is sampled from xy and cum is cumulative xy length', () => {
    const base = sceneOf(stopsAt([[0, 0], [20, 0]]))
    const leg = buildRoute({ ...base, legs: [{ mode: 'line', via: [{ at: [10, 10] }] }] }).legs[0]!
    expect(leg.xy).toHaveLength(leg.path.length)
    expect(leg.cum).toHaveLength(leg.path.length)
    let sum = 0
    for (let i = 1; i < leg.xy.length; i++) {
      sum += Math.hypot(leg.xy[i]![0] - leg.xy[i - 1]![0], leg.xy[i]![1] - leg.xy[i - 1]![1])
      expect(leg.cum[i]).toBeCloseTo(sum, 12)
    }
    expect(leg.length).toBe(leg.cum.at(-1))
    leg.xy.forEach((p, i) => {
      expect(leg.path[i]![0]).toBeCloseTo(toLngLat(p)[0], 9)
      expect(leg.path[i]![1]).toBeCloseTo(toLngLat(p)[1], 9)
    })
  })

  test('land legs are curved like line legs and not flagged', () => {
    const base = sceneOf(stopsAt([[0, 0], [20, 0]]))
    const r = buildRoute({ ...base, legs: [{ mode: 'land', via: [{ at: [10, 10] }] }] })
    expect(r.legs[0]!.mode).toBe('land')
    expect(r.legs[0]!.drawnAs).toBe('line')
    expect(r.legs[0]!.sea).toBeUndefined()
    expect(r.legs[0]!.path).toHaveLength(2 * 24 + 1)
  })

  test('crosses the antimeridian the short way', () => {
    const r = buildRoute(sceneOf(pacific()))
    for (const [lng] of r.legs[0]!.path) {
      expect(lng).toBeGreaterThanOrEqual(178.4)
      expect(lng).toBeLessThanOrEqual(188.3)
    }
    expect(r.length).toBeLessThan(0.05)
    expect(r.bounds[1][0]).toBeCloseTo(188.2487, 3)
    expect(r.bounds[0][0]).toBeCloseTo(178.4419, 3)
    expect(r.legs[0]!.path.at(-1)).toEqual([188.2487, -13.8333])
  })

  test('longitude stays continuous across several legs', () => {
    const r = buildRoute(sceneOf(stopsAt([[170, 0], [-170, 0], [-150, 0], [170, 0]])))
    expect(r.legs[0]!.path.at(-1)![0]).toBe(190)
    expect(r.legs[1]!.path[0]![0]).toBe(190)
    expect(r.legs[1]!.path.at(-1)![0]).toBe(210)
    expect(r.legs[2]!.path.at(-1)![0]).toBe(170)
    expect(r.legs[0]!.xy.at(-1)).toEqual(r.legs[1]!.xy[0])
  })

  test('sea leg without seaPaths is drawn as a line and pending', () => {
    const base = sceneOf(greekIslands())
    const r = buildRoute({ ...base, legs: base.legs.map((l, i) => (i === 1 ? { ...l, mode: 'sea' as const } : l)) })
    expect(r.legs[1]!.mode).toBe('sea')
    expect(r.legs[1]!.drawnAs).toBe('line')
    expect(r.legs[1]!.sea).toEqual({ status: 'pending' })
    expect(r.legs[0]!.sea).toBeUndefined()
  })

  test('air leg is drawn as an air arc', () => {
    const base = sceneOf(stopsAt([[0, 0], [30, 10]]))
    const r = buildRoute({ ...base, legs: [{ mode: 'air', via: [] }] })
    expect(r.legs[0]!.drawnAs).toBe('air')
    expect(r.legs[0]!.sea).toBeUndefined()
  })

  test('route length is the sum of leg lengths and bounds cover every path point', () => {
    const r = buildRoute(sceneOf(greekIslands()))
    expect(r.legs).toHaveLength(3)
    expect(r.length).toBeCloseTo(r.legs.reduce((a, l) => a + l.length, 0), 12)
    const [[w, s], [e, n]] = r.bounds
    for (const leg of r.legs)
      for (const [lng, lat] of leg.path) {
        expect(lng).toBeGreaterThanOrEqual(w)
        expect(lng).toBeLessThanOrEqual(e)
        expect(lat).toBeGreaterThanOrEqual(s)
        expect(lat).toBeLessThanOrEqual(n)
      }
    expect(w).toBeCloseTo(23.6466, 9)
    expect(e).toBeCloseTo(28.2278, 9)
  })

  test('bounds include a curve that bulges past the stops', () => {
    const base = sceneOf(stopsAt([[0, 0], [20, 0]]))
    const r = buildRoute({ ...base, legs: [{ mode: 'line', via: [{ at: [10, 30] }] }] })
    expect(r.bounds[1][1]).toBeGreaterThanOrEqual(30 - 1e-9)
  })

  test('duplicate control points do not produce NaN', () => {
    const base = sceneOf(stopsAt([[0, 0], [10, 5]]))
    const r = buildRoute({ ...base, legs: [{ mode: 'line', via: [{ at: [0, 0] }, { at: [10, 5] }] }] })
    for (const p of r.legs[0]!.path) expect(p.every(Number.isFinite)).toBe(true)
    expect(r.legs[0]!.path[0]).toEqual([0, 0])
    expect(r.legs[0]!.path.at(-1)).toEqual([10, 5])
  })

  test('fewer than two stops gives an empty route', () => {
    expect(buildRoute(sceneOf(emptyProject()))).toEqual({ legs: [], length: 0, bounds: [[0, 0], [0, 0]] })
    const one = buildRoute(sceneOf(stopsAt([[12, 34]])))
    expect(one).toEqual({ legs: [], length: 0, bounds: [[12, 34], [12, 34]] })
    expect(pointAt(one, 5)).toEqual({ at: [12, 34], heading: 0, legIndex: 0 })
    expect(pointAt(buildRoute(sceneOf(emptyProject())), 0)).toEqual({ at: [0, 0], heading: 0, legIndex: 0 })
    expect(slicePath(one, 1)).toEqual([])
  })
})

describe('pointAt', () => {
  test('hits stops at leg boundaries and clamps', () => {
    const p = sceneOf(greekIslands())
    const r = buildRoute(p)
    const at = (d: number) => pointAt(r, d).at
    expect(at(0)).toEqual(p.stops[0]!.at)
    expect(at(r.legs[0]!.length)).toEqual(p.stops[1]!.at)
    expect(at(r.legs[0]!.length + r.legs[1]!.length)).toEqual(p.stops[2]!.at)
    expect(at(-1)).toEqual(p.stops[0]!.at)
    expect(at(99)).toEqual(p.stops[3]!.at)
    expect(at(r.length)).toEqual(p.stops[3]!.at)
  })

  test('a boundary belongs to the later leg except at the end of the route', () => {
    const r = buildRoute(sceneOf(greekIslands()))
    expect(pointAt(r, 0).legIndex).toBe(0)
    expect(pointAt(r, r.legs[0]!.length).legIndex).toBe(1)
    expect(pointAt(r, r.legs[0]!.length - 1e-9).legIndex).toBe(0)
    expect(pointAt(r, r.length).legIndex).toBe(2)
    expect(pointAt(r, 99).legIndex).toBe(2)
    expect(pointAt(r, -5).legIndex).toBe(0)
  })

  test('interpolates along a straight leg with the right heading', () => {
    // The middle stop is sharp, so both legs stay straight.
    const base = sceneOf(stopsAt([[0, 0], [90, 0], [90, 40]]))
    const r = buildRoute({ ...base, stops: base.stops.map((s, i) => (i === 1 ? { ...s, sharp: true } : s)) })
    const mid = pointAt(r, 0.125)
    expect(mid.at[0]).toBeCloseTo(45, 9)
    expect(mid.at[1]).toBeCloseTo(0, 9)
    expect(mid.heading).toBeCloseTo(90, 9)
    const north = pointAt(r, r.legs[0]!.length + 0.01)
    expect(north.legIndex).toBe(1)
    expect(north.heading).toBeCloseTo(0, 9)
    expect(north.at[0]).toBeCloseTo(90, 9)
  })

  test('heading follows the curve and stays in [0, 360)', () => {
    const base = sceneOf(stopsAt([[0, 0], [20, 0]]))
    const r = buildRoute({ ...base, legs: [{ mode: 'line', via: [{ at: [10, 10] }] }] })
    const start = pointAt(r, 0.001).heading
    const end = pointAt(r, r.length - 0.001).heading
    expect(start).toBeGreaterThan(0)
    expect(start).toBeLessThan(90)
    expect(end).toBeGreaterThan(90)
    expect(end).toBeLessThan(180)
  })

  test('zero-length leg has finite heading', () => {
    const a: LngLat = [10, 10]
    const b: LngLat = [20, 10]
    // A, A, B: the leading leg has no length.
    const lead = buildRoute(sceneOf(stopsAt([a, a, b])))
    expect(lead.legs[0]!.length).toBe(0)
    const h0 = pointAt(lead, 0)
    expect(Number.isFinite(h0.heading)).toBe(true)
    expect(h0.heading).toBeCloseTo(90, 9)
    // A, B, B: the head ends on a zero-length leg and keeps the previous heading.
    const tail = buildRoute(sceneOf(stopsAt([a, b, b])))
    const end = pointAt(tail, tail.length)
    expect(end.legIndex).toBe(1)
    expect(end.heading).toBeCloseTo(90, 9)
    expect(end.at).toEqual(b)
    // Everything at one point: heading 0.
    const same = buildRoute(sceneOf(stopsAt([a, a, a])))
    expect(pointAt(same, 0)).toEqual({ at: a, heading: 0, legIndex: 1 })
  })
})

describe('slicePath', () => {
  test('ends exactly at the head', () => {
    const r = buildRoute(sceneOf(greekIslands()))
    for (const d of [0, 0.001, r.legs[0]!.length, r.legs[0]!.length + 0.0123, r.length * 0.9, r.length, 99, -1]) {
      const slice = slicePath(r, d)
      expect(slice.at(-1)).toEqual(pointAt(r, d).at)
    }
  })

  test('starts at the first stop and has no repeated joints', () => {
    const p = sceneOf(greekIslands())
    const r = buildRoute(p)
    const slice = slicePath(r, r.length)
    expect(slice[0]).toEqual(p.stops[0]!.at)
    expect(slice.at(-1)).toEqual(p.stops[3]!.at)
    expect(slice).toHaveLength(r.legs.reduce((n, l) => n + l.path.length, 0) - (r.legs.length - 1))
    for (let i = 1; i < slice.length; i++) expect(slice[i]).not.toEqual(slice[i - 1])
  })

  test('is a prefix of the full path up to the head', () => {
    const base = sceneOf(stopsAt([[0, 0], [20, 0], [40, 10]]))
    // The middle stop is sharp, so the second leg is a straight two-point line.
    const r = buildRoute({
      ...base,
      stops: base.stops.map((s, i) => (i === 1 ? { ...s, sharp: true } : s)),
      legs: [{ mode: 'line', via: [{ at: [10, 10] }] }, { mode: 'line', via: [] }],
    })
    const full = slicePath(r, r.length)
    const d = r.legs[0]!.length + r.legs[1]!.length / 2
    const slice = slicePath(r, d)
    expect(slice.slice(0, -1)).toEqual(full.slice(0, slice.length - 1))
    expect(slice).toHaveLength(r.legs[0]!.path.length + 1)
  })

  test('at distance zero is just the first stop', () => {
    const p = sceneOf(greekIslands())
    expect(slicePath(buildRoute(p), 0)).toEqual([p.stops[0]!.at])
  })

  test('at a leg boundary does not repeat the joint', () => {
    const r = buildRoute(sceneOf(greekIslands()))
    const slice = slicePath(r, r.legs[0]!.length)
    expect(slice).toEqual(r.legs[0]!.path)
  })
})

/** Unsigned turn in degrees, in [0, 180], from the step a→b to the step b→c. */
function turn(a: XY, b: XY, c: XY): number {
  const d = Math.abs(headingDeg(b, c) - headingDeg(a, b)) % 360
  return d > 180 ? 360 - d : d
}

/** Turn at the joint of two legs: last segment of `a` against the first segment of `b`. */
function jointTurn(a: RouteLeg, b: RouteLeg): number {
  return turn(a.xy.at(-2)!, a.xy.at(-1)!, b.xy[1]!)
}

function expectStraight(leg: RouteLeg) {
  for (let i = 2; i < leg.xy.length; i++) expect(turn(leg.xy[i - 2]!, leg.xy[i - 1]!, leg.xy[i]!)).toBeLessThan(0.5)
}

describe('curves and corners', () => {
  test('curves through a stop between two line legs', () => {
    const r = buildRoute(sceneOf(stopsAt([[0, 0], [1, 0], [1, 1]])))
    expect(jointTurn(r.legs[0]!, r.legs[1]!)).toBeLessThan(15)
  })

  test('makes a corner at a sharp stop', () => {
    const p = stopsAt([[0, 0], [1, 0], [1, 1]])
    const scene = sceneOf(p)
    const r = buildRoute({ ...scene, stops: scene.stops.map((s, i) => (i === 1 ? { ...s, sharp: true } : s)) })
    const t = jointTurn(r.legs[0]!, r.legs[1]!)
    expect(t).toBeGreaterThan(85)
    expect(t).toBeLessThan(95)
    expectStraight(r.legs[0]!)
    expectStraight(r.legs[1]!)
  })

  test('makes a corner at a sharp via point', () => {
    const base = sceneOf(stopsAt([[0, 0], [2, 0]]))
    const r = buildRoute({ ...base, legs: [{ mode: 'line', via: [{ at: [1, 1], sharp: true }] }] })
    const leg = r.legs[0]!
    const k = leg.knots[1]!
    expect(leg.path[k]).toEqual([1, 1])
    expect(turn(leg.xy[k - 1]!, leg.xy[k]!, leg.xy[k + 1]!)).toBeGreaterThan(60)
  })

  test('breaks the curve at a sea or air leg', () => {
    const base = sceneOf(stopsAt([[0, 0], [1, 0], [1, 1]]))
    const r = buildRoute({ ...base, legs: [{ mode: 'line', via: [] }, { mode: 'sea', via: [] }] })
    const straight = turn(toXY([0, 0]), toXY([1, 0]), toXY([1, 1]))
    expect(jointTurn(r.legs[0]!, r.legs[1]!)).toBeCloseTo(straight, 6)
  })

  test('knots stay aligned when points coincide', () => {
    const base = sceneOf(stopsAt([[0, 0], [10, 5]]))
    const r = buildRoute({ ...base, legs: [{ mode: 'line', via: [{ at: [0, 0] }] }] })
    const leg = r.legs[0]!
    expect(leg.knots).toHaveLength(3)
    expect(leg.path[leg.knots[0]!]).toEqual([0, 0])
    expect(leg.path[leg.knots[1]!]).toEqual([0, 0])
    expect(leg.path[leg.knots[2]!]).toEqual([10, 5])
  })

  test('every leg has knots, including sea and air legs', () => {
    const base = sceneOf(greekIslands())
    const r = buildRoute({ ...base, legs: [{ mode: 'air', via: [] }, { mode: 'sea', via: [{ at: [25.5, 37] }] }, base.legs[2]!] })
    expect(r.legs.map((l) => l.knots.length)).toEqual([2, 3, 2])
    for (const leg of r.legs) {
      expect(leg.knots[0]).toBe(0)
      expect(leg.knots.at(-1)).toBe(leg.path.length - 1)
    }
  })

  test('still passes exactly through every stop', () => {
    const p = sceneOf(greekIslands())
    const r = buildRoute(p)
    r.legs.forEach((leg, i) => {
      expect(leg.path[leg.knots[0]!]).toEqual(p.stops[i]!.at)
      expect(leg.path.at(-1)).toEqual(p.stops[i + 1]!.at)
    })
  })
})

describe('nearestOnLeg', () => {
  test('nearestOnLeg returns the insert index', () => {
    const base = sceneOf(stopsAt([[0, 0], [3, 0]]))
    const r = buildRoute({ ...base, legs: [{ mode: 'line', via: [{ at: [1, 0] }, { at: [2, 0] }] }] })
    expect(nearestOnLeg(r, 0, [0.5, 0.01]).insertIndex).toBe(0)
    expect(nearestOnLeg(r, 0, [1.5, 0.01]).insertIndex).toBe(1)
    expect(nearestOnLeg(r, 0, [2.5, -0.01]).insertIndex).toBe(2)
    const hit = nearestOnLeg(r, 0, [1.5, 0.01])
    expect(hit.at[0]).toBeCloseTo(1.5, 6)
    expect(hit.at[1]).toBeCloseTo(0, 6)
    expect(hit.distance).toBeCloseTo(toXY([1.5, 0])[1] - toXY([1.5, 0.01])[1], 9)
  })

  test('nearestOnLeg wraps longitude on the Pacific route', () => {
    const r = buildRoute(sceneOf(pacific()))
    const leg = r.legs[0]!
    const a = leg.xy[0]!
    const b = leg.xy.at(-1)!
    const x = toXY([180.5, 0])[0]
    const lat = toLngLat([x, a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1])])[1]
    const hit = nearestOnLeg(r, 0, [-179.5, lat + 0.05])
    expect(hit.at[0]).toBeGreaterThanOrEqual(-180)
    expect(hit.at[0]).toBeLessThanOrEqual(180)
    expect(hit.at[0]).toBeCloseTo(-179.5, 1)
    expect(hit.distance).toBeLessThan(0.01)
    expect(hit.insertIndex).toBe(0)
  })
})

const land = landIndex(decodeLand(readFileSync(new URL('../../data/land-10m.bin', import.meta.url))))

/** Greek islands with leg 0 (Piraeus → Mykonos) by sea through `via`, and its sea path routed. */
function greekSea(via: ViaPoint[] = []): { scene: Scene; cached: SeaPath; seaPaths: SeaPaths } {
  const base = sceneOf(greekIslands())
  const scene: Scene = { ...base, legs: base.legs.map((l, i) => (i === 0 ? { ...l, mode: 'sea' as const, via } : l)) }
  const [from, to] = [scene.stops[0]!.at, scene.stops[1]!.at]
  const cached = routeSea(from, to, via, land)
  expect(cached.status).toBe('ok')
  return { scene, cached, seaPaths: { [seaLegKey(from, to, via)]: cached } }
}

describe('sea and air legs', () => {
  test('draws a sea leg from its cached path', () => {
    const { scene, cached, seaPaths } = greekSea()
    const leg = buildRoute(scene, seaPaths).legs[0]!
    expect(leg.drawnAs).toBe('sea')
    expect(leg.sea).toEqual({ status: 'ok', stopGapKm: cached.stopGapKm })
    expect(leg.path).toHaveLength(cached.path.length)
    expect(leg.xy).toHaveLength(cached.path.length)
    expect(leg.cum).toHaveLength(cached.path.length)
    expect(leg.knots).toEqual(cached.knots)
    expect(leg.path).toEqual(cached.path)
    expect(leg.length).toBe(leg.cum.at(-1))
    expect(leg.length).toBeGreaterThan(0)
  })

  test('a sea leg with coincident via points keeps one knot per control, exactly on it', () => {
    const via: ViaPoint[] = [{ at: [24, 37.6] }, { at: [24, 37.6] }, { at: [24.8, 37.3] }]
    const { scene, seaPaths } = greekSea(via)
    const leg = buildRoute(scene, seaPaths).legs[0]!
    expect(leg.drawnAs).toBe('sea')
    expect(leg.knots).toHaveLength(via.length + 2)
    const controls = [scene.stops[0]!.at, ...via.map((v) => v.at), scene.stops[1]!.at]
    controls.forEach((c, i) => expect(leg.path[leg.knots[i]!]).toEqual(c))
    expect(leg.knots[1]).toBe(leg.knots[2])
  })

  test('places a cached sea path on the scene\'s unwrapped longitudes', () => {
    const base = sceneOf(stopsAt([[170, -17], [178.44, -18.14], [-171.75, -13.83]]))
    const scene: Scene = { ...base, legs: [{ mode: 'line', via: [] }, { mode: 'sea', via: [] }] }
    const cached: SeaPath = {
      status: 'ok',
      path: [[178.44, -18.14], [181, -17], [185, -15], [188.25, -13.83]],
      knots: [0, 3],
    }
    const r = buildRoute(scene, { [seaLegKey([178.44, -18.14], [-171.75, -13.83], [])]: cached })
    expect(r.legs[1]!.drawnAs).toBe('sea')
    expect(r.legs[1]!.path[0]).toEqual(r.legs[0]!.path.at(-1))
    expect(r.legs[1]!.path.at(-1)![0]).toBe(188.25)
    expect(r.bounds[1][0]).toBe(188.25)
  })

  test('shifts a cached sea path by whole turns to meet an unwrapped start', () => {
    // Leg 0 crosses the antimeridian, so the sea leg starts at 190 while its cache starts at -170.
    const base = sceneOf(stopsAt([[170, 0], [-170, 0], [-160, 0], [-150, 0]]))
    const scene: Scene = {
      ...base,
      legs: [{ mode: 'line', via: [] }, { mode: 'sea', via: [] }, { mode: 'line', via: [] }],
    }
    const cached: SeaPath = { status: 'ok', path: [[-170, 0], [-165, 1], [-160, 0]], knots: [0, 2] }
    const r = buildRoute(scene, { [seaLegKey([-170, 0], [-160, 0], [])]: cached })
    expect(r.legs[1]!.path).toEqual([[190, 0], [195, 1], [200, 0]])
    expect(r.legs[2]!.path[0]).toEqual([200, 0])
    expect(r.legs[2]!.path.at(-1)).toEqual([210, 0])
  })

  test('later legs continue from where a long sea path actually ends', () => {
    // The sea path runs east the long way round, ending a turn further than the straight unwrap.
    const base = sceneOf(stopsAt([[0, 0], [-10, 0], [-5, 0]]))
    const scene: Scene = { ...base, legs: [{ mode: 'sea', via: [] }, { mode: 'line', via: [] }] }
    const path: [number, number][] = []
    for (let lng = 0; lng <= 350; lng += 10) path.push([lng, 0])
    const cached: SeaPath = { status: 'ok', path, knots: [0, path.length - 1] }
    const r = buildRoute(scene, { [seaLegKey([0, 0], [-10, 0], [])]: cached })
    expect(r.legs[0]!.path.at(-1)).toEqual([350, 0])
    expect(r.legs[1]!.path[0]).toEqual([350, 0])
    expect(r.legs[1]!.path.at(-1)).toEqual([355, 0])
  })

  test('draws a sea leg without a cached path as a pending line', () => {
    const { scene } = greekSea()
    const leg = buildRoute(scene, {}).legs[0]!
    expect(leg.drawnAs).toBe('line')
    expect(leg.sea).toEqual({ status: 'pending' })
    expect(leg.path).toEqual([scene.stops[0]!.at, scene.stops[1]!.at])
  })

  test('draws a fallback sea leg as a line and keeps its reason', () => {
    const { scene } = greekSea()
    const key = seaLegKey(scene.stops[0]!.at, scene.stops[1]!.at, [])
    const reason = 'Mykonos is more than 30 km from the sea'
    const leg = buildRoute(scene, { [key]: { status: 'fallback', reason, path: [], knots: [] } }).legs[0]!
    expect(leg.drawnAs).toBe('line')
    expect(leg.sea).toEqual({ status: 'fallback', reason })
    expect(leg.path).toEqual([scene.stops[0]!.at, scene.stops[1]!.at])
    expect(leg.knots).toEqual([0, 1])
  })

  test('an ok sea leg that crosses land says where', () => {
    const { scene, cached } = greekSea()
    const key = seaLegKey(scene.stops[0]!.at, scene.stops[1]!.at, [])
    const crossesLand: LngLat = [24.5, 37.5]
    const leg = buildRoute(scene, { [key]: { ...cached, crossesLand } }).legs[0]!
    expect(leg.drawnAs).toBe('sea')
    expect(leg.sea).toEqual({ status: 'ok', crossesLand, stopGapKm: cached.stopGapKm })
  })

  test('draws an air leg as an arc with knots at its via points', () => {
    const base = sceneOf(stopsAt([[0, 0], [40, 10]]))
    const leg = buildRoute({ ...base, legs: [{ mode: 'air', via: [{ at: [20, 20] }] }] }).legs[0]!
    expect(leg.drawnAs).toBe('air')
    expect(leg.sea).toBeUndefined()
    expect(leg.path).toHaveLength(2 * AIR_SAMPLES + 1)
    expect(leg.knots).toEqual([0, AIR_SAMPLES, 2 * AIR_SAMPLES])
    expect(leg.path[leg.knots[1]!]).toEqual([20, 20])
    expect(leg.path.at(-1)).toEqual([40, 10])
    // The arc bows north of the straight line between the stops.
    expect(leg.path[AIR_SAMPLES / 2]![1]).toBeGreaterThan(10)
    expect(leg.cum).toHaveLength(leg.path.length)
    expect(leg.length).toBe(leg.cum.at(-1))
  })

  test('an air leg across the antimeridian stays continuous with the next leg', () => {
    const base = sceneOf(stopsAt([[170, 0], [-170, 10], [-160, 10]]))
    const r = buildRoute({ ...base, legs: [{ mode: 'air', via: [] }, { mode: 'line', via: [] }] })
    expect(r.legs[0]!.path.at(-1)).toEqual([190, 10])
    expect(r.legs[1]!.path[0]).toEqual([190, 10])
    for (const [lng] of r.legs[0]!.path) expect(lng).toBeGreaterThanOrEqual(170)
  })

  test('nearestOnLeg on a sea leg gives an insertIndex between the right knots', () => {
    const via: ViaPoint[] = [{ at: [24, 37.6] }, { at: [24.8, 37.3] }]
    const { scene, seaPaths } = greekSea(via)
    const r = buildRoute(scene, seaPaths)
    const leg = r.legs[0]!
    const [k0, k1, k2, k3] = leg.knots
    expect(nearestOnLeg(r, 0, leg.path[Math.floor((k0! + k1!) / 2)]!).insertIndex).toBe(0)
    expect(nearestOnLeg(r, 0, leg.path[Math.floor((k1! + k2!) / 2)]!).insertIndex).toBe(1)
    expect(nearestOnLeg(r, 0, leg.path[Math.floor((k2! + k3!) / 2)]!).insertIndex).toBe(2)
  })
})

describe('effectiveSymbol', () => {
  test('a leg symbol wins over look.symbol, which applies to every other leg', () => {
    const scene = structuredClone(sceneOf(greekIslands()))
    scene.look.symbol = 'dot'
    scene.legs[0]!.symbol = 'none'
    scene.legs[1]!.symbol = 'ferry'
    expect(effectiveSymbol(scene, 0)).toBe('none')
    expect(effectiveSymbol(scene, 1)).toBe('ferry')
    expect(effectiveSymbol(scene, 2)).toBe('dot')
    scene.look.symbol = 'none'
    expect(effectiveSymbol(scene, 2)).toBe('none')
    expect(effectiveSymbol(scene, 1)).toBe('ferry')
  })
})

describe('track legs', () => {
  const TRACK = '0123456789ab'

  /** A scene on `stops` whose legs all follow `points`, passed in `seaPaths` as the server does. */
  function onTrack(stops: LngLat[], points: LngLat[]): { scene: Scene; seaPaths: SeaPaths } {
    const base = sceneOf(stopsAt(stops))
    const scene: Scene = { ...base, legs: base.legs.map(() => ({ mode: 'track' as const, track: TRACK, via: [] })) }
    return { scene, seaPaths: { [trackKey(TRACK)]: { status: 'ok', path: points, knots: [] } } }
  }

  test('trackKey prefixes the id, so it never collides with a sea key', () => {
    expect(trackKey(TRACK)).toBe('track:0123456789ab')
  })

  test('a track leg follows its points', () => {
    const points: LngLat[] = [[0, 0], [0.1, 0.05], [0.2, 0.1], [0.3, 0.05], [0.4, 0]]
    const { scene, seaPaths } = onTrack([[0.001, 0], [0.401, 0]], points)
    const leg = buildRoute(scene, seaPaths).legs[0]!
    expect(leg.mode).toBe('track')
    expect(leg.drawnAs).toBe('track')
    expect(leg.path).toEqual([[0.001, 0], ...points.slice(1, 4), [0.401, 0]])
    expect(leg.knots).toEqual([0, 4])
    expect(leg.xy).toHaveLength(5)
    expect(leg.length).toBe(leg.cum.at(-1))
    expect(leg.track).toMatchObject({ status: 'ok', id: TRACK })
    expect(leg.track!.stopGapKm![0]).toBeCloseTo(haversineKm([0, 0], [0.001, 0]), 9)
    expect(leg.track!.stopGapKm![1]).toBeCloseTo(haversineKm([0.4, 0], [0.401, 0]), 9)
    expect(leg.sea).toBeUndefined()
  })

  test('two legs on one track share the cut', () => {
    // A round trip B → A → B, then on to C. Searched from the start, leg 3 would begin at the first B.
    const points: LngLat[] = [[0, 0], [0.1, 0], [0.2, 0], [0.1, 0.01], [0.01, 0.01], [0.01, 0.1], [0.01, 0.2]]
    const { scene, seaPaths } = onTrack([[0, 0], [0.2, 0], [0, 0.01], [0.01, 0.2]], points)
    const legs = buildRoute(scene, seaPaths).legs
    expect(legs.map((l) => l.drawnAs)).toEqual(['track', 'track', 'track'])
    expect(legs[0]!.path).toEqual([[0, 0], [0.1, 0], [0.2, 0]])
    expect(legs[1]!.path).toEqual([[0.2, 0], [0.1, 0.01], [0, 0.01]])
    expect(legs[2]!.path).toEqual([[0, 0.01], [0.01, 0.1], [0.01, 0.2]])
    expect(legs[1]!.path[0]).toEqual(legs[0]!.path.at(-1))
    expect(legs[2]!.path[0]).toEqual(legs[1]!.path.at(-1))
    // The shared stop is measured to the same cut point from both sides.
    expect(legs[2]!.track!.stopGapKm![0]).toBe(legs[1]!.track!.stopGapKm![1])
  })

  test('a port called at twice cuts at the first call', () => {
    // A → B (500 m off) → C → B (exactly) → D. The nearest point to B is the second call, but the leg ends at the first.
    const A: LngLat = [0, 0]
    const B: LngLat = [0.3, 0]
    const C: LngLat = [0.3, 0.3]
    const points: LngLat[] = [A, [0.15, 0], [0.3, 0.0045], [0.3, 0.15], C, [0.3, 0.15], B, [0.45, 0], [0.6, 0]]
    const { scene, seaPaths } = onTrack([A, B, C], points)
    const legs = buildRoute(scene, seaPaths).legs
    expect(legs[0]!.path).toEqual([A, [0.15, 0], B])
    expect(legs[1]!.path).toEqual([B, [0.3, 0.15], C])
  })

  test('a cruise that ends where it began cuts at the end', () => {
    // The last point is exactly on A and the first is 300 m off, so the nearest point to A is the last.
    const A: LngLat = [0, 0]
    const B: LngLat = [0.4, 0]
    const points: LngLat[] = [[0, 0.0027], [0.1, 0.05], [0.2, 0.05], B, [0.3, -0.05], [0.1, -0.05], A]
    const { scene, seaPaths } = onTrack([A, B, A], points)
    const legs = buildRoute(scene, seaPaths).legs
    expect(legs[0]!.path).toEqual([A, [0.1, 0.05], [0.2, 0.05], B])
    expect(legs[1]!.path).toEqual([B, [0.3, -0.05], [0.1, -0.05], A])
  })

  test('a loop with two stops follows the whole loop', () => {
    // As import_track's ends mode gives it: a stop on the first point and one on the last, a few metres apart. The
    // track starts inside the end stop's circle, so the end is where it comes back, not where it leaves.
    const { points, lengthKm } = syntheticLoop({ stayMinutes: 0 })
    const { scene, seaPaths } = onTrack([points[0]!, points.at(-1)!], points)
    const r = buildRoute(scene, seaPaths)
    const leg = r.legs[0]!
    expect(leg.drawnAs).toBe('track')
    expect(leg.path).toEqual(points)
    expect(leg.track!.stopGapKm).toEqual([0, 0])
    let km = 0
    for (let k = 1; k < leg.path.length; k++) km += haversineKm(leg.path[k - 1]!, leg.path[k]!)
    expect(km).toBeGreaterThan(lengthKm * 0.98)
    expect(km).toBeLessThan(lengthKm * 1.02)
    expect(r.length).toBe(leg.length)
  })

  /** The great-circle length of `path`, in km. */
  const pathKm = (path: LngLat[]): number => path.slice(1).reduce((km, p, k) => km + haversineKm(path[k]!, p), 0)
  /** `p` moved `east` and `north` km. */
  const moved = (p: LngLat, east: number, north: number): LngLat => [
    p[0] + east / (111.32 * Math.cos((p[1] * Math.PI) / 180)),
    p[1] + north / 111.32,
  ]

  test('a loop imported in ends mode follows the whole loop, however the logger sat while parked', () => {
    // 3 h parked at home before and after the drive, jittering by ±20 m or ±50 m. The ends are a few metres apart,
    // and every parked point is within 2 km of both.
    for (const stayJitterM of [20, 50]) {
      for (const seed of [1, 2, 3]) {
        const imported = trackToStops(parseTrackCsv(syntheticLoop({ seed, stayJitterM }).csv), { stops: 'ends', minStayMinutes: 120 })
        const { scene, seaPaths } = onTrack(imported.stops.map((s) => s.at), imported.points)
        const leg = buildRoute(scene, seaPaths).legs[0]!
        expect(leg.path, `±${stayJitterM} m, seed ${seed}`).toEqual(imported.points)
      }
    }
  })

  test('a loop keeps about its whole length with the start stop dragged off it', () => {
    // Points every 100 m. A start stop 100 m, 200 m or 1 km off home still leaves from home, and the leg runs round.
    const { points, home, lengthKm } = syntheticLoop({ stayMinutes: 0, samples: 400 })
    for (const km of [0.1, 0.2, 1]) {
      for (const from of [moved(home, 0, -km), moved(home, km, 0), moved(home, -km, 0)]) {
        const { scene, seaPaths } = onTrack([from, points.at(-1)!], points)
        const leg = buildRoute(scene, seaPaths).legs[0]!
        expect(pathKm(leg.path), `${km} km`).toBeGreaterThan(lengthKm * 0.95)
      }
    }
    // An end stop moved 100 m along the way out still waits for the track to come back.
    const { scene, seaPaths } = onTrack([points[0]!, points[1]!], points)
    expect(pathKm(buildRoute(scene, seaPaths).legs[0]!.path)).toBeGreaterThan(lengthKm * 0.95)
  })

  test('a short hop from near the start still ends at the first arrival', () => {
    // A to C along the equator and back 220 m north of it. B is 1.6 km from A, so the track starts inside B's circle,
    // and it passes B again on the way back. The leg to B ends on the way out, with B on a point or dragged 100 m off.
    const out: LngLat[] = []
    const back: LngLat[] = []
    for (let k = 0; k <= 200; k++) out.push([k * 0.001, 0])
    for (let k = 199; k >= 0; k--) back.push([k * 0.001, 0.002])
    const points = [...out, ...back]
    for (const B of [[0.014, 0], [0.014, 0.0009]] as LngLat[]) {
      const { scene, seaPaths } = onTrack([[0, 0], B, [0.2, 0]], points)
      const legs = buildRoute(scene, seaPaths).legs
      expect(legs[0]!.path).toEqual([[0, 0], ...points.slice(1, 14), B])
      expect(legs[1]!.path).toEqual([B, ...points.slice(15, 200), [0.2, 0]])
    }
  })

  test('a hop to a stop 1 km off the track takes the nearer of two passes', () => {
    // B is 1 km south of the way out and 1.22 km from the way back, so leg 0 ends on the way out and leg 1 runs on to C.
    const points: LngLat[] = []
    for (let k = 0; k <= 200; k++) points.push([k * 0.001, 0])
    for (let k = 199; k >= 0; k--) points.push([k * 0.001, 0.002])
    const B: LngLat = [0.014, -0.009]
    const { scene, seaPaths } = onTrack([[0, 0], B, [0.2, 0]], points)
    const legs = buildRoute(scene, seaPaths).legs
    expect(legs[0]!.path).toEqual([[0, 0], ...points.slice(1, 14), B])
    expect(legs[1]!.path).toEqual([B, ...points.slice(15, 200), [0.2, 0]])
  })

  test('a stop far from the track reports the gap', () => {
    const points: LngLat[] = [[0, 0], [0.1, 0], [0.2, 0]]
    // 0.05° of latitude is about 5.6 km.
    const { scene, seaPaths } = onTrack([[0, 0], [0.2, 0.05]], points)
    const leg = buildRoute(scene, seaPaths).legs[0]!
    expect(leg.drawnAs).toBe('track')
    expect(leg.track!.stopGapKm![0]).toBe(0)
    expect(leg.track!.stopGapKm![1]).toBeGreaterThan(2)
    expect(leg.path).toEqual([[0, 0], [0.1, 0], [0.2, 0.05]])
  })

  test('a missing track draws a straight line', () => {
    const { scene } = onTrack([[0, 0], [0.2, 0.1]], [])
    for (const seaPaths of [{}, undefined]) {
      const leg = buildRoute(scene, seaPaths).legs[0]!
      expect(leg.mode).toBe('track')
      expect(leg.drawnAs).toBe('line')
      expect(leg.track).toEqual({ status: 'missing', id: TRACK })
      expect(leg.path).toEqual([[0, 0], [0.2, 0.1]])
      expect(leg.knots).toEqual([0, 1])
    }
  })

  test('a track leg across 180° is continuous', () => {
    const points: LngLat[] = []
    for (let k = 0; k <= 40; k++) {
      const lng = 178 + k * 0.1
      points.push([lng > 180 ? lng - 360 : lng, -17 + Math.sin(k / 6) * 0.2])
    }
    const base = sceneOf(stopsAt([[178, -17], [-178, -17 + Math.sin(40 / 6) * 0.2], [-177, -16]]))
    const scene: Scene = { ...base, legs: [{ mode: 'track', track: TRACK, via: [] }, { mode: 'line', via: [] }] }
    const r = buildRoute(scene, { [trackKey(TRACK)]: { status: 'ok', path: points, knots: [] } })
    expect(r.legs[0]!.drawnAs).toBe('track')
    const all = r.legs.flatMap((l) => l.path)
    for (let k = 1; k < all.length; k++) expect(Math.abs(all[k]![0] - all[k - 1]![0])).toBeLessThanOrEqual(1)
    expect(r.legs[0]!.path.at(-1)![0]).toBeCloseTo(182, 9)
    expect(r.legs[1]!.path[0]).toEqual(r.legs[0]!.path.at(-1))
    expect(r.legs[1]!.path.at(-1)![0]).toBeCloseTo(183, 9)
  })
})
