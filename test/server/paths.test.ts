import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { decodeLand, defaultProject, encodeLand, landIndex, ROUTER_VERSION, seaLegKey, type LandSource, type LngLat, type Project } from '../../src/core/index.js'
import { PATHS_FILE, resolveSeaPaths } from '../../src/server/paths.js'

let folder: string
beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), 'mapper-paths-'))
})
afterEach(() => rm(folder, { recursive: true, force: true }))

/** An island between two sea stops, with a counter on `ringsIn`. */
function island(version = 'test-land'): LandSource & { calls: number } {
  const ring: LngLat[] = [
    [9.8, 49.5],
    [10.2, 49.5],
    [10.2, 50.5],
    [9.8, 50.5],
  ]
  const source = landIndex(decodeLand(encodeLand(version, [ring])))
  const counted = {
    version: source.version,
    calls: 0,
    ringsIn(...a: Parameters<LandSource['ringsIn']>) {
      counted.calls++
      return source.ringsIn(...a)
    },
    isLand: (at: LngLat) => source.isLand(at),
  }
  return counted
}

function projectWith(legs: Array<{ from: LngLat; to: LngLat; mode?: 'sea' | 'air' }>): Project {
  const p = defaultProject({ id: '00000000-0000-4000-8000-000000000001', name: 't', now: '2026-01-01T00:00:00.000Z' })
  const scene = p.scenes[0]!
  scene.stops = [legs[0]!.from, ...legs.map((l) => l.to)].map((at, i) => ({ id: `s${i}`, at, name: `S${i}` })) as never
  scene.legs = legs.map((l) => ({ mode: l.mode ?? 'sea', via: [] }))
  return p
}

const A: LngLat = [9, 50]
const B: LngLat = [11, 50]
const cacheFile = () => path.join(folder, PATHS_FILE)
const readCacheFile = async () => JSON.parse(await readFile(cacheFile(), 'utf8'))

test('routes a sea leg and writes the cache', async () => {
  const p = projectWith([{ from: A, to: B }])
  const paths = await resolveSeaPaths(folder, p, { land: island() })
  const key = seaLegKey(A, B, [])
  expect(Object.keys(paths)).toEqual([key])
  expect(paths[key]!.status).toBe('ok')
  expect(paths[key]).not.toHaveProperty('usedAt')
  const file = await readCacheFile()
  expect(file).toMatchObject({ version: 1, router: ROUTER_VERSION, land: 'test-land' })
  expect(file.paths[key].usedAt).toEqual(expect.any(String))
})

test('reads a cached path without routing again', async () => {
  const p = projectWith([{ from: A, to: B }])
  const first = await resolveSeaPaths(folder, p, { land: island() })
  const land = island()
  const second = await resolveSeaPaths(folder, p, { land })
  expect(land.calls).toBe(0)
  expect(second).toEqual(first)
})

test('ignores a cache from another router version', async () => {
  const p = projectWith([{ from: A, to: B }])
  await resolveSeaPaths(folder, p, { land: island() })
  const file = await readCacheFile()
  file.router = ROUTER_VERSION + 1
  await writeFile(cacheFile(), JSON.stringify(file))
  const land = island()
  await resolveSeaPaths(folder, p, { land })
  expect(land.calls).toBeGreaterThan(0)
  expect((await readCacheFile()).router).toBe(ROUTER_VERSION)
})

test('rebuilds a corrupt cache', async () => {
  await mkdir(path.dirname(cacheFile()), { recursive: true })
  await writeFile(cacheFile(), '{"version":')
  const p = projectWith([{ from: A, to: B }])
  const paths = await resolveSeaPaths(folder, p, { land: island() })
  expect(Object.keys(paths)).toHaveLength(1)
  expect(Object.keys((await readCacheFile()).paths)).toHaveLength(1)
})

test('drops malformed cache entries and reroutes them', async () => {
  const p = projectWith([{ from: A, to: B }])
  await resolveSeaPaths(folder, p, { land: island() })
  const key = seaLegKey(A, B, [])
  const file = await readCacheFile()
  file.paths[key] = { status: 'ok', path: [], knots: [], usedAt: '2026-01-01T00:00:00.000Z' }
  file.paths.bad = { status: 'nonsense', usedAt: '2026-01-01T00:00:00.000Z' }
  file.paths.far = { status: 'ok', path: [A, B], knots: [0, 5], usedAt: '2026-01-01T00:00:00.000Z' }
  await writeFile(cacheFile(), JSON.stringify(file))
  const land = island()
  const paths = await resolveSeaPaths(folder, p, { land })
  expect(land.calls).toBeGreaterThan(0)
  expect(paths[key]!.path.length).toBeGreaterThan(0)
  const after = await readCacheFile()
  expect(Object.keys(after.paths)).toEqual([key])
})

test('keeps the newest 500 entries', async () => {
  const stale: Record<string, unknown> = {}
  for (let i = 0; i < 520; i++) {
    stale[`k${i}`] = { status: 'fallback', usedAt: new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString() }
  }
  await mkdir(path.dirname(cacheFile()), { recursive: true })
  await writeFile(cacheFile(), JSON.stringify({ version: 1, router: ROUTER_VERSION, land: 'test-land', paths: stale }))
  const p = projectWith([{ from: A, to: B }])
  await resolveSeaPaths(folder, p, { land: island() })
  const keys = Object.keys((await readCacheFile()).paths)
  expect(keys).toHaveLength(500)
  expect(keys).toContain(seaLegKey(A, B, []))
  expect(keys).not.toContain('k0')
  expect(keys).toContain('k519')
})

test('serialises concurrent calls for one folder', async () => {
  const p = projectWith([
    { from: A, to: B },
    { from: B, to: [11, 51] },
  ])
  const land = island()
  const [x, y] = await Promise.all([resolveSeaPaths(folder, p, { land }), resolveSeaPaths(folder, p, { land })])
  const keys = [seaLegKey(A, B, []), seaLegKey(B, [11, 51], [])]
  expect(Object.keys(x).sort()).toEqual([...keys].sort())
  expect(Object.keys(y).sort()).toEqual([...keys].sort())
  // The second call finds both legs cached, so only the first pays for routing.
  const once = island()
  await rm(path.join(folder, '.mapper'), { recursive: true })
  await resolveSeaPaths(folder, p, { land: once })
  expect(land.calls).toBe(once.calls)
  expect(Object.keys((await readCacheFile()).paths).sort()).toEqual([...keys].sort())
})

test('returns nothing for a project without sea legs, and writes no file', async () => {
  const p = projectWith([{ from: A, to: B, mode: 'air' }])
  expect(await resolveSeaPaths(folder, p, { land: island() })).toEqual({})
  await expect(stat(path.join(folder, '.mapper'))).rejects.toThrow()
})
