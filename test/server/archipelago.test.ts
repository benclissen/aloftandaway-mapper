import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { haversineKm, routeSea, type LandSource, type LngLat, type SeaPath } from '../../src/core/index.js'
import { loadLand } from '../../src/server/land.js'
import { createSeaWater, SEA_BUDGET_TILES, type SeaWater } from '../../src/server/sea-water.js'
import { createTileStore } from '../../src/server/tiles.js'
import { startFakeTiles, type FakeTiles } from '../helpers/fake-tiles.js'
import { findLand, showLand, type LandCheck } from '../helpers/water-check.js'
import { greekIslands, sceneOf } from '../fixtures/projects.js'

/**
 * The stage's proof: a route through the Stockholm archipelago stays off every island the basemap draws. The tiles are
 * the committed water-only fixtures; the check decodes the zoom-14 polygons itself (test/helpers/water-check.ts) and
 * shares nothing with the router's pixels.
 */

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/sea-tiles')

// The manifest's final stops: Sandhamn was moved off the land, into the harbour inlet.
const STADSGARDEN: LngLat = [18.087, 59.317]
const SANDHAMN: LngLat = [18.9073, 59.2893]
const MARIEHAMN: LngLat = [19.925, 60.0935]

let fake: FakeTiles
let water: SeaWater
let land: LandSource
let cache: string
let build: string

beforeAll(async () => {
  fake = await startFakeTiles(FIXTURES)
  build = fake.build
  cache = await mkdtemp(path.join(os.tmpdir(), 'mapper-archipelago-'))
  water = createSeaWater({ store: createTileStore({ cacheDir: cache, upstream: fake.url, retryDelaysMs: [] }) })
  land = await loadLand()
})

afterAll(async () => {
  await fake?.close()
  if (cache) await rm(cache, { recursive: true, force: true })
})

/** A fixture tile's bytes, or undefined when the fixture has no file (an empty tile). */
const fixtureTile =
  (zoom: number) =>
  async (x: number, y: number): Promise<Uint8Array | undefined> =>
    readFile(path.join(FIXTURES, build, String(zoom), String(x), `${y}.pbf`)).catch(() => undefined)

const lengthKm = (p: LngLat[]): number => p.slice(1).reduce((sum, q, i) => sum + haversineKm(p[i]!, q), 0)

/** The point halfway along the path's length. */
function midpoint(p: LngLat[]): LngLat {
  const half = lengthKm(p) / 2
  let along = 0
  for (let i = 1; i < p.length; i++) {
    const d = haversineKm(p[i - 1]!, p[i]!)
    if (along + d >= half) {
      const t = d === 0 ? 0 : (half - along) / d
      return [p[i - 1]![0] + (p[i]![0] - p[i - 1]![0]) * t, p[i - 1]![1] + (p[i]![1] - p[i - 1]![1]) * t]
    }
    along += d
  }
  return p[p.length - 1]!
}

/** The stops are given in km, the check skips each end's gap plus 20 m, for the connector from the stop to its water. */
const skipOf = (sea: SeaPath): [number, number] => [(sea.stopGapKm?.[0] ?? 0) * 1000 + 20, (sea.stopGapKm?.[1] ?? 0) * 1000 + 20]

async function routeOn(from: LngLat, to: LngLat): Promise<SeaPath & { water: unknown }> {
  return water.route(from, to, [], land, { tiles: SEA_BUDGET_TILES })
}

function expectOffLand(check: LandCheck): void {
  expect(check.land.length, `land samples (of ${check.checked}):\n${showLand(check)}`).toBe(0)
  expect(check.missing, 'samples in a tile with no fixture file').toBe(0)
}

async function proof(name: string, from: LngLat, to: LngLat): Promise<void> {
  const sea = await routeOn(from, to)
  expect(sea.status).toBe('ok')
  expect(sea.reason).toBeUndefined()
  expect(sea.unverified).toBeUndefined()
  expect(sea.crossesLand).toBeUndefined()
  expect(sea.water).toMatchObject({ build })
  expect(sea.stopGapKm![0]).toBeLessThan(0.15)
  expect(sea.stopGapKm![1]).toBeLessThan(0.15)

  const check = await findLand(sea.path, { zoom: 14, stepM: 5, skipM: skipOf(sea), tile: fixtureTile(14) })
  console.info(
    `${name}: ${lengthKm(sea.path).toFixed(1)} km, ${sea.path.length} points, ${check.checked} samples, ` +
      `${check.land.length} on land, ${check.missing} in missing tiles, stopGapKm ${JSON.stringify(sea.stopGapKm)}`,
  )
  expect(check.checked).toBeGreaterThan(1000)
  expectOffLand(check)
}

describe('the Stockholm archipelago', () => {
  it('Stockholm to Sandhamn stays off every island the basemap draws', async () => {
    await proof('Stockholm to Sandhamn', STADSGARDEN, SANDHAMN)
  }, 120_000)

  it('Stockholm to Mariehamn stays off every island the basemap draws', async () => {
    await proof('Stockholm to Mariehamn', STADSGARDEN, MARIEHAMN)
  }, 120_000)

  it('Natural Earth alone crosses the archipelago', async () => {
    // The same check on the route Natural Earth gives, which draws solid land over the fairways. It finds land, so the
    // check can fail. Samples whose tile has no fixture are not counted either way.
    const sea = routeSea(STADSGARDEN, MARIEHAMN, [], land)
    expect(sea.status).toBe('ok')
    const check = await findLand(sea.path, { zoom: 14, stepM: 5, skipM: skipOf(sea), tile: fixtureTile(14) })
    console.info(`Natural Earth, Stockholm to Mariehamn: ${check.checked} samples, ${check.land.length} on land, ${check.missing} in missing tiles`)
    expect(check.land.length).toBeGreaterThan(0)
  }, 120_000)
})

describe('greekIslands()', () => {
  it('sea legs keep their shape and stay at sea', async () => {
    const stops = sceneOf(greekIslands()).stops
    for (let i = 1; i < stops.length; i++) {
      const from = stops[i - 1]!
      const to = stops[i]!
      const sea = await routeOn(from.at, to.at)
      const base = routeSea(from.at, to.at, [], land)
      const label = `${from.name} to ${to.name}`

      expect(sea.status, label).toBe('ok')
      expect(sea.unverified, label).toBeUndefined()
      expect(sea.crossesLand, label).toBeUndefined()
      expect(base.status, label).toBe('ok')

      // Zoom 12 is what the router reads. Where the fixtures have no tile (open sea, away from every coast) the router
      // used Natural Earth, so the check does too.
      const check = await findLand(sea.path, {
        zoom: 12,
        stepM: 25,
        skipM: skipOf(sea),
        tile: fixtureTile(12),
        landWhenMissing: (at) => land.isLand(at),
      })
      const km = lengthKm(sea.path)
      const baseKm = lengthKm(base.path)
      const apart = haversineKm(midpoint(sea.path), midpoint(base.path))
      console.info(
        `${label}: ${km.toFixed(1)} km (Natural Earth ${baseKm.toFixed(1)}), midpoints ${apart.toFixed(1)} km apart, ` +
          `${check.checked} samples, ${check.land.length} on land, stopGapKm ${JSON.stringify(sea.stopGapKm)}`,
      )
      expect(check.land.length, `${label}: land samples (of ${check.checked}):\n${showLand(check)}`).toBe(0)
      expect(Math.abs(km - baseKm) / baseKm, `${label}: length ${km} km against ${baseKm} km`).toBeLessThan(0.1)
      expect(apart, `${label}: midpoints`).toBeLessThan(15)
    }
  }, 180_000)
})
