import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'
import {
  allLand,
  allWater,
  rasteriseTile,
  routeSea,
  TILE_PIXELS,
  tileLand,
  tilesNear,
  toLngLat,
  WATER_ZOOM,
  withTiles,
  type LandSource,
  type LandTile,
  type LngLat,
  type SeaPath,
  type TileFeature,
  type ViaPoint,
} from '../core/index.js'
import { tileStore, type TileReply, type TileStore } from './tiles.js'

/**
 * How water is read from the basemap: zoom, pixels per side and the feature filter. It's folded into the land
 * version the router sees. Change it, and bump ROUTER_VERSION, whenever any of those change.
 */
export const SEA_WATER_VERSION = `ofm-z${WATER_ZOOM}-p${TILE_PIXELS}-v1`

/** New tile fetches one `resolveSeaPaths` call may make, well inside OpenFreeMap's 3,000 per download. */
export const SEA_BUDGET_TILES = 2500

/**
 * How long a network failure is remembered. Within it, `route` doesn't try the network again and answers offline at
 * once. It's the same minute an unverified path waits before it's routed again.
 */
export const OFFLINE_MS = 60_000

/** Tiles left to fetch. One per `resolveSeaPaths` call, shared by its legs; `route` takes from it as it fetches. */
export interface SeaBudget {
  tiles: number
}

export type Unverified = NonNullable<SeaPath['unverified']>

/** How a leg's water was checked: on every tile it needed, or not, and why. */
export type WaterNote = { build: string; tiles: number; rounds: number } | { unverified: Unverified }

export interface SeaWaterOptions {
  store: TileStore
  /** Routing rounds before a route that keeps needing new tiles is left unsettled. Default 12. */
  maxRounds?: number
  /** Tiles within this distance of the route are loaded. Default 2 km. */
  bufferKm?: number
  /** A tile is loaded only when Natural Earth land lies within this distance of it. Default 20 km. */
  coastKm?: number
  /** Decoded tiles kept in memory, least recently used dropped first. Default 1,500. */
  cacheTiles?: number
  /** The clock the offline memory reads, in ms. For tests. */
  now?: () => number
}

export interface SeaWater {
  /**
   * Routes a sea leg on `base` with zoom-12 OpenFreeMap water over it, in rounds: load the tiles the route passes
   * near, route again, until the route needs no tile it doesn't have. Every call starts from no tiles, so the tiles a
   * route uses depend only on its inputs and the planet build. When it can't finish (no tiles, no budget left, or
   * the rounds ran out), the route uses what it got, and the path and the note both say why. Tile failures never
   * reject; each request keeps the store's timeout and retries.
   */
  route(from: LngLat, to: LngLat, via: ViaPoint[], base: LandSource, budget: SeaBudget): Promise<SeaPath & { water: WaterNote }>
}

/** Router fetches at once per leg. The store caps all downloads at 4 too. */
const WORKERS = 4

/** A tile with no water layer; whether it's land or water depends on where its centre lies. */
const EMPTY = 'empty'
type Decoded = LandTile | typeof EMPTY

/** The water features of a tile's bytes, or EMPTY when it has no water layer. Throws on bytes that aren't a tile. */
function decodeWater(body: Uint8Array): Decoded {
  if (body.length === 0) return EMPTY
  // Tiles normally arrive decoded, but a server may send gzip without saying so.
  const bytes = body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body
  const layer = new VectorTile(new PbfReader(bytes)).layers.water
  if (!layer) return EMPTY
  // The same filter as the basemap's water layer: everything but tunnels.
  const features: TileFeature[] = []
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i)
    if (feature.type !== 3 || feature.properties.brunnel === 'tunnel') continue
    features.push({ rings: feature.loadGeometry() })
  }
  return rasteriseTile(features, layer.extent, TILE_PIXELS)
}

const SOLID = allLand(TILE_PIXELS)
const OPEN = allWater()

export function createSeaWater(opts: SeaWaterOptions): SeaWater {
  const { store } = opts
  const maxRounds = opts.maxRounds ?? 12
  const bufferKm = opts.bufferKm ?? 2
  const coastKm = opts.coastKm ?? 20
  const cacheTiles = opts.cacheTiles ?? 1500
  const now = opts.now ?? Date.now
  /** When the last route that found the network down began. Cleared by a route that verifies. */
  let downAt: number | undefined
  if (!(bufferKm > 0)) throw new Error('createSeaWater needs a positive bufferKm')
  const span = 2 ** WATER_ZOOM

  /** Decoded tiles by `build/z/x/y`, oldest use first. Only bytes and pixels come from here, never which tiles a route uses. */
  const memory = new Map<string, Decoded>()
  const remember = (key: string, tile: Decoded): void => {
    memory.delete(key)
    memory.set(key, tile)
    while (memory.size > cacheTiles) memory.delete(memory.keys().next().value!)
  }
  const recall = (key: string): Decoded | undefined => {
    const tile = memory.get(key)
    if (tile !== undefined) remember(key, tile)
    return tile
  }

  /** A tile with no water layer is all land, unless Natural Earth puts its centre at sea. */
  const resolve = (tile: Decoded, key: string, base: LandSource): LandTile => {
    if (tile !== EMPTY) return tile
    const [x, y] = key.split('/').map(Number) as [number, number]
    return base.isLand(toLngLat([(x + 0.5) / span, (y + 0.5) / span])) ? SOLID : OPEN
  }

  /**
   * One tile, fetched and decoded, or undefined when it couldn't be had; whether its bytes came from disk; and whether
   * a failure was the network's (no answer after the store's retries, or a 5xx) rather than the tile's.
   */
  async function fetchTile(build: string, key: string): Promise<{ tile: Decoded | undefined; fromCache: boolean; down: boolean }> {
    const fail = (e: unknown, down: boolean, fromCache = false) => {
      console.error(`Mapper sea router: could not read tile ${WATER_ZOOM}/${key} of ${build}:`, e)
      return { tile: undefined, fromCache, down }
    }
    let reply: TileReply
    try {
      reply = await store.get(`planet/${build}/${WATER_ZOOM}/${key}.pbf`, { use: 'download' })
    } catch (e) {
      return fail(e, true)
    }
    if (reply.status === 204) return { tile: EMPTY, fromCache: reply.fromCache, down: false }
    if (reply.status !== 200) return { tile: undefined, fromCache: reply.fromCache, down: reply.status >= 500 }
    try {
      return { tile: decodeWater(reply.body), fromCache: reply.fromCache, down: false }
    } catch (e) {
      return fail(e, false, reply.fromCache)
    }
  }

  /**
   * The tiles `keys` names, from memory or fetched. Each request takes one tile from the budget before it goes out,
   * so legs sharing a budget never pass it, and gives it back when the store answered from disk: only upstream
   * fetches count. While the budget is empty but requests are out, the next one waits to see if they give any back.
   * Stops at the first failed fetch.
   */
  async function obtain(
    build: string,
    keys: string[],
    base: LandSource,
    budget: SeaBudget,
  ): Promise<{ tiles: Map<string, LandTile>; stop?: Unverified; down?: boolean }> {
    const tiles = new Map<string, LandTile>()
    const fresh: string[] = []
    for (const key of keys) {
      const known = recall(`${build}/${WATER_ZOOM}/${key}`)
      if (known === undefined) fresh.push(key)
      else tiles.set(key, resolve(known, key, base))
    }
    let next = 0
    let out = 0
    let failed = false
    let down = false
    let waiting: Array<() => void> = []
    const settled = (): void => {
      const wake = waiting
      waiting = []
      for (const go of wake) go()
    }
    const worker = async (): Promise<void> => {
      while (!failed && next < fresh.length) {
        if (budget.tiles < 1) {
          if (out === 0) return
          await new Promise<void>((go) => waiting.push(go))
          continue
        }
        budget.tiles -= 1
        const key = fresh[next++]!
        out++
        const got = await fetchTile(build, key)
        const { tile } = got
        out--
        if (got.fromCache) budget.tiles += 1
        if (got.down) down = true
        if (tile === undefined) failed = true
        else {
          remember(`${build}/${WATER_ZOOM}/${key}`, tile)
          tiles.set(key, resolve(tile, key, base))
        }
        settled()
      }
    }
    await Promise.all(Array.from({ length: Math.min(WORKERS, fresh.length) }, worker))
    if (failed) return { tiles, stop: 'offline', down }
    if (next < fresh.length) return { tiles, stop: 'budget' }
    return { tiles }
  }

  return {
    async route(from, to, via, base, budget) {
      const unverified = (sea: SeaPath, why: Unverified): SeaPath & { water: WaterNote } => ({
        ...sea,
        unverified: why,
        water: { unverified: why },
      })

      // The network was down a moment ago: don't wait for it again yet.
      const started = now()
      if (downAt !== undefined && started < downAt + OFFLINE_MS) return unverified(routeSea(from, to, via, base), 'offline')

      let build: string
      try {
        build = await store.planetBuild()
      } catch {
        downAt = started
        return unverified(routeSea(from, to, via, base), 'offline')
      }

      // Every round sees the same version, so a route depends only on its tiles.
      const version = `${base.version}+${SEA_WATER_VERSION}`
      const loaded = new Map<string, LandTile>()
      const land = withTiles(base, tileLand(loaded, WATER_ZOOM, TILE_PIXELS), version)
      const controls: LngLat[] = [from, ...via.map((v) => v.at), to]
      let sea = routeSea(from, to, via, base)
      for (let rounds = 0; ; rounds++) {
        // A leg with no route yet is looked for along the straight lines between its controls.
        const near = tilesNear(sea.status === 'ok' ? sea.path : controls, {
          zoom: WATER_ZOOM,
          bufferKm,
          coast: base,
          coastKm,
        })
        const need = near.filter((key) => !loaded.has(key))
        if (need.length === 0) {
          downAt = undefined
          return { ...sea, water: { build, tiles: loaded.size, rounds } }
        }
        if (rounds === maxRounds) return unverified(sea, 'unsettled')
        const got = await obtain(build, need, base, budget)
        // A round that couldn't finish is dropped, so the route is the one on the rounds that did, whatever this one
        // happened to fetch before it stopped.
        if (got.down) downAt = started
        if (got.stop) return unverified(sea, got.stop)
        for (const [key, tile] of got.tiles) loaded.set(key, tile)
        sea = routeSea(from, to, via, land)
      }
    },
  }
}

const routers = new WeakMap<TileStore, SeaWater>()

/** The one sea router on `store`, so everything reading the same tiles shares their decoded copies. */
export function seaWaterOn(store: TileStore): SeaWater {
  let water = routers.get(store)
  if (!water) {
    water = createSeaWater({ store })
    routers.set(store, water)
  }
  return water
}

/** The process's one sea router, on the tile store the studio's map proxy uses. */
export function seaWater(): SeaWater {
  return seaWaterOn(
    tileStore({
      cacheDir: process.env.MAPPER_CACHE_DIR ?? path.join(os.homedir(), '.cache', 'mapper'),
      upstream: process.env.MAPPER_TILE_UPSTREAM || undefined,
    }),
  )
}
