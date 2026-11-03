import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  decodeLand,
  defaultProject,
  encodeLand,
  landIndex,
  NO_ROAD_ROUTE,
  ROAD_OFFLINE,
  roadLegKey,
  seaLegKey,
  type LngLat,
  type Project,
} from '../../src/core/index.js'
import { resolvePaths } from '../../src/server/paths.js'
import { NO_ROUTE_RETRY_MS, ROADS_FILE, resolveRoadPaths } from '../../src/server/road-paths.js'
import type { RoadReply, RoadRouter } from '../../src/server/roads.js'

let folder: string
beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), 'mapper-roads-'))
})
afterEach(() => rm(folder, { recursive: true, force: true }))

const A: LngLat = [9, 50]
const B: LngLat = [9.1, 50.1]
const C: LngLat = [9.2, 50.05]

function carProject(stops: LngLat[] = [A, B], via: LngLat[] = []): Project {
  const p = defaultProject({ id: '00000000-0000-4000-8000-000000000001', name: 't', now: '2026-01-01T00:00:00.000Z' })
  const scene = p.scenes[0]!
  scene.stops = stops.map((at, i) => ({ id: `s${i}`, at, name: `S${i}` })) as never
  scene.legs = stops.slice(1).map((_, i) => ({ mode: 'land', via: i === 0 ? via.map((at) => ({ at })) : [] })) as never
  return p
}

const ok = (): RoadReply => ({
  kind: 'ok',
  answer: { code: 'Ok', routes: [{ geometry: { coordinates: [[9.001, 50.001], [9.05, 50.08], [9.099, 50.099]] } }] },
})

function fake(reply: () => RoadReply = ok): RoadRouter & { calls: Array<{ profile: string; points: LngLat[] }> } {
  const calls: Array<{ profile: string; points: LngLat[] }> = []
  return { calls, route: async (profile, points) => (calls.push({ profile, points }), reply()) }
}

const file = () => path.join(folder, ROADS_FILE)
const key = () => roadLegKey('car', A, B, [])
const T0 = Date.parse('2026-06-01T00:00:00.000Z')

test('routes a road leg once and reuses it', async () => {
  const router = fake()
  const p = carProject()
  const first = await resolveRoadPaths(folder, p, { router, now: () => T0 })
  expect(router.calls).toHaveLength(1)
  expect(first[key()]!.status).toBe('ok')
  const saved = JSON.parse(await readFile(file(), 'utf8'))
  expect(saved.version).toBe(1)
  expect(saved.paths[key()].status).toBe('ok')
  expect(saved.paths[key()].usedAt).toBe(new Date(T0).toISOString())
  const second = await resolveRoadPaths(folder, p, { router, now: () => T0 + 1000 })
  expect(router.calls).toHaveLength(1)
  expect(second[key()]).toEqual(first[key()])
  expect(second[key()]).not.toHaveProperty('usedAt')
})

test('an ok route never expires', async () => {
  const router = fake()
  const p = carProject()
  await resolveRoadPaths(folder, p, { router, now: () => T0 })
  await resolveRoadPaths(folder, p, { router, now: () => T0 + 366 * 86_400_000 })
  expect(router.calls).toHaveLength(1)
})

test('offline is retried after a minute', async () => {
  let reply: RoadReply = { kind: 'offline' }
  const router = fake(() => reply)
  const p = carProject()
  const first = await resolveRoadPaths(folder, p, { router, now: () => T0 })
  expect(first[key()]).toEqual({ status: 'fallback', reason: ROAD_OFFLINE, path: [], knots: [], unverified: 'offline' })
  const saved = JSON.parse(await readFile(file(), 'utf8'))
  expect(saved.paths[key()].retryAt).toBe(new Date(T0 + 60_000).toISOString())
  await resolveRoadPaths(folder, p, { router, now: () => T0 + 59_000 })
  expect(router.calls).toHaveLength(1)
  reply = ok()
  const later = await resolveRoadPaths(folder, p, { router, now: () => T0 + 61_000 })
  expect(router.calls).toHaveLength(2)
  expect(later[key()]!.status).toBe('ok')
})

test('no-route is retried after a day', async () => {
  const router = fake(() => ({ kind: 'no-route' }))
  const p = carProject()
  const first = await resolveRoadPaths(folder, p, { router, now: () => T0 })
  expect(first[key()]).toEqual({ status: 'fallback', reason: NO_ROAD_ROUTE, path: [], knots: [] })
  const saved = JSON.parse(await readFile(file(), 'utf8'))
  expect(saved.paths[key()].retryAt).toBe(new Date(T0 + NO_ROUTE_RETRY_MS).toISOString())
  await resolveRoadPaths(folder, p, { router, now: () => T0 + NO_ROUTE_RETRY_MS - 1000 })
  expect(router.calls).toHaveLength(1)
  await resolveRoadPaths(folder, p, { router, now: () => T0 + NO_ROUTE_RETRY_MS + 1000 })
  expect(router.calls).toHaveLength(2)
})

test('drops a corrupt or other-version cache', async () => {
  const p = carProject()
  const bad = [
    'not json{',
    JSON.stringify({ version: 2, paths: {} }),
    JSON.stringify({ version: 1, paths: { [key()]: { status: 'ok', path: [], knots: [], usedAt: 'x' } } }),
    JSON.stringify({ version: 1, paths: { [key()]: { status: 'ok', path: [[1, 1]], knots: [0], usedAt: 'x' } } }),
    JSON.stringify({ version: 1, paths: { [key()]: { status: 'ok', path: [[1, 1], [2, 2]], knots: [0, 5], usedAt: 'x' } } }),
  ]
  for (const text of bad) {
    await rm(path.join(folder, '.mapper'), { recursive: true, force: true })
    await resolveRoadPaths(folder, carProject([A, C]), { router: fake(), now: () => T0 }) // makes the folder
    await writeFile(file(), text)
    const router = fake()
    const out = await resolveRoadPaths(folder, p, { router, now: () => T0 + 1 })
    expect(router.calls).toHaveLength(1)
    expect(out[key()]!.status).toBe('ok')
  }
})

test('keeps the newest 200 entries', async () => {
  let t = T0
  const router = fake()
  for (let i = 0; i < 205; i++) {
    t += 1000
    await resolveRoadPaths(folder, carProject([[i / 100, 10], [i / 100 + 0.01, 10.01]]), { router, now: () => t })
  }
  const saved = JSON.parse(await readFile(file(), 'utf8'))
  expect(Object.keys(saved.paths)).toHaveLength(200)
  expect(saved.paths[roadLegKey('car', [0, 10], [0.01, 10.01], [])]).toBeUndefined()
  expect(saved.paths[roadLegKey('car', [2.04, 10], [2.05, 10.01], [])]).toBeDefined()
})

test("answers when the cache can't be written", async () => {
  await writeFile(path.join(folder, '.mapper'), 'a file')
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    const router = fake()
    const p = carProject()
    expect((await resolveRoadPaths(folder, p, { router, now: () => T0 }))[key()]!.status).toBe('ok')
    expect((await resolveRoadPaths(folder, p, { router, now: () => T0 + 1 }))[key()]!.status).toBe('ok')
    expect(err).toHaveBeenCalledTimes(1)
    expect(router.calls).toHaveLength(1)
  } finally {
    err.mockRestore()
  }
})

test('sends stops and via points in order', async () => {
  const router = fake()
  const via: LngLat[] = [[9.03, 50.03], [9.06, 50.07]]
  await resolveRoadPaths(folder, carProject([A, B], via), { router, now: () => T0 })
  expect(router.calls[0]).toEqual({ profile: 'car', points: [A, ...via, B] })
})

test('resolvePaths merges sea, track and road entries', async () => {
  const ring: LngLat[] = [[20, 20], [21, 20], [21, 21], [20, 21]]
  const land = landIndex(decodeLand(encodeLand('test-land', [ring])))
  const p = carProject([A, B, C])
  const scene = p.scenes[0]!
  scene.legs = [{ mode: 'land', via: [] }, { mode: 'sea', via: [] }] as never
  const router = fake()
  const out = await resolvePaths(folder, p, { land, water: undefined, router, now: () => T0 })
  expect(out[roadLegKey('car', A, B, [])]!.status).toBe('ok')
  expect(out[seaLegKey(B, C, [])]).toBeDefined()
})
