import * as fsp from 'node:fs/promises'
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { decodeLand, defaultProject, encodeLand, landIndex, ROUTER_VERSION, routeSea, seaLegKey, type LandSource, type LngLat, type Project, type ViaPoint } from '../../src/core/index.js'
import { CACHE_VERSION, PATHS_FILE, resolveSeaPaths } from '../../src/server/paths.js'
import { SEA_BUDGET_TILES, SEA_WATER_VERSION, type SeaBudget, type SeaWater, type WaterNote } from '../../src/server/sea-water.js'

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
  const paths = await resolveSeaPaths(folder, p, { land: island(), water: undefined })
  const key = seaLegKey(A, B, [])
  expect(Object.keys(paths)).toEqual([key])
  expect(paths[key]!.status).toBe('ok')
  expect(paths[key]).not.toHaveProperty('usedAt')
  const file = await readCacheFile()
  expect(file).toMatchObject({ version: CACHE_VERSION, router: ROUTER_VERSION, land: 'test-land' })
  expect(file.paths[key].usedAt).toEqual(expect.any(String))
})

test('reads a cached path without routing again', async () => {
  const p = projectWith([{ from: A, to: B }])
  const first = await resolveSeaPaths(folder, p, { land: island(), water: undefined })
  const land = island()
  const second = await resolveSeaPaths(folder, p, { land, water: undefined })
  expect(land.calls).toBe(0)
  expect(second).toEqual(first)
})

test('ignores a cache from another router version', async () => {
  const p = projectWith([{ from: A, to: B }])
  await resolveSeaPaths(folder, p, { land: island(), water: undefined })
  const file = await readCacheFile()
  file.router = ROUTER_VERSION + 1
  await writeFile(cacheFile(), JSON.stringify(file))
  const land = island()
  await resolveSeaPaths(folder, p, { land, water: undefined })
  expect(land.calls).toBeGreaterThan(0)
  expect((await readCacheFile()).router).toBe(ROUTER_VERSION)
})

test('rebuilds a corrupt cache', async () => {
  await mkdir(path.dirname(cacheFile()), { recursive: true })
  await writeFile(cacheFile(), '{"version":')
  const p = projectWith([{ from: A, to: B }])
  const paths = await resolveSeaPaths(folder, p, { land: island(), water: undefined })
  expect(Object.keys(paths)).toHaveLength(1)
  expect(Object.keys((await readCacheFile()).paths)).toHaveLength(1)
})

test('drops malformed cache entries and reroutes them', async () => {
  const p = projectWith([{ from: A, to: B }])
  await resolveSeaPaths(folder, p, { land: island(), water: undefined })
  const key = seaLegKey(A, B, [])
  const file = await readCacheFile()
  file.paths[key] = { status: 'ok', path: [], knots: [], usedAt: '2026-01-01T00:00:00.000Z' }
  file.paths.bad = { status: 'nonsense', usedAt: '2026-01-01T00:00:00.000Z' }
  file.paths.far = { status: 'ok', path: [A, B], knots: [0, 5], usedAt: '2026-01-01T00:00:00.000Z' }
  await writeFile(cacheFile(), JSON.stringify(file))
  const land = island()
  const paths = await resolveSeaPaths(folder, p, { land, water: undefined })
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
  await writeFile(cacheFile(), JSON.stringify({ version: CACHE_VERSION, router: ROUTER_VERSION, land: 'test-land', paths: stale }))
  const p = projectWith([{ from: A, to: B }])
  await resolveSeaPaths(folder, p, { land: island(), water: undefined })
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
  const [x, y] = await Promise.all([resolveSeaPaths(folder, p, { land, water: undefined }), resolveSeaPaths(folder, p, { land, water: undefined })])
  const keys = [seaLegKey(A, B, []), seaLegKey(B, [11, 51], [])]
  expect(Object.keys(x).sort()).toEqual([...keys].sort())
  expect(Object.keys(y).sort()).toEqual([...keys].sort())
  // The second call finds both legs cached, so only the first pays for routing.
  const once = island()
  await rm(path.join(folder, '.mapper'), { recursive: true })
  await resolveSeaPaths(folder, p, { land: once, water: undefined })
  expect(land.calls).toBe(once.calls)
  expect(Object.keys((await readCacheFile()).paths).sort()).toEqual([...keys].sort())
})

test('returns nothing for a project without sea legs, and writes no file', async () => {
  const p = projectWith([{ from: A, to: B, mode: 'air' }])
  expect(await resolveSeaPaths(folder, p, { land: island(), water: undefined })).toEqual({})
  await expect(stat(path.join(folder, '.mapper'))).rejects.toThrow()
})

test('stores coordinates to 1e-6 degrees and keeps the knots exact', async () => {
  const from: LngLat = [9.123456789, 50.000000123]
  const to: LngLat = [11.987654321, 50.1]
  const p = projectWith([{ from, to }])
  const paths = await resolveSeaPaths(folder, p, { land: island(), water: undefined })
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
  expect(await resolveSeaPaths(folder, p, { land: island(), water: undefined })).toEqual(paths)
})

test('reuses its parsed copy while the file is unchanged', async () => {
  const p = projectWith([{ from: A, to: B }])
  const first = await resolveSeaPaths(folder, p, { land: island(), water: undefined })
  const reads = () => vi.mocked(fsp.readFile).mock.calls.filter(([f]) => f === cacheFile()).length
  const before = reads()
  expect(await resolveSeaPaths(folder, p, { land: island(), water: undefined })).toEqual(first)
  expect(await resolveSeaPaths(folder, p, { land: island(), water: undefined })).toEqual(first)
  expect(reads()).toBe(before)
  // A change on disk is read.
  const file = await readCacheFile()
  file.router = ROUTER_VERSION + 1
  await writeFile(cacheFile(), JSON.stringify(file))
  const changed = reads()
  const land = island()
  await resolveSeaPaths(folder, p, { land, water: undefined })
  expect(reads()).toBe(changed + 1)
  expect(land.calls).toBeGreaterThan(0)
})

test('answers the routes when the cache cannot be written', async () => {
  // A file where the .mapper folder should be.
  await writeFile(path.join(folder, '.mapper'), 'not a folder')
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const p = projectWith([{ from: A, to: B }])
    const paths = await resolveSeaPaths(folder, p, { land: island(), water: undefined })
    expect(paths[seaLegKey(A, B, [])]!.status).toBe('ok')
    await resolveSeaPaths(folder, projectWith([{ from: B, to: A }]), { land: island(), water: undefined })
    expect(error).toHaveBeenCalledTimes(1)
  } finally {
    error.mockRestore()
  }
})

test('serialises calls that spell the folder differently', async () => {
  const p = projectWith([{ from: A, to: B }])
  const land = island()
  await Promise.all([
    resolveSeaPaths(folder, p, { land, water: undefined }),
    resolveSeaPaths(folder + path.sep, p, { land, water: undefined }),
    resolveSeaPaths(path.join(folder, '.'), p, { land, water: undefined }),
  ])
  const once = island()
  await rm(path.join(folder, '.mapper'), { recursive: true })
  await resolveSeaPaths(folder, p, { land: once, water: undefined })
  expect(land.calls).toBe(once.calls)
})

/** A sea router on `land` alone that says the leg was checked, or that it couldn't be, as `state` says. Counts calls. */
function fakeWater(state: { online: boolean } = { online: true }, cost = 0): SeaWater & { calls: number; budgets: SeaBudget[]; seen: number[] } {
  const fake = {
    calls: 0,
    budgets: [] as SeaBudget[],
    seen: [] as number[],
    async route(from: LngLat, to: LngLat, via: ViaPoint[], base: LandSource, budget: SeaBudget) {
      fake.calls++
      fake.budgets.push(budget)
      fake.seen.push(budget.tiles)
      budget.tiles -= cost
      const sea = routeSea(from, to, via, base)
      const water: WaterNote = state.online ? { build: 'b1', tiles: 3, rounds: 1 } : { unverified: 'offline' }
      return state.online ? { ...sea, water } : { ...sea, unverified: 'offline' as const, water }
    },
  }
  return fake
}

/** A sea router that fails the test if it's asked for anything. */
const refuse: SeaWater = {
  route: () => {
    throw new Error('routed again')
  },
}

test('a verified entry is never re-routed', async () => {
  const p = projectWith([{ from: A, to: B }])
  const key = seaLegKey(A, B, [])
  const water = fakeWater()
  const first = await resolveSeaPaths(folder, p, { land: island(), water, now: () => 0 })
  expect(water.calls).toBe(1)
  expect(first[key]!.status).toBe('ok')
  expect(first[key]!.unverified).toBeUndefined()
  // The result is the path alone.
  expect(first[key]).not.toHaveProperty('water')
  expect(first[key]).not.toHaveProperty('retryAt')
  const file = await readCacheFile()
  expect(file).toMatchObject({ version: CACHE_VERSION, router: ROUTER_VERSION, land: `test-land+${SEA_WATER_VERSION}` })
  expect(file.paths[key].water).toEqual({ build: 'b1', tiles: 3, rounds: 1 })
  expect(file.paths[key]).not.toHaveProperty('retryAt')
  // A day later, from the memo and from the file, it's read and not routed.
  const day = 24 * 60 * 60 * 1000
  expect(await resolveSeaPaths(folder, p, { land: island(), water: refuse, now: () => day })).toEqual(first)
  await writeFile(cacheFile(), JSON.stringify(await readCacheFile()))
  expect(await resolveSeaPaths(folder, p, { land: island(), water: refuse, now: () => 2 * day })).toEqual(first)
})

test("offline routes come back unverified and aren't retried within a minute", async () => {
  const p = projectWith([{ from: A, to: B }])
  const key = seaLegKey(A, B, [])
  const water = fakeWater({ online: false })
  let clock = 0
  const resolve = () => resolveSeaPaths(folder, p, { land: island(), water, now: () => clock })
  const first = await resolve()
  expect(water.calls).toBe(1)
  expect(first[key]!.status).toBe('ok')
  expect(first[key]!.unverified).toBe('offline')
  const stored = (await readCacheFile()).paths[key]
  expect(stored.water).toEqual({ unverified: 'offline' })
  expect(stored.retryAt).toBe(new Date(60_000).toISOString())
  clock = 30_000
  expect(await resolve()).toEqual(first)
  expect(water.calls).toBe(1)
  clock = 61_000
  expect((await resolve())[key]!.unverified).toBe('offline')
  expect(water.calls).toBe(2)
  // The retry starts a fresh minute.
  expect((await readCacheFile()).paths[key].retryAt).toBe(new Date(121_000).toISOString())
  clock = 90_000
  await resolve()
  expect(water.calls).toBe(2)
})

test('an upgraded entry replaces the unverified one', async () => {
  const p = projectWith([{ from: A, to: B }])
  const key = seaLegKey(A, B, [])
  const state = { online: false }
  const water = fakeWater(state)
  await resolveSeaPaths(folder, p, { land: island(), water, now: () => 0 })
  state.online = true
  const upgraded = await resolveSeaPaths(folder, p, { land: island(), water, now: () => 61_000 })
  expect(water.calls).toBe(2)
  expect(upgraded[key]!.unverified).toBeUndefined()
  const stored = (await readCacheFile()).paths[key]
  expect(stored.water).toEqual({ build: 'b1', tiles: 3, rounds: 1 })
  expect(stored).not.toHaveProperty('retryAt')
  expect(stored).not.toHaveProperty('unverified')
  // From then on it's verified, and stays put.
  expect(await resolveSeaPaths(folder, p, { land: island(), water: refuse, now: () => 10 * 61_000 })).toEqual(upgraded)
})

test('a cache file from router version 2 is dropped', async () => {
  const p = projectWith([{ from: A, to: B }])
  const key = seaLegKey(A, B, [])
  const old = { status: 'ok', path: [A, B], knots: [0, 1], usedAt: '2026-01-01T00:00:00.000Z' }
  const land = `test-land+${SEA_WATER_VERSION}`
  for (const head of [
    { version: 1, router: 2, land: 'test-land' },
    { version: CACHE_VERSION, router: 2, land },
    { version: 1, router: ROUTER_VERSION, land },
  ]) {
    await mkdir(path.dirname(cacheFile()), { recursive: true })
    await writeFile(cacheFile(), JSON.stringify({ ...head, paths: { [key]: old } }))
    const water = fakeWater()
    const paths = await resolveSeaPaths(folder, p, { land: island(), water })
    expect(water.calls).toBe(1)
    expect(paths[key]!.path).not.toEqual([A, B])
    expect(await readCacheFile()).toMatchObject({ version: CACHE_VERSION, router: ROUTER_VERSION, land })
  }
})

test('one resolve shares one budget across legs', async () => {
  const C: LngLat = [11, 51]
  const water = fakeWater({ online: true }, 100)
  await resolveSeaPaths(folder, projectWith([{ from: A, to: B }, { from: B, to: C }]), { land: island(), water })
  expect(water.calls).toBe(2)
  expect(water.budgets[0]).toBe(water.budgets[1])
  expect(water.seen).toEqual([SEA_BUDGET_TILES, SEA_BUDGET_TILES - 100])
  // The next call starts a fresh one.
  await resolveSeaPaths(folder, projectWith([{ from: C, to: A }]), { land: island(), water })
  expect(water.budgets[2]).not.toBe(water.budgets[0])
  expect(water.seen[2]).toBe(SEA_BUDGET_TILES)
})
