import { describe, expect, test } from 'vitest'
import {
  buildRoute,
  clampLat,
  haversineKm,
  LngLatSchema,
  MAX_LAT,
  headingDeg,
  pointAt,
  slicePath,
  toLngLat,
  toXY,
  unwrapLng,
  type LngLat,
} from '../../src/core/index.js'
import { emptyProject, greekIslands, pacific, stopsAt } from '../fixtures/projects.js'

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
    const r = buildRoute(stopsAt([[0, 0], [90, 0]]))
    expect(r.legs).toHaveLength(1)
    expect(r.length).toBeCloseTo(0.25, 6)
    expect(r.legs[0]!.path).toEqual([[0, 0], [90, 0]])
    expect(r.legs[0]!.drawnAs).toBe('line')
    expect(r.legs[0]!.cum[0]).toBe(0)
    expect(r.legs[0]!.cum.at(-1)).toBe(r.legs[0]!.length)
  })

  test('via points are passed through', () => {
    const base = stopsAt([[0, 0], [20, 0]])
    const r = buildRoute({ ...base, legs: [{ mode: 'line', via: [[10, 10]] }] })
    const path = r.legs[0]!.path
    expect(path.some(([lng, lat]) => Math.abs(lng - 10) < 1e-9 && Math.abs(lat - 10) < 1e-9)).toBe(true)
    expect(path[0]).toEqual([0, 0])
    expect(path.at(-1)).toEqual([20, 0])
    expect(path).toHaveLength(2 * 24 + 1)
    // The curve bends north of the straight line between the stops.
    expect(Math.max(...path.map(([, lat]) => lat))).toBeGreaterThan(9)
  })

  test('path is sampled from xy and cum is cumulative xy length', () => {
    const base = stopsAt([[0, 0], [20, 0]])
    const leg = buildRoute({ ...base, legs: [{ mode: 'line', via: [[10, 10]] }] }).legs[0]!
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
    const base = stopsAt([[0, 0], [20, 0]])
    const r = buildRoute({ ...base, legs: [{ mode: 'land', via: [[10, 10]] }] })
    expect(r.legs[0]!.mode).toBe('land')
    expect(r.legs[0]!.notAvailable).toBeUndefined()
    expect(r.legs[0]!.path).toHaveLength(2 * 24 + 1)
  })

  test('crosses the antimeridian the short way', () => {
    const r = buildRoute(pacific())
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
    const r = buildRoute(stopsAt([[170, 0], [-170, 0], [-150, 0], [170, 0]]))
    expect(r.legs[0]!.path.at(-1)![0]).toBe(190)
    expect(r.legs[1]!.path[0]![0]).toBe(190)
    expect(r.legs[1]!.path.at(-1)![0]).toBe(210)
    expect(r.legs[2]!.path.at(-1)![0]).toBe(170)
    expect(r.legs[0]!.xy.at(-1)).toEqual(r.legs[1]!.xy[0])
  })

  test('sea leg is drawn as line and flagged', () => {
    const base = greekIslands()
    const r = buildRoute({ ...base, legs: base.legs.map((l, i) => (i === 1 ? { ...l, mode: 'sea' as const } : l)) })
    expect(r.legs[1]!.mode).toBe('sea')
    expect(r.legs[1]!.drawnAs).toBe('line')
    expect(r.legs[1]!.notAvailable).toBe(true)
    expect(r.legs[0]!.notAvailable).toBeUndefined()
  })

  test('air leg is drawn as line and flagged', () => {
    const base = stopsAt([[0, 0], [30, 10]])
    const r = buildRoute({ ...base, legs: [{ mode: 'air', via: [] }] })
    expect(r.legs[0]!.drawnAs).toBe('line')
    expect(r.legs[0]!.notAvailable).toBe(true)
  })

  test('route length is the sum of leg lengths and bounds cover every path point', () => {
    const r = buildRoute(greekIslands())
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
    const base = stopsAt([[0, 0], [20, 0]])
    const r = buildRoute({ ...base, legs: [{ mode: 'line', via: [[10, 30]] }] })
    expect(r.bounds[1][1]).toBeGreaterThanOrEqual(30 - 1e-9)
  })

  test('duplicate control points do not produce NaN', () => {
    const base = stopsAt([[0, 0], [10, 5]])
    const r = buildRoute({ ...base, legs: [{ mode: 'line', via: [[0, 0], [10, 5]] }] })
    for (const p of r.legs[0]!.path) expect(p.every(Number.isFinite)).toBe(true)
    expect(r.legs[0]!.path[0]).toEqual([0, 0])
    expect(r.legs[0]!.path.at(-1)).toEqual([10, 5])
  })

  test('fewer than two stops gives an empty route', () => {
    expect(buildRoute(emptyProject())).toEqual({ legs: [], length: 0, bounds: [[0, 0], [0, 0]] })
    const one = buildRoute(stopsAt([[12, 34]]))
    expect(one).toEqual({ legs: [], length: 0, bounds: [[12, 34], [12, 34]] })
    expect(pointAt(one, 5)).toEqual({ at: [12, 34], heading: 0, legIndex: 0 })
    expect(pointAt(buildRoute(emptyProject()), 0)).toEqual({ at: [0, 0], heading: 0, legIndex: 0 })
    expect(slicePath(one, 1)).toEqual([])
  })
})

describe('pointAt', () => {
  test('hits stops at leg boundaries and clamps', () => {
    const p = greekIslands()
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
    const r = buildRoute(greekIslands())
    expect(pointAt(r, 0).legIndex).toBe(0)
    expect(pointAt(r, r.legs[0]!.length).legIndex).toBe(1)
    expect(pointAt(r, r.legs[0]!.length - 1e-9).legIndex).toBe(0)
    expect(pointAt(r, r.length).legIndex).toBe(2)
    expect(pointAt(r, 99).legIndex).toBe(2)
    expect(pointAt(r, -5).legIndex).toBe(0)
  })

  test('interpolates along a straight leg with the right heading', () => {
    const r = buildRoute(stopsAt([[0, 0], [90, 0], [90, 40]]))
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
    const base = stopsAt([[0, 0], [20, 0]])
    const r = buildRoute({ ...base, legs: [{ mode: 'line', via: [[10, 10]] }] })
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
    const lead = buildRoute(stopsAt([a, a, b]))
    expect(lead.legs[0]!.length).toBe(0)
    const h0 = pointAt(lead, 0)
    expect(Number.isFinite(h0.heading)).toBe(true)
    expect(h0.heading).toBeCloseTo(90, 9)
    // A, B, B: the head ends on a zero-length leg and keeps the previous heading.
    const tail = buildRoute(stopsAt([a, b, b]))
    const end = pointAt(tail, tail.length)
    expect(end.legIndex).toBe(1)
    expect(end.heading).toBeCloseTo(90, 9)
    expect(end.at).toEqual(b)
    // Everything at one point: heading 0.
    const same = buildRoute(stopsAt([a, a, a]))
    expect(pointAt(same, 0)).toEqual({ at: a, heading: 0, legIndex: 1 })
  })
})

describe('slicePath', () => {
  test('ends exactly at the head', () => {
    const r = buildRoute(greekIslands())
    for (const d of [0, 0.001, r.legs[0]!.length, r.legs[0]!.length + 0.0123, r.length * 0.9, r.length, 99, -1]) {
      const slice = slicePath(r, d)
      expect(slice.at(-1)).toEqual(pointAt(r, d).at)
    }
  })

  test('starts at the first stop and has no repeated joints', () => {
    const p = greekIslands()
    const r = buildRoute(p)
    const slice = slicePath(r, r.length)
    expect(slice[0]).toEqual(p.stops[0]!.at)
    expect(slice.at(-1)).toEqual(p.stops[3]!.at)
    expect(slice).toHaveLength(r.legs.reduce((n, l) => n + l.path.length, 0) - (r.legs.length - 1))
    for (let i = 1; i < slice.length; i++) expect(slice[i]).not.toEqual(slice[i - 1])
  })

  test('is a prefix of the full path up to the head', () => {
    const base = stopsAt([[0, 0], [20, 0], [40, 10]])
    const r = buildRoute({
      ...base,
      legs: [{ mode: 'line', via: [[10, 10]] }, { mode: 'line', via: [] }],
    })
    const full = slicePath(r, r.length)
    const d = r.legs[0]!.length + r.legs[1]!.length / 2
    const slice = slicePath(r, d)
    expect(slice.slice(0, -1)).toEqual(full.slice(0, slice.length - 1))
    expect(slice).toHaveLength(r.legs[0]!.path.length + 1)
  })

  test('at distance zero is just the first stop', () => {
    const p = greekIslands()
    expect(slicePath(buildRoute(p), 0)).toEqual([p.stops[0]!.at])
  })

  test('at a leg boundary does not repeat the joint', () => {
    const r = buildRoute(greekIslands())
    const slice = slicePath(r, r.legs[0]!.length)
    expect(slice).toEqual(r.legs[0]!.path)
  })
})
