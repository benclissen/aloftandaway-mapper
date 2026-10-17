import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Page } from 'playwright'
import { PNG } from 'pngjs'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  buildRoute,
  buildTimeline,
  cameraAt,
  pointAt,
  layoutSize,
  SIGN_TAG,
  TILE_SIZE,
  toXY,
  type LngLat,
  type Project,
} from '../../src/core/index.js'
import { planExport } from '../../src/render/export-plan.js'
import { resolveSeaPaths } from '../../src/server/paths.js'
import { alpineTilted, cruise, greekIslands, sceneOf, stopsAt } from '../fixtures/projects.js'
import type { MapperPage } from '../../src/studio/render-mode.js'
import { closeAll, expectGolden, openRenderPage, pixelDiff, snapshot } from './helpers.js'
import { startSeaFixtures, type SeaFixtures } from './sea-fixtures.js'

/** Serves the committed water tiles, so the sea legs here don't reach OpenFreeMap. */
let seaFixtures: SeaFixtures
beforeAll(async () => {
  // Not the tile upstream: this file's MAPPER_NET tests draw live map tiles through the shared server.
  seaFixtures = await startSeaFixtures({ env: false })
})
afterAll(async () => {
  await closeAll()
  await seaFixtures?.close()
})

/** The layout-px position of `at` on `frame`, for a shot with no bearing or pitch. */
function layoutPx(project: Project, frame: number, at: LngLat): [number, number] {
  const scene = sceneOf(project)
  const route = buildRoute(scene)
  const shot = cameraAt(scene, project.output.aspect, route, buildTimeline(scene, project.output.fps, route), frame)
  const { width, height } = layoutSize(project.output.aspect)
  const scale = TILE_SIZE * 2 ** shot.zoom
  const [x, y] = toXY(at)
  const [cx, cy] = toXY(shot.center)
  return [width / 2 + (x - cx) * scale, height / 2 + (y - cy) * scale]
}

/** The RGBA pixel at device position (x, y). */
function pixel(png: Buffer, x: number, y: number): [number, number, number, number] {
  const { data, width } = PNG.sync.read(png)
  const i = (Math.round(y) * width + Math.round(x)) * 4
  return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!]
}

describe('render page, blank theme, pixelRatio 0.5', () => {
  let page: Page

  beforeAll(async () => {
    ;({ page } = await openRenderPage(greekIslands(), 0.5))
  })

  test('render page loads and reports frame count', async () => {
    expect(await page.evaluate(() => (window as unknown as { mapper: MapperPage }).mapper.frameCount)).toBe(350)
  })

  test('golden frames', async () => {
    for (const f of [0, 175, 349]) expectGolden(`greek-${f}`, await snapshot(page, f))
  })

  test('frames are deterministic regardless of order', async () => {
    const a = await snapshot(page, 40)
    await snapshot(page, 10)
    const b = await snapshot(page, 40)
    expect(pixelDiff(a, b)).toBe(0)
  })

  test('frames are 960×540 and the blank background fills them', async () => {
    const png = await snapshot(page, 0)
    const { width, height } = PNG.sync.read(png)
    expect([width, height]).toEqual([960, 540])
    // Top-left corner: nothing but background.
    expect(pixel(png, 4, 4)).toEqual([0xe9, 0xe4, 0xda, 255])
  })

  test('the route reaches the head: drawn behind it, absent ahead of it', async () => {
    const project = greekIslands()
    const route = buildRoute(sceneOf(project))
    const timeline = buildTimeline(sceneOf(project), project.output.fps, route)
    // Halfway through the first leg (Piraeus → Mykonos), the line runs from Piraeus to the head.
    const leg = timeline.legFrames[0]!
    const frame = Math.round((leg.start + leg.end) / 2)
    const { distance } = timeline.stateAt(frame)
    const legEnd = route.legs[0]!.length
    const png = await snapshot(page, frame)
    const at = (d: number) => layoutPx(project, frame, pointAt(route, d).at).map((v) => v * 0.5) as [number, number]
    const [r, g, b] = pixel(png, ...at(distance * 0.5))
    // Behind the head: the route colour (#d9472b, give or take anti-aliasing). Ahead of it: background.
    expect(r).toBeGreaterThan(180)
    expect(g).toBeLessThan(130)
    expect(b).toBeLessThan(110)
    expect(pixel(png, ...at(distance + (legEnd - distance) * 0.5))).toEqual([0xe9, 0xe4, 0xda, 255])
  })

  test('renders never show edit layers', async () => {
    // The studio draws the whole route faintly for editing. A render at frame 0 has drawn none of it yet. The default
    // glide opens on the first leg, so look halfway along it.
    const project = greekIslands()
    const route = buildRoute(sceneOf(project))
    const middle = pointAt(route, route.legs[0]!.length / 2).at
    const png = await snapshot(page, 0)
    const [x, y] = layoutPx(project, 0, middle).map((v) => v * 0.5) as [number, number]
    expect(x > 0 && x < 960 && y > 0 && y < 540).toBe(true)
    expect(pixel(png, x, y)).toEqual([0xe9, 0xe4, 0xda, 255])
  })
})

test('4K canvas is 3840×2160 with pixelRatio 2', async () => {
  const { page, close } = await openRenderPage({ ...greekIslands(), output: { aspect: '16:9', height: 2160, fps: { num: 25, den: 1 } } }, 2)
  const size = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.maplibregl-canvas')!
    return [canvas.width, canvas.height]
  })
  expect(size).toEqual([3840, 2160])
  const png = PNG.sync.read(await snapshot(page, 0))
  expect([png.width, png.height]).toEqual([3840, 2160])
  await close()
})

// The blank theme shows no map data, so it burns in no credit. Drawing the lines is covered by test/studio/overlay.test.ts.
test('burned credit draws nothing on the blank theme', async () => {
  const burned = await openRenderPage({ ...greekIslands(), credit: 'burned' }, 0.5)
  const described = await openRenderPage({ ...greekIslands(), credit: 'description' }, 0.5)
  expect(pixelDiff(await snapshot(burned.page, 0), await snapshot(described.page, 0))).toBe(0)
  await burned.close()
  await described.close()
})

test('renderFrame rejects when map data fails to load', async () => {
  // Nothing listens on port 9, so the tile proxy answers 502 after its retries.
  const project = greekIslands({ look: { ...sceneOf(greekIslands()).look, theme: 'paper' } })
  const { page, close } = await openRenderPage(project, 0.5, { tileUpstream: 'http://127.0.0.1:9' })
  const error = await page.evaluate(() =>
    (window as unknown as { mapper: MapperPage }).mapper.renderFrame(0).then(
      () => 'resolved',
      (e: Error) => e.message,
    ),
  )
  expect(error).toMatch(/could not load/i)
  await close()
})

test('elevation tile failure surfaces as a map-data error', async () => {
  // Blank draws no basemap, so the only upstream requests are for elevation tiles. Nothing listens on port 9.
  const project = greekIslands({ look: { ...sceneOf(greekIslands()).look, theme: 'blank', terrain: true } })
  const { page, close } = await openRenderPage(project, 0.5, { tileUpstream: 'http://127.0.0.1:9' })
  const error = await page.evaluate(() =>
    (window as unknown as { mapper: MapperPage }).mapper.renderFrame(0).then(
      () => 'resolved',
      (e: Error) => e.message,
    ),
  )
  expect(error).toMatch(/could not load/i)
  await close()
})

test.skipIf(process.env.MAPPER_NET !== '1')('paper theme draws water (MAPPER_NET only)', async () => {
  // Framed on the whole route (a fixed camera with no start), so the Cretan Sea is in view on frame 0.
  const project = greekIslands({
    look: { ...sceneOf(greekIslands()).look, theme: 'paper' },
    camera: { mode: 'fixed', easing: 'smooth' },
  })
  const { page, close } = await openRenderPage(project, 0.5)
  const png = await snapshot(page, 0)
  const dir = path.resolve('test-output', 'e2e')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'paper-0.png'), png)
  // Open sea in the Cretan Sea, south of the Cyclades.
  const [x, y] = layoutPx(project, 0, [25.0, 36.0]).map((v) => v * 0.5)
  const [r, g, b] = pixel(png, x!, y!)
  expect(b).toBeGreaterThan(r + 20)
  expect(b).toBeGreaterThanOrEqual(g)
  await close()
})

describe('the vehicle at the route head', () => {
  const NAVY: [number, number, number] = [0x0a, 0x24, 0x34]
  const isNavy = ([r, g, b]: number[]) => Math.abs(r! - NAVY[0]) < 40 && Math.abs(g! - NAVY[1]) < 40 && Math.abs(b! - NAVY[2]) < 40

  test('golden frames: a cruise ship in each symbol style', async () => {
    for (const symbolStyle of ['badge', 'badge-line', 'icon'] as const) {
      const base = sceneOf(greekIslands()).look
      // Framed whole and still: the default glide is still close in on the first leg when the ship is off Santorini.
      const project = greekIslands({ look: { ...base, symbol: 'cruise-ship', symbolStyle }, camera: { mode: 'fixed', easing: 'smooth' } })
      const { page, close } = await openRenderPage(project, 0.5)
      expectGolden(`vehicle-${symbolStyle}`, await snapshot(page, 175))
      await close()
    }
  })

  /** Frame and layout-px head position halfway along a two-stop route. */
  function midHead(project: Project): { frame: number; x: number; y: number } {
    const scene = sceneOf(project)
    const route = buildRoute(scene)
    const timeline = buildTimeline(scene, project.output.fps, route)
    const leg = timeline.legFrames[0]!
    const frame = Math.round((leg.start + leg.end) / 2)
    const [x, y] = layoutPx(project, frame, timeline.stateAt(frame).head.at)
    return { frame, x, y }
  }

  /** A one-leg route, framed whole and still (a fixed camera with no start), so the head sits on a pixel edge. */
  function twoStops(points: LngLat[], symbol: 'car' | 'arrow') {
    const base = sceneOf(greekIslands()).look
    return stopsAt(points, { look: { ...base, symbol, symbolStyle: 'icon' }, camera: { mode: 'fixed', easing: 'smooth' } })
  }

  test('a westbound car is mirrored', async () => {
    // Pixel dx of the eastbound frame matches pixel -dx - 1 of the westbound one: the head sits on a pixel edge.
    const east = twoStops([[0, 0], [10, 0]], 'car')
    const west = twoStops([[10, 0], [0, 0]], 'car')
    const e = midHead(east)
    const w = midHead(west)
    const eastPage = await openRenderPage(east, 1)
    const westPage = await openRenderPage(west, 1)
    const eastPng = PNG.sync.read(await snapshot(eastPage.page, e.frame))
    const westPng = PNG.sync.read(await snapshot(westPage.page, w.frame))
    const at = (png: PNG, x: number, y: number) => isNavy([...png.data.subarray((Math.round(y) * png.width + Math.round(x)) * 4, (Math.round(y) * png.width + Math.round(x)) * 4 + 3)])
    let mirrored = 0
    let same = 0
    let navy = 0
    for (let dy = -16; dy <= 16; dy++) {
      for (let dx = -16; dx <= 16; dx++) {
        const a = at(eastPng, e.x + dx, e.y + dy)
        if (a) navy++
        if (a !== at(westPng, w.x - dx - 1, w.y + dy)) mirrored++
        if (a !== at(westPng, w.x + dx, w.y + dy)) same++
      }
    }
    expect(navy).toBeGreaterThan(50)
    expect(mirrored).toBeLessThan(navy * 0.1)
    expect(same).toBeGreaterThan(navy * 0.4)
    await eastPage.close()
    await westPage.close()
  })

  test('an arrow turns with the line: heading east puts the tip to the right of the head', async () => {
    const project = twoStops([[0, 0], [10, 0]], 'arrow')
    const { frame, x, y } = midHead(project)
    const { page, close } = await openRenderPage(project, 1)
    const png = PNG.sync.read(await snapshot(page, frame))
    const navyAt = (dx: number) => {
      const i = (Math.round(y) * png.width + Math.round(x + dx)) * 4
      return isNavy([png.data[i]!, png.data[i + 1]!, png.data[i + 2]!])
    }
    expect(navyAt(8)).toBe(true)
    expect(navyAt(-8)).toBe(false)
    await close()
  })
})

describe('sea legs', () => {
  test('golden: the cruise at its last frame goes around the islands', async () => {
    const project = cruise()
    const folder = await mkdtemp(path.join(os.tmpdir(), 'mapper-sea-golden-'))
    try {
      const seaPaths = await resolveSeaPaths(folder, project, { water: seaFixtures.water })
      const { page, close } = await openRenderPage(project, 0.5, { seaPaths })
      const last = await page.evaluate(() => (window as unknown as { mapper: MapperPage }).mapper.frameCount - 1)
      const png = await snapshot(page, last)
      expectGolden(`sea-${last}`, png)
      await close()
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })

  test('render page frame count matches the plan for sea legs', async () => {
    const project = cruise()
    const folder = await mkdtemp(path.join(os.tmpdir(), 'mapper-sea-count-'))
    try {
      const seaPaths = await resolveSeaPaths(folder, project, { water: seaFixtures.water })
      const expected = planExport(project, { seaPaths }).scenes[0]!.totalFrames
      const { page, close } = await openRenderPage(project, 0.5, { seaPaths })
      expect(await page.evaluate(() => (window as unknown as { mapper: MapperPage }).mapper.frameCount)).toBe(expected)
      await close()
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })
})

describe.skipIf(process.env.MAPPER_NET !== '1')('terrain and tilt (MAPPER_NET only)', () => {
  const projectOn = (page: Page, at: LngLat) =>
    page.evaluate((p) => (window as unknown as { mapper: MapperPage }).mapper.project(p), at)

  test('a tilted terrain frame renders and is deterministic', async () => {
    const project = alpineTilted()
    const warm = await openRenderPage(project, 0.5)
    const fresh = await openRenderPage(project, 0.5)
    try {
      const a = await snapshot(warm.page, 40)
      const dir = path.resolve('test-output', 'e2e')
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'alpine-40.png'), a)
      await snapshot(warm.page, 10)
      const b = await snapshot(warm.page, 40)
      await snapshot(fresh.page, 300)
      const c = await snapshot(fresh.page, 40)
      expect(pixelDiff(a, b)).toBe(0)
      expect(pixelDiff(a, c)).toBe(0)
    } finally {
      await warm.close()
      await fresh.close()
    }
  })

  test('turning terrain off on a warm page matches a fresh page', async () => {
    const project = alpineTilted()
    const flat = alpineTilted()
    sceneOf(flat).look.terrain = false
    const warm = await openRenderPage(project, 0.5)
    const fresh = await openRenderPage(flat, 0.5)
    try {
      const tilted = await snapshot(warm.page, 40)
      await warm.page.evaluate(async (p) => {
        await (window as unknown as { mapper: MapperPage }).mapper.load(p, { pixelRatio: 0.5 })
      }, flat)
      const switched = await snapshot(warm.page, 40)
      expect(pixelDiff(switched, await snapshot(fresh.page, 40))).toBe(0)
      expect(pixelDiff(switched, tilted)).toBeGreaterThan(1000)
    } finally {
      await warm.close()
      await fresh.close()
    }
  })

  test('signs sit on the terrain', async () => {
    const project = alpineTilted()
    const stops = sceneOf(project).stops
    const signs = await openRenderPage(project, 1, { layer: 'signs' })
    // The same view over sea-level terrain, to show the elevation moves the stops.
    const sea = await openRenderPage(project, 1, { layer: 'signs', flatTerrain: true })
    try {
      const png = PNG.sync.read(await snapshot(signs.page, 0))
      await snapshot(sea.page, 0)
      for (const stop of stops) {
        const [x, y] = await projectOn(signs.page, stop.at)
        const [sx, sy] = await projectOn(sea.page, stop.at)
        expect(Math.hypot(x - sx, y - sy), stop.name).toBeGreaterThan(10)
        // The tag's pointer tip is the lowest opaque row near the stop; the anchor sits below it.
        let tip: { x: number[]; y: number } | undefined
        for (let py = Math.round(y) - 80; py <= Math.round(y) + 40; py++) {
          for (let px = Math.round(x) - 40; px <= Math.round(x) + 40; px++) {
            if (px < 0 || py < 0 || px >= png.width || py >= png.height || png.data[(py * png.width + px) * 4 + 3]! < 128) continue
            if (!tip || py > tip.y) tip = { x: [px], y: py }
            else if (py === tip.y) tip.x.push(px)
          }
        }
        expect(tip, stop.name).toBeDefined()
        const anchorX = tip!.x.reduce((sum, v) => sum + v, 0) / tip!.x.length + 0.5
        const anchorY = tip!.y + 1 + SIGN_TAG.lift - SIGN_TAG.pointer
        expect(Math.hypot(anchorX - x, anchorY - y), `${stop.name} anchor (${anchorX}, ${anchorY}) vs (${x}, ${y})`).toBeLessThanOrEqual(3)
      }
    } finally {
      await signs.close()
      await sea.close()
    }
  })
})
