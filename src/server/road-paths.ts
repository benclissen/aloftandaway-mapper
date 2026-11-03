import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { type LngLat, NO_ROAD_ROUTE, ROAD_OFFLINE, roadLegsOf, roadPath, type Project, type SeaPath, type SeaPaths } from '../core/index.js'
import { inOrder, writeFileAtomic } from './atomic.js'
import { RETRY_MS, wellFormed } from './paths.js'
import { roadRouter, type RoadReply, type RoadRouter } from './roads.js'

export const ROADS_FILE = path.join('.mapper', 'roads.json')

/** The shape of roads.json. A file of any other version is dropped. */
export const ROAD_CACHE_VERSION = 1
/** How long a leg the router found no road for is used as it is before the next call asks again: a day. */
export const NO_ROUTE_RETRY_MS = 24 * 60 * 60 * 1000
const MAX_ENTRIES = 200

/** A cached road path. A fallback also has `retryAt`, the ISO time from which the next call asks the router again. */
type Entry = SeaPath & { usedAt: string; retryAt?: string }

interface CacheFile {
  version: number
  paths: Record<string, Entry>
}

/** The last cache read or written for each file, with the file's change time and size at that moment. */
const memo = new Map<string, { stamp: string; paths: Record<string, Entry> }>()

/** Changes whenever the file is rewritten; undefined if it can't be read. */
async function stampOf(file: string): Promise<string | undefined> {
  try {
    const s = await stat(file, { bigint: true })
    return `${s.mtimeNs}:${s.size}`
  } catch {
    return undefined
  }
}

/** True when `entry` is a road path `buildRoute` can use, with the cache's own fields in shape. */
function wellKept(entry: unknown): entry is Entry {
  if (!wellFormed(entry)) return false
  const e = entry as Partial<Entry>
  // A road path always has its two stops, and `buildRoute` relies on it.
  if (e.status === 'ok' && (e.path?.length ?? 0) < 2) return false
  return typeof e.usedAt === 'string' && (e.retryAt === undefined || typeof e.retryAt === 'string')
}

async function readCache(file: string): Promise<Record<string, Entry>> {
  const stamp = await stampOf(file)
  if (stamp === undefined) return {}
  const known = memo.get(file)
  if (known && known.stamp === stamp) return known.paths
  const kept: Record<string, Entry> = {}
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<CacheFile> | null
    if (raw && raw.version === ROAD_CACHE_VERSION && typeof raw.paths === 'object' && raw.paths !== null) {
      for (const [key, entry] of Object.entries(raw.paths)) {
        if (wellKept(entry)) kept[key] = entry
      }
    }
  } catch {
    // A corrupt cache is rebuilt.
  }
  memo.set(file, { stamp, paths: kept })
  return kept
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
    retryAt: new Date(done + RETRY_MS).toISOString(),
  }
}

/** Folders whose cache couldn't be written, logged once each. */
const unwritable = new Set<string>()

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
    const cache = await readCache(file)
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
      const now = new Date(clock()).toISOString()
      for (const key of legs.keys()) cache[key]!.usedAt = now
      const newest = Object.fromEntries(
        Object.entries(cache)
          .sort((a, b) => (a[1].usedAt < b[1].usedAt ? 1 : a[1].usedAt > b[1].usedAt ? -1 : 0))
          .slice(0, MAX_ENTRIES),
      )
      const out: CacheFile = { version: ROAD_CACHE_VERSION, paths: newest }
      try {
        await mkdir(path.dirname(file), { recursive: true })
        await writeFileAtomic(file, JSON.stringify(out))
        const stamp = await stampOf(file)
        if (stamp !== undefined) memo.set(file, { stamp, paths: newest })
        unwritable.delete(dir)
      } catch (e) {
        if (!unwritable.has(dir)) {
          unwritable.add(dir)
          console.error(`Mapper could not save road routes to ${file}:`, e)
        }
      }
    }
    return result
  })
}
