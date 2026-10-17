import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { ROUTER_VERSION, routeSea, seaLegKey, type LandSource, type LngLat, type Project, type SeaPath, type SeaPaths, type ViaPoint } from '../core/index.js'
import { writeFileAtomic } from './atomic.js'
import { loadLand } from './land.js'
import { OFFLINE_MS, SEA_BUDGET_TILES, SEA_WATER_VERSION, seaWater, type SeaBudget, type SeaWater, type WaterNote } from './sea-water.js'

export const PATHS_FILE = path.join('.mapper', 'paths.json')

/** The shape of paths.json. A file of any other version is dropped. */
export const CACHE_VERSION = 2
/**
 * How long a path unverified for the network or the budget is used as it is before the next call routes it again: the
 * router's offline minute, counted from when its routing finished.
 */
export const RETRY_MS = OFFLINE_MS
/**
 * The same for an unsettled path. Its result depends only on its inputs and the planet build, so routing it again
 * soon gives the same path; a day on, the build may have changed.
 */
export const UNSETTLED_RETRY_MS = 24 * 60 * 60 * 1000
const MAX_ENTRIES = 200

/**
 * A cached path. `water` says how its water was checked. An unverified path also has `retryAt`, the ISO time from
 * which the next call routes it again.
 */
type Entry = SeaPath & { usedAt: string; water?: WaterNote; retryAt?: string }

interface CacheFile {
  version: number
  router: number
  land: string
  paths: Record<string, Entry>
}

/** True when `value` is a `SeaPath` that `buildRoute` can use. */
function wellFormed(value: unknown): value is SeaPath {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Partial<SeaPath>
  if (e.status === 'fallback') return true
  if (e.status !== 'ok') return false
  if (!Array.isArray(e.path) || e.path.length === 0) return false
  if (!Array.isArray(e.knots) || e.knots.length === 0) return false
  const n = e.path.length
  return e.knots.every((k) => Number.isInteger(k) && k >= 0 && k < n)
}

/** The last cache read or written for each file, with the file's change time and size at that moment. */
const memo = new Map<string, { stamp: string; land: string; paths: Record<string, Entry> }>()

/** Changes whenever the file is rewritten; undefined if it can't be read. */
async function stampOf(file: string): Promise<string | undefined> {
  try {
    const s = await stat(file, { bigint: true })
    return `${s.mtimeNs}:${s.size}`
  } catch {
    return undefined
  }
}

/** True when `entry` is a path with the cache's own fields in shape. */
function wellKept(entry: unknown): entry is Entry {
  if (!wellFormed(entry)) return false
  const e = entry as Partial<Entry>
  return (
    typeof e.usedAt === 'string' &&
    (e.retryAt === undefined || typeof e.retryAt === 'string') &&
    (e.water === undefined || (typeof e.water === 'object' && e.water !== null))
  )
}

/** The cache's paths when the file is for this `land` version, else none. */
async function readCache(file: string, land: string): Promise<Record<string, Entry>> {
  const stamp = await stampOf(file)
  if (stamp === undefined) return {}
  const known = memo.get(file)
  if (known && known.stamp === stamp && known.land === land) return known.paths
  const kept: Record<string, Entry> = {}
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<CacheFile> | null
    if (raw && raw.version === CACHE_VERSION && raw.router === ROUTER_VERSION && raw.land === land) {
      if (typeof raw.paths === 'object' && raw.paths !== null) {
        for (const [key, entry] of Object.entries(raw.paths)) {
          if (wellKept(entry)) kept[key] = entry
        }
      }
    }
  } catch {
    // A corrupt cache is rebuilt.
  }
  memo.set(file, { stamp, land, paths: kept })
  return kept
}

/** Whether a path is worth routing again within the minute: one the network or the budget left unverified. */
export function retriesSoon(sea: SeaPath): boolean {
  return sea.unverified === 'offline' || sea.unverified === 'budget'
}

/** When a path unverified for `why`, routed at `done`, is next routed again, as an ISO time. */
function retryTime(why: NonNullable<SeaPath['unverified']>, done: number): string {
  return new Date(done + (why === 'unsettled' ? UNSETTLED_RETRY_MS : RETRY_MS)).toISOString()
}

/** Whether a cached path is due to be routed again: it's unverified and its retry time has come (or is unreadable). */
function due(entry: Entry, now: number): boolean {
  return entry.unverified !== undefined && !(Date.parse(entry.retryAt ?? '') > now)
}

/** Coordinates rounded to 1e-6° (about 10 cm) to keep the cache small. Knots stay exact. */
function rounded(sea: SeaPath): SeaPath {
  const r = (v: number): number => Math.round(v * 1e6) / 1e6
  const knots = new Set(sea.knots)
  const out: SeaPath = { ...sea, path: sea.path.map((p, i) => (knots.has(i) ? p : [r(p[0]), r(p[1])])) }
  if (sea.crossesLand) out.crossesLand = [r(sea.crossesLand[0]), r(sea.crossesLand[1])]
  return out
}

/**
 * A leg routed on `water`, as a cache entry: with its note, and a retry time when it couldn't be checked. Its times
 * are read from `clock` once routing has finished, which can be minutes after it began when the network is slow to fail.
 */
async function routeOnWater(
  water: SeaWater,
  from: LngLat,
  to: LngLat,
  via: ViaPoint[],
  land: LandSource,
  budget: SeaBudget,
  clock: () => number,
): Promise<Entry> {
  const { water: note, ...sea } = await water.route(from, to, via, land, budget)
  const done = clock()
  const entry: Entry = { ...rounded(sea), usedAt: new Date(done).toISOString(), water: note }
  if (sea.unverified !== undefined) entry.retryAt = retryTime(sea.unverified, done)
  return entry
}

/** A leg routed on Natural Earth alone because the network is down, as `water` would have answered it, at `done`. */
function offlineEntry(sea: SeaPath, done: number): Entry {
  return {
    ...rounded({ ...sea, unverified: 'offline' }),
    usedAt: new Date(done).toISOString(),
    water: { unverified: 'offline' },
    retryAt: retryTime('offline', done),
  }
}

/** Folders whose cache couldn't be written, logged once each. */
const unwritable = new Set<string>()

const chains = new Map<string, Promise<unknown>>()

/** Runs `task` after every earlier task for `folder` has finished, whether or not they failed. */
function inOrder<T>(folder: string, task: () => Promise<T>): Promise<T> {
  const run = (chains.get(folder) ?? Promise.resolve()).then(task, task)
  const tail = run.catch(() => undefined)
  chains.set(folder, tail)
  void tail.then(() => {
    if (chains.get(folder) === tail) chains.delete(folder)
  })
  return run
}

/** Every sea leg in `project`, keyed by `seaLegKey`. */
export function seaLegsOf(project: Project): Map<string, [LngLat, LngLat, ViaPoint[]]> {
  const legs = new Map<string, [LngLat, LngLat, ViaPoint[]]>()
  for (const scene of project.scenes) {
    scene.legs.forEach((leg, i) => {
      const from = scene.stops[i]
      const to = scene.stops[i + 1]
      if (leg.mode !== 'sea' || !from || !to) return
      legs.set(seaLegKey(from.at, to.at, leg.via), [from.at, to.at, leg.via])
    })
  }
  return legs
}

export interface ResolveOptions {
  /** Natural Earth, or a stand-in for tests. Defaults to the data that ships with Mapper. */
  land?: LandSource
  /**
   * Checks each leg against the basemap's water. Defaults to the process's one router; a test may pass
   * `water: undefined` to route on `land` alone, which keeps a cache file of its own.
   */
  water?: SeaWater
  /** The clock retry times are set and read by, in ms. For tests. */
  now?: () => number
}

/**
 * The path of every sea leg in every scene, keyed by `seaLegKey`. Paths come from `<folder>/.mapper/paths.json`
 * when it holds them and are routed (then saved) when it doesn't. A verified path is used as it is until its leg
 * changes. An unverified one is used until its retry time, a minute after its routing finished (a day for an
 * unsettled one); the first call after that routes it again. The legs of one call share one tile budget. If the
 * cache can't be written the routes are still answered. Calls for one folder run one at a time.
 */
export function resolveSeaPaths(folder: string, project: Project, opts: ResolveOptions = {}): Promise<SeaPaths> {
  const dir = path.resolve(folder)
  const water = 'water' in opts ? opts.water : seaWater()
  return inOrder(dir, async () => {
    const legs = seaLegsOf(project)
    if (legs.size === 0) return {}

    const land = opts.land ?? (await loadLand())
    // The planet build stays out: a new one doesn't re-route anything, and each entry records its own.
    const version = water ? `${land.version}+${SEA_WATER_VERSION}` : land.version
    const file = path.join(dir, PATHS_FILE)
    const cache = await readCache(file, version)
    const clock = opts.now ?? Date.now
    const budget: SeaBudget = { tiles: SEA_BUDGET_TILES }
    let routed = false
    // Once one leg finds the network down, the rest of this call doesn't wait for it again.
    let offline = false
    const result: SeaPaths = {}
    for (const [key, [from, to, via]] of legs) {
      let entry = cache[key]
      if (!entry || due(entry, clock())) {
        if (!water) entry = { ...rounded(routeSea(from, to, via, land)), usedAt: new Date(clock()).toISOString() }
        else if (offline) entry = offlineEntry(routeSea(from, to, via, land), clock())
        else entry = await routeOnWater(water, from, to, via, land, budget, clock)
        if (entry.unverified === 'offline') offline = true
        cache[key] = entry
        routed = true
      }
      const { usedAt: _usedAt, water: _water, retryAt: _retryAt, ...seaPath } = entry
      result[key] = seaPath
    }

    if (routed) {
      const now = new Date(clock()).toISOString()
      for (const key of legs.keys()) cache[key]!.usedAt = now
      const newest = Object.fromEntries(
        Object.entries(cache)
          .sort((a, b) => (a[1].usedAt < b[1].usedAt ? 1 : a[1].usedAt > b[1].usedAt ? -1 : 0))
          .slice(0, MAX_ENTRIES),
      )
      const out: CacheFile = { version: CACHE_VERSION, router: ROUTER_VERSION, land: version, paths: newest }
      try {
        await mkdir(path.dirname(file), { recursive: true })
        await writeFileAtomic(file, JSON.stringify(out))
        const stamp = await stampOf(file)
        if (stamp !== undefined) memo.set(file, { stamp, land: version, paths: newest })
        unwritable.delete(dir)
      } catch (e) {
        if (!unwritable.has(dir)) {
          unwritable.add(dir)
          console.error(`Mapper could not save sea routes to ${file}:`, e)
        }
      }
    }
    return result
  })
}
