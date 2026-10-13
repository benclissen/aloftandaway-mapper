import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Browser } from 'playwright'
import { z } from 'zod'
import {
  buildRoute,
  buildTimeline,
  formatTimecode,
  fpsValue,
  layoutSize,
  type Aspect,
  type Project,
  type Timeline,
} from '../core/index.js'
import { loadProject } from '../server/store.js'
import { launchBrowser } from './chrome.js'
import { RenderPage } from './page.js'

const DEFAULT_PREVIEW_WIDTH = 960
const DEFAULT_SHEET_WIDTH = 1920
const DEFAULT_SHEET_COUNT = 9
/** Space between cells and around the grid, in px. */
const SHEET_GAP = 8
const CAPTION_HEIGHT = 22
const SHEET_BACKGROUND = '#1b1d21'
const PREVIEW_DIR = path.join('.mapper', 'previews')

/** Where to look in the clip. Exactly one key. Out-of-range values are clamped to the clip. */
export const PreviewAtSchema = z.union([
  z.strictObject({ seconds: z.number() }),
  z.strictObject({ frame: z.number().int() }),
  z.strictObject({ progress: z.number() }),
])
export type PreviewAt = z.infer<typeof PreviewAtSchema>

export interface PreviewResult {
  png: Buffer
  /** Where the PNG was saved. */
  path: string
  frame: number
  seconds: number
}

export interface ContactSheetResult {
  png: Buffer
  path: string
  frames: { frame: number; seconds: number }[]
}

// A warm browser, and one render page per aspect, shared by every call.

let browserLaunches = 0
let pageOpens = 0
let browserPromise: Promise<Browser> | undefined
const pages = new Map<Aspect, Promise<RenderPage>>()
/** Calls run one at a time, since they share pages. */
let queue: Promise<unknown> = Promise.resolve()

/** Counters for tests: how often the warm browser was launched and render pages were opened. */
export function previewStats(): { browserLaunches: number; pageOpens: number } {
  return { browserLaunches, pageOpens }
}

function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn)
  queue = run.catch(() => undefined)
  return run
}

function warmBrowser(): Promise<Browser> {
  if (!browserPromise) {
    const launching = launchBrowser().then(({ browser }) => {
      browserLaunches++
      browser.on('disconnected', () => {
        if (browserPromise === launching) forget()
      })
      return browser
    })
    browserPromise = launching
    launching.catch(() => {
      if (browserPromise === launching) browserPromise = undefined
    })
  }
  return browserPromise
}

/** Drops the browser and its pages without closing them. */
function forget(): void {
  browserPromise = undefined
  pages.clear()
}

interface CachedPage {
  page: RenderPage
  entry: Promise<RenderPage>
}

/** Drops `entry` from the cache, if it is still the cached page for the aspect, and closes the page. */
function evict(aspect: Aspect, entry: Promise<RenderPage>, page: RenderPage): void {
  if (pages.get(aspect) === entry) pages.delete(aspect)
  void page.close().catch(() => undefined)
}

async function pageFor(aspect: Aspect): Promise<CachedPage> {
  let opening = pages.get(aspect)
  if (!opening) {
    const created = warmBrowser().then(async (browser) => {
      const page = await RenderPage.open({ browser, aspect })
      pageOpens++
      // A crashed or context-less page can't be reused. The next call opens a fresh one.
      page.onCrash(() => evict(aspect, created, page))
      return page
    })
    opening = created
    pages.set(aspect, created)
    created.catch(() => {
      if (pages.get(aspect) === created) pages.delete(aspect)
    })
  }
  return { page: await opening, entry: opening }
}

/** Closes the warm pages and browser and resets the stats. The next call launches again. */
export function closePreviews(): Promise<void> {
  return exclusive(async () => {
    const opened = [...pages.values()]
    const browser = browserPromise
    forget()
    for (const opening of opened) await opening.then((page) => page.close(), () => undefined)
    await browser?.then((b) => b.close(), () => undefined)
    browserLaunches = 0
    pageOpens = 0
  })
}

// Frames

interface Loaded {
  project: Project
  timeline: Timeline
  page: RenderPage
}

/**
 * Reads the project from disk, loads it into the warm page for its aspect so that a frame comes out `frameWidth`
 * px wide, and runs `use` on it. If loading or `use` rejects, the page is evicted and closed, and the error is
 * rethrown: MapLibre never refetches a tile that errored, so a page that saw a map error would keep painting the
 * gap. The next call opens a fresh page.
 */
async function withProject<T>(folder: string, frameWidth: (aspect: Aspect) => number, use: (loaded: Loaded) => Promise<T>): Promise<T> {
  const project = await loadProject(folder)
  const timeline = buildTimeline(project, buildRoute(project))
  if (timeline.totalFrames < 1) throw new Error('The project has no frames to preview.')
  const { aspect } = project.output
  const { page, entry } = await pageFor(aspect)
  try {
    await page.load(project, frameWidth(aspect) / layoutSize(aspect).width)
    return await use({ project, timeline, page })
  } catch (e) {
    evict(aspect, entry, page)
    throw e
  }
}

function assertWholeNumber(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive whole number, got ${value}.`)
}

const clamp = (value: number, lo: number, hi: number) => Math.min(Math.max(value, lo), hi)

function resolveFrame(at: PreviewAt, timeline: Timeline): number {
  const last = timeline.totalFrames - 1
  let frame: number
  if ('frame' in at) frame = at.frame
  else if ('seconds' in at) frame = Math.round(at.seconds * fpsValue(timeline.fps))
  else frame = Math.round(at.progress * last)
  return clamp(frame, 0, last)
}

async function previewsDir(folder: string): Promise<string> {
  const dir = path.join(folder, PREVIEW_DIR)
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * Renders one frame `width` px wide (default 960) and saves it to `<folder>/.mapper/previews/frame-<n>.png`. A
 * map error rejects the call. It isn't retried, since MapLibre never refetches a tile that errored.
 */
export async function previewFrame(args: { folder: string; at: PreviewAt; width?: number }): Promise<PreviewResult> {
  const width = args.width ?? DEFAULT_PREVIEW_WIDTH
  const at = PreviewAtSchema.parse(args.at)
  assertWholeNumber('width', width)
  return exclusive(async () => {
    const { frame, png, fps } = await withProject(args.folder, () => width, async ({ timeline, page }) => {
      const frame = resolveFrame(at, timeline)
      await page.renderFrame(frame)
      return { frame, png: await page.capturePng(), fps: fpsValue(timeline.fps) }
    })
    const file = path.join(await previewsDir(args.folder), `frame-${frame}.png`)
    await writeFile(file, png)
    return { png, path: file, frame, seconds: frame / fps }
  })
}

// Contact sheets

/** `MM:SS:FF · f<frame>`, followed by ` · <stop name>` when the frame is a stop's arrival frame. */
export function frameCaption(project: Project, timeline: Timeline, frame: number): string {
  const caption = `${formatTimecode(frame, timeline.fps)} · f${frame}`
  const arrival = timeline.arrivals.find((a) => a.frame === frame)
  const stop = arrival && project.stops.find((s) => s.id === arrival.stopId)
  return stop ? `${caption} · ${stop.name}` : caption
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function sheetHtml(args: { width: number; columns: number; cellWidth: number; cells: { dataUrl: string; caption: string }[] }): string {
  const { width, columns, cellWidth, cells } = args
  const cellsHtml = cells
    .map(
      ({ dataUrl, caption }) =>
        `<figure><img src="${dataUrl}" width="${cellWidth}"><figcaption>${escapeHtml(caption)}</figcaption></figure>`,
    )
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:${SHEET_BACKGROUND}}
body{width:${width}px;box-sizing:border-box;padding:${SHEET_GAP}px;display:grid;
  grid-template-columns:repeat(${columns},${cellWidth}px);gap:${SHEET_GAP}px;
  font:13px/${CAPTION_HEIGHT}px -apple-system,system-ui,sans-serif;color:#d8dade}
figure{margin:0;min-width:0}
img{display:block;height:auto}
figcaption{height:${CAPTION_HEIGHT}px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style></head><body>${cellsHtml}</body></html>`
}

function timestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/**
 * Renders `count` evenly spaced frames (default 9) into a captioned grid `width` px wide (default 1920), and saves
 * it to `<folder>/.mapper/previews/contact-<YYYYMMDD-HHmmss>.png`.
 */
export async function contactSheet(args: { folder: string; count?: number; width?: number }): Promise<ContactSheetResult> {
  const count = args.count ?? DEFAULT_SHEET_COUNT
  const width = args.width ?? DEFAULT_SHEET_WIDTH
  assertWholeNumber('count', count)
  assertWholeNumber('width', width)
  const columns = Math.ceil(Math.sqrt(count))
  const cellWidth = Math.floor((width - SHEET_GAP * (columns + 1)) / columns)
  if (cellWidth < 1) throw new RangeError(`width ${width} is too small for ${count} frames in ${columns} columns.`)
  return exclusive(async () => {
    const { frames, cells, fps } = await withProject(args.folder, () => cellWidth, async ({ project, timeline, page }) => {
      const last = timeline.totalFrames - 1
      const frames = Array.from({ length: count }, (_, i) => (count === 1 ? 0 : Math.round((i * last) / (count - 1))))
      const cells: { dataUrl: string; caption: string }[] = []
      for (const frame of frames) {
        await page.renderFrame(frame)
        const png = await page.capturePng()
        cells.push({ dataUrl: `data:image/png;base64,${png.toString('base64')}`, caption: frameCaption(project, timeline, frame) })
      }
      return { frames, cells, fps: fpsValue(timeline.fps) }
    })

    const browser = await warmBrowser()
    const sheetPage = await browser.newPage({ viewport: { width, height: 600 }, deviceScaleFactor: 1 })
    let png: Buffer
    try {
      await sheetPage.setContent(sheetHtml({ width, columns, cellWidth, cells }), { waitUntil: 'load' })
      // A string, because this module is type-checked without the DOM library.
      await sheetPage.evaluate('Promise.all(Array.from(document.images, (image) => image.decode()))')
      png = await sheetPage.screenshot({ type: 'png', fullPage: true })
    } finally {
      await sheetPage.close()
    }
    const file = path.join(await previewsDir(args.folder), `contact-${timestamp(new Date())}.png`)
    await writeFile(file, png)
    return { png, path: file, frames: frames.map((frame) => ({ frame, seconds: frame / fps })) }
  })
}
