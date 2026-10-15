import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createMcpServer } from '../../src/mcp/server.js'
import { doneSummary, leftover, TOOLS } from '../../src/mcp/tools.js'

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
      project: { scenes: { legs: unknown[] }[] }
      timeline: { arrivals: { name: string; frame: number }[]; totalFrames: number }
      validation: { errors: unknown[] }
    }
    expect(data.project.scenes[0]!.legs.length).toBe(3)
    expect(data.timeline.arrivals.map((a) => a.name)).toEqual(['Piraeus', 'Mykonos', 'Santorini', 'Rhodes'])
    expect(data.validation.errors).toEqual([])
    expect(text(got)).toContain('Mykonos [25.3289, 37.4467]')
    expect(text(got)).toContain('0 errors, 0 warnings')
  })

  test('project results include the resolved camera shots, wrapped to ±180', async () => {
    const folder = path.join(tmp, 'pacific')
    await call('create_project', { folder, name: 'Pacific' })
    const set = await call('set_stops', {
      folder,
      stops: [
        { name: 'Suva', at: [178.4419, -18.1416] },
        { name: 'Apia', at: [-171.7513, -13.8333] },
      ],
    })
    for (const result of [set, await call('get_project', { folder })]) {
      const { camera } = result.structuredContent as {
        camera: { resolvedStart: { center: [number, number]; zoom: number }; resolvedEnd: { center: [number, number] } }
      }
      // The fitted centre lies across the antimeridian from Suva, at about −176.7.
      expect(camera.resolvedStart.center[0]).toBeGreaterThan(-180)
      expect(camera.resolvedStart.center[0]).toBeLessThan(-176)
      expect(camera.resolvedStart.zoom).toBeGreaterThan(0)
      expect(camera.resolvedEnd).toEqual(camera.resolvedStart)
    }

    // A stored shot comes back as stored.
    const start = { center: [179.5, -16], zoom: 6, bearing: 0, pitch: 0 }
    const updated = await call('update_project', { folder, sceneSet: { camera: { start } } })
    expect((updated.structuredContent as { camera: { resolvedStart: unknown } }).camera.resolvedStart).toEqual(start)
  })

  test('update_project applies a patch', async () => {
    const folder = path.join(tmp, 'p')
    await call('create_project', { folder, name: 'P', output: { height: 1080 } })
    await call('set_stops', { folder, stops: STOPS })
    const updated = await call('update_project', { folder, sceneSet: { look: { theme: 'blank' } }, ops: [{ op: 'remove_stop', id: 'nope' }] })
    expect(updated.isError).toBe(true)
    expect(text(updated)).toContain('ops.0.id')

    const ok = await call('update_project', { folder, set: { name: 'Q' }, sceneSet: { look: { theme: 'blank' }, timing: { travel: 4 } } })
    expect(ok.isError).toBeFalsy()
    type Data = { project: { name: string; scenes: { look: { theme: string }; timing: { travel: number } }[] } }
    const project = (ok.structuredContent as Data).project
    expect(project.name).toBe('Q')
    expect(project.scenes[0]!.look.theme).toBe('blank')
    expect(project.scenes[0]!.timing.travel).toBe(4)

    const misplaced = await call('update_project', { folder, set: { look: { theme: 'paper' } } })
    expect(misplaced.isError).toBe(true)
    expect(text(misplaced)).toContain('set.look')
    expect(text(misplaced)).toContain('sceneSet')
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

  test('every result repeats its summary in structuredContent, first', async () => {
    const folder = path.join(tmp, 'p')
    const created = await call('create_project', { folder, name: 'P' })
    const results = [created, await call('get_project', { folder }), await call('validate_project', { folder })]
    for (const result of results) {
      const structured = result.structuredContent as Record<string, unknown>
      expect(typeof structured.summary).toBe('string')
      expect(structured.summary).toBe(text(result))
      expect(Object.keys(structured)[0]).toBe('summary')
    }
    expect((results[2]!.structuredContent as { errors: unknown[] }).errors).toHaveLength(1)
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

  test.each([
    ['an unknown layer', { layers: ['map', 'depth'] }, 'layers.1'],
    ['a duplicate layer', { layers: ['map', 'map'] }, 'Each layer may be requested only once'],
    ['an empty list', { layers: [] }, 'layers'],
    ['a future scenes input', { scenes: [{ id: 'a' }] }, 'scenes'],
  ])('render rejects %s', async (_name, extra, expected) => {
    const folder = path.join(tmp, 'p')
    const result = await call('render', { folder, ...extra })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(expected)
    expect(text(result)).toContain('Fix: ')
  })

  test('render rejects layer combinations before creating a render folder', async () => {
    const folder = path.join(tmp, 'combo')
    await call('create_project', { folder, name: 'Combo' })
    await call('set_stops', { folder, stops: STOPS })
    for (const [args, message] of [
      [{ layers: ['all', 'preview'] }, 'Do not combine all and preview'],
      [{ layers: ['map', 'route'], codec: 'h264' }, 'only applies to the flattened'],
    ] as const) {
      const result = await call('render', { folder, ...args })
      expect(result.isError, message).toBe(true)
      expect(text(result)).toContain(message)
      expect(text(result)).toContain('Fix: ')
    }
    await expect(readFile(path.join(folder, 'renders'))).rejects.toMatchObject({ code: 'ENOENT' })
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

describe('render tool description', () => {
  test('says H.264 MP4 is the default and where ProRes and layers fit', () => {
    const description = TOOLS.find((tool) => tool.name === 'render')!.description
    expect(description).toMatch(/default[^.]*H\.264 MP4/i)
    expect(description).toContain("codec: 'prores'")
    expect(description).toContain('layers')
    expect(description).not.toMatch(/'prores' \(default\)/)
  })

  test('a layers-only render with no codec is accepted by the planner', async () => {
    const { planExport } = await import('../../src/render/export-plan.js')
    const { greekIslands } = await import('../fixtures/projects.js')
    expect(() => planExport(greekIslands(), { layers: ['map', 'route', 'signs'] })).not.toThrow()
  })
})

describe('render summaries', () => {
  const output = (request: string, layer: string, file: string) => ({ request, layer, path: `/r/${file}` }) as never

  test('the done summary names the default MP4 as the video', async () => {
    const summary = await doneSummary({ video: '/r/all.mp4', outputs: [], frames: 25, renderFps: 10, manifest: '/nonexistent/manifest.json', dir: '/r' } as never)
    expect(summary).toContain('Video: /r/all.mp4')
  })

  test('leftover labels outputs by what was requested', async () => {
    const lines = await leftover({
      dir: '/nonexistent/render',
      outputs: [output('preview', 'all', 'preview.mp4'), output('all', 'all', 'all.mov'), output('route', 'route', 'route.mov')],
    })
    expect(lines.slice(0, 4)).toEqual([
      'Finished outputs kept:',
      '- preview: /r/preview.mp4',
      '- clip: /r/all.mov',
      '- route: /r/route.mov',
    ])
    expect(lines).toContain('Folder: /nonexistent/render')
    expect(lines.at(-1)).toMatch(/^Credit required: /)
  })

  test('leftover says so when nothing finished, and omits the folder before one exists', async () => {
    expect(await leftover({ outputs: [], dir: '/nonexistent/render' })).toEqual([
      'No outputs were finished.',
      'Folder: /nonexistent/render',
      expect.stringMatching(/^Credit required: /),
    ])
    expect(await leftover({})).toEqual(['No outputs were finished.'])
  })

  test('doneSummary words a skipped FCPXML validation', async () => {
    const text = await doneSummary({
      dir: '/nonexistent/render',
      manifest: '/nonexistent/render/manifest.json',
      frames: 50,
      renderFps: 10,
      outputs: [],
      fcpxml: '/nonexistent/render/trip.fcpxml',
      fcpxmlValidation: 'skipped-no-fcp',
    } as never)
    expect(text).toContain('FCPXML: /nonexistent/render/trip.fcpxml')
    expect(text).toContain('FCPXML validation was skipped: Final Cut Pro is not installed, so the DTD is unavailable.')
    expect(text).not.toContain('validated against')
  })

  test('doneSummary says a passed FCPXML was validated', async () => {
    const text = await doneSummary({
      dir: '/d',
      manifest: '/d/manifest.json',
      frames: 50,
      renderFps: 10,
      outputs: [],
      fcpxml: '/d/trip.fcpxml',
      fcpxmlValidation: 'passed',
    } as never)
    expect(text).toContain('FCPXML validated against the Final Cut Pro DTD.')
  })
})
