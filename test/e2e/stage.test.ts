import { mkdirSync, writeFileSync } from 'node:fs'
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
  TILE_SIZE,
  toXY,
  type LngLat,
  type Project,
} from '../../src/core/index.js'
import { greekIslands, sceneOf } from '../fixtures/projects.js'
import type { MapperPage } from '../../src/studio/render-mode.js'
import { closeAll, expectGolden, openRenderPage, pixelDiff, snapshot } from './helpers.js'

afterAll(closeAll)

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

/** A PNG cropped to the device-pixel rectangle. */
function crop(png: Buffer, x: number, y: number, width: number, height: number): Buffer {
  const source = PNG.sync.read(png)
  const out = new PNG({ width, height })
  PNG.bitblt(source, out, x, y, width, height, 0, 0)
  return PNG.sync.write(out)
}

/** A copy of the PNG with the device-pixel rectangle made transparent black. */
function clear(png: Buffer, x: number, y: number, width: number, height: number): Buffer {
  const image = PNG.sync.read(png)
  for (let row = y; row < y + height; row++) image.data.fill(0, (row * image.width + x) * 4, (row * image.width + x + width) * 4)
  return PNG.sync.write(image)
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

test('burned credit is drawn bottom-right', async () => {
  const region = (png: Buffer) => crop(png, 960 - 200, 540 - 20, 200, 20) // the bottom-right 400×40 layout px
  const burned = await openRenderPage({ ...greekIslands(), credit: 'burned' }, 0.5)
  const described = await openRenderPage({ ...greekIslands(), credit: 'description' }, 0.5)
  const withCredit = await snapshot(burned.page, 0)
  const without = await snapshot(described.page, 0)
  expect(pixelDiff(region(withCredit), region(without))).toBeGreaterThan(100)
  // Nothing else differs, outside a strip wide enough for the whole credit (about 420 layout px).
  const outside = (png: Buffer) => clear(png, 960 - 240, 540 - 20, 240, 20)
  expect(pixelDiff(outside(withCredit), outside(without))).toBe(0)
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

test.skipIf(process.env.MAPPER_NET !== '1')('paper theme draws water (MAPPER_NET only)', async () => {
  const project = greekIslands({
    look: { ...sceneOf(greekIslands()).look, theme: 'paper' },
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
