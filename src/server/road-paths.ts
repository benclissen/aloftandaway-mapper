import path from 'node:path'
import { type LngLat, NO_ROAD_ROUTE, ROAD_OFFLINE, roadLegsOf, roadPath, type Project, type SeaPath, type SeaPaths } from '../core/index.js'
import { inOrder } from './atomic.js'
import { readCache, saveNewest, wellFormed } from './path-cache.js'
import { OFFLINE_MS } from './sea-water.js'
import { roadRouter, type RoadReply, type RoadRouter } from './roads.js'

export const ROADS_FILE = path.join('.mapper', 'roads.json')

/** The shape of roads.json. A file of any other version is dropped. */
export const ROAD_CACHE_VERSION = 1
/** How long a leg the router found no road for is used as it is before the next call asks again: a day. */
export const NO_ROUTE_RETRY_MS = 24 * 60 * 60 * 1000

/** A cached road path. A fallback also has `retryAt`, the ISO time from which the next call asks the router again. */
type Entry = SeaPath & { usedAt: string; retryAt?: string }

/** True when `entry` is a road path `buildRoute` can use, with the cache's own fields in shape. */
function wellKept(entry: unknown): entry is Entry {
  if (!wellFormed(entry)) return false
  const e = entry as Partial<Entry>
  // A road path always has its two stops, and `buildRoute` relies on it.
  if (e.status === 'ok' && (e.path?.length ?? 0) < 2) return false
  return typeof e.usedAt === 'string' && (e.retryAt === undefined || typeof e.retryAt === 'string')
}

/** Whether a cached path is due to be routed again: it's a fallback and its retry time has come (or is unreadable). */
function due(entry: Entry, now: number): boolean {
  return entry.status === 'fallback' && !(Date.parse(entry.retryAt ?? '') > now)
}

/** The entry for the router's `reply`, finished at `done`. */
function entryFor(reply: RoadReply, from: LngLat, to: LngLat, via: LngLat[], done: number): Entry {
  const usedAt = new Date(done).toISOString()
  if (reply.kind === 'ok') return { ...roadPath(reply.answer, from, to, via), usedAt }
  if (reply.kind === 'no-route') {
    return { status: 'fallback', reason: NO_ROAD_ROUTE, path: [], knots: [], usedAt, retryAt: new Date(done + NO_ROUTE_RETRY_MS).toISOString() }
  }
  return {
    status: 'fallback',
    reason: ROAD_OFFLINE,
    path: [],
    knots: [],
    unverified: 'offline',
    usedAt,
    retryAt: new Date(done + OFFLINE_MS).toISOString(),
  }
}

/**
 * The path of every road leg in the project, keyed by `roadLegKey`. Paths come from `<folder>/.mapper/roads.json`
 * when it holds them and are asked of the road router (then saved) when it doesn't. A road is used as it is until
 * its leg changes. A leg with no road is asked again after a day, and one the router couldn't be reached for after
 * a minute. If the cache can't be written the routes are still answered. Calls for one folder run one at a time.
 */
export function resolveRoadPaths(
  folder: string,
  project: Project,
  opts: { router?: RoadRouter; now?: () => number } = {},
): Promise<SeaPaths> {
  const dir = path.resolve(folder)
  return inOrder(`${dir}\0roads`, async () => {
    const legs = roadLegsOf(project)
    const result: SeaPaths = {}
    if (legs.size === 0) return result

    const file = path.join(dir, ROADS_FILE)
    const cache = await readCache(file, '', (raw) => raw.version === ROAD_CACHE_VERSION, wellKept)
    const clock = opts.now ?? Date.now
    let routed = false
    for (const [key, leg] of legs) {
      let entry = cache[key]
      if (!entry || due(entry, clock())) {
        const reply = await (opts.router ?? roadRouter()).route(leg.profile, [leg.from, ...leg.via, leg.to])
        entry = entryFor(reply, leg.from, leg.to, leg.via, clock())
        cache[key] = entry
        routed = true
      }
      const { usedAt: _usedAt, retryAt: _retryAt, ...roadPathOnly } = entry
      result[key] = roadPathOnly
    }

    if (routed) {
      await saveNewest(file, dir, 'road', { version: ROAD_CACHE_VERSION }, '', cache, legs.keys(), new Date(clock()).toISOString())
    }
    return result
  })
}
