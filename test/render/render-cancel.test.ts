import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Browser, BrowserContext, Page } from 'playwright'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { RenderCancelled, renderProject } from '../../src/render/render.js'
import { planExport } from '../../src/render/export-plan.js'
import { RenderPage } from '../../src/render/page.js'
import { renderPass, type PassPage } from '../../src/render/render-pass.js'
import { saveProject } from '../../src/server/store.js'
import { greekIslands, twoScenes } from '../fixtures/projects.js'

/** What happened to the fake Chrome, in order. */
const events: string[] = []

vi.mock('../../src/render/chrome.js', () => ({
  launchBrowser: async () => ({
    browser: { close: async () => void events.push('browser.close') } as unknown as Browser,
    channel: 'chrome',
    webgl: 'fake',
  }),
}))

vi.mock('../../src/render/render-pass.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/render/render-pass.js')>()),
  renderPass: vi.fn(),
}))

let tmp: string

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'mapper-render-cancel-'))
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  events.length = 0
})

describe('cancelling a render', () => {
  // Closing Chrome while a page's browser context is still being disposed can leave Chrome stuck in shutdown, and
  // Playwright only kills it after 30 s. The MCP server's 15 s shutdown limit then exits with code 1.
  test('closes Chrome only after the active pass has closed its page', async () => {
    const folder = path.join(tmp, 'project')
    await mkdir(folder)
    await saveProject(folder, greekIslands())
    // Like the real pass: an abort starts closing the page, and the pass settles once the page is closed.
    vi.mocked(renderPass).mockImplementation(async ({ signal, onFrame }) => {
      onFrame?.(1)
      if (!signal!.aborted) await new Promise((resolve) => signal!.addEventListener('abort', resolve, { once: true }))
      events.push('page closing')
      await sleep(50)
      events.push('page closed')
      throw new Error('page.evaluate: Target page, context or browser has been closed')
    })

    const controller = new AbortController()
    const rendering = renderProject({
      folder,
      range: { from: 0, to: 0.2 },
      signal: controller.signal,
      onProgress: () => controller.abort(),
    })
    await expect(rendering).rejects.toBeInstanceOf(RenderCancelled)
    expect(events).toEqual(['page closing', 'page closed', 'browser.close'])
  })

  test('during the scene join stops ffmpeg, keeps the scene parts and settles at once', async () => {
    const folder = path.join(tmp, 'join-cancel')
    await mkdir(folder)
    await saveProject(folder, twoScenes())
    vi.mocked(renderPass).mockImplementation(async ({ pass, dir, onFrame }) => {
      const frames = pass.toFrame - pass.fromFrame
      await writeFile(path.join(dir, pass.path), 'part')
      onFrame?.(frames)
      return { ...pass, frames, segments: 1, recoveries: 0 }
    })
    // An ffmpeg that starts writing the join, then runs until it is killed.
    const bin = path.join(tmp, 'slow-ffmpeg')
    await mkdir(bin)
    await writeFile(path.join(bin, 'ffmpeg'), '#!/bin/sh\nfor last; do :; done\necho partial > "$last"\nexec sleep 30\n', { mode: 0o755 })
    const savedPath = process.env.PATH
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`
    const controller = new AbortController()
    let dir = ''
    try {
      const rendering = renderProject({ folder, signal: controller.signal, h264Encoder: 'libx264', onStart: (info) => (dir = info.dir) })
      rendering.catch(() => undefined)
      await vi.waitFor(() => expect(dir && readdirSync(dir).some((file) => file.includes('.joining'))).toBe(true), { timeout: 4000, interval: 20 })
      const cancelledAt = performance.now()
      controller.abort()
      await expect(rendering).rejects.toBeInstanceOf(RenderCancelled)
      expect(performance.now() - cancelledAt).toBeLessThan(1000)
    } finally {
      process.env.PATH = savedPath
    }

    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as { status: string; outputs: { path: string; sceneId: string }[] }
    expect(manifest.status).toBe('cancelled')
    expect(manifest.outputs.map((output) => output.sceneId)).toEqual(twoScenes().scenes.map((scene) => scene.id))
    for (const output of manifest.outputs) expect(existsSync(path.join(dir, output.path)), output.path).toBe(true)
    const left = readdirSync(dir, { recursive: true }).map(String)
    expect(left.filter((file) => /(^|\/)all\.|\.joining/.test(file))).toEqual([])
  })
})

describe('render speed', () => {
  test('renderFps counts clip frames', async () => {
    const folder = path.join(tmp, 'fps')
    await mkdir(folder)
    await saveProject(folder, greekIslands())
    let clock = 0
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    // Each of the three passes renders its 10 frames in a third of a second: 30 work frames, 10 clip frames, 1 s.
    vi.mocked(renderPass).mockImplementation(async ({ pass, onFrame }) => {
      const frames = pass.toFrame - pass.fromFrame
      clock += 1000 / 3
      onFrame?.(frames)
      return { ...pass, frames, segments: 1, recoveries: 0 }
    })
    try {
      const result = await renderProject({ folder, layers: ['map', 'route', 'all'], codec: 'prores', range: { from: 0, to: 0.4 } })
      expect(result.outputs.map((o) => o.frames)).toEqual([10, 10, 10])
      expect(result.renderFps).toBe(10)
      expect(JSON.parse(await readFile(result.manifest, 'utf8')).renderFps).toBe(10)
    } finally {
      now.mockRestore()
    }
  })

  // Four passes, two scenes × two layers: each renders its frames at 20 fps, so the clip comes out at 10 fps whatever
  // the scenes' lengths.
  test.each([true, false])('renderFps counts clip frames over every scene (join: %s)', async (join) => {
    const folder = path.join(tmp, `fps-scenes-${join}`)
    await mkdir(folder)
    await saveProject(folder, twoScenes())
    let clock = 0
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    vi.mocked(renderPass).mockImplementation(async ({ pass, onFrame }) => {
      const frames = pass.toFrame - pass.fromFrame
      clock += frames * 50
      onFrame?.(frames)
      return { ...pass, frames, segments: 1, recoveries: 0 }
    })
    try {
      const result = await renderProject({ folder, layers: ['map', 'route'], join })
      expect(result.outputs).toHaveLength(4)
      expect(result.renderFps).toBe(10)
      expect(JSON.parse(await readFile(result.manifest, 'utf8')).renderFps).toBe(10)
    } finally {
      now.mockRestore()
    }
  })
})

describe('cancelling a pass', () => {
  test('closes a page that is still loading', async () => {
    const { renderPass: realRenderPass } = await vi.importActual<typeof import('../../src/render/render-pass.js')>(
      '../../src/render/render-pass.js',
    )
    const project = greekIslands()
    const plan = planExport(project, { seaPaths: {}, layers: ['route'], range: { from: 0, to: 0.2 } })
    const pass = plan.passes[0]!
    const controller = new AbortController()
    let closed!: () => void
    const closing = new Promise<void>((resolve) => (closed = resolve))
    let closes = 0
    const page: PassPage = {
      // Loading waits for tiles; only closing the page cuts it short.
      load: async () => {
        controller.abort()
        await closing
        throw new Error('page.evaluate: Target page, context or browser has been closed')
      },
      renderFrame: async () => undefined,
      capturePng: async () => Buffer.alloc(0),
      contextLost: async () => false,
      onCrash: () => undefined,
      close: async () => {
        closes++
        closed()
      },
    }
    const dir = await mkdtemp(path.join(tmp, 'loading-'))
    const rendering = realRenderPass(
      { browser: {} as Browser, project, scene: plan.scenes[0]!, pass, dir, signal: controller.signal },
      { openPage: async () => page, startEncoder: () => expect.fail('no frame should be encoded') },
    )
    await expect(rendering).rejects.toThrow('has been closed')
    expect(closes).toBeGreaterThan(0)
  })
})

describe('RenderPage.close', () => {
  test('a second close waits for the first to finish', async () => {
    let finish!: () => void
    let closes = 0
    const context = {
      close: () => {
        closes++
        return new Promise<void>((resolve) => (finish = resolve))
      },
    } as unknown as BrowserContext
    // The constructor is private; `open` needs Chrome and the studio server.
    const page = new (RenderPage as unknown as new (args: { aspect: string; context: BrowserContext; page: Page }) => RenderPage)({
      aspect: '16:9',
      context,
      page: {} as Page,
    })

    let firstDone = false
    let secondDone = false
    void page.close().then(() => (firstDone = true))
    void page.close().then(() => (secondDone = true))
    await sleep(10)
    expect([firstDone, secondDone]).toEqual([false, false])
    finish()
    await sleep(0)
    expect([firstDone, secondDone]).toEqual([true, true])
    expect(closes).toBe(1)
  })
})
