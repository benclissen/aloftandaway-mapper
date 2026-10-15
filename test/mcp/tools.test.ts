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

interface SceneResult {
  id: string
  name: string
  timeline: { durationSeconds: number; totalFrames: number; arrivals: { name: string; frame: number }[] }
  camera: {
    resolvedStart: { center: [number, number]; zoom: number }
    resolvedEnd: { center: [number, number] }
    resolvedFollow?: { zoom: number; orient: string; lookAhead: number; smoothing: number }
  }
}

describe('tools', () => {
  test('lists the tools', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual([
      'create_project',
      'get_project',
      'set_stops',
      'import_gpx',
      'update_project',
      'validate_project',
      'preview_frame',
      'preview_contact_sheet',
      'open_studio',
      'render',
      'render_status',
      'cancel_render',
    ])
    for (const tool of TOOLS) expect(tool.description.length, tool.name).toBeLessThan(600)
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
      scenes: { id: string; timeline: { arrivals: { name: string; frame: number }[]; totalFrames: number } }[]
      validation: { errors: unknown[] }
    }
    expect(data.project.scenes[0]!.legs.length).toBe(3)
    expect(data).not.toHaveProperty('timeline')
    expect(data).not.toHaveProperty('camera')
    expect(data.scenes[0]!.timeline.arrivals.length).toBe(4)
    expect(data.scenes[0]!.timeline.arrivals.map((a) => a.name)).toEqual(['Piraeus', 'Mykonos', 'Santorini', 'Rhodes'])
    expect(data.validation.errors).toEqual([])
    expect(text(got)).toContain('Mykonos [25.3289, 37.4467]')
    expect(text(got)).toContain('0 errors, 0 warnings')
  })

  test('set_stops with legMode sea reports the sea route', async () => {
    const folder = path.join(tmp, 'sea')
    await call('create_project', { folder, name: 'Sea' })
    const set = await call('set_stops', { folder, stops: STOPS.slice(0, 2), legMode: 'sea' })
    expect(set.isError).toBeFalsy()
    expect(text(set)).toContain('sea route')
    const data = set.structuredContent as { validation: { warnings: { code: string }[] } }
    expect(data.validation.warnings.map((w) => w.code)).not.toContain('not-available-yet')
  })

  test('a landlocked sea leg reports the fallback', async () => {
    const folder = path.join(tmp, 'landlocked')
    await call('create_project', { folder, name: 'Landlocked' })
    const set = await call('set_stops', {
      folder,
      stops: [
        { name: 'Bern', at: [7.4474, 46.948] },
        { name: 'Prague', at: [14.4378, 50.0755] },
      ],
      legMode: 'sea',
    })
    expect(text(set)).toContain('sea route failed: The start stop is more than 30 km from the sea')
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
      const { camera } = (result.structuredContent as { scenes: SceneResult[] }).scenes[0]!
      // The fitted centre lies across the antimeridian from Suva, at about −176.7.
      expect(camera.resolvedStart.center[0]).toBeGreaterThan(-180)
      expect(camera.resolvedStart.center[0]).toBeLessThan(-176)
      expect(camera.resolvedStart.zoom).toBeGreaterThan(0)
      expect(camera.resolvedEnd).toEqual(camera.resolvedStart)
    }

    // A stored shot comes back as stored.
    const start = { center: [179.5, -16], zoom: 6, bearing: 0, pitch: 0 }
    const updated = await call('update_project', { folder, sceneSet: { camera: { start } } })
    expect((updated.structuredContent as { scenes: SceneResult[] }).scenes[0]!.camera.resolvedStart).toEqual(start)
  })

  test('project results include the follow settings in use when the camera follows', async () => {
    const folder = path.join(tmp, 'follow')
    await call('create_project', { folder, name: 'Follow' })
    const set = await call('set_stops', { folder, stops: STOPS })
    expect((set.structuredContent as { scenes: SceneResult[] }).scenes[0]!.camera.resolvedFollow).toBeUndefined()
    const updated = await call('update_project', { folder, sceneSet: { camera: { mode: 'follow' } } })
    const { camera } = (updated.structuredContent as { scenes: SceneResult[] }).scenes[0]!
    expect(camera.resolvedFollow).toEqual({ zoom: expect.any(Number), orient: 'north', lookAhead: 1, smoothing: 0.5 })
    expect(camera.resolvedFollow!.zoom).toBeGreaterThan(camera.resolvedStart.zoom)
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

  test('update_project applies sceneSet and via ops', async () => {
    const folder = path.join(tmp, 'v')
    await call('create_project', { folder, name: 'V' })
    await call('set_stops', { folder, stops: STOPS })
    const via = { at: [24.5, 37.9], sharp: true }
    const ok = await call('update_project', {
      folder,
      sceneSet: { look: { theme: 'blank' } },
      ops: [{ op: 'insert_via', leg: 0, index: 0, point: via }],
    })
    expect(ok.isError, text(ok)).toBeFalsy()
    const got = await call('get_project', { folder })
    const project = (got.structuredContent as { project: { scenes: { look: { theme: string }; legs: { via: { at: number[] }[] }[] }[] } }).project
    expect(project.scenes[0]!.look.theme).toBe('blank')
    expect(project.scenes[0]!.legs[0]!.via[0]!.at).toEqual([24.5, 37.9])
  })

  test('the summary lists shaped legs', async () => {
    const folder = path.join(tmp, 's')
    await call('create_project', { folder, name: 'S' })
    await call('set_stops', { folder, stops: STOPS })
    const result = await call('update_project', {
      folder,
      ops: [
        { op: 'insert_via', leg: 0, index: 0, point: { at: [24, 37.9] } },
        { op: 'insert_via', leg: 0, index: 1, point: { at: [24.5, 37.8], sharp: true } },
        { op: 'update_leg', index: 0, changes: { symbol: 'ferry' } },
        { op: 'update_leg', index: 2, changes: { symbol: 'plane' } },
      ],
    })
    expect(result.isError, text(result)).toBeFalsy()
    expect(text(result)).toContain('Leg 1 Piraeus → Mykonos: ferry (sea), 2 via points, 1 sharp')
    expect(text(result)).toContain('Leg 3 Santorini → Rhodes: plane (air)')
    expect(text(result)).not.toContain('Leg 2')
  })

  test('descriptions describe version 2', () => {
    const get = TOOLS.find((t) => t.name === 'get_project')!.description
    expect(get).toContain('scenes')
    expect(get).toContain('scenes[0]')
    expect(TOOLS.find((t) => t.name === 'set_stops')!.description).toContain('symbol')
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
    expect(() => planExport(greekIslands(), { seaPaths: {}, layers: ['map', 'route', 'signs'] })).not.toThrow()
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

  describe('import_gpx', () => {
    const gpx = (name: string) => path.resolve(process.cwd(), 'test/fixtures/gpx', name)

    test('import_gpx imports a track with waypoints', async () => {
      const folder = path.join(tmp, 'gpx')
      await call('create_project', { folder, name: 'Walk' })
      const result = await call('import_gpx', { folder, path: gpx('track.gpx'), stops: 'waypoints' })
      expect(result.isError, text(result)).toBeFalsy()
      const sc = result.structuredContent as {
        summary: string
        project: { scenes: { stops: { name: string }[]; legs: { via: unknown[] }[] }[] }
        import: { line: { name?: string }; stops: number; skipped: { name: string; km: number }[] }
      }
      expect(sc.summary.split('\n')[0]).toMatch(/^Imported \d+ stops from track "Coastal Walk"; skipped 1 waypoint more than 2 km from the track \(Inland Farm, [\d.]+ km\)\.$/)
      expect(sc.import.stops).toBe(sc.project.scenes[0]!.stops.length)
      expect(sc.import.line.name).toBe('Coastal Walk')
      expect(sc.import.skipped.map((s) => s.name)).toEqual(['Inland Farm'])
      expect(sc.project.scenes[0]!.stops.map((s) => s.name)).not.toContain('Inland Farm')
    })

    test('import_gpx rejects a relative path', async () => {
      const folder = path.join(tmp, 'gpx')
      await call('create_project', { folder, name: 'Walk' })
      const result = await call('import_gpx', { folder, path: 'test/fixtures/gpx/track.gpx' })
      expect(result.isError).toBe(true)
      expect(text(result)).toMatch(/Error: .*absolute/)
      expect(text(result)).toContain('Fix:')
    })

    test('import_gpx rejects a non-GPX extension', async () => {
      const folder = path.join(tmp, 'gpx')
      await call('create_project', { folder, name: 'Walk' })
      const result = await call('import_gpx', { folder, path: path.join(tmp, 'walk.txt') })
      expect(result.isError).toBe(true)
      expect(text(result)).toMatch(/\.gpx/)
      expect(text(result)).toContain('Fix:')
    })

    test('import_gpx turns a GpxError into a tool error with its fix', async () => {
      const folder = path.join(tmp, 'gpx')
      await call('create_project', { folder, name: 'Walk' })
      const result = await call('import_gpx', { folder, path: gpx('track.gpx'), track: 'Nope' })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain("Error: No track 'Nope'")
      expect(text(result)).toContain('Fix: Pass a number from 1 to 1')
    })
  })
})
