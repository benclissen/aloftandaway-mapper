import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { PNG } from 'pngjs'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildRoute, buildTimeline, cameraAt, layoutSize, slicePath, TILE_SIZE, toXY, type LngLat, type Project } from '../../src/core/index.js'
import type { RenderResult } from '../../src/render/render.js'
import { readTrackPaths } from '../../src/server/tracks.js'
import { syntheticCruise } from '../fixtures/tracks.js'
import { expectGolden } from './helpers.js'

// Recorded tracks end to end: nothing here needs the network, since the scenes use the blank theme.
const run = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const MAIN = path.join(ROOT, 'dist', 'cli', 'main.js')

let tmp: string
let csv: string
let client: Client

/** Unless the run is allowed the network, any tile fetch goes to a dead port, so a stray one fails instead of passing quietly. */
const NO_NETWORK: Record<string, string> = process.env.MAPPER_NET === '1' ? {} : { MAPPER_TILE_UPSTREAM: 'http://127.0.0.1:9' }

beforeAll(async () => {
  expect(existsSync(MAIN), `${MAIN} is missing; run npm run build`).toBe(true)
  tmp = await mkdtemp(path.join(os.tmpdir(), 'mapper-track-e2e-'))
  csv = path.join(tmp, 'cruise.csv')
  await writeFile(csv, syntheticCruise().csv)
  client = new Client({ name: 'e2e', version: '0.0.0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [MAIN, 'mcp'],
      env: { ...(process.env as Record<string, string>), ...NO_NETWORK, MAPPER_CACHE_DIR: path.join(tmp, 'cache') },
      stderr: 'inherit',
    }),
  )
})

afterAll(async () => {
  await client?.close()
  await rm(tmp, { recursive: true, force: true })
})

const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult
  expect(result.isError, `${name}: ${textOf(result)}`).toBeFalsy()
  return result
}

/** Runs the compiled CLI, as an agent without MCP would. */
function mapper(...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args], {
      env: { ...(process.env as Record<string, string>), ...NO_NETWORK, MAPPER_CACHE_DIR: path.join(tmp, 'cache') },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d))
    child.stderr.on('data', (d: Buffer) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** A new project on the blank theme at 1080p, with the synthetic cruise imported through the CLI. */
async function cruiseProject(name: string): Promise<{ folder: string; project: Project; trackFile: string }> {
  const folder = path.join(tmp, name)
  await call('create_project', { folder, name })
  const imported = await mapper('import-track', '--json', JSON.stringify({ folder, path: csv }))
  expect(imported.code, imported.stderr).toBe(0)
  const out = JSON.parse(imported.stdout) as { import: { file: string }; project: Project }
  await call('update_project', { folder, set: { output: { height: 1080 } }, sceneSet: { look: { theme: 'blank' } } })
  return { folder, project: out.project, trackFile: path.join(folder, out.import.file) }
}

/** Starts a render and waits for it to finish. */
async function renderToEnd(folder: string): Promise<RenderResult> {
  const started = await call('render', { folder })
  const { jobId } = started.structuredContent as { jobId: string }
  const deadline = Date.now() + 120_000
  for (;;) {
    const status = await call('render_status', { jobId })
    const state = (status.structuredContent as { state: string }).state
    if (state === 'done') return (status.structuredContent as { result: RenderResult }).result
    expect(state, textOf(status)).toBe('running')
    expect(Date.now(), 'render did not finish in time').toBeLessThan(deadline)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/** Frames ffmpeg decodes from the file, not the count its header claims. */
async function countFrames(file: string): Promise<number> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file])
  return Number(stdout.trim())
}

// Checking the drawn line against the log. A golden tolerates 0.5% of its pixels differing, which is more than the whole
// line, so on its own it would pass a straight-line fallback. These checks look for the line where the track goes and
// where it doesn't.

interface Expected {
  /** The line drawn up to the head, from the recorded track. */
  drawn: LngLat[]
  stops: LngLat[]
}

/** Where `folder`'s project draws the line on `frame`, and where its stops are. */
async function expectedGeometry(folder: string, frame: number): Promise<Expected> {
  const project = ((await call('get_project', { folder })).structuredContent as { project: Project }).project
  const scene = project.scenes[0]!
  const route = buildRoute(scene, await readTrackPaths(folder, project))
  const timeline = buildTimeline(scene, project.output.fps, route)
  return { drawn: slicePath(route, timeline.stateAt(frame).distance), stops: scene.stops.map((stop) => stop.at) }
}

/** The projection of `folder`'s project on `frame`, from lng/lat to px of a preview `width` px wide, and its frame count. */
async function projection(folder: string, frame: number, width: number): Promise<{ toPx(at: LngLat): [number, number]; frames: number }> {
  const project = ((await call('get_project', { folder })).structuredContent as { project: Project }).project
  const scene = project.scenes[0]!
  const route = buildRoute(scene, await readTrackPaths(folder, project))
  const timeline = buildTimeline(scene, project.output.fps, route)
  const shot = cameraAt(scene, project.output.aspect, route, timeline, frame)
  const layout = layoutSize(project.output.aspect)
  const ratio = width / layout.width
  const scale = TILE_SIZE * 2 ** shot.zoom
  const [cx, cy] = toXY(shot.center)
  return {
    frames: timeline.totalFrames,
    toPx: (at) => {
      const [x, y] = toXY(at)
      return [(layout.width / 2 + (x - cx) * scale) * ratio, (layout.height / 2 + (y - cy) * scale) * ratio]
    },
  }
}

const dist = (a: [number, number], b: [number, number]): number => Math.hypot(a[0] - b[0], a[1] - b[1])

function distToSegment(p: [number, number], a: [number, number], b: [number, number]): number {
  const len2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / len2))
  return dist(p, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])])
}

/** What `checkLine` found, in counts. */
interface LineCheck {
  /** Points of the drawn track on the second leg that are well off the straight chord between its stops. */
  bends: number
  /** Of those, how many have no line drawn within 3 px. */
  missing: number
  /** Points on the chord that are well away from the drawn track. */
  chord: number
  /** Of those, how many have line drawn within 2 px. */
  onChord: number
}

/**
 * Looks for the red line in `png` (a preview `width` px wide): at the second leg's bends, where the log departs from the
 * chord between its stops, and along that chord where the log is far from it. A leg that follows the log has line at the
 * first and none at the second. Points near a stop are skipped, since the stop's dot and label are there.
 */
function checkLine(png: Buffer, toPx: (at: LngLat) => [number, number], expected: Expected): LineCheck {
  const image = PNG.sync.read(png)
  const hasLine = ([x, y]: [number, number], radius: number): boolean => {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const px = Math.round(x) + dx
        const py = Math.round(y) + dy
        if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue
        const i = (py * image.width + px) * 4
        const [r, g, b] = [image.data[i]!, image.data[i + 1]!, image.data[i + 2]!]
        if (r - g > 50 && r - b > 50) return true
      }
    }
    return false
  }
  const stops = expected.stops.map(toPx)
  // A stop's dot, and its label, which sits above the dot and hides the line under it.
  const nearStop = (p: [number, number]) => stops.some((s) => dist(p, s) < 20 || (Math.abs(p[0] - s[0]) < 45 && p[1] - s[1] > -45 && p[1] - s[1] < 10))
  const drawn = expected.drawn.map(toPx)
  const at2 = expected.drawn.findIndex((p) => p[0] === expected.stops[1]![0] && p[1] === expected.stops[1]![1])
  expect(at2, 'the drawn line reaches stop 2').toBeGreaterThan(-1)
  const [s2, s3] = [stops[1]!, stops[2]!]
  const bends = drawn.slice(at2 + 1).filter((p) => distToSegment(p, s2, s3) > 12 && !nearStop(p))
  const chord: [number, number][] = []
  for (let t = 0.05; t < 0.96; t += 0.05) {
    const p: [number, number] = [s2[0] + (s3[0] - s2[0]) * t, s2[1] + (s3[1] - s2[1]) * t]
    if (!nearStop(p) && drawn.every((q, i) => i === 0 || distToSegment(p, drawn[i - 1]!, q) > 8)) chord.push(p)
  }
  return {
    bends: bends.length,
    missing: bends.filter((p) => !hasLine(p, 3)).length,
    chord: chord.length,
    onChord: chord.filter((p) => hasLine(p, 2)).length,
  }
}

async function previewPng(folder: string, frame: number, width: number): Promise<Buffer> {
  const result = await call('preview_frame', { folder, at: { frame }, width })
  const image = result.content.find((c) => c.type === 'image') as { data: string; mimeType: string } | undefined
  expect(image).toMatchObject({ mimeType: 'image/png' })
  return Buffer.from(image!.data, 'base64')
}

/** Frame `progress` of the way through the scene, as a preview at that progress would pick it. */
const frameAt = (frames: number, progress: number): number => Math.round(progress * (frames - 1))

test('import_track then preview draws the recorded line', async () => {
  const { folder, project } = await cruiseProject('draws')
  const legs = project.scenes[0]!.legs
  expect(legs.map((leg) => leg.mode)).toEqual(['track', 'track'])

  const validation = await call('validate_project', { folder })
  expect((validation.structuredContent as { errors: unknown[] }).errors).toEqual([])

  // Halfway the head is at the first port. Late on it is part-way down the second leg, which bends round the islands
  // (a straight line or a sea route would not), so that frame shows the line follows the log.
  const width = 960
  const { frames } = await projection(folder, 0, width)
  const bend = frameAt(frames, 0.85)
  expectGolden('track-mid', await previewPng(folder, frameAt(frames, 0.5), width))
  const png = await previewPng(folder, bend, width)
  expectGolden('track-bend', png)

  // The goldens allow more differing pixels than the line has, so they would pass a straight line. These checks don't.
  const found = checkLine(png, (await projection(folder, bend, width)).toPx, await expectedGeometry(folder, bend))
  expect(found.bends, 'the second leg has bends to look for').toBeGreaterThanOrEqual(3)
  expect(found.chord, 'the chord has stretches the log keeps off').toBeGreaterThanOrEqual(5)
  expect(found, 'the line is drawn at the bends').toMatchObject({ missing: 0 })
  expect(found, 'no line is drawn along the chord where the log is far from it').toMatchObject({ onChord: 0 })
}, 120_000)

test('the line check fails when the track is ignored', async () => {
  // The same checks as above, on projects that don't draw the track, against the track's geometry: they have to find the
  // bends missing. Without this, they could pass for the wrong reason.
  const width = 960
  const ignored = async (name: string, ignore: (folder: string, trackFile: string) => Promise<void>): Promise<LineCheck> => {
    const { folder, trackFile } = await cruiseProject(name)
    const frames = (await projection(folder, 0, width)).frames
    const bend = frameAt(frames, 0.85)
    const expected = await expectedGeometry(folder, bend)
    await ignore(folder, trackFile)
    return checkLine(await previewPng(folder, bend, width), (await projection(folder, bend, width)).toPx, expected)
  }

  // Legs switched to the plain mode: a smooth curve through the stops.
  const curved = await ignored('curved', async (folder) => {
    await call('update_project', { folder, ops: [0, 1].map((index) => ({ op: 'update_leg', index, changes: { mode: 'line' } })) })
  })
  expect(curved.missing).toBeGreaterThan(0)

  // The track file gone: the leg falls back to a straight line between its stops, along the chord.
  const straight = await ignored('straight', async (_folder, trackFile) => {
    await rm(trackFile)
  })
  expect(straight.missing).toBeGreaterThan(0)
  expect(straight.onChord).toBeGreaterThan(0)
}, 120_000)

test('a fixed-length scene renders exactly its frames', async () => {
  const { folder } = await cruiseProject('length')
  await call('update_project', { folder, sceneSet: { timing: { holdStart: 0.4, holdEnd: 0.4, length: 4 } } })

  const first = await renderToEnd(folder)
  expect(first.frames).toBe(100)
  expect(await countFrames(first.video!)).toBe(100)

  // A pause takes its time out of the travel, so the scene is as long as before.
  const got = await call('get_project', { folder })
  const before = (got.structuredContent as { project: Project }).project.scenes[0]!
  const stops = before.stops
  await call('update_project', { folder, ops: [{ op: 'update_stop', id: stops[1]!.id, changes: { pause: 1 } }] })
  const after = ((await call('get_project', { folder })).structuredContent as { project: Project }).project.scenes[0]!
  expect(after.stops[1]!.pause).toBe(1)
  // The pause came out of the travel, which is what keeps the length.
  expect(after.timing.travel).toBeCloseTo((before.timing.travel ?? 0) - 1, 6)
  const second = await renderToEnd(folder)
  expect(second.frames).toBe(100)
  expect(await countFrames(second.video!)).toBe(100)
}, 240_000)

test('render refuses a missing track', async () => {
  const { folder, trackFile } = await cruiseProject('missing')
  await rm(trackFile)

  const validation = await call('validate_project', { folder })
  const errors = (validation.structuredContent as { errors: { code?: string }[] }).errors
  expect(errors.map((e) => e.code)).toContain('track-missing')

  const refused = (await client.callTool({ name: 'render', arguments: { folder } })) as CallToolResult
  expect(refused.isError, textOf(refused)).toBe(true)
  expect(textOf(refused)).toContain('track-missing')
}, 120_000)
