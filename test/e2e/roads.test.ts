import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { ROAD_CREDIT_WRITTEN } from '../../src/core/index.js'
import { startFakeOsrm, type FakeOsrm } from '../helpers/fake-osrm.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const MAIN = path.join(ROOT, 'dist', 'cli', 'main.js')
const PNG_SIGNATURE = '89504e470d0a1a0a'

let tmp: string
let working: FakeOsrm
let down: FakeOsrm

beforeAll(async () => {
  expect(existsSync(MAIN), `${MAIN} is missing; run npm run build`).toBe(true)
  tmp = await mkdtemp(path.join(os.tmpdir(), 'mapper-roads-e2e-'))
  working = await startFakeOsrm((_profile, points) => {
    const first = points[0]!
    const last = points[points.length - 1]!
    const mid: [number, number] = [(first[0] + last[0]) / 2 + 0.01, (first[1] + last[1]) / 2]
    return { status: 200, body: { code: 'Ok', routes: [{ geometry: { coordinates: [first, mid, last] } }], waypoints: points.map((location) => ({ location })) } }
  })
  down = await startFakeOsrm(() => ({ status: 503, body: { code: 'Unavailable' } }))
})

afterAll(async () => {
  await working?.close()
  await down?.close()
  await rm(tmp, { recursive: true, force: true })
})

const textOf = (result: CallToolResult) => result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')

/** Runs `body` against a Mapper MCP process whose road router is `router`. */
async function withMapper(router: FakeOsrm, body: (call: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>) => Promise<void>): Promise<void> {
  const client = new Client({ name: 'e2e', version: '0.0.0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [MAIN, 'mcp'],
      env: { ...(process.env as Record<string, string>), MAPPER_CACHE_DIR: path.join(tmp, 'cache'), MAPPER_ROAD_ROUTER: router.url },
      stderr: 'inherit',
    }),
  )
  const call = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult
    expect(result.isError, `${name}: ${textOf(result)}`).toBeFalsy()
    return result
  }
  try {
    await body(call)
  } finally {
    await client.close()
  }
}

async function carProject(call: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>, folder: string): Promise<void> {
  await call('create_project', { folder, name: 'Roads' })
  await call('set_stops', {
    folder,
    legMode: 'land',
    stops: [
      { name: 'Frankfurt', at: [8.6821, 50.1109] },
      { name: 'Wurzburg', at: [9.9534, 49.7913] },
    ],
  })
  await call('update_project', { folder, sceneSet: { look: { theme: 'blank', symbol: 'car' } } })
}

type Warnings = { errors: unknown[]; warnings: { code?: string; message?: string }[] }

test('a car leg follows the road: no warnings, a cache file, and a frame', async () => {
  await withMapper(working, async (call) => {
    const folder = path.join(tmp, 'ok')
    await carProject(call, folder)
    const found = (await call('validate_project', { folder })).structuredContent as Warnings
    expect(found.errors).toEqual([])
    expect(found.warnings.filter((w) => /road/i.test(`${w.code} ${w.message}`))).toEqual([])
    expect(working.requests.length).toBeGreaterThan(0)
    expect(working.requests[0]).toMatch(/^\/car\//)

    const saved = JSON.parse(await readFile(path.join(folder, '.mapper', 'roads.json'), 'utf8')) as { paths: Record<string, { status: string }> }
    expect(Object.values(saved.paths).map((p) => p.status)).toEqual(['ok'])

    const frame = await call('preview_frame', { folder, at: { progress: 0.5 }, width: 480 })
    const image = frame.content.find((c) => c.type === 'image') as { data: string; mimeType: string } | undefined
    expect(image).toMatchObject({ mimeType: 'image/png' })
    expect(Buffer.from(image!.data, 'base64').subarray(0, 8).toString('hex')).toBe(PNG_SIGNATURE)
  })
}, 90_000)

test('a render with a car leg writes the road credit', async () => {
  await withMapper(working, async (call) => {
    const folder = path.join(tmp, 'render')
    await carProject(call, folder)
    const started = (await call('render', { folder, range: { from: 0, to: 0.2 } })).structuredContent as { data?: { jobId: string }; jobId?: string }
    const jobId = started.data?.jobId ?? started.jobId!
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
    expect(textOf(status)).toContain(ROAD_CREDIT_WRITTEN)
    const dirs = await readdir(path.join(folder, 'renders'))
    const manifest = JSON.parse(await readFile(path.join(folder, 'renders', dirs[0]!, 'manifest.json'), 'utf8')) as { credit: string }
    expect(manifest.credit).toContain(ROAD_CREDIT_WRITTEN)
  })
}, 180_000)

test('a router that answers 503 gives a road-offline warning', async () => {
  await withMapper(down, async (call) => {
    const folder = path.join(tmp, 'down')
    await carProject(call, folder)
    const found = (await call('validate_project', { folder })).structuredContent as Warnings
    expect(found.errors).toEqual([])
    expect(down.requests.length).toBeGreaterThan(0)
    expect(found.warnings.map((w) => w.code)).toContain('road-offline')
  })
}, 90_000)
