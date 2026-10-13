import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { MAP_DATA_ERROR } from '../../src/core/index.js'
import { callTool, errorText, TOOLS } from '../../src/mcp/tools.js'
import { launchBrowser } from '../../src/render/chrome.js'
import { Encoder, pickH264Encoder } from '../../src/render/encode.js'
import { renderStatus, startRenderJob, type RenderStatus } from '../../src/render/jobs.js'
import { pageError } from '../../src/render/page.js'
import { joinParts, RenderError } from '../../src/render/render.js'
import { EnvironmentError } from '../../src/server/errors.js'
import { createProject, saveProject } from '../../src/server/store.js'
import { greekIslands } from '../fixtures/projects.js'

// Neither Chrome nor Playwright's Chromium will start.
vi.mock('playwright', () => ({
  chromium: {
    launch: async () => {
      throw new Error("browserType.launch: Executable doesn't exist at /nowhere/chrome\n    at somewhere")
    },
  },
}))

const BUG_FIX = 'This looks like a bug in Mapper'
const FIXES = {
  mapData: 'Check the internet connection. Map tiles come from tiles.openfreemap.org, and Mapper caches them after the first load.',
  chrome: 'Install Google Chrome, or run: npx playwright install chromium',
  ffmpeg: 'brew install ffmpeg',
  h264: 'Install an ffmpeg build with h264_videotoolbox or libx264: brew reinstall ffmpeg',
  access: "Check the folder's permissions.",
  notDir: 'Pass the project folder itself, not a file inside it.',
}

let tmp: string
const realPath = process.env.PATH

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'mapper-errors-'))
})

afterEach(() => {
  process.env.PATH = realPath
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

/** The error a promise rejects with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (e) {
    return e
  }
  throw new Error('expected a rejection')
}

function expectFix(text: string, fix: string): void {
  expect(text).toMatch(/^Error: /)
  expect(text).toContain(`\nFix: ${fix}`)
  expect(text).not.toContain(BUG_FIX)
}

const tool = (name: string) => TOOLS.find((t) => t.name === name)!
const toolText = async (name: string, input: unknown) => {
  const result = await callTool(tool(name), input)
  expect(result.isError).toBe(true)
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
}

/** A folder holding a Greek Islands project with a fresh id. */
async function projectFolder(name: string): Promise<string> {
  const folder = path.join(tmp, name)
  const created = await createProject(folder, 'Greek Islands')
  await saveProject(folder, { ...greekIslands(), id: created.id })
  return folder
}

describe('errorText', () => {
  test('uses the fix of any error that carries one', () => {
    expectFix(errorText(new EnvironmentError('No network.', 'Plug it in.'), 'x'), 'Plug it in.')
    expectFix(errorText(Object.assign(new Error('Odd.'), { fix: 'Do this.' }), 'x'), 'Do this.')
  })

  test('falls back to the bug fix only for errors without one', () => {
    expect(errorText(new Error('Boom.'), 'x')).toContain(BUG_FIX)
    expect(errorText(Object.assign(new Error('Boom.'), { fix: '' }), 'x')).toContain(BUG_FIX)
  })
})

describe('environment failures say what to do', () => {
  test('map data that failed to load in the page', () => {
    const fromPlaywright = new Error(
      `page.evaluate: Error: ${MAP_DATA_ERROR}: AJAXError: Forbidden (403): http://127.0.0.1/tiles/planet/1/2/3.pbf\n    at showFrame (x.js:1:1)`,
    )
    const e = pageError(fromPlaywright)
    expect(e).toBeInstanceOf(EnvironmentError)
    expect((e as Error).message).toBe(`${MAP_DATA_ERROR}: AJAXError: Forbidden (403): http://127.0.0.1/tiles/planet/1/2/3.pbf`)
    expectFix(errorText(e, 'preview_frame'), FIXES.mapData)
    // Anything else from the page is passed on as it is.
    const other = new Error('page.evaluate: RangeError: Frame 900 is outside 0 to 299.')
    expect(pageError(other)).toBe(other)
  })

  test('no Chrome', async () => {
    const e = await rejection(launchBrowser())
    expect(e).toBeInstanceOf(EnvironmentError)
    expect((e as Error).message).toContain("Executable doesn't exist")
    expectFix(errorText(e, 'render'), FIXES.chrome)
  })

  test('no ffmpeg, when encoding or picking an H.264 encoder', async () => {
    process.env.PATH = path.join(tmp, 'empty-path')
    const encoder = Encoder.start(['-version'])
    const e = await rejection(encoder.finish())
    expect(e).toBeInstanceOf(EnvironmentError)
    expectFix(errorText(e, 'render'), FIXES.ffmpeg)
    expectFix(errorText(await rejection(pickH264Encoder()), 'render'), FIXES.ffmpeg)
  })

  test('no H.264 encoder', async () => {
    const bin = path.join(tmp, 'fake-ffmpeg')
    await mkdir(bin, { recursive: true })
    const fake = path.join(bin, 'ffmpeg')
    await writeFile(fake, '#!/bin/sh\necho " V....D prores_ks            Apple ProRes (iCodec Pro) (codec prores)"\n')
    await chmod(fake, 0o755)
    process.env.PATH = `${bin}:/usr/bin:/bin`
    const e = await rejection(pickH264Encoder())
    expect(e).toBeInstanceOf(EnvironmentError)
    expectFix(errorText(e, 'render'), FIXES.h264)
  })

  test('a project file Mapper may not read', async () => {
    const folder = await projectFolder('locked')
    const file = path.join(folder, 'mapper.json')
    await chmod(file, 0o000)
    try {
      expectFix(await toolText('get_project', { folder }), FIXES.access)
    } finally {
      await chmod(file, 0o644)
    }
  })

  test('a folder Mapper may not write to', async () => {
    const folder = await projectFolder('read-only')
    await chmod(folder, 0o555)
    try {
      expectFix(await toolText('set_stops', { folder, stops: [{ name: 'Piraeus', at: [23.6466, 37.942] }] }), FIXES.access)
    } finally {
      await chmod(folder, 0o755)
    }
  })

  test('a file passed as the project folder', async () => {
    const folder = await projectFolder('trip')
    const file = path.join(folder, 'mapper.json')
    expectFix(await toolText('get_project', { folder: file }), FIXES.notDir)
    expectFix(await toolText('create_project', { folder: path.join(file, 'inner'), name: 'Inner' }), FIXES.notDir)
  })
})

describe('render failures', () => {
  test('a failed join names the kept segments and says to render again', async () => {
    const dir = path.join(tmp, 'join')
    await mkdir(dir, { recursive: true })
    const parts = [path.join(dir, 'all.part1.mov'), path.join(dir, 'all.part2.mov')]
    for (const part of parts) await writeFile(part, 'not a video')
    const e = await rejection(joinParts({ parts, out: path.join(dir, 'all.mov'), codec: 'prores' }))
    expect(e).toBeInstanceOf(RenderError)
    const text = errorText(e, 'render')
    expect(text).not.toContain(BUG_FIX)
    expect(text).toMatch(/\nFix: .*[Rr]ender again/)
    for (const part of parts) {
      expect(text).toContain(part)
      expect((await stat(part)).isFile()).toBe(true)
    }
  })

  async function settled(jobId: string): Promise<RenderStatus> {
    for (;;) {
      const status = renderStatus(jobId)
      if (status.state !== 'running') return status
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  test('a job keeps the error and its fix apart', async () => {
    const folder = path.join(tmp, 'empty')
    await createProject(folder, 'Empty')
    const status = await settled(startRenderJob({ folder }))
    expect(status.state).toBe('failed')
    expect(status.error).toMatch(/too-few-stops/)
    expect(status.error).not.toContain('Fix:')
    expect(status.fix).toMatch(/set_stops/)
  })

  test('a job that fails for want of ffmpeg reports the ffmpeg fix', async () => {
    const folder = await projectFolder('no-ffmpeg')
    process.env.PATH = path.join(tmp, 'empty-path')
    const jobId = startRenderJob({ folder, codec: 'h264' })
    const status = await settled(jobId)
    expect(status.state).toBe('failed')
    expect(status.fix).toBe(FIXES.ffmpeg)
    const result = await callTool(tool('render_status'), { jobId })
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
    expect(text).toContain(`\nFix: ${FIXES.ffmpeg}`)
    expectFix(await toolText('render', { folder, codec: 'h264' }), FIXES.ffmpeg)
  })
})
