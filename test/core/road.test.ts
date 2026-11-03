import { describe, expect, it } from 'vitest'
import {
  haversineKm,
  legProfile,
  roadLegKey,
  roadLegsOf,
  roadPath,
  roadProfile,
  SYMBOLS,
  type LngLat,
  type OsrmAnswer,
  type Project,
} from '../../src/core/index.js'
import { sceneOf, stopsAt } from '../fixtures/projects.js'

/** An OSRM answer with one route along `line`, and waypoints at `waypoints` when given. */
const answer = (line: LngLat[], waypoints?: LngLat[]): OsrmAnswer => ({
  code: 'Ok',
  routes: [{ geometry: { coordinates: line } }],
  ...(waypoints ? { waypoints: waypoints.map((location) => ({ location })) } : {}),
})

/** Degrees of latitude per metre, near enough on a sphere. */
const M = 1 / 111_195

describe('roadProfile', () => {
  it('maps every symbol', () => {
    expect(roadProfile('walk')).toBe('foot')
    expect(roadProfile('bike')).toBe('bike')
    for (const symbol of ['train', 'tram', 'cable-car'] as const) expect(roadProfile(symbol)).toBeUndefined()
    const special = new Set(['walk', 'bike', 'train', 'tram', 'cable-car'])
    for (const symbol of SYMBOLS) if (!special.has(symbol)) expect(roadProfile(symbol), symbol).toBe('car')
  })
})

describe('legProfile', () => {
  it('is undefined off land', () => {
    expect(legProfile({ mode: 'line', symbol: 'car' }, { symbol: 'car' })).toBeUndefined()
    expect(legProfile({ mode: 'sea' }, { symbol: 'car' })).toBeUndefined()
    expect(legProfile({ mode: 'land' }, { symbol: 'walk' })).toBe('foot')
    expect(legProfile({ mode: 'land', symbol: 'bike' }, { symbol: 'walk' })).toBe('bike')
    expect(legProfile({ mode: 'land', symbol: 'train' }, { symbol: 'car' })).toBeUndefined()
  })
})

describe('roadLegKey', () => {
  it('changes with each input and ignores sharp', () => {
    const from: LngLat = [25.4, 36.4]
    const to: LngLat = [25.38, 36.46]
    const key = roadLegKey('car', from, to, [{ at: [25.39, 36.43] }])
    expect(key).toMatch(/^road:[0-9a-f]{16}$/)
    expect(roadLegKey('car', from, to, [{ at: [25.39, 36.43] }])).toBe(key)
    const others = [
      roadLegKey('foot', from, to, [{ at: [25.39, 36.43] }]),
      roadLegKey('car', [25.41, 36.4], to, [{ at: [25.39, 36.43] }]),
      roadLegKey('car', from, [25.38, 36.47], [{ at: [25.39, 36.43] }]),
      roadLegKey('car', from, to, [{ at: [25.39, 36.44] }]),
      roadLegKey('car', from, to, []),
    ]
    expect(new Set([key, ...others]).size).toBe(others.length + 1)
    expect(roadLegKey('car', from, to, [{ at: [25.39, 36.43], sharp: true }])).toBe(key)
  })
})

describe('roadLegsOf', () => {
  const a: LngLat = [7.262, 43.7102]
  const b: LngLat = [7.0174, 43.5528]
  const c: LngLat = [6.6407, 43.2727]

  const project = (symbol: 'car' | 'walk'): Project => {
    const p = stopsAt([a, b, c])
    const scene = sceneOf(p)
    scene.look.symbol = symbol
    scene.legs = [
      { mode: 'land', via: [{ at: [7.1, 43.6] }] },
      { mode: 'line', via: [] },
    ]
    return p
  }

  it('follows look.symbol', () => {
    const car = roadLegsOf(project('car'))
    const carKey = roadLegKey('car', a, b, [{ at: [7.1, 43.6] }])
    expect([...car.keys()]).toEqual([carKey])
    expect(car.get(carKey)).toEqual({ profile: 'car', from: a, to: b, via: [[7.1, 43.6]] })

    const walk = roadLegsOf(project('walk'))
    const walkKey = roadLegKey('foot', a, b, [{ at: [7.1, 43.6] }])
    expect(walkKey).not.toBe(carKey)
    expect([...walk.keys()]).toEqual([walkKey])
    expect(walk.get(walkKey)?.profile).toBe('foot')
  })

  it('uses a leg symbol over the look and skips other modes', () => {
    const p = project('car')
    const scene = sceneOf(p)
    scene.legs = [
      { mode: 'land', via: [], symbol: 'bike' },
      { mode: 'sea', via: [] },
    ]
    expect([...roadLegsOf(p).values()]).toEqual([{ profile: 'bike', from: a, to: b, via: [] }])
    scene.legs = [
      { mode: 'line', via: [] },
      { mode: 'sea', via: [] },
    ]
    expect(roadLegsOf(p).size).toBe(0)
  })

  it("includes context land legs with the scene's look", () => {
    const p = project('walk')
    const scene = sceneOf(p)
    scene.legs = [
      { mode: 'line', via: [] },
      { mode: 'line', via: [] },
    ]
    const x: LngLat = [6.9, 43.4]
    const y: LngLat = [6.8, 43.3]
    scene.context = {
      from: 'Elsewhere',
      stops: [
        { name: 'X', at: x },
        { name: 'Y', at: y },
        { name: 'Z', at: c },
      ],
      legs: [
        { mode: 'land', via: [] },
        { mode: 'sea', via: [] },
      ],
    }
    const legs = roadLegsOf(p)
    expect([...legs.keys()]).toEqual([roadLegKey('foot', x, y, [])])
    expect(legs.get(roadLegKey('foot', x, y, []))).toEqual({ profile: 'foot', from: x, to: y, via: [] })
  })

  it('skips a leg without both stops', () => {
    const p = stopsAt([a])
    sceneOf(p).legs = [{ mode: 'land', via: [] }]
    expect(roadLegsOf(p).size).toBe(0)
  })
})

describe('roadPath', () => {
  it('adds joins and pins the stops', () => {
    const from: LngLat = [0, 0]
    const to: LngLat = [0.01, 0]
    const road = roadPath(
      answer([
        [0, 0.001],
        [0.005, 0.001],
        [0.01, 0.001],
      ]),
      from,
      to,
      [],
    )
    expect(road.status).toBe('ok')
    expect(road.path[0]).toEqual(from)
    expect(road.path.at(-1)).toEqual(to)
    expect(road.path).toContainEqual([0, 0.001])
    expect(road.path).toContainEqual([0.01, 0.001])
    expect(road.knots).toEqual([0, road.path.length - 1])
    expect(road.stopGapKm![0]).toBeCloseTo(0.111, 2)
    expect(road.stopGapKm![1]).toBeCloseTo(0.111, 2)
  })

  it('keeps a far stop as a join', () => {
    const from: LngLat = [0, -1200 * M]
    const road = roadPath(
      answer([
        [0, 0],
        [0.001, 0],
      ]),
      from,
      [0.001, 0],
      [],
    )
    expect(road.status).toBe('ok')
    expect(road.stopGapKm![0]).toBeGreaterThan(1.1)
    expect(road.path[0]).toEqual(from)
    expect(road.path[1]).toEqual([0, 0])
  })

  it('finds via knots in order on an out-and-back route', () => {
    const A: LngLat = [0, 0]
    const B: LngLat = [0.01, 0.002]
    const C: LngLat = [0.02, 0]
    const from: LngLat = [0, -0.001]
    const to: LngLat = [0, 0.001]
    const road = roadPath(answer([A, B, C, B, A], [from, C, B, to]), from, to, [
      [0.02, 0.0005],
      [0.01, 0.0025],
    ])
    expect(road.knots).toHaveLength(4)
    expect(road.knots[0]).toBe(0)
    expect(road.knots[3]).toBe(road.path.length - 1)
    for (let i = 1; i < road.knots.length; i++) expect(road.knots[i]!).toBeGreaterThan(road.knots[i - 1]!)
    expect(road.path[road.knots[1]!]).toEqual(C)
    expect(road.path[road.knots[2]!]).toEqual(B)
    // B' comes after C on the way back, not the outbound B before it.
    expect(road.path.slice(0, road.knots[1]!)).toContainEqual(B)
  })

  it('falls back to the via points when the waypoints are missing', () => {
    const A: LngLat = [0, 0]
    const B: LngLat = [0.01, 0.002]
    const C: LngLat = [0.02, 0]
    const road = roadPath(answer([A, B, C, B, A], [A, A]), [0, -0.001], [0, 0.001], [C, B])
    for (let i = 1; i < road.knots.length; i++) expect(road.knots[i]!).toBeGreaterThan(road.knots[i - 1]!)
    expect(road.path[road.knots[1]!]).toEqual(C)
    expect(road.path[road.knots[2]!]).toEqual(B)
  })

  it('simplifies but keeps a hairpin', () => {
    const straight: LngLat[] = Array.from({ length: 200 }, (_, i) => [i * M, 0])
    const flat = roadPath(answer(straight), straight[0]!, straight.at(-1)!, [])
    expect(flat.path.length).toBeLessThanOrEqual(4)
    expect(flat.path[0]).toEqual(straight[0])
    expect(flat.path.at(-1)).toEqual(straight.at(-1))

    // Up 500 m, across 20 m, and back down, a point every metre.
    const up: LngLat[] = Array.from({ length: 501 }, (_, i) => [0, i * M])
    const down: LngLat[] = Array.from({ length: 501 }, (_, i) => [20 * M, (500 - i) * M])
    const apex = up.at(-1)!
    const hairpin = roadPath(answer([...up, ...down]), up[0]!, down.at(-1)!, [])
    expect(hairpin.path.length).toBeLessThan(10)
    expect(hairpin.path).toContainEqual([0, Math.round(apex[1] * 1e6) / 1e6])
    expect(hairpin.path).toContainEqual([Math.round(20 * M * 1e6) / 1e6, Math.round(500 * M * 1e6) / 1e6])
  })

  it('unwraps across 180°', () => {
    const road = roadPath(
      answer([
        [179.999, 0.0001],
        [-179.999, 0.0001],
      ]),
      [179.999, 0],
      [-179.999, 0],
      [],
    )
    expect(road.path[0]).toEqual([179.999, 0])
    for (let i = 1; i < road.path.length; i++) {
      expect(Math.abs(road.path[i]![0] - road.path[i - 1]![0])).toBeLessThan(1)
    }
    expect(road.path.at(-1)![0]).toBeCloseTo(180.001, 9)
    expect(haversineKm(road.path.at(-1)!, [-179.999, 0])).toBeLessThan(1e-9)
  })

  it('keeps a start and an end at zero length', () => {
    const p: LngLat = [10, 50]
    for (const line of [[p], [[10.0001, 50] as LngLat], []]) {
      const road = roadPath(answer(line), p, p, [])
      expect(road.status).toBe('ok')
      expect(road.path.length).toBeGreaterThanOrEqual(2)
      expect(road.knots).toEqual([0, road.path.length - 1])
      expect(road.path[0]).toEqual(p)
      expect(road.path.at(-1)).toEqual(p)
    }
  })
})
