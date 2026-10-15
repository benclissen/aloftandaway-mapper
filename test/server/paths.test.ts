import * as fsp from 'node:fs/promises'
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { decodeLand, defaultProject, encodeLand, landIndex, ROUTER_VERSION, seaLegKey, type LandSource, type LngLat, type Project } from '../../src/core/index.js'
import { PATHS_FILE, resolveSeaPaths } from '../../src/server/paths.js'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, readFile: vi.fn(fs.readFile) }
})

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

test('keeps the newest 200 entries', async () => {
  const stale: Record<string, unknown> = {}
  for (let i = 0; i < 220; i++) {
    stale[`k${i}`] = { status: 'fallback', usedAt: new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString() }
  }
  await mkdir(path.dirname(cacheFile()), { recursive: true })
  await writeFile(cacheFile(), JSON.stringify({ version: 1, router: ROUTER_VERSION, land: 'test-land', paths: stale }))
  const p = projectWith([{ from: A, to: B }])
  await resolveSeaPaths(folder, p, { land: island() })
  const keys = Object.keys((await readCacheFile()).paths)
  expect(keys).toHaveLength(200)
  expect(keys).toContain(seaLegKey(A, B, []))
  expect(keys).not.toContain('k20')
  expect(keys).toContain('k21')
  expect(keys).toContain('k219')
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

test('stores coordinates to 1e-6 degrees and keeps the knots exact', async () => {
  const from: LngLat = [9.123456789, 50.000000123]
  const to: LngLat = [11.987654321, 50.1]
  const p = projectWith([{ from, to }])
  const paths = await resolveSeaPaths(folder, p, { land: island() })
  const key = seaLegKey(from, to, [])
  const stored = (await readCacheFile()).paths[key]
  expect(stored.path[0]).toEqual(from)
  expect(stored.path.at(-1)).toEqual(to)
  const inner = stored.path.slice(1, -1) as LngLat[]
  expect(inner.length).toBeGreaterThan(0)
  for (const [lng, lat] of inner) {
    expect(Math.abs(lng * 1e6 - Math.round(lng * 1e6))).toBeLessThan(1e-6)
    expect(Math.abs(lat * 1e6 - Math.round(lat * 1e6))).toBeLessThan(1e-6)
  }
  // The answer matches what a later call reads back.
  expect(await resolveSeaPaths(folder, p, { land: island() })).toEqual(paths)
})

test('reuses its parsed copy while the file is unchanged', async () => {
  const p = projectWith([{ from: A, to: B }])
  const first = await resolveSeaPaths(folder, p, { land: island() })
  const reads = () => vi.mocked(fsp.readFile).mock.calls.filter(([f]) => f === cacheFile()).length
  const before = reads()
  expect(await resolveSeaPaths(folder, p, { land: island() })).toEqual(first)
  expect(await resolveSeaPaths(folder, p, { land: island() })).toEqual(first)
  expect(reads()).toBe(before)
  // A change on disk is read.
  const file = await readCacheFile()
  file.router = ROUTER_VERSION + 1
  await writeFile(cacheFile(), JSON.stringify(file))
  const changed = reads()
  const land = island()
  await resolveSeaPaths(folder, p, { land })
  expect(reads()).toBe(changed + 1)
  expect(land.calls).toBeGreaterThan(0)
})

test('answers the routes when the cache cannot be written', async () => {
  // A file where the .mapper folder should be.
  await writeFile(path.join(folder, '.mapper'), 'not a folder')
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const p = projectWith([{ from: A, to: B }])
    const paths = await resolveSeaPaths(folder, p, { land: island() })
    expect(paths[seaLegKey(A, B, [])]!.status).toBe('ok')
    await resolveSeaPaths(folder, projectWith([{ from: B, to: A }]), { land: island() })
    expect(error).toHaveBeenCalledTimes(1)
  } finally {
    error.mockRestore()
  }
})

test('serialises calls that spell the folder differently', async () => {
  const p = projectWith([{ from: A, to: B }])
  const land = island()
  await Promise.all([
    resolveSeaPaths(folder, p, { land }),
    resolveSeaPaths(folder + path.sep, p, { land }),
    resolveSeaPaths(path.join(folder, '.'), p, { land }),
  ])
  const once = island()
  await rm(path.join(folder, '.mapper'), { recursive: true })
  await resolveSeaPaths(folder, p, { land: once })
  expect(land.calls).toBe(once.calls)
})
