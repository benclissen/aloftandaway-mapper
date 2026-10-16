// Capture stress check: hunts a rare corrupt capture seen once while chasing an e2e flake (a dark block over a sign
// and a white hole in its text). It repeats the pattern that showed it: one browser, two pages per load, each on
// `alpine()` as satellite with terrain at 1920×1080, one with the credit burned in and one with it in the description.
// Both render frame 0 and are captured; outside the credit box the two frames should match. Satellite and terrain
// seams can differ by ±1 between pages, so a glitch is a pixel that differs by more than 8 in a channel.
//
// Usage: npm run bench:capture [-- --loads 1000 --cold-every 10 --cpu-overlay]
//        npm run bench:capture -- --diff <burned.png> <plain.png>   (runs the detector on two saved captures)
//
// Needs the network (OpenFreeMap, EOX and AWS terrain tiles). Glitches are saved under /tmp/stage7-capture-stress/.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { PNG } from 'pngjs'
import type { Browser, Page } from 'playwright'
import { layoutSize, sceneCredit, type Project } from '../src/core/index.js'
import { capturePng } from '../src/render/capture.js'
import { launchBrowser } from '../src/render/chrome.js'
import { startServer, type MapperServer } from '../src/server/server.js'
import { alpine, sceneOf } from '../test/fixtures/projects.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const STUDIO_DIR = path.join(ROOT, 'dist', 'studio')
const OUT_ROOT = '/tmp/stage7-capture-stress'
/** A pixel whose largest channel difference is above this, outside the credit box, is a glitch. */
const THRESHOLD = 8
/** By default, a new server with an empty tile cache every this many loads. `--cold-every` changes it. */
const COLD_EVERY = 10
/** Differences above this, outside the credit box, make up the bbox logged for the worst clean load. */
const NOISE_FLOOR = 4
/** Slack around the measured credit text, for its halo and anti-aliasing. Layout px. */
const CREDIT_PAD = 6
/**
 * The overlay's credit layout and font, from `CREDIT` and `CREDIT_FONT` in src/studio/stage/overlay.ts. That module
 * needs the DOM types, which the bench is checked without, so the values are repeated here.
 */
const CREDIT = { margin: 16, lineHeight: 20, haloWidth: 3, font: '500 14px "Plus Jakarta Sans"' }

interface Box { x0: number; y0: number; x1: number; y1: number }

/** `b` grown to take in pixel (x, y). */
const grow = (b: Box | undefined, x: number, y: number): Box =>
  b ? { x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x), y1: Math.max(b.y1, y) } : { x0: x, y0: y, x1: x, y1: y }

interface Detection {
  /** Pixels outside the credit box with a channel difference above THRESHOLD. */
  glitchPixels: number
  /** The largest channel difference outside the credit box, and the first pixel that has it. */
  maxOutside: number
  maxAt: [number, number] | undefined
  /** Bounding box of the pixels outside the credit box with a difference above NOISE_FLOOR. */
  noiseBox: Box | undefined
  /** Bounding box of the glitch pixels, or undefined when there are none. */
  bbox: Box | undefined
  /** Pixels that differ at all, anywhere. */
  anyDiff: number
  diff: PNG
}

/** Compares two captures. Red: glitch pixels. Grey: any smaller difference, or any difference inside the credit box. */
function detect(a: PNG, b: PNG, credit: Box): Detection {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`Capture sizes differ: ${a.width}×${a.height} and ${b.width}×${b.height}.`)
  const diff = new PNG({ width: a.width, height: a.height })
  let glitchPixels = 0
  let maxOutside = 0
  let maxAt: [number, number] | undefined
  let noiseBox: Box | undefined
  let anyDiff = 0
  let bbox: Box | undefined
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4
      const d = Math.max(
        Math.abs(a.data[i]! - b.data[i]!),
        Math.abs(a.data[i + 1]! - b.data[i + 1]!),
        Math.abs(a.data[i + 2]! - b.data[i + 2]!),
        Math.abs(a.data[i + 3]! - b.data[i + 3]!),
      )
      diff.data[i + 3] = 255
      if (d === 0) continue
      anyDiff++
      const inCredit = x >= credit.x0 && x <= credit.x1 && y >= credit.y0 && y <= credit.y1
      if (!inCredit && d > maxOutside) {
        maxOutside = d
        maxAt = [x, y]
      }
      if (!inCredit && d > NOISE_FLOOR) noiseBox = grow(noiseBox, x, y)
      if (inCredit || d <= THRESHOLD) {
        diff.data[i] = diff.data[i + 1] = diff.data[i + 2] = 96
        continue
      }
      glitchPixels++
      diff.data[i] = 255
      bbox = grow(bbox, x, y)
    }
  }
  return { glitchPixels, maxOutside, maxAt, noiseBox, bbox, anyDiff, diff }
}

/** The stress project: alpine() as satellite with terrain, at 1920×1080. */
function stressProject(credit: Project['credit']): Project {
  const project = alpine()
  const scene = sceneOf(project)
  scene.look = { ...scene.look, theme: 'satellite', terrain: true }
  project.credit = credit
  return project
}

/** The burned-in credit's box in device px (pixel ratio 1), measured with the page's own font. */
async function measureCredit(page: Page, project: Project): Promise<Box> {
  const { width, height } = layoutSize(project.output.aspect)
  const lines = sceneCredit(sceneOf(project))
  const m = await page.evaluate(
    ([font, texts]) => {
      // The bench is checked without the DOM library, so the canvas is typed by hand.
      interface Metrics { actualBoundingBoxLeft: number; actualBoundingBoxRight: number; actualBoundingBoxAscent: number; actualBoundingBoxDescent: number }
      interface Ctx { font: string; measureText(text: string): Metrics }
      const doc = (globalThis as unknown as { document: { createElement(tag: 'canvas'): { getContext(type: '2d'): Ctx } } }).document
      const ctx = doc.createElement('canvas').getContext('2d')
      ctx.font = font
      const metrics = texts.map((t) => ctx.measureText(t))
      return {
        width: Math.max(...metrics.map((x) => x.actualBoundingBoxLeft + x.actualBoundingBoxRight)),
        ascent: Math.max(...metrics.map((x) => x.actualBoundingBoxAscent)),
        descent: Math.max(...metrics.map((x) => x.actualBoundingBoxDescent)),
      }
    },
    [CREDIT.font, lines] as const,
  )
  const halo = CREDIT.haloWidth / 2
  const right = width - CREDIT.margin
  const lastBaseline = height - CREDIT.margin
  const firstBaseline = lastBaseline - (lines.length - 1) * CREDIT.lineHeight
  return {
    x0: Math.floor(right - m.width - halo - CREDIT_PAD),
    y0: Math.floor(firstBaseline - m.ascent - halo - CREDIT_PAD),
    x1: Math.min(width - 1, Math.ceil(right + halo + CREDIT_PAD)),
    y1: Math.min(height - 1, Math.ceil(lastBaseline + m.descent + halo + CREDIT_PAD)),
  }
}

interface Opened { page: Page; close: () => Promise<void> }

async function openPage(browser: Browser, server: MapperServer, project: Project, cpuOverlay: boolean): Promise<Opened> {
  const context = await browser.newContext({ viewport: layoutSize(project.output.aspect), deviceScaleFactor: 1 })
  try {
    const page = await context.newPage()
    await page.goto(`${server.base}studio/?mode=render`)
    await page.waitForFunction("'mapper' in window")
    await page.evaluate(
      async ([p, cpu]) => {
        const mapper = (globalThis as unknown as { mapper: { ready: Promise<void>; load: (p: unknown, o: object) => Promise<unknown> } }).mapper
        await mapper.ready
        await mapper.load(p, { pixelRatio: 1, ...(cpu ? { cpuOverlay: true } : {}) })
      },
      [project, cpuOverlay] as const,
    )
    return { page, close: () => context.close().catch(() => undefined) }
  } catch (e) {
    await context.close().catch(() => undefined)
    throw e
  }
}

async function shoot(o: Opened, project: Project): Promise<{ png: Buffer; settled: boolean }> {
  const { settled } = await o.page.evaluate(
    () => (globalThis as unknown as { mapper: { renderFrame: (n: number) => Promise<{ settled: boolean }> } }).mapper.renderFrame(0),
  )
  const png = await capturePng(o.page, { ...layoutSize(project.output.aspect), pixelRatio: 1 })
  return { png, settled }
}

const fmtBox = (b: Box | undefined) => (b ? `[${b.x0},${b.y0}]-[${b.x1},${b.y1}] (${b.x1 - b.x0 + 1}×${b.y1 - b.y0 + 1})` : 'none')
const fmtAt = (at: [number, number] | undefined) => (at ? `(${at[0]},${at[1]})` : 'none')
const log = (line: string) => process.stdout.write(`${line}\n`)

async function freshServer(tmp: string): Promise<{ server: MapperServer; cacheDir: string }> {
  const cacheDir = await mkdtemp(path.join(tmp, 'cache-'))
  return { server: await startServer({ studioDir: STUDIO_DIR, cacheDir }), cacheDir }
}

/** `--diff`: runs the detector on two saved captures, measuring the credit box in a real page. */
async function diffFiles(fileA: string, fileB: string): Promise<void> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'capture-stress-'))
  const { server } = await freshServer(tmp)
  const { browser } = await launchBrowser()
  try {
    const project = stressProject('burned')
    const context = await browser.newContext({ viewport: layoutSize(project.output.aspect), deviceScaleFactor: 1 })
    const page = await context.newPage()
    await page.goto(`${server.base}studio/?mode=render`)
    await page.waitForFunction("'mapper' in window")
    await page.evaluate(() => (globalThis as unknown as { mapper: { ready: Promise<void> } }).mapper.ready)
    const credit = await measureCredit(page, project)
    const r = detect(PNG.sync.read(readFileSync(fileA)), PNG.sync.read(readFileSync(fileB)), credit)
    log(`credit box ${fmtBox(credit)}`)
    log(`glitch: ${r.glitchPixels > 0 ? 'yes' : 'no'}  glitchPixels=${r.glitchPixels} maxOutside=${r.maxOutside} at ${fmtAt(r.maxAt)} bbox=${fmtBox(r.bbox)} above${NOISE_FLOOR}=${fmtBox(r.noiseBox)} anyDiff=${r.anyDiff}`)
  } finally {
    await browser.close()
    await server.close()
    rmSync(tmp, { recursive: true, force: true })
  }
}

async function stress(loads: number, cpuOverlay: boolean, coldEvery: number): Promise<void> {
  const runTag = `${cpuOverlay ? 'cpu' : 'gpu'}-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const outDir = path.join(OUT_ROOT, runTag)
  mkdirSync(outDir, { recursive: true })
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'capture-stress-'))
  const { browser, channel, webgl } = await launchBrowser()
  log(`capture stress: ${loads} loads, overlay on the ${cpuOverlay ? 'CPU (willReadFrequently)' : 'GPU (default)'}`)
  log(`browser: ${channel} ${browser.version()}, WebGL ${webgl}`)
  log(`glitch: a pixel outside the credit box differing by more than ${THRESHOLD} in a channel; fresh tile cache every ${coldEvery === 1 ? 'load' : `${coldEvery} loads`}`)
  log(`output: ${outDir}`)

  const burnedProject = stressProject('burned')
  const plainProject = stressProject('description')
  let current: { server: MapperServer; cacheDir: string } | undefined
  let credit: Box | undefined
  let glitches = 0
  let errors = 0
  let unsettled = 0
  /** The clean load (no glitch) with the largest difference outside the credit box: the worst seam noise. */
  let worst: { load: number; max: number; at: [number, number] | undefined; noiseBox: Box | undefined } | undefined
  const worstStem = path.join(outDir, 'worst-clean')
  const started = performance.now()
  try {
    for (let i = 0; i < loads; i++) {
      if (i % coldEvery === 0) {
        if (current) {
          await current.server.close()
          rmSync(current.cacheDir, { recursive: true, force: true })
        }
        current = await freshServer(tmp)
      }
      const { server } = current!
      let a: Opened | undefined
      let b: Opened | undefined
      try {
        a = await openPage(browser, server, burnedProject, cpuOverlay)
        b = await openPage(browser, server, plainProject, cpuOverlay)
        credit ??= await measureCredit(a.page, burnedProject)
        if (i === 0) log(`credit box ${fmtBox(credit)}`)
        const sa = await shoot(a, burnedProject)
        const sb = await shoot(b, plainProject)
        if (!sa.settled || !sb.settled) unsettled++
        const r = detect(PNG.sync.read(sa.png), PNG.sync.read(sb.png), credit)
        if (r.glitchPixels === 0 && r.maxOutside > (worst?.max ?? 0)) {
          // Kept so someone can check that it is seam noise. A later, larger one replaces it.
          worst = { load: i, max: r.maxOutside, at: r.maxAt, noiseBox: r.noiseBox }
          writeFileSync(`${worstStem}-burned.png`, sa.png)
          writeFileSync(`${worstStem}-plain.png`, sb.png)
        }
        if (r.glitchPixels > 0) {
          glitches++
          const stem = path.join(outDir, `load${i}`)
          writeFileSync(`${stem}-burned.png`, sa.png)
          writeFileSync(`${stem}-plain.png`, sb.png)
          writeFileSync(`${stem}-diff.png`, PNG.sync.write(r.diff))
          log(
            `GLITCH load ${i}: glitchPixels=${r.glitchPixels} maxDiff=${r.maxOutside} bbox=${fmtBox(r.bbox)} ` +
              `settled=${sa.settled}/${sb.settled} saved ${stem}-{burned,plain,diff}.png`,
          )
        }
      } catch (e) {
        errors++
        log(`ERROR load ${i}: ${e instanceof Error ? e.message.split('\n', 1)[0] : String(e)}`)
      } finally {
        await a?.close()
        await b?.close()
      }
      if ((i + 1) % 50 === 0 || i + 1 === loads) {
        const s = (performance.now() - started) / 1000
        log(`  ${i + 1}/${loads} loads, ${glitches} glitches, ${errors} errors, ${unsettled} unsettled, ${s.toFixed(0)} s (${(s / (i + 1)).toFixed(2)} s/load)`)
      }
    }
  } finally {
    await browser.close()
    await current?.server.close()
    rmSync(tmp, { recursive: true, force: true })
  }
  const total = (performance.now() - started) / 1000
  log(`errors: ${errors}, unsettled frames: ${unsettled}`)
  log(
    worst
      ? `worst clean load: ${worst.load}, largest difference outside the credit box ${worst.max} at ${fmtAt(worst.at)}, ` +
          `pixels above ${NOISE_FLOOR} in ${fmtBox(worst.noiseBox)}, saved ${worstStem}-{burned,plain}.png`
      : 'worst clean load: none, no clean load differed outside the credit box',
  )
  log(`time: ${(total / 60).toFixed(1)} min, ${(total / loads).toFixed(2)} s/load`)
  log(`glitches: ${glitches} of ${loads - errors} loads`)
}

const { values, positionals } = parseArgs({
  options: {
    loads: { type: 'string', default: '100' },
    'cpu-overlay': { type: 'boolean', default: false },
    'cold-every': { type: 'string', default: String(COLD_EVERY) },
    diff: { type: 'boolean', default: false },
  },
  allowPositionals: true,
})

if (values.diff) {
  if (positionals.length !== 2) throw new Error('--diff takes two PNG paths.')
  await diffFiles(positionals[0]!, positionals[1]!)
} else {
  const loads = Number(values.loads)
  if (!Number.isInteger(loads) || loads < 1) throw new Error(`--loads must be a positive integer, got ${values.loads}.`)
  const coldEvery = Number(values['cold-every'])
  if (!Number.isInteger(coldEvery) || coldEvery < 1) throw new Error(`--cold-every must be a positive integer, got ${values['cold-every']}.`)
  await stress(loads, values['cpu-overlay'], coldEvery)
}
process.exit(0)
