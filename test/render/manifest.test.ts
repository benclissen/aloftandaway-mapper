import { existsSync, readdirSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Browser } from 'playwright'
import { PNG } from 'pngjs'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { buildRoute, buildTimeline, MAP_CREDIT, type RenderPageOptions } from '../../src/core/index.js'
import { Encoder } from '../../src/render/encode.js'
import { RenderError } from '../../src/render/errors.js'
import { adaptV1Scene, planExport } from '../../src/render/export-plan.js'
import { writeManifest, type ExportManifest } from '../../src/render/manifest.js'
import { renderPass, type PassDeps, type PassEncoder, type PassPage } from '../../src/render/render-pass.js'
import { greekIslands } from '../fixtures/projects.js'

let tmp: string
const previousPath = process.env.PATH

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'mapper-manifest-'))
})

afterEach(() => {
  process.env.PATH = previousPath
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

function manifest(status: ExportManifest['status']): ExportManifest {
  const project = greekIslands()
  return {
    manifestVersion: 2,
    mapperVersion: '0.0.0',
    projectId: project.id,
    projectHash: 'abc',
    name: project.name,
    output: project.output,
    frameSize: { width: 1920, height: 1080 },
    credit: MAP_CREDIT,
    creditPlacement: project.credit,
    status,
    scenes: [{ id: project.id, name: project.name, range: { fromFrame: 0, toFrame: 50 } }],
    outputs: [],
    totalFrames: 50,
    completedWorkFrames: 0,
    totalWorkFrames: 150,
    durationSeconds: 2,
    renderedAt: '2026-10-14T00:00:00.000Z',
    renderFps: 0,
  }
}

describe('writeManifest', () => {
  test('writes the manifest and leaves no temporary file', async () => {
    const dir = await mkdtemp(path.join(tmp, 'write-'))
    const file = path.join(dir, 'manifest.json')
    await writeManifest(file, manifest('running'))
    await writeManifest(file, manifest('done'))
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(manifest('done'))
    expect(readdirSync(dir)).toEqual(['manifest.json'])
  })

  test('a failed rename keeps the previous manifest and removes the temporary file', async () => {
    const dir = await mkdtemp(path.join(tmp, 'rename-'))
    const file = path.join(dir, 'manifest.json')
    // Renaming a file over a non-empty folder fails.
    await mkdir(path.join(file, 'blocker'), { recursive: true })
    await expect(writeManifest(file, manifest('running'))).rejects.toThrow()
    expect(readdirSync(dir)).toEqual(['manifest.json'])
    expect(readdirSync(file)).toEqual(['blocker'])
  })

  test('a failed write leaves the previous manifest whole', async () => {
    const dir = await mkdtemp(path.join(tmp, 'readonly-'))
    const file = path.join(dir, 'manifest.json')
    await writeManifest(file, manifest('running'))
    await chmod(dir, 0o555)
    try {
      await expect(writeManifest(file, manifest('failed'))).rejects.toThrow()
    } finally {
      await chmod(dir, 0o755)
    }
    expect(JSON.parse(await readFile(file, 'utf8')).status).toBe('running')
    expect(readdirSync(dir)).toEqual(['manifest.json'])
  })
})

describe('renderPass failures', () => {
  const project = greekIslands()
  const scene = adaptV1Scene(project)
  const totalFrames = buildTimeline(scene.scene, project.output.fps, buildRoute(scene.scene)).totalFrames
  const browser = {} as Browser
  let frame: Buffer

  beforeAll(() => {
    const png = new PNG({ width: 1920, height: 1080 })
    png.data.fill(255)
    frame = PNG.sync.write(png)
  })

  /** Pages that fail to render any frame from `failFrom` on, recording every load and close. */
  function fakePages(failFrom: number) {
    const loads: RenderPageOptions[] = []
    let open = 0
    const openPage: PassDeps['openPage'] = async () => {
      open++
      let closed = false
      const page: PassPage = {
        load: async (_p, _ratio, opts = {}) => {
          loads.push(opts)
          return totalFrames
        },
        renderFrame: async (n) => {
          if (n >= failFrom) throw new Error(`fake failure at frame ${n}`)
        },
        capturePng: async () => frame,
        contextLost: async () => false,
        onCrash: () => undefined,
        close: async () => {
          if (!closed) open--
          closed = true
        },
      }
      return page
    }
    return { openPage, loads, openPages: () => open }
  }

  test('gives up after three recoveries, with every page closed', async () => {
    const dir = await mkdtemp(path.join(tmp, 'exhausted-'))
    const pass = planExport(project, { layers: ['route'], range: { from: 0, to: 0.4 } }).passes[0]!
    const pages = fakePages(2)
    const encoders: { out: string; frames: number; finished: boolean }[] = []
    const startEncoder = (args: string[]): PassEncoder => {
      const record = { out: args.at(-1)!, frames: 0, finished: false }
      encoders.push(record)
      return {
        write: async () => void record.frames++,
        finish: async () => void (record.finished = true),
        kill: () => undefined,
      }
    }
    const e = await renderPass({ browser, scene, pass, dir, faultAtFrame: 7 }, { openPage: pages.openPage, startEncoder })
      .then(() => undefined, (error: unknown) => error)
    expect(e).toBeInstanceOf(RenderError)
    expect((e as Error).message).toMatch(/Frame 2 of the route layer failed 4 times, after 3 recoveries/)
    expect(pages.loads).toEqual([
      { layer: 'route', faultAtFrame: 7, faultAfterRenderFrame: undefined },
      { layer: 'route' },
      { layer: 'route' },
      { layer: 'route' },
    ])
    expect(pages.openPages()).toBe(0)
    // Frames 0 and 1 went to the first segment, which was finished before the first recovery.
    expect(encoders).toEqual([{ out: path.join(dir, '01-greek-islands', 'route.part1.mov'), frames: 2, finished: true }])
    expect(existsSync(path.join(dir, '01-greek-islands', 'route.mov'))).toBe(false)
  })

  test('an ffmpeg failure fails the pass without a recovery and leaves no ffmpeg running', async () => {
    const dir = await mkdtemp(path.join(tmp, 'encoder-'))
    const bin = path.join(tmp, 'fake-bin')
    await mkdir(bin, { recursive: true })
    const pidFile = path.join(tmp, 'fake-ffmpeg.pid')
    await writeFile(
      path.join(bin, 'ffmpeg'),
      `#!/bin/sh\necho $$ > '${pidFile}'\nhead -c 100000 > /dev/null\necho 'fake encoder failure' >&2\nexit 1\n`,
      { mode: 0o755 },
    )
    process.env.PATH = `${bin}:${previousPath}`
    const pass = planExport(project, { layers: ['map'], range: { from: 0, to: 0.4 } }).passes[0]!
    const pages = fakePages(Infinity)
    const e = await renderPass({ browser, scene, pass, dir }, { openPage: pages.openPage, startEncoder: Encoder.start })
      .then(() => undefined, (error: unknown) => error)
    expect(e).toBeInstanceOf(Error)
    expect((e as Error).message).toMatch(/ffmpeg exited with code 1[\s\S]*fake encoder failure/)
    // One page: the encoder's failure was not treated as a page fault.
    expect(pages.loads).toHaveLength(1)
    expect(pages.openPages()).toBe(0)
    expect(existsSync(path.join(dir, '01-greek-islands', 'map.mov'))).toBe(false)
    const pid = Number((await readFile(pidFile, 'utf8')).trim())
    expect(() => process.kill(pid, 0)).toThrow()
  })
})
