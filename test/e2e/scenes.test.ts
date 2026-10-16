import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { PNG } from 'pngjs'
import { afterAll, beforeAll, expect, test } from 'vitest'
import {
  applyPatch, buildRoute, buildTimeline, fpsValue, joinCredit, MAP_CREDIT, SATELLITE_CREDIT_WRITTEN,
  type Project, type Scene,
} from '../../src/core/index.js'
import { frameTime } from '../../src/render/fcpxml.js'
import { findFcpxmlDtd, validateFcpxml } from '../../src/render/fcpxml-validation.js'
import { closePreviews, previewFrame } from '../../src/render/preview.js'
import { renderProject, type RenderResult } from '../../src/render/render.js'
import { getServer } from '../../src/server/server.js'
import { createProject, saveProject } from '../../src/server/store.js'
import { twoScenes } from '../fixtures/projects.js'
import { frameTimestamps, pixelDiff } from './helpers.js'

const run = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const MAIN = path.join(ROOT, 'dist', 'cli', 'main.js')
let tempDir: string
const previousCacheDir = process.env.MAPPER_CACHE_DIR

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'mapper-scenes-'))
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

/** `twoScenes()` at 1080p, 25 fps, with short timings and no pauses: Drive of 40 frames (1.6 s), Sail of 50 (2 s). */
function shortTwoScenes(): Project {
  const project = twoScenes()
  project.scenes[0]!.timing = { holdStart: 0.4, travel: 0.8, holdEnd: 0.4 }
  project.scenes[1]!.timing = { holdStart: 0.4, travel: 1.2, holdEnd: 0.4 }
  for (const scene of project.scenes) scene.stops = scene.stops.map((stop) => ({ ...stop, pause: 0 }))
  return project
}
/** Mean colour distance (RGB, 0 to 441) the styles test needs between aloftandaway and satellite. */
const THRESHOLD = 20
const DRIVE_FRAMES = 40
const SAIL_FRAMES = 50

function readManifest(file: string): Record<string, any> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>
}

/** Frames ffmpeg decodes from the file, not the count its header claims. */
async function countFrames(file: string): Promise<number> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file])
  return Number(stdout.trim())
}

async function streamDuration(file: string): Promise<number> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', file])
  return Number(stdout.trim())
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

/** Mean red, green and blue of a PNG. */
function meanColour(png: Buffer): [number, number, number] {
  const { data } = PNG.sync.read(png)
  const sum = [0, 0, 0]
  for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) sum[c]! += data[i + c]!
  const pixels = data.length / 4
  return [sum[0]! / pixels, sum[1]! / pixels, sum[2]! / pixels]
}

for (const encoder of [undefined, 'libx264'] as const) {
  test(`the joined clip has even frame timing across the cut (${encoder ?? 'picked encoder'})`, async () => {
    const folder = await writeFolder(shortTwoScenes())
    const result = await renderProject({ folder, h264Encoder: encoder })
    const total = DRIVE_FRAMES + SAIL_FRAMES
    expect(result.frames).toBe(total)
    expect(result.outputs.map((o) => o.segments)).toEqual([2])

    const times = await frameTimestamps(result.video!)
    expect(times.length).toBe(total)
    const step = result.fps.den / result.fps.num
    const steps = times.slice(1).map((t, i) => t - times[i]!)
    // ffprobe prints microseconds, so two rounded stamps differ from the true step by up to 1 µs.
    const worst = Math.max(...steps.map((s) => Math.abs(s - step)))
    expect(worst, `worst step error ${worst} s over ${steps.length} steps`).toBeLessThanOrEqual(1e-6 + 1e-9)

    expect(await countFrames(result.video!)).toBe(total)
    expect(await streamDuration(result.video!)).toBeCloseTo(total / fpsValue(result.fps), 3)
  }, 120_000)
}

const dtd = await findFcpxmlDtd()

/** The text of `<tag ...>...</tag>` blocks, in order. */
function blocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}[ >][\\s\\S]*?</${tag}>`, 'g'))].map((m) => m[0])
}

test.skipIf(!dtd)('a layered two-scene export places the scenes back to back', async () => {
  const project = shortTwoScenes()
  const folder = await writeFolder(project)
  const result = await renderProject({ folder, layers: ['map', 'route', 'signs'] })
  expect(result.fcpxmlValidation).toBe('passed')
  await expect(validateFcpxml(result.fcpxml!)).resolves.toBe('passed')
  const xml = readFileSync(result.fcpxml!, 'utf8')

  // One compound clip per scene.
  const media = blocks(xml, 'media')
  expect(media.map((m) => /<media [^>]*name="([^"]*)"/.exec(m)![1])).toEqual(['Two Scenes · Drive', 'Two Scenes · Sail'])

  // The project's spine has them back to back.
  const spine = blocks(blocks(xml, 'project')[0]!, 'spine')[0]!
  const clips = [...spine.matchAll(/<ref-clip [^>]*>/g)].map((m) => m[0])
  expect(clips.map((c) => /offset="([^"]*)"/.exec(c)![1])).toEqual(['0s', frameTime(DRIVE_FRAMES, project.output.fps)])
  expect(clips.map((c) => /name="([^"]*)"/.exec(c)![1])).toEqual(['Two Scenes · Drive', 'Two Scenes · Sail'])

  // Each compound clip has markers at its own scene's arrivals, counted from that scene's frame 0.
  project.scenes.forEach((scene: Scene, i) => {
    const arrivals = buildTimeline(scene, project.output.fps, buildRoute(scene)).arrivals
    const markers = [...media[i]!.matchAll(/<marker [^>]*>/g)].map((m) => m[0])
    expect(markers.map((m) => /start="([^"]*)"/.exec(m)![1])).toEqual(arrivals.map((a) => frameTime(a.frame, project.output.fps)))
    expect(markers.map((m) => /value="([^"]*)"/.exec(m)![1])).toEqual(scene.stops.map((s) => s.name))
  })

  // Each scene's three layers hold that scene's frames.
  expect(result.scenes.map((s) => s.name)).toEqual(['Drive', 'Sail'])
  for (const [scene, frames] of [[result.scenes[0]!, DRIVE_FRAMES], [result.scenes[1]!, SAIL_FRAMES]] as const) {
    for (const layer of ['map', 'route', 'signs'] as const) {
      expect(await countFrames(scene.layers[layer]), `${scene.name} ${layer}`).toBe(frames)
    }
  }
}, 180_000)

test('a range across the cut renders the end of one scene and the start of the next', async () => {
  const project = shortTwoScenes()
  const folder = await writeFolder(project)
  // Seconds 1.2 to 2.4 are frames 30 to 60: the last 10 frames of Drive and the first 20 of Sail.
  const result = await renderProject({ folder, range: { from: 1.2, to: 2.4 } })
  expect(result.frames).toBe(30)
  expect(await countFrames(result.video!)).toBe(30)
  expect(result.sceneStarts.map((s) => [s.position, s.seconds])).toEqual([[1, 0], [2, 0.4]])
  const manifest = readManifest(result.manifest)
  expect(manifest.totalFrames).toBe(30)
  expect(manifest.scenes.map((s: any) => [s.position, s.range, s.offsetFrame])).toEqual([
    [1, { fromFrame: 30, toFrame: 40 }, 0],
    [2, { fromFrame: 0, toFrame: 20 }, 10],
  ])

  // The clip's frame 9 is Drive's last frame and frame 10 is Sail's first.
  const width = 1920
  const pixels = width * 1080
  const [driveEnd, sailStart] = [
    (await previewFrame({ folder, scene: 1, at: { frame: DRIVE_FRAMES - 1 }, width })).png,
    (await previewFrame({ folder, scene: 2, at: { frame: 0 }, width })).png,
  ]
  expect(pixelDiff(await videoFramePng(result.video!, 9), driveEnd)).toBeLessThan(pixels * 0.0005)
  expect(pixelDiff(await videoFramePng(result.video!, 10), sailStart)).toBeLessThan(pixels * 0.0005)
  // The two scenes look different, so the cut is really there.
  expect(pixelDiff(driveEnd, sailStart)).toBeGreaterThan(pixels * 0.0005)
}, 120_000)

test("an unpicked empty scene doesn't block a render", async () => {
  const project = applyPatch(shortTwoScenes(), { ops: [{ op: 'add_scene', name: 'Empty' }] })
  expect(project.scenes.map((s) => s.stops.length)).toEqual([3, 4, 0])
  const folder = await writeFolder(project)

  const result = await renderProject({ folder, scenes: [1, 2] })
  expect(result.frames).toBe(DRIVE_FRAMES + SAIL_FRAMES)
  expect(result.sceneStarts.map((s) => s.name)).toEqual(['Drive', 'Sail'])
  expect(readManifest(result.manifest).status).toBe('done')

  await expect(renderProject({ folder })).rejects.toThrow(/too-few-stops/)
  await expect(renderProject({ folder, scenes: [3] })).rejects.toThrow(/too-few-stops/)
}, 120_000)

const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')

test('MCP: add a scene, fill it, preview it and render joined', async () => {
  const client = new Client({ name: 'e2e', version: '0.0.0' })
  expect(existsSync(MAIN), `${MAIN} is missing; run npm run build`).toBe(true)
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [MAIN, 'mcp'],
    env: { ...(process.env as Record<string, string>), MAPPER_CACHE_DIR: path.join(tempDir, 'mcp-cache') },
    stderr: 'inherit',
  }))
  const call = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult
    expect(result.isError, `${name}: ${textOf(result)}`).toBeFalsy()
    return result
  }
  try {
    const folder = path.join(tempDir, 'Mcp Scenes')
    await call('create_project', { folder, name: 'Mcp Scenes' })
    await call('set_stops', { folder, stops: [{ name: 'Piraeus', at: [23.6466, 37.942] }, { name: 'Mykonos', at: [25.3289, 37.4467] }] })
    await call('update_project', {
      folder,
      set: { output: { height: 1080 } },
      sceneSet: { look: { theme: 'blank' }, timing: { holdStart: 0.4, travel: 0.8, holdEnd: 0.4 } },
    })

    const added = await call('update_project', { folder, ops: [{ op: 'add_scene', name: 'Drive', copyLookFrom: 1 }] })
    expect(textOf(added)).toContain('Scenes: 1 Mcp Scenes, 2 Drive.')
    await call('set_stops', { folder, scene: 2, stops: [{ name: 'Nice', at: [7.262, 43.7102] }, { name: 'Cannes', at: [7.0174, 43.5528] }] })

    const sheet = await call('preview_contact_sheet', { folder, scene: 2, count: 4, width: 640 })
    expect(sheet.content.find((c) => c.type === 'image')).toMatchObject({ mimeType: 'image/png' })

    const started = await call('render', { folder })
    const { jobId } = started.structuredContent as { jobId: string }
    const deadline = Date.now() + 120_000
    let status: CallToolResult
    for (;;) {
      status = await call('render_status', { jobId })
      const state = (status.structuredContent as { state: string }).state
      if (state === 'done') break
      expect(state, textOf(status)).toBe('running')
      expect(Date.now(), 'render did not finish in time').toBeLessThan(deadline)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    const text = textOf(status)
    expect(text).toMatch(/Scene 1 · Mcp Scenes starts at 00:00:00/)
    // Scene 1 is 40 frames, so scene 2 starts at 1.6 s.
    expect(text).toMatch(/Scene 2 · Drive starts at 00:01:15/)
    const result = (status.structuredContent as { result: RenderResult }).result
    expect(result.frames).toBe(80)
    expect(result.sceneStarts.map((s) => [s.position, s.name, s.seconds])).toEqual([[1, 'Mcp Scenes', 0], [2, 'Drive', 1.6]])
    expect(await countFrames(result.video!)).toBe(80)
  } finally {
    await client.close()
  }
}, 180_000)

test.skipIf(process.env.MAPPER_NET !== '1')('scenes in different styles join cleanly (MAPPER_NET only)', async () => {
  // Both scenes cover the same route, so a difference between their frames comes from the style alone.
  const project = shortTwoScenes()
  const [drive, sail] = project.scenes as [Scene, Scene]
  project.scenes[0] = { ...structuredClone(sail), id: drive.id, name: drive.name }
  project.scenes[0]!.look.theme = 'aloftandaway'
  project.scenes[1]!.look.theme = 'satellite'
  const folder = await writeFolder(project)
  const result = await renderProject({ folder })
  const total = 2 * SAIL_FRAMES
  expect(result.frames).toBe(total)
  expect(await countFrames(result.video!)).toBe(total)

  const manifest = readManifest(result.manifest)
  expect(manifest.credit).toBe(joinCredit([MAP_CREDIT, SATELLITE_CREDIT_WRITTEN]))
  expect(manifest.credit).toContain('OpenStreetMap')
  expect(manifest.credit).toContain('EOxCloudless')
  expect(manifest.credit).toContain('2016')

  // The same moment of each scene, as the joined clip has it and as a preview of the scene alone draws it.
  const frame = 5
  const joined = [await videoFramePng(result.video!, frame), await videoFramePng(result.video!, SAIL_FRAMES + frame)].map(meanColour)
  const alone = [1, 2].map(async (scene) => meanColour((await previewFrame({ folder, scene, at: { frame }, width: 1920 })).png))
  const [first, second] = await Promise.all(alone)
  const distance = (a: number[], b: number[]) => Math.hypot(...a.map((c, i) => c - b[i]!))
  const apart = distance(joined[0]!, joined[1]!)
  const measured = `joined ${joined.map((c) => c.map(Math.round))}, previews ${[first, second].map((c) => c!.map(Math.round))}`
  process.stderr.write(`styles test: aloftandaway vs satellite mean colour distance ${apart.toFixed(1)} (${measured})\n`)
  expect(apart, measured).toBeGreaterThan(THRESHOLD)
  // Each half of the joined clip is the style its scene asked for.
  expect(distance(joined[0]!, first!), measured).toBeLessThan(THRESHOLD / 4)
  expect(distance(joined[1]!, second!), measured).toBeLessThan(THRESHOLD / 4)
}, 180_000)
