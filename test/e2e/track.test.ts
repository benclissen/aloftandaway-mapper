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
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { Project } from '../../src/core/index.js'
import type { RenderResult } from '../../src/render/render.js'
import { syntheticCruise } from '../fixtures/tracks.js'
import { expectGolden } from './helpers.js'

// Recorded tracks end to end: nothing here needs the network, since the scenes use the blank theme.
const run = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const MAIN = path.join(ROOT, 'dist', 'cli', 'main.js')

let tmp: string
let csv: string
let client: Client

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
      env: { ...(process.env as Record<string, string>), MAPPER_CACHE_DIR: path.join(tmp, 'cache') },
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
      env: { ...(process.env as Record<string, string>), MAPPER_CACHE_DIR: path.join(tmp, 'cache') },
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

test('import_track then preview draws the recorded line', async () => {
  const { folder, project } = await cruiseProject('draws')
  const legs = project.scenes[0]!.legs
  expect(legs.map((leg) => leg.mode)).toEqual(['track', 'track'])

  const validation = await call('validate_project', { folder })
  expect((validation.structuredContent as { errors: unknown[] }).errors).toEqual([])

  // Halfway the head is at the first port. Late on it is part-way down the second leg, which bends round the islands
  // (a straight line or a sea route would not), so that frame shows the line follows the log.
  const previews: [string, number][] = [['track-mid', 0.5], ['track-bend', 0.85]]
  for (const [golden, progress] of previews) {
    const frame = await call('preview_frame', { folder, at: { progress }, width: 960 })
    const image = frame.content.find((c) => c.type === 'image') as { data: string; mimeType: string } | undefined
    expect(image).toMatchObject({ mimeType: 'image/png' })
    expectGolden(golden, Buffer.from(image!.data, 'base64'))
  }
}, 120_000)

test('a fixed-length scene renders exactly its frames', async () => {
  const { folder } = await cruiseProject('length')
  await call('update_project', { folder, sceneSet: { timing: { length: 4 } } })

  const first = await renderToEnd(folder)
  expect(first.frames).toBe(100)
  expect(await countFrames(first.video!)).toBe(100)

  // A pause takes its time out of the travel, so the scene is as long as before.
  const got = await call('get_project', { folder })
  const stops = (got.structuredContent as { project: Project }).project.scenes[0]!.stops
  await call('update_project', { folder, ops: [{ op: 'update_stop', id: stops[1]!.id, changes: { pause: 1 } }] })
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
