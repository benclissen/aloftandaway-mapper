import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { ROUTER_VERSION, routeSea, seaLegKey, type LandSource, type LngLat, type Project, type SeaPath, type SeaPaths, type ViaPoint } from '../core/index.js'
import { writeFileAtomic } from './atomic.js'
import { loadLand } from './land.js'

export const PATHS_FILE = path.join('.mapper', 'paths.json')

const CACHE_VERSION = 1
const MAX_ENTRIES = 500

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

async function readCache(file: string, land: LandSource): Promise<Record<string, Entry>> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<CacheFile> | null
    if (!raw || raw.version !== CACHE_VERSION || raw.router !== ROUTER_VERSION || raw.land !== land.version) return {}
    if (typeof raw.paths !== 'object' || raw.paths === null) return {}
    const kept: Record<string, Entry> = {}
    for (const [key, entry] of Object.entries(raw.paths)) {
      if (wellFormed(entry) && typeof (entry as Partial<Entry>).usedAt === 'string') kept[key] = entry as Entry
    }
    return kept
  } catch {
    return {}
  }
}

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

/**
 * The path of every sea leg in every scene, keyed by `seaLegKey`. Paths come from `<folder>/.mapper/paths.json`
 * when it holds them and are routed (then saved) when it doesn't. `opts.land` is for tests.
 */
export function resolveSeaPaths(folder: string, project: Project, opts: { land?: LandSource } = {}): Promise<SeaPaths> {
  return inOrder(folder, async () => {
    const legs = new Map<string, [LngLat, LngLat, ViaPoint[]]>()
    for (const scene of project.scenes) {
      scene.legs.forEach((leg, i) => {
        const from = scene.stops[i]
        const to = scene.stops[i + 1]
        if (leg.mode !== 'sea' || !from || !to) return
        legs.set(seaLegKey(from.at, to.at, leg.via), [from.at, to.at, leg.via])
      })
    }
    if (legs.size === 0) return {}

    const land = opts.land ?? (await loadLand())
    const file = path.join(folder, PATHS_FILE)
    const cache = await readCache(file, land)
    const now = new Date().toISOString()
    let routed = false
    const result: SeaPaths = {}
    for (const [key, [from, to, via]] of legs) {
      let entry = cache[key]
      if (!entry) {
        entry = { ...routeSea(from, to, via, land), usedAt: now }
        cache[key] = entry
        routed = true
      }
      const { usedAt: _usedAt, ...seaPath } = entry
      result[key] = seaPath
    }

    if (routed) {
      for (const key of legs.keys()) cache[key]!.usedAt = now
      const newest = Object.entries(cache)
        .sort((a, b) => (a[1].usedAt < b[1].usedAt ? 1 : a[1].usedAt > b[1].usedAt ? -1 : 0))
        .slice(0, MAX_ENTRIES)
      const out: CacheFile = { version: CACHE_VERSION, router: ROUTER_VERSION, land: land.version, paths: Object.fromEntries(newest) }
      await mkdir(path.dirname(file), { recursive: true })
      await writeFileAtomic(file, JSON.stringify(out))
    }
    return result
  })
}
