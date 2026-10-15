import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { PNG } from 'pngjs'
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { Project } from '../../src/core/index.js'
import { cancelRender, renderStatus, startRenderJob, type RenderStatus } from '../../src/render/jobs.js'
import { closePreviews, previewFrame } from '../../src/render/preview.js'
import { renderProject, type RenderProgress, type RenderResult } from '../../src/render/render.js'
import { getServer } from '../../src/server/server.js'
import { createProject, loadProject, mutateProject, projectHash, saveProject } from '../../src/server/store.js'
import { greekIslands, sceneOf } from '../fixtures/projects.js'
import { pixelDiff } from './helpers.js'

const run = promisify(execFile)
let tempDir: string
const previousCacheDir = process.env.MAPPER_CACHE_DIR
const LAYERS = ['map', 'route', 'signs'] as const
const SLUG_DIR = '01-greek-islands'

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'mapper-layer-render-'))
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

/** Stream info with every frame decoded and counted. */
async function probe(file: string): Promise<Record<string, string | number>> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_streams', '-of', 'json', file])
  return (JSON.parse(stdout) as { streams: Record<string, string | number>[] }).streams[0]!
}

/** Frame `n` of `video` as an 8-bit RGBA PNG, converted back from Rec.709 limited range. */
async function rgbaFrame(video: string, n: number): Promise<Buffer> {
  const { stdout } = await run(
    'ffmpeg',
    ['-v', 'error', '-i', video, '-vf', `select=eq(n\\,${n}),scale=in_color_matrix=bt709:in_range=tv`, '-frames:v', '1',
      '-pix_fmt', 'rgba', '-f', 'image2pipe', '-c:v', 'png', '-'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  )
  return stdout
}

/** Pixels whose decoded alpha differs by more than 2 levels. */
function alphaDiff(a: Buffer, b: Buffer): number {
  const left = PNG.sync.read(a).data
  const right = PNG.sync.read(b).data
  expect(left.length).toBe(right.length)
  let differing = 0
  for (let i = 3; i < left.length; i += 4) if (Math.abs(left[i]! - right[i]!) > 2) differing++
  return differing
}

function readManifest(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

async function waitFor(jobId: string, done: (s: RenderStatus) => boolean, timeoutMs = 120_000): Promise<RenderStatus> {
  const start = Date.now()
  for (;;) {
    const status = renderStatus(jobId)
    if (done(status)) return status
    if (status.state !== 'running') throw new Error(`Job ended as ${status.state}: ${status.error ?? ''}`)
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for job ${jobId}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const PIXELS = 1920 * 1080

let clean: Promise<{ folder: string; result: RenderResult; progress: RenderProgress[] }> | undefined
/** A fault-free 2-second map/route/signs export of the blank Greek Islands fixture. */
function cleanExport(): Promise<{ folder: string; result: RenderResult; progress: RenderProgress[] }> {
  clean ??= (async () => {
    const folder = await writeFolder(greekIslands())
    const progress: RenderProgress[] = []
    const result = await renderProject({ folder, range: { from: 0, to: 2 }, layers: [...LAYERS], onProgress: (p) => progress.push(p) })
    return { folder, result, progress }
  })()
  return clean
}

/** The layer's frames match the fault-free export's, compared on decoded colour and alpha. */
async function expectSameLayerFrames(video: string, layer: (typeof LAYERS)[number], frames: number[]): Promise<void> {
  const { result } = await cleanExport()
  const reference = path.join(result.dir, SLUG_DIR, `${layer}.mov`)
  expect(Number((await probe(video)).nb_read_frames)).toBe(Number((await probe(reference)).nb_read_frames))
  for (const n of frames) {
    const [got, want] = [await rgbaFrame(video, n), await rgbaFrame(reference, n)]
    const alpha = alphaDiff(got, want)
    expect(alpha, `${layer} frame ${n}: ${alpha} px of alpha differ`).toBeLessThan(PIXELS * 0.0001)
    const diff = pixelDiff(got, want)
    expect(diff, `${layer} frame ${n}: ${diff} px differ`).toBeLessThan(PIXELS * 0.0001)
  }
}

test('exports map, route and signs as aligned ProRes layers', async () => {
  const { folder, result, progress } = await cleanExport()
  const hash = projectHash(await loadProject(folder))
  expect(result.projectHash).toBe(hash)
  expect(result.frames).toBe(50)
  expect(result.video).toBeUndefined()
  expect(readdirSync(result.dir).sort()).toEqual([SLUG_DIR, 'greek-islands.fcpxml', 'manifest.json'])
  expect(result.fcpxml).toBe(path.join(result.dir, 'greek-islands.fcpxml'))
  expect(readdirSync(path.join(result.dir, SLUG_DIR)).sort()).toEqual(['map.mov', 'route.mov', 'signs.mov'])
  expect(existsSync(path.join(result.dir, 'all.mov'))).toBe(false)

  expect(result.outputs.map((o) => o.layer)).toEqual([...LAYERS])
  const profiles = { map: 'HQ', route: '4444', signs: '4444' }
  for (const output of result.outputs) {
    expect(output.path).toBe(path.join(result.dir, SLUG_DIR, `${output.layer}.mov`))
    expect(path.isAbsolute(output.path)).toBe(true)
    expect([output.fromFrame, output.toFrame, output.frames]).toEqual([0, 50, 50])
    expect([output.segments, output.recoveries]).toEqual([1, 0])
    const stream = await probe(output.path)
    expect(stream.codec_name).toBe('prores')
    expect(stream.profile).toBe(profiles[output.layer as keyof typeof profiles])
    expect(Number(stream.nb_read_frames)).toBe(50)
    expect(stream.r_frame_rate).toBe('25/1')
  }

  const manifest = readManifest(result.manifest)
  expect(manifest.manifestVersion).toBe(2)
  expect(manifest.status).toBe('done')
  expect(manifest.projectHash).toBe(hash)
  expect(manifest.totalFrames).toBe(50)
  expect(manifest.completedWorkFrames).toBe(150)
  expect(manifest.totalWorkFrames).toBe(150)
  expect(manifest.scenes).toEqual([{ id: expect.any(String), name: 'Greek Islands', range: { fromFrame: 0, toFrame: 50 } }])
  const outputs = manifest.outputs as { path: string; fromFrame: number; toFrame: number; kind: string }[]
  expect(outputs.map((o) => [o.path, o.kind, o.fromFrame, o.toFrame])).toEqual([
    [`${SLUG_DIR}/map.mov`, 'prores-hq', 0, 50],
    [`${SLUG_DIR}/route.mov`, 'prores-4444', 0, 50],
    [`${SLUG_DIR}/signs.mov`, 'prores-4444', 0, 50],
  ])
  expect(manifest.fcpxml).toBe('greek-islands.fcpxml')
  expect(manifest.fcpxmlValidation).toBe(result.fcpxmlValidation)
  expect(['passed', 'skipped-no-fcp']).toContain(result.fcpxmlValidation)

  expect(progress.at(-1)).toMatchObject({ frame: 150, totalFrames: 150 })
  expect(progress.every((p) => p.totalFrames === 150)).toBe(true)
  for (let i = 1; i < progress.length; i++) expect(progress[i]!.frame).toBeGreaterThanOrEqual(progress[i - 1]!.frame)
  expect(new Set(progress.map((p) => p.layer))).toEqual(new Set(LAYERS))

  expect(result.scenes).toHaveLength(1)
  expect(result.scenes[0]).toMatchObject({
    name: 'Greek Islands',
    frames: 50,
    sourceRange: { fromFrame: 0, toFrame: 50 },
    layers: Object.fromEntries(LAYERS.map((l) => [l, path.join(result.dir, SLUG_DIR, `${l}.mov`)])),
    markers: [{ frame: 25, value: 'Piraeus' }],
  })
})

test('the FCPXML references the three finished layers, a range starting after frame zero, notes and a preview', async () => {
  const folder = await writeFolder({ ...greekIslands(), credit: 'description' })
  // Frames [12, 50): the Piraeus arrival at frame 25 lands at clip-local frame 13.
  const result = await renderProject({ folder, range: { from: 0.5, to: 2 }, layers: [...LAYERS, 'preview'] })
  expect(result.frames).toBe(38)
  expect(result.outputs.map((o) => o.request)).toEqual(['map', 'route', 'signs', 'preview'])
  expect(result.video).toBeUndefined()
  expect(result.preview).toBe(path.join(result.dir, 'preview.mp4'))
  expect(readdirSync(result.dir).sort()).toEqual([SLUG_DIR, 'greek-islands.fcpxml', 'manifest.json', 'preview.mp4'])
  for (const output of result.outputs) {
    const stream = await probe(output.path)
    expect(Number(stream.nb_read_frames), output.path).toBe(38)
    expect(stream.r_frame_rate, output.path).toBe('25/1')
  }
  expect((await probe(result.preview!)).codec_name).toBe('h264')

  const xml = readFileSync(result.fcpxml!, 'utf8')
  for (const layer of LAYERS) expect(xml).toContain(pathToFileURL(path.join(result.dir, SLUG_DIR, `${layer}.mov`)).href)
  expect(xml).not.toContain('preview.mp4')
  expect(xml).toContain('<note>© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap</note>')
  expect(xml).toContain('<marker start="13/25s" duration="1/25s" value="Piraeus"/>')
  expect(xml).toContain('duration="38/25s"')
  expect(result.scenes[0]).toMatchObject({ frames: 38, sourceRange: { fromFrame: 12, toFrame: 50 } })
  const manifest = readManifest(result.manifest)
  expect(manifest.status).toBe('done')
  expect(manifest.fcpxml).toBe('greek-islands.fcpxml')
})

test('a DTD failure keeps the videos and the .tmp XML but publishes no final XML', async () => {
  const folder = await writeFolder(greekIslands())
  let dir = ''
  const missingDtd = path.join(tempDir, 'missing.dtd')
  await expect(
    renderProject({ folder, range: { from: 0, to: 1 }, layers: [...LAYERS], fcpxmlDtdPath: missingDtd, onStart: (info) => (dir = info.dir) }),
  ).rejects.toThrow(/DTD is missing/)
  expect(readdirSync(dir).sort()).toEqual([SLUG_DIR, 'greek-islands.fcpxml.tmp', 'manifest.json'])
  expect(readdirSync(path.join(dir, SLUG_DIR)).sort()).toEqual(['map.mov', 'route.mov', 'signs.mov'])
  const manifest = readManifest(path.join(dir, 'manifest.json'))
  expect(manifest.status).toBe('failed')
  expect(manifest.error).toMatch(/DTD is missing/)
  expect(manifest.fcpxml).toBeUndefined()
  expect((manifest.outputs as unknown[]).length).toBe(3)
})

test('a render without layers is the legacy flattened clip', async () => {
  const folder = await writeFolder(greekIslands())
  const result = await renderProject({ folder, codec: 'prores', range: { from: 0, to: 1 } })
  expect(result.video).toBe(path.join(result.dir, 'all.mov'))
  expect(result.frames).toBe(25)
  expect(readdirSync(result.dir).sort()).toEqual(['all.mov', 'manifest.json'])
  expect(result.outputs).toEqual([
    { sceneId: expect.any(String), request: 'all', layer: 'all', kind: 'prores-hq', path: result.video, fromFrame: 0, toFrame: 25, frames: 25, segments: 1, recoveries: 0 },
  ])
  expect(result.scenes).toEqual([])
  expect(result.preview).toBeUndefined()
  const manifest = readManifest(result.manifest)
  expect(manifest).toMatchObject({ codec: 'prores', range: { fromFrame: 0, toFrame: 25 }, segments: 1, recoveries: 0, status: 'done' })
})

test('recovers route after map completes, matching a clean route', async () => {
  const folder = await writeFolder(greekIslands())
  const result = await renderProject({ folder, range: { from: 0, to: 2 }, layers: ['map', 'route'], faultLayer: 'route', faultAtFrame: 20 })
  const [map, route] = result.outputs
  expect([map!.segments, map!.recoveries]).toEqual([1, 0])
  expect([route!.segments, route!.recoveries]).toEqual([2, 1])
  expect(readdirSync(path.join(result.dir, SLUG_DIR)).sort()).toEqual(['map.mov', 'route.mov'])
  await expectSameLayerFrames(route!.path, 'route', [19, 20, 21])
})

test('drops a route frame captured after its context was lost', async () => {
  const folder = await writeFolder(greekIslands())
  const result = await renderProject({ folder, range: { from: 0, to: 2 }, layers: ['route'], faultLayer: 'route', faultAfterRenderFrame: 20 })
  const [route] = result.outputs
  expect([route!.segments, route!.recoveries]).toEqual([2, 1])
  await expectSameLayerFrames(route!.path, 'route', [19, 20, 21])
})

test('recovers when the first frame of a layer fails', async () => {
  const folder = await writeFolder(greekIslands())
  const result = await renderProject({ folder, range: { from: 0, to: 2 }, layers: ['signs'], faultLayer: 'signs', faultAtFrame: 0 })
  const [signs] = result.outputs
  // Nothing was written before the fault, so the only segment is the recovered one.
  expect([signs!.segments, signs!.recoveries]).toEqual([1, 1])
  expect(readdirSync(path.join(result.dir, SLUG_DIR))).toEqual(['signs.mov'])
  await expectSameLayerFrames(signs!.path, 'signs', [0, 1, 25])
})

test('cancelling during signs keeps the finished map and route', async () => {
  const folder = await writeFolder(greekIslands())
  const jobId = startRenderJob({ folder, range: { from: 0, to: 2 }, layers: [...LAYERS] })
  const running = await waitFor(jobId, (s) => s.progress?.layer === 'signs' && s.progress.frame > 100)
  expect(running.progress!.frame).toBeLessThan(150)
  expect(running.outputs?.map((o) => o.layer)).toEqual(['map', 'route'])
  const status = await cancelRender(jobId)
  expect(status.state).toBe('cancelled')
  const dir = status.dir!
  await expect(run('pgrep', ['-f', dir])).rejects.toMatchObject({ code: 1 })
  expect(status.outputs?.map((o) => o.path)).toEqual([path.join(dir, SLUG_DIR, 'map.mov'), path.join(dir, SLUG_DIR, 'route.mov')])
  for (const output of status.outputs!) expect(Number((await probe(output.path)).nb_read_frames)).toBe(50)
  expect(existsSync(path.join(dir, SLUG_DIR, 'signs.mov'))).toBe(false)
  expect(readdirSync(dir).filter((f) => f.endsWith('.fcpxml'))).toEqual([])
  const manifest = readManifest(path.join(dir, 'manifest.json'))
  expect(manifest.status).toBe('cancelled')
  expect((manifest.outputs as { layer: string }[]).map((o) => o.layer)).toEqual(['map', 'route'])
  // Map and route, plus whatever signs had reached.
  expect(manifest.completedWorkFrames).toBeGreaterThan(100)
  expect(manifest.completedWorkFrames).toBeLessThan(150)
  expect(manifest.fcpxml).toBeUndefined()
})

test('every pass renders the starting snapshot, and a queued job waits', async () => {
  const original = greekIslands()
  const folder = await writeFolder(original)
  const before = await loadProject(folder)
  const jobId = startRenderJob({ folder, range: { from: 0, to: 2 }, layers: [...LAYERS] })
  const queued = startRenderJob({ folder, range: { from: 0, to: 1 } })
  await waitFor(jobId, (s) => (s.outputs?.length ?? 0) >= 1)
  // Move Rhodes far east, rename Piraeus and the project. Every frame and the arrival marker would change.
  await mutateProject(folder, (p) => ({
    ...p,
    name: 'Renamed mid-render',
    scenes: [
      {
        ...sceneOf(p),
        stops: sceneOf(p).stops.map((s) =>
          s.id === 'rhodes' ? { ...s, at: [34.0, 31.0] as [number, number] } : s.id === 'piraeus' ? { ...s, name: 'Edited' } : s),
      },
    ],
  }))
  const during = renderStatus(jobId)
  expect(during.state).toBe('running')
  expect(during.outputs).toHaveLength(1)
  expect(renderStatus(queued)).toEqual({ jobId: queued, state: 'running' })

  const status = await waitFor(jobId, (s) => s.state === 'done')
  const result = status.result!
  expect(result.projectHash).toBe(projectHash(before))
  const manifest = readManifest(result.manifest)
  expect(manifest.projectHash).toBe(projectHash(before))
  expect(manifest.name).toBe('Greek Islands')
  expect(result.scenes[0]!.markers).toEqual([{ frame: 25, value: 'Piraeus' }])
  for (const layer of LAYERS) {
    await expectSameLayerFrames(path.join(result.dir, SLUG_DIR, `${layer}.mov`), layer, [49])
  }
  // The edit is big enough to show: a fresh preview of the edited project differs from the original. Measured about
  // 7900 px at this early frame, against under 200 px allowed above.
  const originalFolder = await writeFolder(original)
  const fromOriginal = (await previewFrame({ folder: originalFolder, at: { frame: 49 }, width: 1920 })).png
  const fromEdited = (await previewFrame({ folder, at: { frame: 49 }, width: 1920 })).png
  expect(pixelDiff(fromOriginal, fromEdited)).toBeGreaterThan(PIXELS * 0.002)

  const second = await waitFor(queued, (s) => s.state === 'done')
  expect(second.result!.frames).toBe(25)
})
