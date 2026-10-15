import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { ROUTER_VERSION, routeSea, seaLegKey, type LandSource, type LngLat, type Project, type SeaPath, type SeaPaths, type ViaPoint } from '../core/index.js'
import { writeFileAtomic } from './atomic.js'
import { loadLand } from './land.js'

export const PATHS_FILE = path.join('.mapper', 'paths.json')

const CACHE_VERSION = 1
const MAX_ENTRIES = 200

type Entry = SeaPath & { usedAt: string }

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

async function readCache(file: string, land: LandSource): Promise<Record<string, Entry>> {
  const stamp = await stampOf(file)
  if (stamp === undefined) return {}
  const known = memo.get(file)
  if (known && known.stamp === stamp && known.land === land.version) return known.paths
  const kept: Record<string, Entry> = {}
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<CacheFile> | null
    if (raw && raw.version === CACHE_VERSION && raw.router === ROUTER_VERSION && raw.land === land.version) {
      if (typeof raw.paths === 'object' && raw.paths !== null) {
        for (const [key, entry] of Object.entries(raw.paths)) {
          if (wellFormed(entry) && typeof (entry as Partial<Entry>).usedAt === 'string') kept[key] = entry as Entry
        }
      }
    }
  } catch {
    // A corrupt cache is rebuilt.
  }
  memo.set(file, { stamp, land: land.version, paths: kept })
  return kept
}

/** Coordinates rounded to 1e-6° (about 10 cm) to keep the cache small. Knots stay exact. */
function rounded(sea: SeaPath): SeaPath {
  const r = (v: number): number => Math.round(v * 1e6) / 1e6
  const knots = new Set(sea.knots)
  const out: SeaPath = { ...sea, path: sea.path.map((p, i) => (knots.has(i) ? p : [r(p[0]), r(p[1])])) }
  if (sea.crossesLand) out.crossesLand = [r(sea.crossesLand[0]), r(sea.crossesLand[1])]
  return out
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

/**
 * The path of every sea leg in every scene, keyed by `seaLegKey`. Paths come from `<folder>/.mapper/paths.json`
 * when it holds them and are routed (then saved) when it doesn't. If the cache can't be written the routes are still
 * answered. `opts.land` is for tests.
 */
export function resolveSeaPaths(folder: string, project: Project, opts: { land?: LandSource } = {}): Promise<SeaPaths> {
  const dir = path.resolve(folder)
  return inOrder(dir, async () => {
    const legs = seaLegsOf(project)
    if (legs.size === 0) return {}

    const land = opts.land ?? (await loadLand())
    const file = path.join(dir, PATHS_FILE)
    const cache = await readCache(file, land)
    const now = new Date().toISOString()
    let routed = false
    const result: SeaPaths = {}
    for (const [key, [from, to, via]] of legs) {
      let entry = cache[key]
      if (!entry) {
        entry = { ...rounded(routeSea(from, to, via, land)), usedAt: now }
        cache[key] = entry
        routed = true
      }
      const { usedAt: _usedAt, ...seaPath } = entry
      result[key] = seaPath
    }

    if (routed) {
      for (const key of legs.keys()) cache[key]!.usedAt = now
      const newest = Object.fromEntries(
        Object.entries(cache)
          .sort((a, b) => (a[1].usedAt < b[1].usedAt ? 1 : a[1].usedAt > b[1].usedAt ? -1 : 0))
          .slice(0, MAX_ENTRIES),
      )
      const out: CacheFile = { version: CACHE_VERSION, router: ROUTER_VERSION, land: land.version, paths: newest }
      try {
        await mkdir(path.dirname(file), { recursive: true })
        await writeFileAtomic(file, JSON.stringify(out))
        const stamp = await stampOf(file)
        if (stamp !== undefined) memo.set(file, { stamp, land: land.version, paths: newest })
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
