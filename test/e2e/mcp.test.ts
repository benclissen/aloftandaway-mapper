import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, expect, test } from 'vitest'

const run = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const MAIN = path.join(ROOT, 'dist', 'cli', 'main.js')
const PNG_SIGNATURE = '89504e470d0a1a0a'

let tmp: string

beforeAll(async () => {
  expect(existsSync(MAIN), `${MAIN} is missing; run npm run build`).toBe(true)
  tmp = await mkdtemp(path.join(os.tmpdir(), 'mapper-mcp-e2e-'))
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const childEnv = () => ({ ...(process.env as Record<string, string>), MAPPER_CACHE_DIR: path.join(tmp, 'cache') })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const STOPS = [
  { name: 'Piraeus', at: [23.6466, 37.942] },
  { name: 'Mykonos', at: [25.3289, 37.4467] },
  { name: 'Santorini', at: [25.4317, 36.4166], pause: 1 },
  { name: 'Rhodes', at: [28.2278, 36.451] },
]

function textOf(result: CallToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
}

function expectImage(result: CallToolResult): void {
  const image = result.content.find((c) => c.type === 'image')
  expect(image, textOf(result)).toBeDefined()
  expect(image).toMatchObject({ mimeType: 'image/png' })
  expect(Buffer.from((image as { data: string }).data, 'base64').subarray(0, 8).toString('hex')).toBe(PNG_SIGNATURE)
}

test('agent flow end to end', async () => {
  const client = new Client({ name: 'e2e', version: '0.0.0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [MAIN, 'mcp'], env: childEnv(), stderr: 'inherit' }))
  const call = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult
    expect(result.isError, `${name}: ${textOf(result)}`).toBeFalsy()
    return result
  }

  try {
    const folder = path.join(tmp, 'Café Tour')
    await call('create_project', { folder, name: 'Café Tour' })
    await call('set_stops', { folder, stops: STOPS })
    const updated = await call('update_project', { folder, set: { output: { height: 1080 } }, sceneSet: { look: { theme: 'blank' } } })
    expect((updated.structuredContent as { project: { output: { height: number } } }).project.output.height).toBe(1080)

    const validation = await call('validate_project', { folder })
    expect((validation.structuredContent as { errors: unknown[] }).errors).toEqual([])

    const frame = await call('preview_frame', { folder, at: { progress: 0.5 }, width: 480 })
    expectImage(frame)
    expect(frame.structuredContent).toMatchObject({ frame: expect.any(Number), path: expect.stringContaining('.mapper') })

    const sheet = await call('preview_contact_sheet', { folder, count: 4, width: 1280 })
    expectImage(sheet)

    const studio = await call('open_studio', { folder })
    const { url } = studio.structuredContent as { url: string }
    expect((await fetch(url)).status).toBe(200)

    const started = await call('render', { folder, range: { from: 0, to: 2 } })
    const { jobId, dir } = started.structuredContent as { jobId: string; dir?: string }
    expect(dir).toContain(path.join(folder, 'renders'))

    const deadline = Date.now() + 120_000
    let status: CallToolResult
    for (;;) {
      status = await call('render_status', { jobId })
      const state = (status.structuredContent as { state: string }).state
      if (state === 'done') break
      expect(state, textOf(status)).toBe('running')
      expect(Date.now(), 'render did not finish in time').toBeLessThan(deadline)
      await sleep(500)
    }
    expect(textOf(status)).toContain('Credit required: © OpenStreetMap contributors · OpenMapTiles · OpenFreeMap (burned in)')
    // Some clients show the model only structuredContent, so the credit must be there too.
    expect((status.structuredContent as { summary: string }).summary).toBe(textOf(status))

    const { video } = (status.structuredContent as { result: { video: string } }).result
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', video])
    const stream = (JSON.parse(stdout) as { streams: Record<string, string>[] }).streams[0]!
    expect(Number(stream.nb_frames)).toBe(50)
  } finally {
    await client.close()
  }
})

test('a layered render returns the FCPXML and three layers', async () => {
  const client = new Client({ name: 'e2e', version: '0.0.0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [MAIN, 'mcp'], env: childEnv(), stderr: 'inherit' }))
  const call = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult
    expect(result.isError, `${name}: ${textOf(result)}`).toBeFalsy()
    return result
  }
  try {
    const folder = path.join(tmp, 'Layered')
    await call('create_project', { folder, name: 'Layered' })
    await call('set_stops', { folder, stops: STOPS })
    await call('update_project', { folder, set: { output: { height: 1080 } }, sceneSet: { look: { theme: 'blank' } } })

    const bad = (await client.callTool({ name: 'render', arguments: { folder, layers: ['all', 'preview'] } })) as CallToolResult
    expect(bad.isError).toBe(true)
    expect(existsSync(path.join(folder, 'renders'))).toBe(false)

    const started = await call('render', { folder, layers: ['map', 'route', 'signs'], range: { from: 0, to: 2 } })
    const { jobId } = started.structuredContent as { jobId: string }
    const deadline = Date.now() + 180_000
    let status: CallToolResult
    for (;;) {
      status = await call('render_status', { jobId })
      const state = (status.structuredContent as { state: string }).state
      if (state === 'done') break
      expect(state, textOf(status)).toBe('running')
      expect(Date.now(), 'render did not finish in time').toBeLessThan(deadline)
      await sleep(500)
    }
    const text = textOf(status)
    expect(text).toContain('Credit required: © OpenStreetMap contributors · OpenMapTiles · OpenFreeMap (burned in)')
    expect(text).not.toContain('undefined')
    const result = (status.structuredContent as { result: { video?: string; fcpxml: string; fcpxmlValidation: string; outputs: { layer: string; path: string }[] } }).result
    expect(result.video).toBeUndefined()
    expect(text).toContain(`FCPXML: ${result.fcpxml}`)
    expect(text).toContain(result.fcpxmlValidation === 'passed' ? 'validated against the Final Cut Pro DTD' : 'validation was skipped')
    expect(result.outputs.map((o) => o.layer)).toEqual(['map', 'route', 'signs'])
    const xml = await readFile(result.fcpxml, 'utf8')
    for (const output of result.outputs) {
      expect(text).toContain(output.path)
      expect(xml).toContain(pathToFileURL(output.path).href)
      const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_streams', '-of', 'json', output.path])
      expect(Number((JSON.parse(stdout) as { streams: Record<string, string>[] }).streams[0]!.nb_read_frames)).toBe(50)
    }
  } finally {
    await client.close()
  }
})

test('stdout carries only protocol', async () => {
  const folder = path.join(tmp, 'Pure')
  const child = spawn(process.execPath, [MAIN, 'mcp'], { env: childEnv(), stdio: ['pipe', 'pipe', 'inherit'] })
  const chunks: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
  const exited = new Promise<number | null>((resolve) => child.on('close', resolve))

  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`)
  let id = 0
  const request = (method: string, params: object) => send({ jsonrpc: '2.0', id: ++id, method, params })
  const tool = (name: string, args: object) => request('tools/call', { name, arguments: args })

  request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0.0.0' } })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  request('tools/list', {})
  tool('create_project', { folder, name: 'Pure' })
  tool('set_stops', { folder, stops: STOPS })
  tool('open_studio', { folder })
  tool('get_project', { folder: 'relative' })
  const requests = id

  // Wait for every reply, then end stdin. The child must clean up and exit by itself.
  const replied = () => Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean).length
  for (let waited = 0; replied() < requests; waited += 50) {
    expect(waited, 'the server did not answer in time').toBeLessThan(20_000)
    await sleep(50)
  }
  child.stdin.end()
  expect(await exited).toBe(0)

  const lines = Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean)
  expect(lines.length).toBe(requests)
  for (const line of lines) {
    const message = JSON.parse(line) as { jsonrpc: string; id?: number; result?: unknown }
    expect(message.jsonrpc).toBe('2.0')
    expect(message.id).toBeTypeOf('number')
  }
}, 60_000)

/** Pids of processes whose command line contains `needle`. Empty when there are none. */
async function pgrep(needle: string): Promise<string[]> {
  try {
    return (await run('pgrep', ['-f', needle])).stdout.split('\n').filter(Boolean)
  } catch (e) {
    if ((e as { code?: number }).code === 1) return []
    throw e
  }
}

test.each(['SIGTERM', 'SIGHUP', 'SIGINT'] as const)('%s during a render cancels it and leaves no ffmpeg or Chrome', async (signal) => {
  const folder = path.join(tmp, `Signal-${signal}`)
  // Chrome's profile lives under TMPDIR, so this folder's path picks out this child's Chrome and nothing else.
  const childTmp = path.join(tmp, `child-tmp-${signal}`)
  await mkdir(childTmp)
  const child = spawn(process.execPath, [MAIN, 'mcp'], {
    env: { ...childEnv(), TMPDIR: childTmp },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const exited = new Promise<number | null>((resolve) => child.on('close', resolve))

  const waiting = new Map<number, (message: { result?: CallToolResult }) => void>()
  let buffered = ''
  child.stdout.setEncoding('utf8').on('data', (text: string) => {
    buffered += text
    for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
      const message = JSON.parse(buffered.slice(0, end)) as { id?: number; result?: CallToolResult }
      buffered = buffered.slice(end + 1)
      if (message.id !== undefined) waiting.get(message.id)?.(message)
    }
  })
  let id = 0
  const rpc = (method: string, params: object) =>
    new Promise<{ result?: CallToolResult }>((resolve) => {
      waiting.set(++id, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  const call = async (name: string, args: object) => {
    const result = (await rpc('tools/call', { name, arguments: args })).result!
    expect(result.isError, `${name}: ${textOf(result)}`).toBeFalsy()
    return result.structuredContent as Record<string, any>
  }

  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0.0.0' } })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    await call('create_project', { folder, name: signal, output: { height: 1080 } })
    await call('set_stops', { folder, stops: STOPS })
    await call('update_project', { folder, sceneSet: { look: { theme: 'blank' }, timing: { holdStart: 1, travel: 4, holdEnd: 1 } } })
    const { jobId, dir } = await call('render', { folder, codec: 'h264' })
    expect(dir).toBeTypeOf('string')

    for (let waited = 0; !(await call('render_status', { jobId })).progress; waited += 100) {
      expect(waited, 'the render never reported progress').toBeLessThan(60_000)
      await sleep(100)
    }
    // Both are running now.
    expect((await pgrep(dir)).length, 'ffmpeg should be running').toBeGreaterThan(0)
    expect((await pgrep(childTmp)).length, 'Chrome should be running').toBeGreaterThan(0)

    child.kill(signal)
    const timedOut = Symbol('timed out')
    const code = await Promise.race([exited, sleep(20_000).then(() => timedOut)])
    expect(code, 'the server did not exit within 20 s').toBe(0)

    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>
    expect(manifest.cancelled).toBe(true)
    expect(await pgrep(dir), 'ffmpeg is still running').toEqual([])
    expect(await pgrep(childTmp), 'Chrome is still running').toEqual([])
  } finally {
    child.kill('SIGKILL')
  }
}, 120_000)
