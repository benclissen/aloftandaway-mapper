import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { type Project } from '../../src/core/index.js'
import { cancelRender, renderStatus, startRenderJob, type RenderStatus } from '../../src/render/jobs.js'
import { closePreviews, previewFrame } from '../../src/render/preview.js'
import { frameRange, renderProject } from '../../src/render/render.js'
import { getServer } from '../../src/server/server.js'
import { createProject, loadProject, mutateProject, projectHash, saveProject } from '../../src/server/store.js'
import { greekIslands, sceneOf } from '../fixtures/projects.js'
import { pixelDiff } from './helpers.js'

const run = promisify(execFile)
let tempDir: string
const previousCacheDir = process.env.MAPPER_CACHE_DIR

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'mapper-render-'))
  process.env.MAPPER_CACHE_DIR = path.join(tempDir, 'cache')
})

afterAll(async () => {
  await closePreviews()
  await (await getServer()).close()
  if (previousCacheDir === undefined) delete process.env.MAPPER_CACHE_DIR
  else process.env.MAPPER_CACHE_DIR = previousCacheDir
  await rm(tempDir, { recursive: true, force: true })
})

async function writeFolder(project: Project): Promise<string> {
  const folder = await mkdtemp(path.join(tempDir, 'project-'))
  await createProject(folder, project.name)
  await saveProject(folder, { ...project, id: randomUUID() })
  return folder
}

async function ffprobe(file: string): Promise<Record<string, string | number>> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', file])
  return (JSON.parse(stdout) as { streams: Record<string, string | number>[] }).streams[0]!
}

/** Frame `n` of `video` as an 8-bit RGB PNG, converted back from Rec.709 limited range. */
async function videoFramePng(video: string, n: number): Promise<Buffer> {
  const { stdout } = await run(
    'ffmpeg',
    ['-v', 'error', '-i', video, '-vf', `select=eq(n\\,${n}),scale=in_color_matrix=bt709:in_range=tv`, '-frames:v', '1',
      '-pix_fmt', 'rgb24', '-f', 'image2pipe', '-c:v', 'png', '-'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  )
  return stdout
}

function readManifest(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

/** Polls the job until `done` returns true for its status. */
async function waitFor(jobId: string, done: (s: RenderStatus) => boolean, timeoutMs = 120_000): Promise<RenderStatus> {
  const start = Date.now()
  for (;;) {
    const status = renderStatus(jobId)
    if (done(status)) return status
    if (status.state !== 'running') throw new Error(`Job ended as ${status.state}: ${status.error ?? ''}`)
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for job ${jobId}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

test('renders a 2-second ProRes clip', async () => {
  const folder = await writeFolder(greekIslands())
  const result = await renderProject({ folder, codec: 'prores', range: { from: 0, to: 2 } })
  expect(result.dir.startsWith(path.join(folder, 'renders') + path.sep)).toBe(true)
  expect(path.basename(result.dir)).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}$/)
  expect(result.video).toBe(path.join(result.dir, 'all.mov'))
  expect(result.frames).toBe(50)
  expect(result.renderFps).toBeGreaterThan(0)

  const stream = await ffprobe(result.video!)
  expect(stream.codec_name).toBe('prores')
  expect(stream.profile).toBe('HQ')
  expect(stream.pix_fmt).toBe('yuv422p10le')
  expect(`${stream.width}x${stream.height}`).toBe('1920x1080')
  expect(stream.r_frame_rate).toBe('25/1')
  expect(Number(stream.nb_frames)).toBe(50)
  expect([stream.color_space, stream.color_transfer, stream.color_primaries]).toEqual(['bt709', 'bt709', 'bt709'])

  const manifest = readManifest(result.manifest)
  expect(manifest.credit).toBe('') // the blank theme shows no map data
  expect(manifest.creditPlacement).toBe('burned')
  expect(manifest.codec).toBe('prores')
  expect(manifest.range).toEqual({ fromFrame: 0, toFrame: 50 })
  expect(manifest.totalFrames).toBe(50)
  expect(manifest.durationSeconds).toBe(2)
  expect(manifest.frameSize).toEqual({ width: 1920, height: 1080 })
  expect(manifest.projectHash).toBe(result.projectHash)
  expect(manifest.mapperVersion).toBe('0.0.0')
  expect(manifest.chrome).toMatchObject({ channel: expect.any(String), webgl: expect.any(String) })
  expect(manifest.manifestVersion).toBe(2)
  expect(manifest.status).toBe('done')
  expect(manifest.outputs).toEqual([
    { sceneId: expect.any(String), request: 'all', layer: 'all', kind: 'prores-hq', path: 'all.mov', fromFrame: 0, toFrame: 50, frames: 50, segments: 1, recoveries: 0 },
  ])
  expect(result.outputs.map((o) => o.path)).toEqual([result.video])
})

test('renders a flattened H.264 MP4 by default', async () => {
  const folder = await writeFolder(greekIslands())
  const result = await renderProject({ folder, range: { from: 0, to: 1 } })
  expect(result.video).toBe(path.join(result.dir, 'all.mp4'))
  expect((await ffprobe(result.video!)).codec_name).toBe('h264')
  expect(readManifest(result.manifest)).toMatchObject({ codec: 'h264', status: 'done' })
})

test('renders H.264', async () => {
  const folder = await writeFolder(greekIslands())
  const result = await renderProject({ folder, codec: 'h264', range: { from: 0, to: 1 } })
  expect(result.video).toBe(path.join(result.dir, 'all.mp4'))
  const stream = await ffprobe(result.video!)
  expect(stream.codec_name).toBe('h264')
  expect(stream.pix_fmt).toBe('yuv420p')
  expect(Number(stream.nb_frames)).toBe(25)
  expect([stream.color_space, stream.color_transfer, stream.color_primaries]).toEqual(['bt709', 'bt709', 'bt709'])
})

test('renders the starting snapshot', async () => {
  const original = greekIslands()
  const folder = await writeFolder(original)
  const before = await loadProject(folder)
  // A copy of the original, so its frames can still be previewed after `folder` changes.
  const originalFolder = await writeFolder(original)
  const jobId = startRenderJob({ folder, range: { from: 0, to: 4 } })
  await waitFor(jobId, (s) => (s.progress?.frame ?? 0) >= 5)
  // Move Rhodes far east and rename the project; both change every frame of a fresh render.
  await mutateProject(folder, (p) => ({
    ...p,
    name: 'Renamed mid-render',
    scenes: [
      {
        ...sceneOf(p),
        stops: sceneOf(p).stops.map((s) => (s.id === 'rhodes' ? { ...s, at: [34.0, 31.0] as [number, number] } : s)),
      },
    ],
  }))
  // The edit must land mid-render, or this test proves nothing.
  const during = renderStatus(jobId)
  expect(during.state).toBe('running')
  expect(during.progress!.frame).toBeLessThan(during.progress!.totalFrames)

  const status = await waitFor(jobId, (s) => s.state === 'done')
  expect(status.outputs).toEqual(status.result!.outputs)
  const manifest = readManifest(status.result!.manifest)
  expect(manifest.projectHash).toBe(projectHash(before))
  expect(manifest.name).toBe('Greek Islands')
  expect(status.dir).toBe(status.result!.dir)

  // The rendered last frame matches the original project's frame and not the edited one's.
  const last = 99
  const rendered = await videoFramePng(status.result!.video!, last)
  const fromOriginal = (await previewFrame({ folder: originalFolder, at: { frame: last }, width: 1920 })).png
  const fromEdited = (await previewFrame({ folder, at: { frame: last }, width: 1920 })).png
  const pixels = 1920 * 1080
  const diffOriginal = pixelDiff(rendered, fromOriginal)
  const diffEdited = pixelDiff(rendered, fromEdited)
  // Measured: 24 px from encoding against about 30 000 px for the moved route and Rhodes sign. The blank theme's
  // background is flat, so only the route, symbol and signs can differ.
  expect(diffOriginal, `${diffOriginal} px differ from the original`).toBeLessThan(pixels * 0.0005)
  expect(diffEdited, `${diffEdited} px differ from the edited project`).toBeGreaterThan(pixels * 0.005)
})

test('cancel stops the job', async () => {
  const folder = await writeFolder(greekIslands())
  const jobId = startRenderJob({ folder })
  const running = await waitFor(jobId, (s) => (s.progress?.frame ?? 0) >= 3)
  const dir = running.dir!
  // ffmpeg's output path is inside the render folder.
  expect((await run('pgrep', ['-f', dir])).stdout.trim()).not.toBe('')
  const status = await cancelRender(jobId)
  expect(status.state).toBe('cancelled')
  expect(renderStatus(jobId).state).toBe('cancelled')
  // pgrep exits 1 when nothing matches.
  await expect(run('pgrep', ['-f', dir])).rejects.toMatchObject({ code: 1 })
  const manifest = readManifest(path.join(dir, 'manifest.json'))
  expect(manifest.cancelled).toBe(true)
  expect(manifest.framesDone).toBeGreaterThanOrEqual(3)
  expect(manifest.status).toBe('cancelled')
  expect(manifest.outputs).toEqual([])
  // The unfinished clip is never reported as an output.
  expect(status.outputs).toBeUndefined()
})

test('a queued job reports running until it starts, and can be cancelled', async () => {
  const folder = await writeFolder(greekIslands())
  const first = startRenderJob({ folder, range: { from: 0, to: 1 } })
  const second = startRenderJob({ folder, range: { from: 0, to: 1 } })
  expect(renderStatus(second)).toEqual({ jobId: second, state: 'running' })
  expect((await cancelRender(second)).state).toBe('cancelled')
  const done = await waitFor(first, (s) => s.state === 'done')
  expect(done.result!.frames).toBe(25)
  expect(renderStatus(second).state).toBe('cancelled')
})

test('validation errors block the render', async () => {
  const one = greekIslands()
  const folder = await writeFolder({ ...one, scenes: [{ ...sceneOf(one), stops: sceneOf(one).stops.slice(0, 1), legs: [] }] })
  await expect(renderProject({ folder })).rejects.toThrow(/too-few-stops/)
  expect(existsSync(path.join(folder, 'renders'))).toBe(false)
  const jobId = startRenderJob({ folder })
  const status = await waitFor(jobId, (s) => s.state !== 'running')
  expect(status.state).toBe('failed')
  expect(status.error).toMatch(/too-few-stops/)
  expect(status.fix).toMatch(/set_stops/)
})

test('an unknown job id throws', () => {
  expect(() => renderStatus('nope')).toThrow(/job id/)
})

test('range maps seconds to frames, clamped to the clip', () => {
  expect(frameRange(undefined, 350, 25)).toEqual({ fromFrame: 0, toFrame: 350 })
  expect(frameRange({ from: 0.5, to: 2 }, 350, 25)).toEqual({ fromFrame: 12, toFrame: 50 })
  expect(frameRange({ from: 0, to: 0.28 }, 350, 25)).toEqual({ fromFrame: 0, toFrame: 7 })
  expect(frameRange({ from: -3, to: 99 }, 350, 25)).toEqual({ fromFrame: 0, toFrame: 350 })
  expect(frameRange({ from: 0, to: 1 }, 350, 30000 / 1001)).toEqual({ fromFrame: 0, toFrame: 30 })
  expect(() => frameRange({ from: 2, to: 1 }, 350, 25)).toThrow(/not a valid range/)
  expect(() => frameRange({ from: 20, to: 30 }, 350, 25)).toThrow(/no frames/)
})
