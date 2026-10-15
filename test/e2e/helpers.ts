import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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

/**
 * Opens render mode at the layout size and loads the project into it. With `tileUpstream`, the page gets its own
 * server whose tile proxy fetches from there.
 */
export async function openRenderPage(
  project: Project,
  pixelRatio: number,
  opts: { tileUpstream?: string; layer?: RenderLayer; seaPaths?: SeaPaths } = {},
): Promise<{ page: Page; close(): Promise<void> }> {
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
    close: async () => {
      await context.close()
      if (server !== sharedServer) await server.close()
    },
  }
}

/**
 * Writes the project (with a fresh id, since the fixtures share one) to a temp folder, registers it and opens the
 * studio's edit mode at `viewport`.
 */
export async function openStudioPage(
  project: Project,
  viewport: { width: number; height: number },
): Promise<{ page: Page; folder: string; project: Project; close(): Promise<void> }> {
  const { server, browser, tempDir } = await setup()
  const folder = await mkdtemp(path.join(tempDir, 'project-'))
  await createProject(folder, project.name)
  const saved = await saveProject(folder, { ...project, id: randomUUID() })
  const key = await server.registerProject(folder)
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
  const page = await context.newPage()
  page.on('pageerror', (error) => process.stderr.write(`page error: ${error.message}\n`))
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
