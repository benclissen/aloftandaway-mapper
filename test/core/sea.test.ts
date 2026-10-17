import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  allLand,
  decodeLand,
  haversineKm,
  headingDeg,
  landIndex,
  rasteriseTile,
  routeSea,
  seaLegKey,
  tileLand,
  toLngLat,
  toXY,
  WATER_ZOOM,
  withTiles,
  type LandSource,
  type LandTile,
  type LngLat,
  type SeaPath,
  type ViaPoint,
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

/** Points every `stepKm` or closer along the path, straight in Mercator between its points. */
function densePath(path: LngLat[], stepKm: number): LngLat[] {
  const out: LngLat[] = [path[0]!]
  for (let i = 1; i < path.length; i++) {
    const a = toXY(path[i - 1]!)
    const b = toXY(path[i]!)
    const n = Math.max(1, Math.ceil(haversineKm(path[i - 1]!, path[i]!) / stepKm))
    for (let k = 1; k <= n; k++) out.push(toLngLat([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]))
  }
  return out
}

/** West, south, east and north, in degrees. */
type Rect = [number, number, number, number]

/**
 * Natural Earth with zoom-12 tiles loaded wherever `rects` reach: land inside the rects, water elsewhere in those
 * tiles. The rects must not overlap.
 */
function tileIslands(rects: Rect[]): LandSource {
  const span = 2 ** WATER_ZOOM
  const extent = 4096
  // Each rect in tile units, x right and y down from the world's corner.
  const boxes = rects.map(([w, s, e, n]) => {
    const [x0, y1] = toXY([w, s])
    const [x1, y0] = toXY([e, n])
    return [x0 * span, y0 * span, x1 * span, y1 * span] as const
  })
  const touched = new Map<string, (typeof boxes)[number][]>()
  for (const box of boxes) {
    for (let tx = Math.floor(box[0]); tx <= Math.floor(box[2]); tx++) {
      for (let ty = Math.floor(box[1]); ty <= Math.floor(box[3]); ty++) {
        const key = `${tx}/${ty}`
        touched.set(key, [...(touched.get(key) ?? []), box])
      }
    }
  }
  const ring = (x0: number, y0: number, x1: number, y1: number) => [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ]
  const solid = allLand()
  const tiles = new Map<string, LandTile>()
  for (const [key, list] of touched) {
    const [tx, ty] = key.split('/').map(Number) as [number, number]
    const local = list.map(
      ([x0, y0, x1, y1]) => [(x0 - tx) * extent, (y0 - ty) * extent, (x1 - tx) * extent, (y1 - ty) * extent] as const,
    )
    if (local.some(([x0, y0, x1, y1]) => x0 <= 0 && y0 <= 0 && x1 >= extent && y1 >= extent)) {
      tiles.set(key, solid)
      continue
    }
    // One water feature over the whole tile, with each rect as a hole.
    const rings = [ring(-64, -64, extent + 64, extent + 64), ...local.map((b) => ring(...b))]
    tiles.set(key, rasteriseTile([{ rings }], extent))
  }
  return withTiles(land, tileLand(tiles), 'test-tiles')
}

/** Turns of more than 120° between consecutive 100 m steps, outside the stop connectors and near via points. */
function hairpins(r: SeaPath): string[] {
  const along = [0]
  for (let i = 1; i < r.path.length; i++) along.push(along[i - 1]! + haversineKm(r.path[i - 1]!, r.path[i]!))
  const total = along.at(-1)!
  const [gapA, gapB] = r.stopGapKm!
  const skip: [number, number][] = [
    [-Infinity, gapA + 0.1],
    [total - gapB - 0.1, Infinity],
    ...r.knots.slice(1, -1).map((k): [number, number] => [along[k]! - 0.2, along[k]! + 0.2]),
  ]
  const steps: { p: LngLat; d: number }[] = []
  let i = 0
  for (let d = 0; d <= total; d += 0.1) {
    while (i < r.path.length - 2 && along[i + 1]! < d) i++
    const len = along[i + 1]! - along[i]!
    const t = len > 0 ? Math.min(1, (d - along[i]!) / len) : 0
    const a = r.path[i]!
    const b = r.path[i + 1]!
    steps.push({ p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], d })
  }
  const at = steps.map((s) => s.p)
  const out: string[] = []
  for (let k = 1; k + 1 < steps.length; k++) {
    const lo = steps[k - 1]!.d
    const hi = steps[k + 1]!.d
    if (skip.some(([s, e]) => hi > s && lo < e)) continue
    const turn = turnAt(at, k)
    const { p, d } = steps[k]!
    if (turn > 120) out.push(`${Math.round(turn)}° at ${p[0].toFixed(4)}, ${p[1].toFixed(4)}, ${d.toFixed(1)} km`)
  }
  return out
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

  // Real cruise legs whose ports sit up estuaries, in archipelagos or past narrow straits.
  const ports: Record<string, LngLat> = {
    barcelona: [2.18, 41.38],
    lisbon: [-9.14, 38.7],
    piraeus: [23.62, 37.94],
    istanbul: [28.98, 41.01],
    southampton: [-1.4, 50.9],
    newYork: [-74.01, 40.7],
    stockholm: [18.07, 59.33],
    helsinki: [24.95, 60.17],
    copenhagen: [12.59, 55.69],
    oslo: [10.74, 59.9],
    seattle: [-122.34, 47.6],
    juneau: [-134.42, 58.3],
    bergen: [5.32, 60.39],
    geiranger: [7.21, 62.1],
    miami: [-80.17, 25.77],
    singapore: [103.85, 1.26],
    hongKong: [114.17, 22.28],
  }
  const legs: [string, string][] = [
    ['barcelona', 'lisbon'],
    ['piraeus', 'istanbul'],
    ['southampton', 'newYork'],
    ['lisbon', 'newYork'],
    ['stockholm', 'helsinki'],
    ['copenhagen', 'oslo'],
    ['seattle', 'juneau'],
    ['bergen', 'geiranger'],
    ['miami', 'barcelona'],
    ['singapore', 'hongKong'],
  ]
  /** Each leg is routed once, for both the tests that keep it at sea and the one that checks its turns. */
  const routed = new Map<string, SeaPath>()
  const routeOnce = (name: string, from: LngLat, to: LngLat, via: ViaPoint[] = []): SeaPath => {
    let r = routed.get(name)
    if (!r) routed.set(name, (r = routeSea(from, to, via, land)))
    return r
  }
  for (const [a, b] of legs) {
    it(`keeps ${a} to ${b} at sea`, () => {
      const from = ports[a]!
      const to = ports[b]!
      const r = ok(routeOnce(`${a} to ${b}`, from, to))
      expect(r.path[0]).toEqual(from)
      expect(r.path.at(-1)).toEqual(to)
      expect(r.crossesLand).toBeUndefined()
      atSeaBetweenConnectors(r.path)
    })
  }

  it("routes don't double back", () => {
    const greek: [string, LngLat, LngLat, ViaPoint[]][] = [
      ['Athens to Mykonos', [23.7275, 37.9838], [25.3289, 37.4467], []],
      ['Piraeus to Rhodes by Amorgos', piraeus, rhodes, [{ at: southOfAmorgos }]],
      ['Piraeus to Rhodes, sharp at Amorgos', piraeus, rhodes, [{ at: southOfAmorgos, sharp: true }]],
    ]
    const found: string[] = []
    type Case = [string, LngLat, LngLat, ViaPoint[]]
    const cases: Case[] = [...legs.map(([a, b]): Case => [`${a} to ${b}`, ports[a]!, ports[b]!, []]), ...greek]
    for (const [name, from, to, via] of cases) {
      for (const turn of hairpins(ok(routeOnce(name, from, to, via)))) found.push(`${name}: ${turn}`)
    }
    expect(found).toEqual([])
  })

  it('stopGapKm is the distance to the first water point', () => {
    // Barcelona's centre is on Natural Earth land; the end is out at sea.
    const from: LngLat = [2.1734, 41.3851]
    const to: LngLat = [3.0, 41.0]
    expect(land.isLand(from)).toBe(true)
    const r = ok(routeSea(from, to, [], land))
    const [gap, end] = r.stopGapKm!
    expect(end).toBe(0)
    expect(r.path.at(-1)).toEqual(to)
    expect(gap).toBeGreaterThan(0)
    expect(gap).toBeLessThan(5)
    // The connector runs straight from the stop to a water point exactly that far away.
    const i = r.path.findIndex((p) => Math.abs(haversineKm(from, p) - gap) < 1e-6)
    expect(i).toBeGreaterThan(0)
    expect(land.isLand(r.path[i]!)).toBe(false)
    const [ax, ay] = toXY(from)
    const [bx, by] = toXY(r.path[i]!)
    for (let k = 1; k < i; k++) {
      const [px, py] = toXY(r.path[k]!)
      const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
      expect(Math.abs(cross)).toBeLessThan(1e-9 * Math.hypot(bx - ax, by - ay))
      expect(haversineKm(from, r.path[k]!)).toBeLessThan(gap)
    }
  })

  it('a 150 m channel stays open at 50 m cells', () => {
    // A wall of two islands 100 km long across open sea, with a 150 m gap where the straight line crosses it.
    const half = 0.075 / 111.2
    const src = tileIslands([
      [-20.01, 59.5, -19.99, 60 - half],
      [-20.01, 60 + half, -19.99, 60.5],
    ])
    const from: LngLat = [-21.8, 60]
    const to: LngLat = [-18.2, 60]
    const r = ok(routeSea(from, to, [], src))
    expect(r.crossesLand).toBeUndefined()
    expect(r.stopGapKm![0]).toBeLessThan(0.1)
    expect(r.stopGapKm![1]).toBeLessThan(0.1)
    const points = densePath(r.path, 0.01)
    expect(points.filter((p) => src.isLand(p))).toEqual([])
    const inWall = points.filter((p) => p[0] > -20.01 && p[0] < -19.99)
    expect(inWall.length).toBeGreaterThan(0)
    expect(inWall.filter((p) => Math.abs(p[1] - 60) >= half)).toEqual([])
    expect(hairpins(r)).toEqual([])
  })

  it('a long tight stretch keeps 50 m cells', () => {
    // A channel 120 km long and 200 m wide through land that reaches past the search box on both sides.
    const lat = 60
    const half = 0.1 / 111.2
    const west = -31.08
    const east = west + 120 / (111.32 * Math.cos((lat * Math.PI) / 180))
    const src = tileIslands([
      [west, lat - 0.7, east, lat - half],
      [west, lat + half, east, lat + 0.7],
    ])
    const from: LngLat = [west - 0.06, lat]
    const to: LngLat = [east + 0.06, lat]
    const r = ok(routeSea(from, to, [], src))
    expect(r.crossesLand).toBeUndefined()
    expect(r.stopGapKm).toEqual([0, 0])
    expect(pathKm(r.path)).toBeLessThan(1.05 * haversineKm(from, to))
    expect(densePath(r.path, 0.01).filter((p) => src.isLand(p))).toEqual([])
    // The pieces join on a shared point without a kink.
    expect(hairpins(r)).toEqual([])
  })

  it('pieces join only on their shared water point', () => {
    // Two parallel channels 120 km long with a 20 m strip of land between them. The north one runs through, with a
    // dogleg near 94 km; the south one is cut by plugs into lengths that open into the north one only at their west
    // ends. The fine grids' boundary falls in the south length past 90 km, so the next piece starts where its own
    // water leads nowhere, with the through channel less than two fine cells away across the strip. The route must
    // go back and round by the link rather than step across.
    const lat = 60
    const kmLng = 111.32 * Math.cos((lat * Math.PI) / 180)
    const x = (km: number): number => -31.08 + km / kmLng
    const y = (m: number): number => lat + m / 111200
    const rects: Rect[] = [
      [x(0), y(100), x(92.8), lat + 0.7],
      [x(95.2), y(100), x(120), lat + 0.7],
      [x(92.8), y(400), x(95.2), lat + 0.7],
      [x(93), y(-20), x(95), y(200)],
      [x(0), lat - 0.7, x(120), y(-130)],
    ]
    let strip = 0
    for (const plug of [30, 60, 90, 115]) {
      rects.push([x(plug), y(-130), x(plug + 0.2), y(-40)], [x(strip), y(-40), x(plug + 0.2), y(-20)])
      strip = plug + 0.4
    }
    rects.push([x(strip), y(-40), x(120), y(-20)])
    const src = tileIslands(rects)
    const r = ok(routeSea([x(-3), lat], [x(123), lat], [], src))
    expect(r.crossesLand).toBeUndefined()
    expect(r.stopGapKm).toEqual([0, 0])
    expect(densePath(r.path, 0.005).filter((p) => src.isLand(p))).toEqual([])
  })

  it("a stop whose way out lies behind it still starts in its own water", () => {
    // A lagoon 11 km long that opens to the west, with the stop at its east end behind a wall 200 m thick, and the
    // end stop 300 km east. The coarse route goes straight through the wall; the fine route has to go round.
    const lat = 60
    const kmLng = 111.32 * Math.cos((lat * Math.PI) / 180)
    const lng = (km: number): number => -25 + km / kmLng
    const at = (km: number): number => lat + km / 111.2
    const src = tileIslands([
      [lng(-11), at(0.5), lng(0.2), at(3)],
      [lng(-11), at(-3), lng(0.2), at(-0.5)],
      [lng(0), at(-0.5), lng(0.2), at(0.5)],
    ])
    const from: LngLat = [lng(-0.25), lat]
    const to: LngLat = [lng(300), lat]
    const r = ok(routeSea(from, to, [], src))
    expect(r.stopGapKm).toEqual([0, 0])
    expect(r.crossesLand).toBeUndefined()
    expect(densePath(r.path, 0.01).filter((p) => src.isLand(p))).toEqual([])
    expect(Math.min(...r.path.map((p) => p[0]))).toBeLessThan(lng(-11))
  })

  it('widens the search when the way round lies outside the first box', () => {
    // Naples to Bari: the only way round Italy's toe is well south of both ports.
    const from: LngLat = [14.27, 40.84]
    const to: LngLat = [16.87, 41.13]
    const r = ok(routeSea(from, to, [], land))
    expect(Math.min(...r.path.map((p) => p[1]))).toBeLessThan(39.5)
    atSeaBetweenConnectors(r.path)
  })

  it('keeps one knot per control with several and coincident vias', () => {
    const v1: LngLat = [24.5, 37.6]
    const v2: LngLat = [26.0, 36.3]
    const via = [{ at: v1 }, { at: v1 }, { at: v2, sharp: true }, { at: southOfAmorgos }]
    const r = ok(routeSea(piraeus, rhodes, via, land))
    expect(r.knots).toHaveLength(via.length + 2)
    const controls = [piraeus, ...via.map((v) => v.at), rhodes]
    r.knots.forEach((k, i) => expect(r.path[k]).toEqual(controls[i]))
    for (let i = 1; i < r.knots.length; i++) expect(r.knots[i]!).toBeGreaterThanOrEqual(r.knots[i - 1]!)
    expect(r.knots[1]).toBe(r.knots[2])
    expect(r.knots.at(-1)).toBe(r.path.length - 1)
  })

  it('seaLegKey is stable and input-sensitive', () => {
    const key = seaLegKey(piraeus, rhodes, [{ at: southOfAmorgos }])
    expect(key).toMatch(/^[0-9a-f]{16}$/)
    expect(seaLegKey(piraeus, rhodes, [{ at: southOfAmorgos }])).toBe(key)
    expect(seaLegKey(piraeus, rhodes, [{ at: southOfAmorgos, sharp: false }])).toBe(key)
    expect(seaLegKey(piraeus, rhodes, [{ at: southOfAmorgos, sharp: true }])).not.toBe(key)
  })
})
