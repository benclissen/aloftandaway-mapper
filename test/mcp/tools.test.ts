import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createMcpServer } from '../../src/mcp/server.js'
import { TOOLS } from '../../src/mcp/tools.js'

const STOPS = [
  { name: 'Piraeus', at: [23.6466, 37.942] },
  { name: 'Mykonos', at: [25.3289, 37.4467] },
  { name: 'Santorini', at: [25.4317, 36.4166], pause: 1 },
  { name: 'Rhodes', at: [28.2278, 36.451] },
]

let tmp: string
let client: Client

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'mapper-mcp-'))
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await createMcpServer().connect(serverSide)
  client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(clientSide)
})

afterEach(async () => {
  await client.close()
  await rm(tmp, { recursive: true, force: true })
})

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult
}

function text(result: CallToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
}

describe('tools', () => {
  test('lists the eleven stage-1 tools', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual([
      'create_project',
      'get_project',
      'set_stops',
      'update_project',
      'validate_project',
      'preview_frame',
      'preview_contact_sheet',
      'open_studio',
      'render',
      'render_status',
      'cancel_render',
    ])
    for (const tool of TOOLS) expect(tool.description.length, tool.name).toBeLessThan(400)
    expect(tools.find((t) => t.name === 'render')!.description).toContain('Look at a contact sheet before rendering.')
  })

  test('create → set_stops → get_project', async () => {
    const folder = path.join(tmp, 'Café Tour')
    const created = await call('create_project', { folder, name: 'Café Tour' })
    expect(created.isError).toBeFalsy()
    expect(text(created)).toContain('No stops yet.')

    const set = await call('set_stops', { folder, stops: STOPS, legMode: 'line' })
    expect(set.isError).toBeFalsy()
    expect(text(set)).toContain('1. Piraeus [23.6466, 37.942] arrives 00:01:00')

    const got = await call('get_project', { folder })
    const data = got.structuredContent as {
      project: { legs: unknown[] }
      timeline: { arrivals: { name: string; frame: number }[]; totalFrames: number }
      validation: { errors: unknown[] }
    }
    expect(data.project.legs.length).toBe(3)
    expect(data.timeline.arrivals.map((a) => a.name)).toEqual(['Piraeus', 'Mykonos', 'Santorini', 'Rhodes'])
    expect(data.validation.errors).toEqual([])
    expect(text(got)).toContain('Mykonos [25.3289, 37.4467]')
    expect(text(got)).toContain('0 errors, 0 warnings')
  })

  test('update_project applies a patch', async () => {
    const folder = path.join(tmp, 'p')
    await call('create_project', { folder, name: 'P', output: { height: 1080 } })
    await call('set_stops', { folder, stops: STOPS })
    const updated = await call('update_project', { folder, set: { look: { theme: 'blank' } }, ops: [{ op: 'remove_stop', id: 'nope' }] })
    expect(updated.isError).toBe(true)
    expect(text(updated)).toContain('ops.0.id')

    const ok = await call('update_project', { folder, set: { look: { theme: 'blank' }, timing: { travel: 4 } } })
    expect(ok.isError).toBeFalsy()
    const project = (ok.structuredContent as { project: { look: { theme: string }; timing: { travel: number } } }).project
    expect(project.look.theme).toBe('blank')
    expect(project.timing.travel).toBe(4)
  })

  test('bad update returns a tool error with a fix and leaves the file unchanged', async () => {
    const folder = path.join(tmp, 'p')
    await call('create_project', { folder, name: 'P' })
    const file = path.join(folder, 'mapper.json')
    const before = await readFile(file)

    const result = await call('update_project', { folder, set: { output: { fps: { num: 7, den: 1 } } } })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/^Error: /)
    expect(text(result)).toContain('output.fps')
    expect(text(result)).toContain('Fix: ')
    expect((await readFile(file)).equals(before)).toBe(true)

    const forbidden = await call('update_project', { folder, set: { stops: [] } })
    expect(forbidden.isError).toBe(true)
    expect(text(forbidden)).toContain('set.stops')
  })

  test('relative folder is rejected', async () => {
    for (const name of ['create_project', 'get_project', 'validate_project', 'open_studio', 'render']) {
      const result = await call(name, name === 'create_project' ? { folder: 'relative/dir', name: 'X' } : { folder: 'relative/dir' })
      expect(result.isError, name).toBe(true)
      expect(text(result), name).toContain('absolute')
      expect(text(result), name).toContain('Fix: ')
    }
  })

  test('validate reports too-few-stops on a new project', async () => {
    const folder = path.join(tmp, 'p')
    await call('create_project', { folder, name: 'P' })
    const result = await call('validate_project', { folder })
    expect(result.isError).toBeFalsy()
    const { errors } = result.structuredContent as { errors: { code: string }[] }
    expect(errors.map((e) => e.code)).toContain('too-few-stops')
    expect(text(result)).toContain('1 error, 0 warnings')
    expect(text(result)).toContain('too-few-stops')
  })

  test('a missing project says how to create one', async () => {
    const result = await call('get_project', { folder: path.join(tmp, 'nothing') })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Fix: Create the project first with create_project.')
  })

  test('creating over an existing project fails', async () => {
    const folder = path.join(tmp, 'p')
    await call('create_project', { folder, name: 'P' })
    const again = await call('create_project', { folder, name: 'P' })
    expect(again.isError).toBe(true)
    expect(text(again)).toContain('already exists')
  })

  test('bad stops name the path', async () => {
    const folder = path.join(tmp, 'p')
    await call('create_project', { folder, name: 'P' })
    const result = await call('set_stops', { folder, stops: [{ name: 'Nowhere', at: [200, 0] }] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('stops.0.at.0')
  })

  test('input errors are friendly tool errors, not protocol errors', async () => {
    const missing = await call('create_project', {})
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('Invalid input for create_project')
    expect(text(missing)).toContain('folder')

    const folder = path.join(tmp, 'p')
    const tooWide = await call('preview_frame', { folder, at: { seconds: 1 }, width: 99999 })
    expect(tooWide.isError).toBe(true)
    expect(text(tooWide)).toContain('width')

    const sheet = await call('preview_contact_sheet', { folder, count: 1 })
    expect(sheet.isError).toBe(true)
    expect(text(sheet)).toContain('count')
  })

  test('preview_frame asks for exactly one of seconds, frame or progress', async () => {
    const folder = path.join(tmp, 'p')
    for (const at of [{}, { seconds: 1, frame: 2 }, { progress: 'half' }]) {
      const result = await call('preview_frame', { folder, at })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('Fix: Give exactly one of { seconds }, { frame } or { progress }.')
    }
  })

  test('render rejects a project with errors and lists the fixes', async () => {
    const folder = path.join(tmp, 'p')
    await call('create_project', { folder, name: 'P' })
    const result = await call('render', { folder, codec: 'h264', range: { from: 0, to: 2 } })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('too-few-stops')
    expect(text(result)).toContain('Fix: Add at least two stops with set_stops')
  })

  test('render checks its range', async () => {
    const result = await call('render', { folder: path.join(tmp, 'p'), range: { from: -1, to: 2 } })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('range.from')
  })

  test('render_status and cancel_render reject an unknown job', async () => {
    for (const name of ['render_status', 'cancel_render']) {
      const result = await call(name, { jobId: 'missing' })
      expect(result.isError, name).toBe(true)
      expect(text(result), name).toContain("No render job has the id 'missing'")
      expect(text(result), name).toContain('Fix: ')
    }
  })

  test('an unknown tool is a tool error', async () => {
    const result = await call('nope', {})
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Fix: Use one of: create_project')
  })
})
