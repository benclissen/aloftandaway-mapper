import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PNG } from 'pngjs'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { buildRoute, buildTimeline, type Project } from '../../src/core/index.js'
import { launchBrowser } from '../../src/render/chrome.js'
import { RenderPage } from '../../src/render/page.js'
import {
  closePreviews,
  contactSheet,
  frameCaption,
  previewFrame,
  PreviewAtSchema,
  previewStats,
} from '../../src/render/preview.js'
import { getServer } from '../../src/server/server.js'
import { createProject, loadProject, saveProject } from '../../src/server/store.js'
import { greekIslands, projectWithScenes, sceneOf } from '../fixtures/projects.js'
import { pixelDiff } from './helpers.js'

let tempDir: string
const previousCacheDir = process.env.MAPPER_CACHE_DIR

/** Writes `project` (with a fresh id, since the fixtures share one) to a new folder and returns the folder. */
async function writeFolder(project: Project): Promise<string> {
  const folder = await mkdtemp(path.join(tempDir, 'project-'))
  await createProject(folder, project.name)
  await saveProject(folder, { ...project, id: randomUUID() })
  return folder
}

function size(png: Buffer): { width: number; height: number } {
  const { width, height } = PNG.sync.read(png)
  return { width, height }
}

function timelineOf(project: Project) {
  return buildTimeline(sceneOf(project), project.output.fps, buildRoute(sceneOf(project)))
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'mapper-preview-'))
  process.env.MAPPER_CACHE_DIR = path.join(tempDir, 'cache')
})

afterAll(async () => {
  await closePreviews()
  await (await getServer()).close()
  if (previousCacheDir === undefined) delete process.env.MAPPER_CACHE_DIR
  else process.env.MAPPER_CACHE_DIR = previousCacheDir
  await rm(tempDir, { recursive: true, force: true })
})

describe('previewFrame', () => {
  test('preview at progress 0.5 is 960×540 PNG', async () => {
    const project = greekIslands()
    const folder = await writeFolder(project)
    const total = timelineOf(project).totalFrames
    const result = await previewFrame({ folder, at: { progress: 0.5 } })
    expect(size(result.png)).toEqual({ width: 960, height: 540 })
    expect(result.frame).toBe(Math.round(0.5 * (total - 1)))
    expect(result.seconds).toBeCloseTo(result.frame / 25, 6)
    expect(result.path).toBe(path.join(folder, '.mapper', 'previews', `frame-${result.frame}.png`))
    expect(readFileSync(result.path).equals(result.png)).toBe(true)
  })

  test('a scene preview shows that scene and names its file after its position', async () => {
    const project = projectWithScenes(2, ['Drive', 'Sail'])
    // Scene 2 is shorter, so its clip ends sooner than scene 1's.
    project.scenes[1]!.stops = project.scenes[1]!.stops.slice(0, 2)
    project.scenes[1]!.legs = project.scenes[1]!.legs.slice(0, 1)
    const folder = await writeFolder(project)
    const second = project.scenes[1]!
    const total = buildTimeline(second, project.output.fps, buildRoute(second)).totalFrames
    expect(total).toBeLessThan(timelineOf(project).totalFrames)

    const result = await previewFrame({ folder, at: { progress: 1 }, scene: 2 })
    expect(result.frame).toBe(total - 1)
    expect(result.path).toBe(path.join(folder, '.mapper', 'previews', `scene2-frame-${total - 1}.png`))
    const byId = await previewFrame({ folder, at: { progress: 1 }, scene: second.id })
    expect(byId.png.equals(result.png)).toBe(true)

    const first = await previewFrame({ folder, at: { progress: 1 } })
    expect(first.path).toBe(path.join(folder, '.mapper', 'previews', `scene1-frame-${first.frame}.png`))
    await expect(previewFrame({ folder, at: { frame: 0 }, scene: 3 })).rejects.toThrow(/no scene 3/)
    const sheet = await contactSheet({ folder, count: 2, width: 640, scene: 2 })
    expect(path.basename(sheet.path)).toMatch(/^scene2-contact-\d{8}-\d{6}\.png$/)
  })

  test('seconds and frame agree', async () => {
    const folder = await writeFolder(greekIslands())
    const bySeconds = await previewFrame({ folder, at: { seconds: 4 } })
    const byFrame = await previewFrame({ folder, at: { frame: 100 } })
    expect(bySeconds.frame).toBe(100)
    expect(byFrame.frame).toBe(100)
    expect(bySeconds.png.equals(byFrame.png)).toBe(true)
  })

  test('positions past either end are clamped', async () => {
    const project = greekIslands()
    const folder = await writeFolder(project)
    const total = timelineOf(project).totalFrames
    expect((await previewFrame({ folder, at: { frame: 99999 } })).frame).toBe(total - 1)
    expect((await previewFrame({ folder, at: { seconds: -3 } })).frame).toBe(0)
    expect((await previewFrame({ folder, at: { progress: 7 } })).frame).toBe(total - 1)
  })

  test('width sets the PNG size and keeps the aspect, including 9:16', async () => {
    const folder = await writeFolder({ ...greekIslands(), output: { aspect: '9:16', height: 1080, fps: { num: 25, den: 1 } } })
    const { png } = await previewFrame({ folder, at: { frame: 0 }, width: 540 })
    expect(size(png)).toEqual({ width: 540, height: 960 })
  })

  test('rejects a width that is not a positive integer', async () => {
    const folder = await writeFolder(greekIslands())
    await expect(previewFrame({ folder, at: { frame: 0 }, width: 0 })).rejects.toThrow(/width/)
    await expect(previewFrame({ folder, at: { frame: 0 }, width: 960.5 })).rejects.toThrow(/width/)
  })

  test('rejects a relative folder and a missing project', async () => {
    await expect(previewFrame({ folder: 'relative/folder', at: { frame: 0 } })).rejects.toThrow(/absolute/i)
    await expect(previewFrame({ folder: path.join(tempDir, 'nothing-here'), at: { frame: 0 } })).rejects.toThrow(
      /No project found/,
    )
  })

  test('uses the latest mapper.json on every call', async () => {
    const project = greekIslands()
    const folder = await writeFolder(project)
    const before = await previewFrame({ folder, at: { progress: 1 } })
    expect(before.frame).toBe(349)
    const saved = await loadProject(folder)
    await saveProject(folder, { ...saved, scenes: [{ ...sceneOf(saved), timing: { ...sceneOf(saved).timing, holdEnd: 4 } }] })
    const after = await previewFrame({ folder, at: { progress: 1 } })
    expect(after.frame).toBe(399)
  })
})

describe('PreviewAtSchema', () => {
  test('rejects two at keys', () => {
    expect(() => PreviewAtSchema.parse({ seconds: 1, frame: 2 })).toThrow()
  })

  test('rejects no keys, unknown keys and non-finite numbers', () => {
    expect(() => PreviewAtSchema.parse({})).toThrow()
    expect(() => PreviewAtSchema.parse({ minute: 1 })).toThrow()
    expect(() => PreviewAtSchema.parse({ frame: Number.NaN })).toThrow()
  })

  test('accepts each single key', () => {
    expect(PreviewAtSchema.parse({ seconds: 1.5 })).toEqual({ seconds: 1.5 })
    expect(PreviewAtSchema.parse({ frame: 3 })).toEqual({ frame: 3 })
    expect(PreviewAtSchema.parse({ progress: 0.25 })).toEqual({ progress: 0.25 })
  })
})

describe('contactSheet', () => {
  test('contact sheet is width 1920 with 9 frames', async () => {
    const project = greekIslands()
    const folder = await writeFolder(project)
    const total = timelineOf(project).totalFrames
    const result = await contactSheet({ folder })
    expect(size(result.png).width).toBe(1920)
    expect(result.frames).toHaveLength(9)
    expect(result.frames[0]).toEqual({ frame: 0, seconds: 0 })
    expect(result.frames[8]!.frame).toBe(total - 1)
    expect(result.frames.map((f) => f.frame)).toEqual(
      Array.from({ length: 9 }, (_, i) => Math.round((i * (total - 1)) / 8)),
    )
    expect(path.dirname(result.path)).toBe(path.join(folder, '.mapper', 'previews'))
    expect(path.basename(result.path)).toMatch(/^contact-\d{8}-\d{6}\.png$/)
    expect(existsSync(result.path)).toBe(true)
  })

  test('count and width change the grid', async () => {
    const folder = await writeFolder(greekIslands())
    const result = await contactSheet({ folder, count: 4, width: 800 })
    expect(result.frames).toHaveLength(4)
    const { width, height } = size(result.png)
    expect(width).toBe(800)
    // Two columns of 16:9 cells: taller than one row, shorter than the width of a 4-up column.
    expect(height).toBeGreaterThan(400)
    expect(height).toBeLessThan(800)
  })

  test('a single frame is frame 0', async () => {
    const folder = await writeFolder(greekIslands())
    const result = await contactSheet({ folder, count: 1, width: 640 })
    expect(result.frames).toEqual([{ frame: 0, seconds: 0 }])
  })

  test('captions read MM:SS:FF and f<frame>, plus the stop name on an arrival frame', () => {
    const project = greekIslands()
    const timeline = timelineOf(project)
    const arrival = timeline.arrivals[1]!
    expect(frameCaption(project, sceneOf(project), timeline, 0)).toBe('00:00:00 · f0')
    expect(frameCaption(project, sceneOf(project), timeline, 102)).toBe('00:04:02 · f102')
    expect(frameCaption(project, sceneOf(project), timeline, arrival.frame)).toBe(
      `${Math.floor(arrival.frame / 1500).toString().padStart(2, '0')}:${(Math.floor(arrival.frame / 25) % 60).toString().padStart(2, '0')}:${(arrival.frame % 25).toString().padStart(2, '0')} · f${arrival.frame} · Mykonos`,
    )
  })
})

describe('warm pages', () => {
  test('second preview reuses the warm page', async () => {
    await closePreviews()
    expect(previewStats()).toEqual({ browserLaunches: 0, pageOpens: 0 })
    const folder = await writeFolder(greekIslands())
    const t0 = performance.now()
    await previewFrame({ folder, at: { frame: 10 } })
    const t1 = performance.now()
    await previewFrame({ folder, at: { frame: 20 } })
    const t2 = performance.now()
    process.stderr.write(`first preview ${Math.round(t1 - t0)} ms, second ${Math.round(t2 - t1)} ms\n`)
    expect(previewStats()).toEqual({ browserLaunches: 1, pageOpens: 1 })
  })

  test('another project with the same aspect reuses the page; another aspect opens one more', async () => {
    await closePreviews()
    const first = await writeFolder(greekIslands())
    const second = await writeFolder(greekIslands())
    const portrait = await writeFolder({ ...greekIslands(), output: { aspect: '9:16', height: 1080, fps: { num: 25, den: 1 } } })
    await previewFrame({ folder: first, at: { frame: 0 } })
    await previewFrame({ folder: second, at: { frame: 0 } })
    expect(previewStats()).toEqual({ browserLaunches: 1, pageOpens: 1 })
    await previewFrame({ folder: portrait, at: { frame: 0 } })
    expect(previewStats()).toEqual({ browserLaunches: 1, pageOpens: 2 })
  })

  test('closePreviews resets the stats and the next preview launches again', async () => {
    const folder = await writeFolder(greekIslands())
    await previewFrame({ folder, at: { frame: 0 } })
    await closePreviews()
    expect(previewStats()).toEqual({ browserLaunches: 0, pageOpens: 0 })
    await previewFrame({ folder, at: { frame: 0 } })
    expect(previewStats()).toEqual({ browserLaunches: 1, pageOpens: 1 })
  })

  test('a contact sheet and a preview share the same browser and page', async () => {
    await closePreviews()
    const folder = await writeFolder(greekIslands())
    await previewFrame({ folder, at: { frame: 0 } })
    await contactSheet({ folder, count: 4, width: 800 })
    expect(previewStats()).toEqual({ browserLaunches: 1, pageOpens: 1 })
  })
})

describe('RenderPage crash reports', () => {
  async function loadedPage() {
    const { browser } = await launchBrowser()
    const folder = await writeFolder(greekIslands())
    const project = await loadProject(folder)
    const page = await RenderPage.open({ browser, aspect: project.output.aspect })
    await page.load(project, 0.25)
    return { browser, page, handle: browser.contexts()[0]!.pages()[0]! }
  }

  test('a lost WebGL context calls onCrash', async () => {
    const { browser, page, handle } = await loadedPage()
    try {
      let crashes = 0
      page.onCrash(() => crashes++)
      await page.renderFrame(0)
      await handle.evaluate(`document.querySelectorAll('canvas').forEach((canvas) => {
        canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext()
      })`)
      await expect.poll(() => crashes).toBe(1)
    } finally {
      await browser.close()
    }
  })

  test('a crashed page calls onCrash', async () => {
    const { browser, page, handle } = await loadedPage()
    try {
      let crashes = 0
      page.onCrash(() => crashes++)
      await handle.goto('chrome://crash').catch(() => undefined)
      await expect.poll(() => crashes).toBe(1)
    } finally {
      await browser.close()
    }
  })
})

describe.skipIf(!process.env.MAPPER_NET)('label determinism (needs the network)', () => {
  test('a frame looks the same before and after another frame, with real labels', async () => {
    const folder = await writeFolder(greekIslands({ look: { ...sceneOf(greekIslands()).look, theme: 'paper' } }))
    const a = await previewFrame({ folder, at: { frame: 40 }, width: 960 })
    await previewFrame({ folder, at: { frame: 10 }, width: 960 })
    const b = await previewFrame({ folder, at: { frame: 40 }, width: 960 })
    expect(pixelDiff(a.png, b.png)).toBe(0)
  })
})
