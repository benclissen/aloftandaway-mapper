/**
 * Dev only. Renders four sheets for reviewing the look by eye, and writes them to the folder given on the command
 * line (keep it outside the repo):
 *
 *   npx tsx scripts/review-sheets.ts /tmp/stage5-review
 *
 * - icons.png: every transport in the three symbol styles, heading east and west, on the aloftandaway sea.
 * - styles.png: the same frame in each of the eleven styles.
 * - tilt.png: a tilted terrain frame.
 * - follow.png: a follow contact sheet (heading-up camera) across a route with three legs.
 *
 * Map tiles come from the network the first time and are cached after that.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Browser } from 'playwright'
import { SYMBOLS, THEMES, type Project, type SymbolKind, type SymbolStyle, SYMBOL_STYLES } from '../src/core/index.js'
import { launchBrowser } from '../src/render/chrome.js'
import { RenderPage } from '../src/render/page.js'
import { closePreviews, contactSheet, previewFrame } from '../src/render/preview.js'
import { closeServerIfStarted } from '../src/server/server.js'
import { createProject, saveProject } from '../src/server/store.js'
import { alpineTilted, cruise, greekIslands, sceneOf, stopsAt } from '../test/fixtures/projects.js'

const out = process.argv[2]
if (!out || !path.isAbsolute(out)) {
  console.error('Usage: npx tsx scripts/review-sheets.ts <absolute output folder>')
  process.exit(1)
}

/** Pixels of the map cut out around a vehicle in the icon sheet, and the sheet's cell size. */
const CELL = 128
const CROP = 96

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const dataUrl = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`

/** Lays HTML out in a page and screenshots it. */
async function screenshotHtml(browser: Browser, html: string, width: number): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width, height: 600 }, deviceScaleFactor: 1 })
  try {
    await page.setContent(html, { waitUntil: 'load' })
    await page.evaluate('Promise.all(Array.from(document.images, (image) => image.decode()))')
    return await page.screenshot({ type: 'png', fullPage: true })
  } finally {
    await page.close()
  }
}

const SHEET_CSS = `html,body{margin:0;background:#1b1d21}
body{padding:12px;font:14px/1.3 -apple-system,system-ui,sans-serif;color:#d8dade;box-sizing:border-box;width:fit-content}
figure{margin:0}figcaption{padding:4px 0}
img{display:block}`

/** Two stops in the open Ionian Sea, `eastward` or westward, drawn with one symbol. */
function iconProject(symbol: SymbolKind, symbolStyle: SymbolStyle, eastward: boolean): Project {
  const west: [number, number] = [17.5, 36]
  const east: [number, number] = [18.5, 36]
  const project = stopsAt(eastward ? [west, east] : [east, west])
  const scene = sceneOf(project)
  scene.look = { ...scene.look, theme: 'aloftandaway', symbol, symbolStyle, line: { ...scene.look.line, color: '#dc8376' } }
  scene.stops.forEach((s) => (s.sign = 'none'))
  scene.timing = { holdStart: 1, travel: 4, holdEnd: 1 }
  scene.camera = { mode: 'fixed', easing: 'linear', start: { center: [18, 36], zoom: 8, bearing: 0, pitch: 0 } }
  return project
}

async function iconsSheet(browser: Browser): Promise<Buffer> {
  const symbols = SYMBOLS.filter((s) => s !== 'none')
  const page = await RenderPage.open({ browser, aspect: '16:9' })
  const cells = new Map<string, string>()
  try {
    for (const symbol of symbols) {
      for (const style of SYMBOL_STYLES) {
        for (const eastward of [true, false]) {
          const project = iconProject(symbol, style, eastward)
          const frames = await page.load(project, 1)
          const mid = Math.round((frames - 1) / 2)
          await page.renderFrame(mid)
          // The camera is fixed on the midpoint, which is where the head is halfway along.
          cells.set(`${symbol}|${style}|${eastward}`, dataUrl(await page.capturePng()))
        }
      }
    }
  } finally {
    await page.close()
  }

  // Each cell is the centre of the frame: the full 1920 by 1080 PNG is cropped to CROP px by CSS and shown at CELL px.
  const crop = (url: string) =>
    `<div style="width:${CELL}px;height:${CELL}px;overflow:hidden;position:relative;border-radius:6px"><img src="${url}" ` +
    `style="position:absolute;width:${(1920 * CELL) / CROP}px;left:${-(960 - CROP / 2) * (CELL / CROP)}px;top:${-(540 - CROP / 2) * (CELL / CROP)}px"></div>`
  const header = (label: string, span: number) => `<th colspan="${span}" style="padding:6px 0">${escapeHtml(label)}</th>`
  const table = (names: readonly SymbolKind[]) => `<table style="border-spacing:6px"><tr><th></th>${SYMBOL_STYLES.map((s) => header(s, 2)).join('')}</tr>
<tr><th></th>${SYMBOL_STYLES.map(() => '<th>east</th><th>west</th>').join('')}</tr>
${names
  .map(
    (symbol) =>
      `<tr><th style="text-align:right;padding-right:8px;white-space:nowrap">${escapeHtml(symbol)}</th>${SYMBOL_STYLES.map((style) =>
        [true, false].map((eastward) => `<td>${crop(cells.get(`${symbol}|${style}|${eastward}`)!)}</td>`).join(''),
      ).join('')}</tr>`,
  )
  .join('\n')}</table>`
  const half = Math.ceil(symbols.length / 2)
  const html = `<!doctype html><meta charset="utf-8"><style>${SHEET_CSS}</style>
<div style="display:flex;gap:24px;align-items:flex-start">${table(symbols.slice(0, half))}${table(symbols.slice(half))}</div>`
  return screenshotHtml(browser, html, 2000)
}

async function stylesSheet(browser: Browser): Promise<Buffer> {
  const page = await RenderPage.open({ browser, aspect: '16:9' })
  const tiles: { theme: string; url: string }[] = []
  try {
    for (const theme of THEMES) {
      const project = greekIslands()
      const scene = sceneOf(project)
      scene.look = { ...scene.look, theme, symbol: 'cruise-ship', line: { ...scene.look.line, color: '#dc8376' } }
      scene.camera = { mode: 'fixed', easing: 'smooth' }
      await page.load(project, 0.5)
      await page.renderFrame(175)
      tiles.push({ theme, url: dataUrl(await page.capturePng()) })
    }
  } finally {
    await page.close()
  }
  const html = `<!doctype html><meta charset="utf-8"><style>${SHEET_CSS}
.grid{display:grid;grid-template-columns:repeat(3,960px);gap:12px}figcaption{font-size:18px;font-weight:600}</style>
<div class="grid">${tiles.map((t) => `<figure><figcaption>${escapeHtml(t.theme)}</figcaption><img src="${t.url}" width="960"></figure>`).join('')}</div>`
  return screenshotHtml(browser, html, 3000)
}

/** Writes `project` to a folder under `root` so the preview tools can read it. */
async function saved(root: string, name: string, project: Project): Promise<string> {
  const folder = path.join(root, name)
  await createProject(folder, name)
  await saveProject(folder, project)
  return folder
}

async function main(): Promise<void> {
  await mkdir(out!, { recursive: true })
  const work = await mkdtemp(path.join(os.tmpdir(), 'mapper-review-'))
  const { browser } = await launchBrowser()
  try {
    await writeFile(path.join(out!, 'icons.png'), await iconsSheet(browser))
    console.log('icons.png')
    await writeFile(path.join(out!, 'styles.png'), await stylesSheet(browser))
    console.log('styles.png')

    const tilt = await previewFrame({ folder: await saved(work, 'tilt', alpineTilted()), at: { frame: 40 }, width: 1920 })
    await writeFile(path.join(out!, 'tilt.png'), tilt.png)
    console.log('tilt.png')

    // A cruise with three legs, the camera following the ship heading-up on the default look-ahead and smoothing.
    const follow = cruise()
    const scene = sceneOf(follow)
    scene.look = { ...scene.look, theme: 'aloftandaway', symbol: 'cruise-ship', line: { ...scene.look.line, color: '#dc8376' } }
    scene.camera = { mode: 'follow', easing: 'smooth', follow: { zoom: 8, orient: 'heading' } }
    const sheet = await contactSheet({ folder: await saved(work, 'follow', follow), count: 9, width: 1920 })
    await writeFile(path.join(out!, 'follow.png'), sheet.png)
    console.log('follow.png')
  } finally {
    await browser.close()
    await closePreviews()
    await closeServerIfStarted()
    await rm(work, { recursive: true, force: true })
  }
}

await main()
