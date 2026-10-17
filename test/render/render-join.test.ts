import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { frameSize } from '../../src/core/index.js'
import { planExport } from '../../src/render/export-plan.js'
import type { ExportManifest } from '../../src/render/manifest.js'
import { RenderError, renderProject } from '../../src/render/render.js'
import { renderPass, type PassEncoder, type PassPage } from '../../src/render/render-pass.js'
import { saveProject } from '../../src/server/store.js'
import { greekIslands, twoScenes } from '../fixtures/projects.js'

vi.mock('../../src/render/chrome.js', () => ({
  launchBrowser: async () => ({ browser: { close: async () => undefined } as unknown as Browser, channel: 'chrome', webgl: 'fake' }),
}))

vi.mock('../../src/render/render-pass.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/render/render-pass.js')>()),
  renderPass: vi.fn(),
}))

/** The scene parts of `twoScenes()` joined into `all.mp4`. */
const PARTS = ['01-drive.part.mp4', '02-sail.part.mp4']

let tmp: string

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'mapper-render-join-'))
  // Each pass writes a stand-in for its clip, so only the join needs ffmpeg.
  vi.mocked(renderPass).mockImplementation(async ({ pass, dir, onFrame }) => {
    const frames = pass.toFrame - pass.fromFrame
    await writeFile(path.join(dir, pass.path), 'part')
    onFrame?.(frames)
    return { ...pass, frames, segments: 1, recoveries: 0 }
  })
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

/** Runs `run` with an `ffmpeg` on the PATH that runs `script`. `$last` is its last argument, the output file. */
async function withFfmpeg<T>(name: string, script: string, run: () => Promise<T>): Promise<T> {
  const bin = path.join(tmp, name)
  await mkdir(bin)
  await writeFile(path.join(bin, 'ffmpeg'), `#!/bin/sh\nfor last; do :; done\n${script}\n`, { mode: 0o755 })
  const savedPath = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${savedPath}`
  try {
    return await run()
  } finally {
    process.env.PATH = savedPath
  }
}

const JOINS = 'echo joined > "$last"'
const FAILS = 'echo "concat: invalid data found" >&2\nexit 1'

async function twoSceneFolder(name: string): Promise<string> {
  const folder = path.join(tmp, name)
  await mkdir(folder)
  await saveProject(folder, twoScenes())
  return folder
}

const readManifest = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as ExportManifest

const eacces = (file: string) => Object.assign(new Error(`EACCES: permission denied, unlink '${file}'`), { code: 'EACCES' })

describe('joining the scene parts', () => {
  test("the manifest stops listing the parts before they're deleted", async () => {
    const folder = await twoSceneFolder('forget-first')
    let dir = ''
    const seen: { deleting: string; outputs: string[] }[] = []
    const result = await withFfmpeg('joins', JOINS, () =>
      renderProject({
        folder,
        h264Encoder: 'libx264',
        onStart: (info) => (dir = info.dir),
        removeFile: async (file) => {
          const { outputs } = readManifest(path.join(dir, 'manifest.json'))
          seen.push({ deleting: path.relative(dir, file), outputs: outputs.map((output) => output.path) })
          await rm(file, { force: true })
        },
      }),
    )
    expect(seen.map((s) => s.deleting).sort()).toEqual(PARTS)
    for (const s of seen) expect(s.outputs).toEqual(['all.mp4'])
    for (const part of PARTS) expect(existsSync(path.join(dir, part)), part).toBe(false)
    expect(result.warnings).toEqual([])
  })

  test('a failed part delete is a warning, not a failure', async () => {
    const folder = await twoSceneFolder('delete-fails')
    const result = await withFfmpeg('joins-2', JOINS, () =>
      renderProject({
        folder,
        h264Encoder: 'libx264',
        removeFile: async (file) => {
          throw eacces(file)
        },
      }),
    )
    const line = `Couldn't delete 2 scene parts after joining them: ${PARTS.join(', ')} (EACCES). They're not needed; delete them yourself.`
    expect(result.warnings).toEqual([line])
    expect(result.outputs.map((output) => path.relative(result.dir, output.path))).toEqual(['all.mp4'])
    expect(result.video).toBe(path.join(result.dir, 'all.mp4'))
    const manifest = readManifest(result.manifest)
    expect(manifest.status).toBe('done')
    expect(manifest.outputs.map((output) => output.path)).toEqual(['all.mp4'])
    expect(manifest.warnings).toEqual([line])
  })

  test('a failed scene join keeps the scene clips', async () => {
    const folder = await twoSceneFolder('join-fails')
    let dir = ''
    const removed: string[] = []
    const rendering = withFfmpeg('fails', FAILS, () =>
      renderProject({
        folder,
        h264Encoder: 'libx264',
        onStart: (info) => (dir = info.dir),
        removeFile: async (file) => void removed.push(file),
      }),
    )
    const e = await rendering.then(
      () => expect.fail('the render should fail'),
      (e: unknown) => e,
    )
    expect(e).toBeInstanceOf(RenderError)
    expect((e as RenderError).message).toContain('concat: invalid data found')
    expect((e as RenderError).fix).toBe(`Render again. The 2 scene clips are kept: ${PARTS.map((part) => path.join(dir, part)).join(', ')}`)
    expect(removed).toEqual([])
    const manifest = readManifest(path.join(dir, 'manifest.json'))
    expect(manifest.status).toBe('failed')
    expect(manifest.outputs.map((output) => output.path)).toEqual(PARTS)
    for (const part of PARTS) expect(await readFile(path.join(dir, part), 'utf8'), part).toBe('part')
    expect(existsSync(path.join(dir, 'all.mp4'))).toBe(false)
  })
})

describe("joining a pass's segments", () => {
  test('a failed segment delete is a warning, not a failure', async () => {
    const { renderPass: realRenderPass } = await vi.importActual<typeof import('../../src/render/render-pass.js')>(
      '../../src/render/render-pass.js',
    )
    const project = greekIslands()
    const plan = planExport(project, { seaPaths: {}, range: { from: 0, to: 0.2 } })
    const pass = plan.passes[0]!
    const size = frameSize(project.output)
    // Just enough PNG for the size check.
    const png = Buffer.alloc(24)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
    png.write('IHDR', 12, 'latin1')
    png.writeUInt32BE(size.width, 16)
    png.writeUInt32BE(size.height, 20)
    let failed = false
    const page: PassPage = {
      load: async () => plan.scenes[0]!.totalFrames,
      // Frame 2 fails once, so the pass recovers into a second segment.
      renderFrame: async (n) => {
        if (n === 2 && !failed) {
          failed = true
          throw new Error('the WebGL context was lost')
        }
        return { settled: true }
      },
      capturePng: async () => png,
      contextLost: async () => false,
      onCrash: () => undefined,
      close: async () => undefined,
    }
    const startEncoder = (args: string[]): PassEncoder => ({
      write: async () => undefined,
      finish: () => writeFile(args.at(-1)!, 'segment'),
      kill: () => undefined,
    })
    const dir = await mkdtemp(path.join(tmp, 'segments-'))
    const warnings: string[] = []
    const done = await withFfmpeg('joins-segments', JOINS, () =>
      realRenderPass(
        {
          browser: {} as Browser,
          project,
          seaPaths: {},
          scene: plan.scenes[0]!,
          pass,
          dir,
          h264Encoder: 'libx264',
          removeFile: async (file) => {
            throw eacces(file)
          },
          onWarning: (line) => warnings.push(line),
        },
        { openPage: async () => page, startEncoder },
      ),
    )
    expect(done.segments).toBe(2)
    expect(await readFile(path.join(dir, pass.path), 'utf8')).toBe('joined\n')
    const stem = pass.path.slice(0, -path.extname(pass.path).length)
    const segments = [`${stem}.part1.mp4`, `${stem}.part2.mp4`]
    expect(warnings).toEqual([
      `Couldn't delete 2 segments after joining them: ${segments.join(', ')} (EACCES). They're not needed; delete them yourself.`,
    ])
  })
})
