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
 * How long a failed route is remembered, from when its failure came back. Within it, `route` doesn't try the network
 * again and answers offline at once. Any failure counts (no answer, any reply but 200 or 204, bytes that don't
 * decode, no TileJSON), and only a tile fetched from upstream ends it early. It's the same minute an unverified path
 * waits before it's routed again.
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
   *
   * A route that ends offline starts the offline minute (`OFFLINE_MS`) from when its failure came back, whatever the
   * cause, and routes within it answer offline without trying the network. Only a tile fetched from upstream ends the
   * minute early, as it arrives; a route answered from memory or disk leaves it alone. Routes run concurrently on one
   * router, so the latest news about the network wins.
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

/** When a fetch failure came back, and its place in the order news about the network arrived in. */
type Failure = { at: number; news: number }

const SOLID = allLand(TILE_PIXELS)
const OPEN = allWater()

export function createSeaWater(opts: SeaWaterOptions): SeaWater {
  const { store } = opts
  const maxRounds = opts.maxRounds ?? 12
  const bufferKm = opts.bufferKm ?? 2
  const coastKm = opts.coastKm ?? 20
  const cacheTiles = opts.cacheTiles ?? 1500
  const now = opts.now ?? Date.now
  /**
   * When a route last ended offline: when its failure came back, which can be minutes after the route began. The
   * latest news about the network wins, so it's cleared the moment a tile arrives from upstream (200 or 204), even
   * for another route. A route answered from memory or disk proves nothing about the network and leaves it alone.
   */
  let downAt: number | undefined
  /**
   * News about the network, numbered as it arrives, so the latest wins even within one millisecond. `heard` is the
   * number of the last tile that arrived from upstream; a failure numbered before it is old news.
   */
  let news = 0
  let heard = 0
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
   * it arrived from upstream (a 200 or 204 that decodes), which is news that the network is up. Bytes that don't
   * decode are a failure, not that news. They're dropped from the disk cache, so a later fetch gets the tile again;
   * from disk, that's tried now. A 404 drops the cached TileJSON too: the build it names may have been retired, and
   * the next route should read the current one rather than fail until the TileJSON expires.
   */
  async function fetchTile(
    build: string,
    key: string,
    again = false,
  ): Promise<{ tile: Decoded | undefined; fromCache: boolean; answered: boolean }> {
    const fail = (e: unknown, fromCache = false) => {
      console.error(`Mapper sea router: could not read tile ${WATER_ZOOM}/${key} of ${build}:`, e)
      return { tile: undefined, fromCache, answered: false }
    }
    const subpath = `planet/${build}/${WATER_ZOOM}/${key}.pbf`
    let reply: TileReply
    try {
      reply = await store.get(subpath, { use: 'download' })
    } catch (e) {
      return fail(e)
    }
    const answered = !reply.fromCache && (reply.status === 200 || reply.status === 204)
    if (reply.status === 204) return { tile: EMPTY, fromCache: reply.fromCache, answered }
    if (reply.status !== 200) {
      if (reply.status === 404) await store.forget('planet')
      return { tile: undefined, fromCache: reply.fromCache, answered }
    }
    try {
      return { tile: decodeWater(reply.body), fromCache: reply.fromCache, answered }
    } catch (e) {
      await store.forget(subpath)
      if (reply.fromCache && !again) return fetchTile(build, key, true)
      return fail(e, reply.fromCache)
    }
  }

  /**
   * The tiles `keys` names, from memory or fetched. Each request takes one tile from the budget before it goes out,
   * so legs sharing a budget never pass it, and gives it back when the store answered from disk: only upstream
   * fetches count. While the budget is empty but requests are out, the next one waits to see if they give any back.
   * Stops at the first failed fetch, and says when that failure came back. Each tile that arrives from upstream
   * clears the offline memory as it arrives.
   */
  async function obtain(
    build: string,
    keys: string[],
    base: LandSource,
    budget: SeaBudget,
  ): Promise<{ tiles: Map<string, LandTile>; stop?: Unverified; failure?: Failure }> {
    const tiles = new Map<string, LandTile>()
    const fresh: string[] = []
    for (const key of keys) {
      const known = recall(`${build}/${WATER_ZOOM}/${key}`)
      if (known === undefined) fresh.push(key)
      else tiles.set(key, resolve(known, key, base))
    }
    let next = 0
    let out = 0
    let failure: Failure | undefined
    let waiting: Array<() => void> = []
    const settled = (): void => {
      const wake = waiting
      waiting = []
      for (const go of wake) go()
    }
    const worker = async (): Promise<void> => {
      while (failure === undefined && next < fresh.length) {
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
        if (got.answered) {
          heard = ++news
          downAt = undefined
        }
        if (tile === undefined) failure ??= { at: now(), news: ++news }
        else {
          remember(`${build}/${WATER_ZOOM}/${key}`, tile)
          tiles.set(key, resolve(tile, key, base))
        }
        settled()
      }
    }
    await Promise.all(Array.from({ length: Math.min(WORKERS, fresh.length) }, worker))
    if (failure) return { tiles, stop: 'offline', failure }
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

      /**
       * A route that failed: the offline minute runs from when its failure came back, unless a tile has arrived from
       * upstream since. A later failure already remembered stands.
       */
      const failed = (sea: SeaPath, failure: Failure): SeaPath & { water: WaterNote } => {
        if (heard < failure.news) downAt = Math.max(downAt ?? failure.at, failure.at)
        return unverified(sea, 'offline')
      }

      // A route failed a moment ago: don't wait for the network again yet. This doesn't restart the minute.
      if (downAt !== undefined && now() < downAt + OFFLINE_MS) return unverified(routeSea(from, to, via, base), 'offline')

      let build: string
      try {
        build = await store.planetBuild()
      } catch {
        return failed(routeSea(from, to, via, base), { at: now(), news: ++news })
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
        if (need.length === 0) return { ...sea, water: { build, tiles: loaded.size, rounds } }
        if (rounds === maxRounds) return unverified(sea, 'unsettled')
        const got = await obtain(build, need, base, budget)
        // A round that couldn't finish is dropped, so the route is the one on the rounds that did, whatever this one
        // happened to fetch before it stopped.
        if (got.failure) return failed(sea, got.failure)
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
