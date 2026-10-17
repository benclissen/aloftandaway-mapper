import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Browser } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { MAX_TERRAIN_SETTLES, type Project } from '../../src/core/index.js'
import { planExport } from '../../src/render/export-plan.js'
import { EnvironmentError } from '../../src/server/errors.js'
import { LOAD_TIMEOUT_MS } from '../../src/render/page.js'
import { renderPass, STEP_TIMEOUT_MS, TERRAIN_FRAME_TIMEOUT_MS, type PassPage } from '../../src/render/render-pass.js'
import { greekIslands, sceneOf } from '../fixtures/projects.js'

let tmp: string

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'mapper-pass-timeouts-'))
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

beforeEach(() => void vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))
afterEach(() => void vi.useRealTimers())

/** Waits for `cond` on the real event loop. `vi.waitFor` would advance the fake timers while it polls. */
async function until(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition.')
    await new Promise((resolve) => setImmediate(resolve))
  }
}

const terrainProject = () => greekIslands({ look: { ...sceneOf(greekIslands()).look, terrain: true } })

/** Starts a pass over `project` whose pages never answer a `renderFrame`. Returns how many pages were opened so far. */
async function hangingPass(project: Project, load: PassPage['load'] = async (p) => planExport(p, { seaPaths: {}, layers: ['route'] }).scenes[0]!.totalFrames) {
  const plan = planExport(project, { seaPaths: {}, layers: ['route'], range: { from: 0, to: 0.2 } })
  const controller = new AbortController()
  const stats = { opened: 0 }
  const pages: PassPage[] = []
  const openPage = async () => {
    stats.opened++
    let fail!: (e: Error) => void
    const closed = new Promise<never>((_, reject) => (fail = reject))
    closed.catch(() => undefined)
    const page: PassPage = {
      load,
      // A frame that never finishes, until the page is closed.
      renderFrame: () => closed,
      capturePng: async () => Buffer.alloc(0),
      contextLost: async () => false,
      onCrash: () => undefined,
      close: async () => fail(new Error('Target page, context or browser has been closed')),
    }
    pages.push(page)
    return page
  }
  const dir = await mkdtemp(path.join(tmp, 'pass-'))
  const rendering = renderPass(
    { browser: {} as Browser, project, seaPaths: {}, scene: plan.scenes[0]!, pass: plan.passes[0]!, dir, signal: controller.signal },
    { openPage, startEncoder: () => expect.fail('no frame should be encoded') },
  )
  rendering.catch(() => undefined)
  // Real file system calls come before the first page opens.
  await until(() => stats.opened === 1)
  return { stats, rendering, stop: () => controller.abort() }
}

describe('step budgets', () => {
  test('a terrain frame outlasts the page\'s own idle timeouts', () => {
    expect(TERRAIN_FRAME_TIMEOUT_MS).toBe((MAX_TERRAIN_SETTLES + 2) * 60_000 + 10_000)
    expect(TERRAIN_FRAME_TIMEOUT_MS).toBeGreaterThan((MAX_TERRAIN_SETTLES + 1) * 60_000)
  })

  test('a frame without terrain is recovered after the usual 60 s', async () => {
    const { stats, stop } = await hangingPass(greekIslands())
    await vi.advanceTimersByTimeAsync(STEP_TIMEOUT_MS - 1)
    expect(stats.opened).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await until(() => stats.opened === 2)
    stop()
  })

  test('a terrain frame gets the full terrain budget', async () => {
    const { stats, stop } = await hangingPass(terrainProject())
    await vi.advanceTimersByTimeAsync(STEP_TIMEOUT_MS + 1)
    expect(stats.opened).toBe(1)
    await vi.advanceTimersByTimeAsync(TERRAIN_FRAME_TIMEOUT_MS - STEP_TIMEOUT_MS - 2)
    expect(stats.opened).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await until(() => stats.opened === 2)
    stop()
  })
})

describe('loading a page', () => {
  test('a load that never finishes fails the pass after the load budget', async () => {
    const never: PassPage['load'] = () => new Promise<number>(() => undefined)
    const plan = planExport(greekIslands(), { seaPaths: {}, layers: ['route'], range: { from: 0, to: 0.2 } })
    let closes = 0
    const page: PassPage = {
      load: never,
      renderFrame: async () => ({ settled: true }),
      capturePng: async () => Buffer.alloc(0),
      contextLost: async () => false,
      onCrash: () => undefined,
      close: async () => void closes++,
    }
    let opened = false
    const rendering = renderPass(
      { browser: {} as Browser, project: greekIslands(), seaPaths: {}, scene: plan.scenes[0]!, pass: plan.passes[0]!, dir: await mkdtemp(path.join(tmp, 'load-')) },
      { openPage: async () => ((opened = true), page), startEncoder: () => expect.fail('no frame should be encoded') },
    )
    const outcome = rendering.then(() => 'rendered', (e: Error) => e.message)
    await until(() => opened)
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS - 1)
    expect(closes).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    await expect(outcome).resolves.toBe(`Could not load the scene within ${LOAD_TIMEOUT_MS / 1000} s.`)
    expect(closes).toBeGreaterThan(0)
    expect(LOAD_TIMEOUT_MS).toBeGreaterThan(STEP_TIMEOUT_MS)
  })

  test('a load that fails with a map-data error keeps its type and fix', async () => {
    const fail = new EnvironmentError('The map could not load its data: x', 'Check the internet connection.')
    const plan = planExport(greekIslands(), { seaPaths: {}, layers: ['route'], range: { from: 0, to: 0.2 } })
    const page: PassPage = {
      load: async () => {
        throw fail
      },
      renderFrame: async () => ({ settled: true }),
      capturePng: async () => Buffer.alloc(0),
      contextLost: async () => false,
      onCrash: () => undefined,
      close: async () => undefined,
    }
    await expect(
      renderPass(
        { browser: {} as Browser, project: greekIslands(), seaPaths: {}, scene: plan.scenes[0]!, pass: plan.passes[0]!, dir: await mkdtemp(path.join(tmp, 'typed-')) },
        { openPage: async () => page, startEncoder: () => expect.fail('no frame should be encoded') },
      ),
    ).rejects.toBe(fail)
  })
})
