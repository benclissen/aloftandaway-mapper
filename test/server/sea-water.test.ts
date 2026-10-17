import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fromVectorTileJs, type VectorTileLike } from '@maplibre/vt-pbf'
import { afterEach, describe, expect, it } from 'vitest'
import {
  decodeLand,
  encodeLand,
  haversineKm,
  landIndex,
  routeSea,
  tilesNear,
  toLngLat,
  toXY,
  WATER_ZOOM,
  type LandSource,
  type LngLat,
  type SeaPath,
} from '../../src/core/index.js'
import { createSeaWater, type SeaBudget, type SeaWater } from '../../src/server/sea-water.js'
import { createTileStore, USER_AGENT, type TileStore } from '../../src/server/tiles.js'
import { startFakeTiles, type FakeTiles } from '../helpers/fake-tiles.js'

const SPAN = 2 ** WATER_ZOOM
const EXTENT = 4096
const BUILD = '20261001_000000_pt'

/** West, south, east and north, in degrees. */
type Rect = [number, number, number, number]
type Pt = { x: number; y: number }

const source = (rings: LngLat[][]): LandSource => landIndex(decodeLand(encodeLand('t', rings)))
const box = ([w, s, e, n]: Rect): LngLat[] => [[w, s], [e, s], [e, n], [w, n]]
const inRect = ([lng, lat]: LngLat, [w, s, e, n]: Rect): boolean => lng > w && lng < e && lat > s && lat < n

/** The zoom-12 tile at a point, as [x, y]. */
const tileAt = (at: LngLat): [number, number] => {
  const [x, y] = toXY(at)
  return [Math.floor(x * SPAN), Math.floor(y * SPAN)]
}
/** The tile's centre. */
const centreOf = (tx: number, ty: number): LngLat => toLngLat([(tx + 0.5) / SPAN, (ty + 0.5) / SPAN])

/** The test area: the tile holding 20° W, 60° N. Its centre is where islands and channels go. */
const [TX, TY] = tileAt([-20, 60])
const [CX, CY] = centreOf(TX, TY)
const FROM: LngLat = [CX - 0.3, CY]
const TO: LngLat = [CX + 0.3, CY]

/** A closed ring in a tile's own units, rounded, clamped a little past the tile's edges. */
function tileRing(tx: number, ty: number, [w, s, e, n]: Rect): Pt[] {
  const unit = ([lng, lat]: LngLat): Pt => {
    const [x, y] = toXY([lng, lat])
    const clamp = (v: number): number => Math.round(Math.min(EXTENT + 64, Math.max(-64, v)))
    return { x: clamp((x * SPAN - tx) * EXTENT), y: clamp((y * SPAN - ty) * EXTENT) }
  }
  const a = unit([w, n])
  const b = unit([e, s])
  return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a]
}

const WHOLE: Pt[] = [
  { x: -64, y: -64 },
  { x: EXTENT + 64, y: -64 },
  { x: EXTENT + 64, y: EXTENT + 64 },
  { x: -64, y: EXTENT + 64 },
  { x: -64, y: -64 },
]

type Feature = { props: Record<string, string | number | boolean>; rings: Pt[][] }

/** A vector tile with the given layers of polygon features. */
function encodeTile(layers: Record<string, Feature[]>): Uint8Array {
  const tile: VectorTileLike = {
    layers: Object.fromEntries(
      Object.entries(layers).map(([name, features]) => [
        name,
        {
          version: 2,
          name,
          extent: EXTENT,
          length: features.length,
          feature: (i: number) => ({
            type: 3 as const,
            properties: features[i]!.props,
            id: undefined,
            extent: EXTENT,
            loadGeometry: () => features[i]!.rings as never,
          }),
        },
      ]),
    ),
  }
  return fromVectorTileJs(tile)
}

/** A tile that's water but for `land`, which must not overlap: one water feature with each rect as a hole. */
const waterBut = (tx: number, ty: number, land: Rect[], extra: Feature[] = []): Uint8Array =>
  encodeTile({ water: [{ props: { class: 'ocean' }, rings: [WHOLE, ...land.map((r) => tileRing(tx, ty, r))] }, ...extra] })

/** Tiles touching any rect, as "x/y". */
function tilesTouching(rects: Rect[]): string[] {
  const keys = new Set<string>()
  for (const [w, s, e, n] of rects) {
    const [x0, y0] = tileAt([w, n])
    const [x1, y1] = tileAt([e, s])
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) keys.add(`${x}/${y}`)
  }
  return [...keys]
}

/** Points every `stepKm` or closer along the path. */
function densePath(p: LngLat[], stepKm: number): LngLat[] {
  const out: LngLat[] = [p[0]!]
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1]!
    const b = p[i]!
    const n = Math.max(1, Math.ceil(haversineKm(a, b) / stepKm))
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n])
  }
  return out
}

const opened: Array<() => Promise<void>> = []
afterEach(async () => {
  while (opened.length) await opened.pop()!()
})

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `mapper-sea-${name}-`))
  opened.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

interface World {
  fake: FakeTiles
  store: TileStore
  water: SeaWater
  /** Tile requests the fake saw, as "x/y", in order. */
  tileRequests(): string[]
}

/** A fake OpenFreeMap serving `tiles` (by "x/y") at zoom 12, a fresh cache, and a sea router on them. */
async function world(tiles: Map<string, Uint8Array>, opts: { maxRounds?: number } = {}): Promise<World> {
  const root = await tempDir('tiles')
  for (const [key, bytes] of tiles) {
    const [x, y] = key.split('/')
    const file = path.join(root, BUILD, String(WATER_ZOOM), x!, `${y}.pbf`)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, bytes)
  }
  const fake = await startFakeTiles(root)
  opened.push(() => fake.close())
  const store = createTileStore({ cacheDir: await tempDir('cache'), upstream: fake.url, retryDelaysMs: [] })
  return {
    fake,
    store,
    water: createSeaWater({ store, ...opts }),
    tileRequests: () =>
      fake.requests.flatMap((url) => {
        const m = /^\/planet\/[\w.-]+\/12\/(\d+)\/(\d+)\.pbf$/.exec(url)
        return m ? [`${m[1]}/${m[2]}`] : []
      }),
  }
}

const budget = (tiles = 2500): SeaBudget => ({ tiles })

/** A 2 km island at the test tile's centre, across the straight line. */
const ISLAND: Rect = [CX - 0.018, CY - 0.009, CX + 0.018, CY + 0.009]
/** Natural Earth land 11 km south of the line, so the coast filter keeps the tiles along it. */
const COAST: Rect = [CX - 3, CY - 0.2, CX + 3, CY - 0.1]
const coastBase = source([box(COAST)])

const ok = (r: SeaPath): SeaPath => {
  expect(r.reason).toBeUndefined()
  expect(r.status).toBe('ok')
  return r
}

describe('SeaWater.route', () => {
  it('an island only the tiles have is avoided', async () => {
    // Natural Earth has open sea along the line; only the tile has the island.
    expect(densePath(routeSea(FROM, TO, [], coastBase).path, 0.05).some((p) => inRect(p, ISLAND))).toBe(true)
    const w = await world(new Map([[`${TX}/${TY}`, waterBut(TX, TY, [ISLAND])]]))
    const r = await w.water.route(FROM, TO, [], coastBase, budget())
    ok(r)
    expect(r.crossesLand).toBeUndefined()
    expect(r.unverified).toBeUndefined()
    expect(r.water).toMatchObject({ build: BUILD })
    expect(densePath(r.path, 0.01).filter((p) => inRect(p, ISLAND))).toEqual([])
  })

  it('a channel only the tiles have is used', async () => {
    // A wall of Natural Earth land 1 km thick and 2,200 km long across the line, so there is no way round: on Natural
    // Earth the route stops at the wall and a stop connector jumps it. The tiles draw the same wall with a 300 m
    // channel through it at the tile's centre.
    const half = 0.15 / 111.2
    const wall: Rect = [CX - 0.01, 50, CX + 0.01, 70]
    const base = source([box(wall)])
    expect(routeSea(FROM, TO, [], base).stopGapKm![1]).toBeGreaterThan(10)
    const north: Rect = [wall[0], CY + half, wall[2], wall[3]]
    const south: Rect = [wall[0], wall[1], wall[2], CY - half]
    const tiles = new Map<string, Uint8Array>()
    for (const key of tilesTouching([[CX - 0.5, CY - 0.2, CX + 0.5, CY + 0.2]])) {
      const [x, y] = key.split('/').map(Number) as [number, number]
      tiles.set(key, waterBut(x, y, x === TX ? [north, south] : []))
    }
    const w = await world(tiles)
    const r = await w.water.route(FROM, TO, [], base, budget())
    ok(r)
    expect(r.crossesLand).toBeUndefined()
    expect(r.stopGapKm![0]).toBeLessThan(0.1)
    expect(r.stopGapKm![1]).toBeLessThan(0.1)
    expect(r.water).toMatchObject({ build: BUILD })
    const points = densePath(r.path, 0.01)
    expect(points.filter((p) => inRect(p, north) || inRect(p, south))).toEqual([])
    expect(points.some((p) => p[0] > wall[0] && p[0] < wall[2])).toBe(true)
  })

  it('the rounds stop when the route needs no new tile', async () => {
    const w = await world(new Map([[`${TX}/${TY}`, waterBut(TX, TY, [ISLAND])]]))
    const r = await w.water.route(FROM, TO, [], coastBase, budget())
    ok(r)
    if (!('build' in r.water)) throw new Error(`unverified: ${r.water.unverified}`)
    expect(r.water.rounds).toBeGreaterThanOrEqual(1)
    expect(r.water.rounds).toBeLessThan(12)
    // Each tile was fetched once, and the final route needs none it doesn't have.
    const fetched = w.tileRequests()
    expect(new Set(fetched).size).toBe(fetched.length)
    expect(fetched.length).toBe(r.water.tiles)
    const near = tilesNear(r.path, { zoom: WATER_ZOOM, bufferKm: 2, coast: coastBase, coastKm: 20 })
    expect(near.filter((key) => !fetched.includes(key))).toEqual([])
    // Routing again needs no new requests and gives the same answer.
    const before = w.fake.requests.length
    const again = await w.water.route(FROM, TO, [], coastBase, budget())
    expect(w.fake.requests.length).toBe(before)
    expect(again).toEqual(r)
    // With no rounds allowed, the Natural Earth route comes back unsettled, having fetched nothing.
    const none = await world(new Map(), { maxRounds: 0 })
    const unsettled = await none.water.route(FROM, TO, [], coastBase, budget())
    expect(unsettled.water).toEqual({ unverified: 'unsettled' })
    expect(unsettled.unverified).toBe('unsettled')
    expect(unsettled.path).toEqual(routeSea(FROM, TO, [], coastBase).path)
    expect(none.tileRequests()).toEqual([])
  })

  it("a warm cache of unrelated tiles doesn't change the route", async () => {
    // More islands north and south of the line, which the warming legs pass and load.
    const others: Rect[] = [-2.4, -1.6, -0.8, -0.4, 0.4, 0.8, 1.6, 2.4].flatMap((dx): Rect[] => [
      [CX + dx - 0.02, CY + 0.03, CX + dx + 0.02, CY + 0.04],
      [CX + dx - 0.02, CY - 0.07, CX + dx + 0.02, CY - 0.06],
    ])
    const rects = [ISLAND, ...others]
    const tiles = new Map<string, Uint8Array>()
    for (const key of tilesTouching(rects)) {
      const [x, y] = key.split('/').map(Number) as [number, number]
      tiles.set(key, waterBut(x, y, rects))
    }
    const warm = await world(tiles)
    const first = await warm.water.route(FROM, TO, [], coastBase, budget())
    ok(first)
    const firstTiles = new Set(warm.tileRequests())
    for (const lat of [CY + 0.06, CY - 0.045, CY + 0.02]) {
      await warm.water.route([CX - 2.8, lat], [CX + 2.8, lat], [], coastBase, budget())
    }
    const loaded = new Set(warm.tileRequests())
    expect([...loaded].filter((key) => !firstTiles.has(key)).length).toBeGreaterThanOrEqual(200)

    const cold = await world(tiles)
    const fresh = await cold.water.route(FROM, TO, [], coastBase, budget())
    const again = await warm.water.route(FROM, TO, [], coastBase, budget())
    expect(fresh).toEqual(first)
    expect(again).toEqual(first)
  })

  it("router fetches stay within OpenFreeMap's download rules", async () => {
    const tiles = new Map([[`${TX}/${TY}`, waterBut(TX, TY, [ISLAND])]])
    const w = await world(tiles)
    w.fake.delayMs = 20
    const small = budget(10)
    const r = await w.water.route(FROM, TO, [], coastBase, small)
    expect(w.tileRequests()).toHaveLength(10)
    expect(small.tiles).toBe(0)
    expect(r.water).toEqual({ unverified: 'budget' })
    expect(r.unverified).toBe('budget')

    const all = await world(tiles)
    all.fake.delayMs = 20
    const big = budget()
    const done = await all.water.route(FROM, TO, [], coastBase, big)
    if (!('build' in done.water)) throw new Error(`unverified: ${done.water.unverified}`)
    expect(done.water.tiles).toBeGreaterThan(10)
    expect(big.tiles).toBe(2500 - done.water.tiles)
    for (const f of [w.fake, all.fake]) {
      expect(f.inFlightMax).toBeLessThanOrEqual(4)
      expect(f.userAgents.length).toBe(f.requests.length)
      expect(f.userAgents.every((ua) => ua === USER_AGENT)).toBe(true)
    }
    expect(all.fake.inFlightMax).toBe(4)
  })

  it('offline gives the Natural Earth route, unverified', async () => {
    const ne = routeSea(FROM, TO, [], coastBase)
    // Nothing answers at all.
    const refused = createTileStore({ cacheDir: await tempDir('cache'), upstream: 'http://127.0.0.1:9', retryDelaysMs: [] })
    const t0 = Date.now()
    const r = await createSeaWater({ store: refused }).route(FROM, TO, [], coastBase, budget())
    expect(r).toEqual({ ...ne, unverified: 'offline', water: { unverified: 'offline' } })
    // The TileJSON is cached, then the server goes away before any tile.
    const w = await world(new Map())
    await w.store.planetBuild()
    await w.fake.close()
    const left = budget()
    const later = await w.water.route(FROM, TO, [], coastBase, left)
    expect(later).toEqual({ ...ne, unverified: 'offline', water: { unverified: 'offline' } })
    // Only the requests that went out are charged: one per worker before the first failure.
    expect(left.tiles).toBeGreaterThanOrEqual(2500 - 4)
    expect(Date.now() - t0).toBeLessThan(10_000)
  })

  it('a tunnel is not water', async () => {
    // A tunnel's water feature covers the island; the island is still land.
    const tunnel: Feature = { props: { class: 'river', brunnel: 'tunnel' }, rings: [tileRing(TX, TY, ISLAND)] }
    const w = await world(new Map([[`${TX}/${TY}`, waterBut(TX, TY, [ISLAND], [tunnel])]]))
    const r = await w.water.route(FROM, TO, [], coastBase, budget())
    ok(r)
    expect(r.crossesLand).toBeUndefined()
    expect(densePath(r.path, 0.01).filter((p) => inRect(p, ISLAND))).toEqual([])
  })

  it('a tile with no water layer is land inland and water at sea', async () => {
    const other = encodeTile({ landcover: [{ props: { class: 'grass' }, rings: [WHOLE] }] })
    // At sea by Natural Earth: the tile without water, and every 204 around it, are all water, so the line is clear.
    const sea = await world(new Map([[`${TX}/${TY}`, other]]))
    const straight = await sea.water.route(FROM, TO, [], coastBase, budget())
    ok(straight)
    expect(straight.crossesLand).toBeUndefined()
    expect(straight.water).toMatchObject({ build: BUILD })
    expect(densePath(straight.path, 0.05).some((p) => inRect(p, ISLAND))).toBe(true)

    // Inland by Natural Earth: the wall's tile has no water layer, so it is all land and its channel is shut.
    const half = 0.15 / 111.2
    const wall: Rect = [CX - 0.01, 50, CX + 0.01, 70]
    const base = source([box(wall)])
    const tiles = new Map<string, Uint8Array>()
    for (const key of tilesTouching([[CX - 0.5, CY - 0.2, CX + 0.5, CY + 0.2]])) {
      const [x, y] = key.split('/').map(Number) as [number, number]
      const pieces: Rect[] = [
        [wall[0], CY + half, wall[2], wall[3]],
        [wall[0], wall[1], wall[2], CY - half],
      ]
      tiles.set(key, x === TX && y === TY ? other : waterBut(x, y, x === TX ? pieces : []))
    }
    const land = await world(tiles)
    const shut = await land.water.route(FROM, TO, [], base, budget())
    // The route can't get through, so it stops at the wall again.
    expect(shut.stopGapKm![1]).toBeGreaterThan(10)
    expect(shut.water).toMatchObject({ build: BUILD })
    expect(land.tileRequests()).toContain(`${TX}/${TY}`)
  })
})
