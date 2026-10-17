import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
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
import { createTileStore, USER_AGENT, type TileReply, type TileStore } from '../../src/server/tiles.js'
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
  /** The fake's tile folder for BUILD at zoom 12, and the store's: `<dir>/<x>/<y>.pbf`. */
  served: string
  cached: string
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
  const cacheDir = await tempDir('cache')
  const store = createTileStore({ cacheDir, upstream: fake.url, retryDelaysMs: [] })
  return {
    served: path.join(root, BUILD, String(WATER_ZOOM)),
    cached: path.join(cacheDir, 'tiles', 'planet', BUILD, String(WATER_ZOOM)),
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

  it('tiles already on disk cost nothing from the budget', async () => {
    // Every tile the route could ask for is a real tile, so each one fetched is written to disk.
    const tiles = new Map<string, Uint8Array>()
    for (const key of tilesTouching([[CX - 0.6, CY - 0.15, CX + 0.6, CY + 0.15]])) {
      const [x, y] = key.split('/').map(Number) as [number, number]
      tiles.set(key, waterBut(x, y, x === TX && y === TY ? [ISLAND] : []))
    }
    const w = await world(tiles)
    const first = await w.water.route(FROM, TO, [], coastBase, budget())
    if (!('build' in first.water)) throw new Error(`unverified: ${first.water.unverified}`)
    expect(w.tileRequests().every((key) => tiles.has(key))).toBe(true)
    expect(first.water.tiles).toBeGreaterThan(5)
    // A fresh router on the same disk cache, with a budget far smaller than the tile count.
    const before = w.fake.requests.length
    const small = budget(5)
    const again = await createSeaWater({ store: w.store }).route(FROM, TO, [], coastBase, small)
    expect(w.fake.requests.length).toBe(before)
    expect(again).toEqual(first)
    expect(small.tiles).toBe(5)
  })

  it('a budget stop gives the same path on a warm and a cold SeaWater', async () => {
    // The budget runs out partway through the first round, after the island's tile has been fetched.
    const ne = routeSea(FROM, TO, [], coastBase)
    const need = tilesNear(ne.path, { zoom: WATER_ZOOM, bufferKm: 2, coast: coastBase, coastKm: 20 })
    const at = need.indexOf(`${TX}/${TY}`)
    expect(at).toBeGreaterThanOrEqual(0)
    expect(need.length).toBeGreaterThan(at + 1)
    const tiles = new Map([[`${TX}/${TY}`, waterBut(TX, TY, [ISLAND])]])

    const cold = await world(tiles)
    const fromCold = await cold.water.route(FROM, TO, [], coastBase, budget(at + 1))
    expect(cold.tileRequests()).toContain(`${TX}/${TY}`)

    // Warm with tiles of an unrelated leg along the coast's far side, 28 km south.
    const warm = await world(tiles)
    await warm.water.route([CX - 2.8, CY - 0.25], [CX + 2.8, CY - 0.25], [], coastBase, budget())
    expect(warm.tileRequests().length).toBeGreaterThan(20)
    expect(warm.tileRequests().filter((key) => need.includes(key))).toEqual([])
    const fromWarm = await warm.water.route(FROM, TO, [], coastBase, budget(at + 1))

    // Both route on the rounds that finished, which here is none: the Natural Earth route.
    expect(fromCold).toEqual({ ...ne, unverified: 'budget', water: { unverified: 'budget' } })
    expect(fromWarm).toEqual(fromCold)
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

  it('a slow network failure is remembered from when it came back', async () => {
    // Each failure takes as long as the store's timeouts and retries can: about two minutes on the router's clock.
    let clock = 0
    let tilesFail = false
    const calls = { build: 0, tiles: 0 }
    const store: TileStore = {
      async get() {
        calls.tiles++
        clock += 125_000
        throw new Error('timed out')
      },
      async forget() {},
      async planetBuild() {
        calls.build++
        if (tilesFail) return BUILD
        clock += 125_000
        throw new Error('timed out')
      },
    }
    const water = createSeaWater({ store, now: () => clock })
    const offline = { ...routeSea(FROM, TO, [], coastBase), unverified: 'offline', water: { unverified: 'offline' } }
    expect(await water.route(FROM, TO, [], coastBase, budget())).toEqual(offline)
    expect(calls).toEqual({ build: 1, tiles: 0 })
    // Straight after, the next route doesn't wait for the network again.
    expect(await water.route(FROM, TO, [], coastBase, budget())).toEqual(offline)
    expect(calls).toEqual({ build: 1, tiles: 0 })
    // A minute after the failure came back it tries again. This time the tiles are slow to fail.
    clock += 61_000
    tilesFail = true
    expect(await water.route(FROM, TO, [], coastBase, budget())).toEqual(offline)
    expect(calls.build).toBe(2)
    const tried = calls.tiles
    expect(tried).toBeGreaterThan(0)
    expect(await water.route(FROM, TO, [], coastBase, budget())).toEqual(offline)
    expect(calls).toEqual({ build: 2, tiles: tried })
  })

  it('a route that verifies clears the memory of a failure', async () => {
    // One route's tiles are held back while another's fail, then the first finishes and verifies.
    let mode: 'hold' | 'fail' | 'open' = 'hold'
    let builds = 0
    let release!: () => void
    const gate = new Promise<void>((go) => (release = go))
    let asked!: () => void
    const held = new Promise<void>((go) => (asked = go))
    const empty: TileReply = { status: 204, body: Buffer.alloc(0), fromCache: false }
    const store: TileStore = {
      async get() {
        if (mode === 'fail') throw new Error('refused')
        if (mode === 'hold') {
          asked()
          await gate
        }
        return empty
      },
      async forget() {},
      async planetBuild() {
        builds++
        return BUILD
      },
    }
    const water = createSeaWater({ store, now: () => 0 })
    const first = water.route(FROM, TO, [], coastBase, budget())
    await held
    mode = 'fail'
    expect((await water.route(FROM, TO, [], coastBase, budget())).unverified).toBe('offline')
    mode = 'open'
    release()
    expect((await first).water).toMatchObject({ build: BUILD })
    // Within the failure's minute, but the network has answered since: the next route goes to it.
    const before = builds
    const next = await water.route(FROM, TO, [], coastBase, budget())
    expect(builds).toBe(before + 1)
    expect(next.water).toMatchObject({ build: BUILD })
  })

  /** FROM and TO moved `tiles` whole tiles east (or west, when negative), onto tiles the first leg never touched. */
  const shifted = (tiles: number): [LngLat, LngLat] => {
    const d = (tiles * 360) / SPAN
    return [
      [FROM[0] + d, FROM[1]],
      [TO[0] + d, TO[1]],
    ]
  }
  // Twenty tiles is about 1.8° of longitude: clear of the first leg's tiles, and still along the coast.
  const EAST = shifted(20)
  const WEST = shifted(-20)

  it('the shifted legs need tiles of their own', () => {
    const near = ([a, b]: [LngLat, LngLat]): string[] =>
      tilesNear([a, b], { zoom: WATER_ZOOM, bufferKm: 2, coast: coastBase, coastKm: 20 })
    const home = near([FROM, TO])
    for (const leg of [EAST, WEST]) {
      const keys = near(leg)
      expect(keys.length).toBeGreaterThan(5)
      expect(keys.filter((key) => home.includes(key))).toEqual([])
    }
    expect(near(EAST).filter((key) => near(WEST).includes(key))).toEqual([])
  })

  it("a route served from memory doesn't clear the memory of a failure", async () => {
    const empty: TileReply = { status: 204, body: Buffer.alloc(0), fromCache: false }
    let clock = 0
    let fail = false
    let holdNext = false
    const calls = { build: 0, tiles: 0 }
    let release!: () => void
    const gate = new Promise<void>((go) => (release = go))
    let asked!: () => void
    const held = new Promise<void>((go) => (asked = go))
    const store: TileStore = {
      async get() {
        calls.tiles++
        if (fail) throw new Error('refused')
        return empty
      },
      async forget() {},
      async planetBuild() {
        calls.build++
        if (holdNext) {
          holdNext = false
          asked()
          await gate
        }
        return BUILD
      },
    }
    const water = createSeaWater({ store, now: () => clock })
    // Warm the router's memory with FROM→TO's tiles.
    expect((await water.route(FROM, TO, [], coastBase, budget())).water).toMatchObject({ build: BUILD })
    expect(calls.tiles).toBeGreaterThan(0)
    // V starts on the same leg and waits for the planet build.
    holdNext = true
    const v = water.route(FROM, TO, [], coastBase, budget())
    await held
    // Meanwhile F, on a leg the memory doesn't have, finds the network down.
    clock = 1_000
    fail = true
    const tilesBeforeF = calls.tiles
    expect((await water.route(...EAST, [], coastBase, budget())).unverified).toBe('offline')
    expect(calls.tiles).toBeGreaterThan(tilesBeforeF)
    // V finishes from memory, after F's failure, without asking the network for a tile.
    const tilesBeforeV = calls.tiles
    release()
    expect((await v).water).toMatchObject({ build: BUILD })
    expect(calls.tiles).toBe(tilesBeforeV)
    // V proved nothing about the network, so half a minute after F's failure a route still doesn't try it.
    const afterV = { ...calls }
    clock = 31_000
    expect((await water.route(...WEST, [], coastBase, budget())).unverified).toBe('offline')
    expect(calls).toEqual(afterV)
  })

  it('a 4xx tile reply starts the offline minute', async () => {
    for (const status of [404, 429]) {
      let clock = 0
      const calls = { build: 0, tiles: 0 }
      const store: TileStore = {
        async get() {
          calls.tiles++
          return { status, body: Buffer.alloc(0), fromCache: false }
        },
        async forget() {},
        async planetBuild() {
          calls.build++
          return BUILD
        },
      }
      const water = createSeaWater({ store, now: () => clock })
      expect((await water.route(FROM, TO, [], coastBase, budget())).unverified).toBe('offline')
      expect(calls.build).toBe(1)
      expect(calls.tiles).toBeGreaterThan(0)
      const after = { ...calls }
      clock = 30_000
      expect((await water.route(FROM, TO, [], coastBase, budget())).unverified).toBe('offline')
      expect(calls).toEqual(after)
      clock = 61_000
      expect((await water.route(FROM, TO, [], coastBase, budget())).unverified).toBe('offline')
      expect(calls.build).toBe(2)
    }
  })

  it("a tile served from disk doesn't clear the memory", async () => {
    // V's tiles come from disk and arrive after F's failure: the network hasn't been heard from since.
    let clock = 0
    let mode: 'fail' | 'disk' = 'fail'
    let holdNext = true
    const calls = { build: 0, tiles: 0 }
    let release!: () => void
    const gate = new Promise<void>((go) => (release = go))
    let asked!: () => void
    const held = new Promise<void>((go) => (asked = go))
    const store: TileStore = {
      async get() {
        calls.tiles++
        if (mode === 'fail') throw new Error('refused')
        return { status: 204, body: Buffer.alloc(0), fromCache: true }
      },
      async forget() {},
      async planetBuild() {
        calls.build++
        if (holdNext) {
          holdNext = false
          asked()
          await gate
        }
        return BUILD
      },
    }
    const water = createSeaWater({ store, now: () => clock })
    const v = water.route(FROM, TO, [], coastBase, budget())
    await held
    clock = 1_000
    expect((await water.route(...EAST, [], coastBase, budget())).unverified).toBe('offline')
    expect(calls.tiles).toBeGreaterThan(0)
    mode = 'disk'
    const tilesBeforeV = calls.tiles
    release()
    expect((await v).water).toMatchObject({ build: BUILD })
    expect(calls.tiles).toBeGreaterThan(tilesBeforeV)
    const afterV = { ...calls }
    clock = 31_000
    expect((await water.route(...WEST, [], coastBase, budget())).unverified).toBe('offline')
    expect(calls).toEqual(afterV)
  })

  it("an upstream reply during a failing route's wait wins", async () => {
    // F's first tile fails at once while its others are held. G hears from upstream before F's held tiles fail too.
    let clock = 0
    let mode: 'f' | 'open' = 'f'
    let fGets = 0
    let builds = 0
    let release!: () => void
    const gate = new Promise<void>((go) => (release = go))
    let asked!: () => void
    const held = new Promise<void>((go) => (asked = go))
    const store: TileStore = {
      async get() {
        if (mode === 'open') return { status: 204, body: Buffer.alloc(0), fromCache: false }
        if (++fGets > 1) {
          asked()
          await gate
        }
        throw new Error('refused')
      },
      async forget() {},
      async planetBuild() {
        builds++
        return BUILD
      },
    }
    const water = createSeaWater({ store, now: () => clock })
    const f = water.route(FROM, TO, [], coastBase, budget())
    await held
    // Lets F's first failure come back before the clock moves on.
    await new Promise((go) => setImmediate(go))
    expect(fGets).toBeGreaterThan(1)
    clock = 5_000
    mode = 'open'
    expect((await water.route(...EAST, [], coastBase, budget())).water).toMatchObject({ build: BUILD })
    clock = 10_000
    release()
    expect((await f).unverified).toBe('offline')
    // The network answered after F's failure came back, so a route on a fresh leg goes to it.
    clock = 20_000
    const before = builds
    expect((await water.route(...WEST, [], coastBase, budget())).water).toMatchObject({ build: BUILD })
    expect(builds).toBe(before + 1)
  })

  it('upstream bytes that never decode start the offline minute', async () => {
    let clock = 0
    const calls = { build: 0, tiles: 0 }
    const forgotten = new Set<string>()
    const store: TileStore = {
      async get(subpath) {
        calls.tiles++
        // Bad bytes on disk, and bad bytes again when the tile is fetched from upstream.
        return { status: 200, body: Buffer.from([255]), fromCache: !forgotten.has(subpath) }
      },
      async forget(subpath) {
        forgotten.add(subpath)
      },
      async planetBuild() {
        calls.build++
        return BUILD
      },
    }
    const water = createSeaWater({ store, now: () => clock })
    expect((await water.route(FROM, TO, [], coastBase, budget())).unverified).toBe('offline')
    expect(forgotten.size).toBeGreaterThan(0)
    expect(calls.build).toBe(1)
    const after = { ...calls }
    clock = 30_000
    expect((await water.route(FROM, TO, [], coastBase, budget())).unverified).toBe('offline')
    expect(calls).toEqual(after)
  })

  it('a 404 on a planet tile forgets the cached TileJSON', async () => {
    const replies: Record<string, () => TileReply> = {
      404: () => ({ status: 404, body: Buffer.alloc(0), fromCache: false }),
      429: () => ({ status: 429, body: Buffer.alloc(0), fromCache: false }),
      500: () => ({ status: 500, body: Buffer.alloc(0), fromCache: false }),
      throw: () => {
        throw new Error('refused')
      },
    }
    for (const [name, reply] of Object.entries(replies)) {
      const forgotten: string[] = []
      const store: TileStore = {
        async get() {
          return reply()
        },
        async forget(subpath) {
          forgotten.push(subpath)
        },
        async planetBuild() {
          return BUILD
        },
      }
      const r = await createSeaWater({ store }).route(FROM, TO, [], coastBase, budget())
      expect(r.unverified, name).toBe('offline')
      if (name === '404') expect(forgotten, name).toContain('planet')
      else expect(forgotten, name).not.toContain('planet')
    }
  })

  it("a tile that doesn't decode is fetched again", async () => {
    const good = waterBut(TX, TY, [ISLAND])
    const w = await world(new Map([[`${TX}/${TY}`, Uint8Array.of(255)]]))
    let clock = 0
    const water = createSeaWater({ store: w.store, now: () => clock })
    // The server sends bad bytes: the route is unverified, and the bytes aren't kept.
    expect((await water.route(FROM, TO, [], coastBase, budget())).unverified).toBe('offline')
    const cachedFile = path.join(w.cached, String(TX), `${TY}.pbf`)
    await expect(stat(cachedFile)).rejects.toThrow()
    // Once it sends good ones, the next due route verifies.
    await writeFile(path.join(w.served, String(TX), `${TY}.pbf`), good)
    clock += 61_000
    const fixed = await water.route(FROM, TO, [], coastBase, budget())
    expect(fixed.water).toMatchObject({ build: BUILD })
    expect(densePath(fixed.path, 0.01).filter((p) => inRect(p, ISLAND))).toEqual([])
    // Bad bytes on disk are dropped and fetched again in the same route.
    await writeFile(cachedFile, Uint8Array.of(255))
    const asks = (): number => w.tileRequests().filter((key) => key === `${TX}/${TY}`).length
    const before = asks()
    expect(await createSeaWater({ store: w.store }).route(FROM, TO, [], coastBase, budget())).toEqual(fixed)
    expect(asks()).toBe(before + 1)
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
