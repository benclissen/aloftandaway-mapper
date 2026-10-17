import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import pixelmatch from 'pixelmatch'
import type { Browser, Page } from 'playwright'
import { PNG } from 'pngjs'
import { expect } from 'vitest'
import { layoutSize, type Project, type RenderLayer, type SeaPaths } from '../../src/core/index.js'
import { capturePng } from '../../src/render/capture.js'
import { launchBrowser } from '../../src/render/chrome.js'
import { startServer, type MapperServer } from '../../src/server/server.js'
import { createProject, saveProject } from '../../src/server/store.js'
import type { MapperPage } from '../../src/studio/render-mode.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const GOLDEN_DIR = path.join(ROOT, 'test', 'e2e', 'golden')
const OUTPUT_DIR = path.join(ROOT, 'test-output', 'e2e')
/** A golden fails when more than this share of its pixels differ. */
const GOLDEN_TOLERANCE = 0.005

interface Shared {
  server: MapperServer
  browser: Browser
  tempDir: string
}

let shared: Promise<Shared> | undefined
const frames = new WeakMap<Page, { width: number; height: number; pixelRatio: number; transparent: boolean }>()

function setup(): Promise<Shared> {
  shared ??= (async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'mapper-e2e-'))
    const server = await startServer({ studioDir: path.join(ROOT, 'dist', 'studio'), cacheDir: path.join(tempDir, 'cache') })
    const { browser } = await launchBrowser()
    return { server, browser, tempDir }
  })()
  return shared
}

let flatTile: Buffer | undefined

/** A 256 px Terrarium elevation tile at sea level everywhere (red 128, green 0, blue 0). */
export function flatTerrainTile(): Buffer {
  if (!flatTile) {
    const tile = new PNG({ width: 256, height: 256 })
    for (let i = 0; i < tile.data.length; i += 4) tile.data.set([128, 0, 0, 255], i)
    flatTile = PNG.sync.write(tile)
  }
  return flatTile
}

let greenTile: Buffer | undefined

/** A 256 px tile of one colour, #5a6b4f: stands in for satellite imagery. */
function solidTile(): Buffer {
  if (!greenTile) {
    const tile = new PNG({ width: 256, height: 256 })
    for (let i = 0; i < tile.data.length; i += 4) tile.data.set([0x5a, 0x6b, 0x4f, 255], i)
    greenTile = PNG.sync.write(tile)
  }
  return greenTile
}

/**
 * Opens render mode at the layout size and loads the project into it. With `tileUpstream`, the page gets its own
 * server whose tile proxy fetches from there. With `stubTiles`, satellite, terrain and vector tiles are answered
 * in the browser (solid green, sea level, empty), so the page needs no network: any other request beyond the studio's
 * files and the glyphs is aborted and listed in `leaks`.
 */
export async function openRenderPage(
  project: Project,
  pixelRatio: number,
  opts: { tileUpstream?: string; layer?: RenderLayer; seaPaths?: SeaPaths; flatTerrain?: boolean; stubTiles?: boolean } = {},
): Promise<{ page: Page; leaks: string[]; close(): Promise<void> }> {
  const { server: sharedServer, browser, tempDir } = await setup()
  const server = opts.tileUpstream
    ? await startServer({
        studioDir: path.join(ROOT, 'dist', 'studio'),
        cacheDir: await mkdtemp(path.join(tempDir, 'cache-')),
        tileUpstream: opts.tileUpstream,
      })
    : sharedServer
  const size = layoutSize(project.output.aspect)
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1 })
  // Terrain on the blank theme is the one offline scene that has a credit. Its elevation tiles come from the network
  // (or the server's proxy), so a test that only needs the credit can answer them with sea level instead.
  if (opts.flatTerrain) await context.route('**/tiles/terrain/**', (route) => route.fulfill({ contentType: 'image/png', body: flatTerrainTile() }))
  // Every tile answered in the browser, so two pages draw the same map and a test can tell the overlay's pixels from
  // the map's (live tiles can differ by a colour level at a seam between two loads), and the page needs no network.
  // Playwright tries the route registered last first, so the catch-all goes in first: it passes the studio's own files
  // and the local glyphs, and aborts and records anything else, so a test can assert that nothing leaked past the stubs.
  const leaks: string[] = []
  if (opts.stubTiles) {
    const local = new URL(server.base)
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url())
      if (url.origin === local.origin && (url.pathname.startsWith(`${local.pathname}studio/`) || url.pathname.startsWith(`${local.pathname}tiles/fonts/`))) return route.continue()
      leaks.push(url.href)
      return route.abort()
    })
    await context.route('**/tiles/satellite/**', (route) => route.fulfill({ contentType: 'image/png', body: solidTile() }))
    await context.route('**/tiles/terrain/**', (route) => route.fulfill({ contentType: 'image/png', body: flatTerrainTile() }))
    // The vector source loads a TileJSON from `.../tiles/planet`, which names the tile URLs; the tiles themselves are empty.
    await context.route('**/tiles/planet', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          tilejson: '3.0.0',
          tiles: [route.request().url().replace(/planet$/, 'planet/stub/{z}/{x}/{y}.pbf')],
          minzoom: 0,
          maxzoom: 14,
          bounds: [-180, -85.0511, 180, 85.0511],
        }),
      }),
    )
    await context.route('**/tiles/planet/**', (route) => route.fulfill({ status: 204 }))
  }
  const page = await context.newPage()
  page.on('pageerror', (error) => process.stderr.write(`page error: ${error.message}\n`))
  await page.goto(`${server.base}studio/?mode=render`)
  await page.waitForFunction(() => 'mapper' in window)
  await page.evaluate(
    async ([p, ratio, layer, seaPaths]) => {
      const mapper = (window as unknown as { mapper: MapperPage }).mapper
      await mapper.ready
      await mapper.load(p, { pixelRatio: ratio, layer, seaPaths })
    },
    [project, pixelRatio, opts.layer, opts.seaPaths] as const,
  )
  frames.set(page, { ...size, pixelRatio, transparent: opts.layer === 'route' || opts.layer === 'signs' })
  return {
    page,
    leaks,
    close: async () => {
      await context.close()
      if (server !== sharedServer) await server.close()
    },
  }
}

/**
 * Writes the project (with a fresh id, since the fixtures share one) to a temp folder, registers it and opens the
 * studio's edit mode at `viewport`. `beforeOpen` runs on the page and the saved folder before the page goes to the
 * studio, to route its requests or seed the folder.
 */
export async function openStudioPage(
  project: Project,
  viewport: { width: number; height: number },
  beforeOpen?: (page: Page, folder: string) => Promise<void>,
): Promise<{ page: Page; folder: string; project: Project; close(): Promise<void> }> {
  const { server, browser, tempDir } = await setup()
  const folder = await mkdtemp(path.join(tempDir, 'project-'))
  await createProject(folder, project.name)
  const saved = await saveProject(folder, { ...project, id: randomUUID() })
  const key = await server.registerProject(folder)
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
  const page = await context.newPage()
  page.on('pageerror', (error) => process.stderr.write(`page error: ${error.message}\n`))
  await beforeOpen?.(page, folder)
  await page.goto(server.studioUrl(key))
  return { page, folder, project: saved, close: () => context.close() }
}

/** Renders `frame` and captures it as a PNG at the page's pixel ratio. */
export async function snapshot(page: Page, frame: number): Promise<Buffer> {
  const size = frames.get(page)
  if (!size) throw new Error('snapshot needs a page from openRenderPage')
  await page.evaluate((n) => (window as unknown as { mapper: MapperPage }).mapper.renderFrame(n), frame)
  return capturePng(page, size)
}

/** Number of differing pixels between two PNGs of the same size (pixelmatch threshold 0.1). */
export function pixelDiff(a: Buffer, b: Buffer, diffOut?: PNG): number {
  const left = PNG.sync.read(a)
  const right = PNG.sync.read(b)
  if (left.width !== right.width || left.height !== right.height) {
    throw new Error(`PNG sizes differ: ${left.width}×${left.height} and ${right.width}×${right.height}`)
  }
  return pixelmatch(left.data, right.data, diffOut?.data, left.width, left.height, { threshold: 0.1 })
}

/** Compares `png` with `test/e2e/golden/<name>.png`, or writes the golden when UPDATE_GOLDENS=1. */
export function expectGolden(name: string, png: Buffer): void {
  const file = path.join(GOLDEN_DIR, `${name}.png`)
  if (process.env.UPDATE_GOLDENS === '1') {
    mkdirSync(GOLDEN_DIR, { recursive: true })
    writeFileSync(file, png)
    return
  }
  if (!existsSync(file)) throw new Error(`No golden at ${file}. Run with UPDATE_GOLDENS=1 to create it.`)
  const golden = readFileSync(file)
  const { width, height } = PNG.sync.read(golden)
  const diff = new PNG({ width, height })
  const differing = pixelDiff(golden, png, diff)
  if (differing > width * height * GOLDEN_TOLERANCE) {
    mkdirSync(OUTPUT_DIR, { recursive: true })
    writeFileSync(path.join(OUTPUT_DIR, `${name}.actual.png`), png)
    writeFileSync(path.join(OUTPUT_DIR, `${name}.diff.png`), PNG.sync.write(diff))
  }
  expect(differing, `${name}: ${differing} of ${width * height} pixels differ (see test-output/e2e)`).toBeLessThanOrEqual(
    width * height * GOLDEN_TOLERANCE,
  )
}

/** Closes the browser and server and removes the temp folders. */
export async function closeAll(): Promise<void> {
  if (!shared) return
  const { server, browser, tempDir } = await shared
  shared = undefined
  await browser.close()
  await server.close()
  await rm(tempDir, { recursive: true, force: true })
}

/**
 * The decode timestamp, in seconds, of each video frame's packet, in decode order. Read from the packets because
 * ffprobe reports no `pkt_dts_time` for the frames it flushes at the end of the stream.
 */
export async function frameTimestamps(file: string): Promise<number[]> {
  const { stdout } = await promisify(execFile)(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v', '-show_packets', '-show_entries', 'packet=dts_time', '-of', 'csv=p=0', file],
    { maxBuffer: 16 * 1024 * 1024 },
  )
  return stdout.split('\n').filter((line) => line.trim() !== '').map(Number)
}
