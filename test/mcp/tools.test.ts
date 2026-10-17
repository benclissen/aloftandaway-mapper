import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMcpServer } from '../../src/mcp/server.js'
import { creditLine, doneSummary, leftover, statusSummary, TOOLS } from '../../src/mcp/tools.js'
import { startRenderJob, type RenderStatus } from '../../src/render/jobs.js'
import { contactSheet, previewFrame } from '../../src/render/preview.js'

// The real job runs; the spy records what the render tool asked for.
vi.mock('../../src/render/jobs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/render/jobs.js')>()
  return { ...actual, startRenderJob: vi.fn(actual.startRenderJob) }
})

// No browser in unit tests: the preview functions are replaced, and the tests check what they were asked for.
vi.mock('../../src/render/preview.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/render/preview.js')>()),
  previewFrame: vi.fn(),
  contactSheet: vi.fn(),
}))

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
  position: number
  startSeconds: number
  timeline: { durationSeconds: number; totalFrames: number; arrivals: { name: string; frame: number }[] }
  camera: {
    resolvedStart: { center: [number, number]; zoom: number }
    resolvedEnd: { center: [number, number]; zoom: number }
    resolvedFollow?: { zoom: number; orient: string; lookAhead: number; smoothing: number; pitch: number }
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
    // update_project carries the patch format and the scene ops, so it gets more room.
    for (const tool of TOOLS) expect(tool.description.length, tool.name).toBeLessThan(tool.name === 'update_project' ? 900 : 600)
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
    expect(text(set)).not.toContain('sea route failed')
    const data = set.structuredContent as { validation: { warnings: { code: string }[] } }
    expect(data.validation.warnings.map((w) => w.code)).not.toContain('not-available-yet')
  })

  test('a sharp stop ends its summary line in · sharp', async () => {
    const folder = path.join(tmp, 'sharp-stop')
    await call('create_project', { folder, name: 'Sharp' })
    await call('set_stops', { folder, stops: STOPS })
    const got = await call('get_project', { folder })
    const stops = (got.structuredContent as { project: { scenes: { stops: { id: string }[] }[] } }).project.scenes[0]!.stops
    const updated = await call('update_project', { folder, ops: [{ op: 'update_stop', id: stops[1]!.id, changes: { sharp: true } }] })
    expect(updated.isError, text(updated)).toBeFalsy()
    const lines = text(updated).split('\n')
    expect(lines.find((l) => l.startsWith('2. Mykonos'))).toMatch(/ · sharp$/)
    expect(lines.find((l) => l.startsWith('1. Piraeus'))).not.toContain('sharp')
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

  test('a sea leg pulled ashore names the place to 4 decimals', async () => {
    const folder = path.join(tmp, 'ashore')
    await call('create_project', { folder, name: 'Ashore' })
    await call('set_stops', { folder, stops: [STOPS[0], STOPS[3]], legMode: 'sea' })
    // A via point on Naxos.
    const updated = await call('update_project', { folder, ops: [{ op: 'insert_via', leg: 0, index: 0, point: { at: [25.45, 37.05] } }] })
    const line = text(updated)
      .split('\n')
      .find((l) => l.startsWith('Leg 1'))
    expect(line).toMatch(/sea route crosses land near \[-?\d+\.\d{4}, -?\d+\.\d{4}\]/)
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
      // The whole-route fit's centre lies across the antimeridian from Suva, at about −176.7.
      expect(camera.resolvedEnd.center[0]).toBeGreaterThan(-180)
      expect(camera.resolvedEnd.center[0]).toBeLessThan(-176)
      expect(camera.resolvedEnd.zoom).toBeGreaterThan(0)
      // One leg, so the default start is Suva, closer in.
      expect(camera.resolvedStart).toEqual({ center: [178.4419, -18.1416], zoom: camera.resolvedEnd.zoom + 2, bearing: 0, pitch: 0 })
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
    expect(camera.resolvedFollow).toEqual({ zoom: expect.any(Number), orient: 'north', lookAhead: 0.25, smoothing: 0.2, pitch: 0 })
    // Three steps in from the whole-route fit, which is the default end.
    expect(camera.resolvedFollow!.zoom).toBeGreaterThan(camera.resolvedEnd.zoom)
  })

  test('update_project accepts symbolStyle and a partial follow', async () => {
    const folder = path.join(tmp, 'look')
    await call('create_project', { folder, name: 'Look' })
    await call('set_stops', { folder, stops: STOPS })
    const updated = await call('update_project', {
      folder,
      sceneSet: { look: { symbolStyle: 'icon', terrain: true, theme: 'satellite' }, camera: { mode: 'follow', follow: { pitch: 40 } } },
    })
    expect(updated.isError).toBeFalsy()
    const data = updated.structuredContent as { project: { scenes: { look: { symbolStyle: string } }[] }; scenes: SceneResult[] }
    expect(data.project.scenes[0]!.look.symbolStyle).toBe('icon')
    expect(data.scenes[0]!.camera.resolvedFollow).toEqual({ zoom: expect.any(Number), orient: 'north', lookAhead: 0.25, smoothing: 0.2, pitch: 40 })
    expect(text(updated)).toContain('Style: satellite, terrain on')
    const { tools } = await client.listTools()
    const description = tools.find((t) => t.name === 'update_project')!.description!
    for (const word of ['aloftandaway-warm', 'monochrome', 'symbolStyle', 'badge-line', 'follow.pitch', 'look.terrain']) expect(description).toContain(word)
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
    expect(get).toContain('project.scenes')
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

  describe('scenes', () => {
    async function twoScenes(name: string): Promise<string> {
      const folder = path.join(tmp, name)
      await call('create_project', { folder, name: 'Trip' })
      await call('update_project', { folder, sceneSet: { name: 'Drive' } })
      await call('set_stops', { folder, stops: STOPS.slice(0, 2) })
      const added = await call('update_project', { folder, ops: [{ op: 'add_scene', name: 'Sail' }] })
      expect(added.isError, text(added)).toBeFalsy()
      return folder
    }

    test('set_stops with scene 2 leaves scene 1 alone, and the summary names scene 2', async () => {
      const folder = await twoScenes('scene-stops')
      const set = await call('set_stops', { folder, scene: 2, stops: STOPS.slice(1), legMode: 'sea' })
      expect(set.isError, text(set)).toBeFalsy()
      const lines = text(set).split('\n')
      expect(lines[0]).toBe('Changed Scene 2 of 2 · Sail.')
      const data = set.structuredContent as {
        project: { scenes: { id: string; stops: { name: string }[] }[] }
        scene: { id: string; position: number }
      }
      expect(data.project.scenes[0]!.stops.map((s) => s.name)).toEqual(['Piraeus', 'Mykonos'])
      expect(data.project.scenes[1]!.stops.map((s) => s.name)).toEqual(['Mykonos', 'Santorini', 'Rhodes'])
      expect(data.scene).toEqual({ id: data.project.scenes[1]!.id, position: 2 })

      // By id, too.
      const byId = await call('set_stops', { folder, scene: data.scene.id, stops: STOPS.slice(0, 2) })
      expect(text(byId).split('\n')[0]).toBe('Changed Scene 2 of 2 · Sail.')
    })

    test('update_project adds a scene and the summary lists the scenes', async () => {
      const folder = path.join(tmp, 'scene-add')
      await call('create_project', { folder, name: 'Trip' })
      await call('update_project', { folder, sceneSet: { name: 'Drive' } })
      const added = await call('update_project', { folder, ops: [{ op: 'add_scene', name: 'Sail' }] })
      expect(added.isError, text(added)).toBeFalsy()
      expect(text(added).split('\n')[0]).toBe('Scenes: 1 Drive, 2 Sail.')
      const data = added.structuredContent as { project: { scenes: unknown[] }; scenes: SceneResult[] }
      expect(data.project.scenes).toHaveLength(2)
      expect(data.scenes.map((s) => s.name)).toEqual(['Drive', 'Sail'])

      // A patch on scene 2's own fields names scene 2.
      const renamed = await call('update_project', { folder, scene: 2, sceneSet: { name: 'Ferry' } })
      expect(text(renamed).split('\n')[0]).toBe('Changed Scene 2 of 2 · Ferry.')
      expect((renamed.structuredContent as { scene: unknown }).scene).toEqual({ id: data.scenes[1]!.id, position: 2 })
    })

    test('update_project names the scene it patched even when a scene op moves it', async () => {
      const folder = await twoScenes('scene-move')
      const moved = await call('update_project', {
        folder,
        scene: 1,
        sceneSet: { name: 'Road' },
        ops: [{ op: 'move_scene', id: (await sceneIds(folder))[0]!, index: 1 }],
      })
      expect(moved.isError, text(moved)).toBeFalsy()
      expect(text(moved).split('\n')[0]).toBe('Changed Scene 2 of 2 · Road.')
    })

    async function sceneIds(folder: string): Promise<string[]> {
      const got = await call('get_project', { folder })
      return (got.structuredContent as { scenes: SceneResult[] }).scenes.map((s) => s.id)
    }

    test('get_project heads each scene and gives the joined length', async () => {
      const folder = await twoScenes('scene-get')
      await call('set_stops', { folder, scene: 2, stops: STOPS })
      const got = await call('get_project', { folder })
      const data = got.structuredContent as { scenes: SceneResult[] }
      const [a, b] = data.scenes
      expect(a!.position).toBe(1)
      expect(a!.startSeconds).toBe(0)
      expect(b!.position).toBe(2)
      expect(b!.startSeconds).toBeCloseTo(a!.timeline.durationSeconds, 6)
      const joined = a!.timeline.durationSeconds + b!.timeline.durationSeconds
      const frames = a!.timeline.totalFrames + b!.timeline.totalFrames
      const lines = text(got).split('\n')
      expect(lines[0]).toBe(`Trip: 2 scenes, ${joined.toFixed(1)} s joined (${frames} frames), 3840×2160.`)
      expect(lines).toContain(`Scene 1 of 2 · Drive (id ${a!.id})`)
      expect(lines).toContain(`Scene 2 of 2 · Sail (id ${b!.id})`)
      expect(lines.indexOf(`Scene 1 of 2 · Drive (id ${a!.id})`)).toBeLessThan(lines.indexOf(`Scene 2 of 2 · Sail (id ${b!.id})`))
      expect(lines.filter((l) => l.startsWith('Style: '))).toHaveLength(2)
    })

    test('each scene block starts with its counts, not the project name', async () => {
      const folder = await twoScenes('scene-blocks')
      const got = await call('get_project', { folder })
      const lines = text(got).split('\n')
      expect(lines.filter((l) => l.includes('Trip'))).toEqual([lines[0]])
      const counts = lines.filter((l) => /^\d+ stops?, /.test(l))
      expect(counts).toHaveLength(2)
      expect(counts[0]).toMatch(/^2 stops, [\d.]+ s \(\d+ frames\), 3840×2160\.$/)
      const header = lines.findIndex((l) => l.startsWith('Scene 1 of 2 · Drive'))
      expect(lines[header + 1]).toBe(counts[0])
    })

    test('a one-scene summary is unchanged', async () => {
      const folder = path.join(tmp, 'one-scene')
      await call('create_project', { folder, name: 'Greek Islands', output: { height: 1080 } })
      await call('update_project', {
        folder,
        sceneSet: { timing: { holdStart: 1, travel: 10, holdEnd: 2 } },
      })
      const set = await call('set_stops', { folder, stops: STOPS, legMode: 'line' })
      expect(text(set)).toMatchInlineSnapshot(`
        "Greek Islands: 4 stops, 14.0 s (350 frames), 1920×1080.
        Style: aloftandaway, terrain off.
        1. Piraeus [23.6466, 37.942] arrives 00:01:00
        2. Mykonos [25.3289, 37.4467] arrives 00:04:01
        3. Santorini [25.4317, 36.4166] arrives 00:06:07
        4. Rhodes [28.2278, 36.451] arrives 00:12:00
        0 errors, 0 warnings"
      `)
      const data = set.structuredContent as { scenes: SceneResult[] }
      expect(data.scenes[0]!.position).toBe(1)
      expect(data.scenes[0]!.startSeconds).toBe(0)
    })

    test('an unknown scene is a tool error that lists the scenes', async () => {
      const folder = await twoScenes('scene-unknown')
      for (const [tool, args] of [
        ['set_stops', { stops: STOPS }],
        ['update_project', { sceneSet: { name: 'x' } }],
      ] as const) {
        for (const scene of [3, 'nope']) {
          const result = await call(tool, { folder, scene, ...args })
          expect(result.isError, `${tool} ${scene}`).toBe(true)
          expect(text(result)).toContain('scene:')
          expect(text(result)).toContain('1 "Drive"')
          expect(text(result)).toContain('2 "Sail"')
        }
      }
    })

    test('scene is described, with its default, on every tool that takes it', async () => {
      const { tools } = await client.listTools()
      for (const name of ['set_stops', 'import_gpx', 'update_project', 'preview_frame', 'preview_contact_sheet']) {
        const schema = tools.find((t) => t.name === name)!.inputSchema as { properties: Record<string, { description?: string }> }
        expect(schema.properties.scene, name).toBeDefined()
      }
      const scene = (tools.find((t) => t.name === 'set_stops')!.inputSchema as { properties: Record<string, { description?: string }> }).properties.scene!
      expect(scene.description).toBe('Scene id, or its 1-based position. Default: the first scene')
      const get = tools.find((t) => t.name === 'get_project')!.description!
      expect(get).toContain('project.scenes')
      expect(get).not.toContain('scenes[0]')
      const update = tools.find((t) => t.name === 'update_project')!.description!
      for (const word of ['add_scene', 'duplicate_scene', 'remove_scene', 'move_scene']) expect(update).toContain(word)
      for (const words of ['0-based', 'scene id', 'appends', 'copyLookFrom is an id or 1-based position']) expect(update).toContain(words)
      expect(update).not.toContain('restore_scene')
    })

    test('preview_frame and preview_contact_sheet take a scene', async () => {
      const folder = await twoScenes('scene-preview')
      const sail = { id: 'b', position: 2, name: 'Sail' }
      const label = 'Scene 2 of 2 · Sail'
      vi.mocked(previewFrame).mockResolvedValue({ png: Buffer.from('png'), path: '/p/scene2-frame-3.png', frame: 3, seconds: 0.12, scene: sail, sceneLabel: label })
      vi.mocked(contactSheet).mockResolvedValue({ png: Buffer.from('png'), path: '/p/scene2-contact.png', frames: [{ frame: 0, seconds: 0 }], scene: sail, sceneLabel: label })

      const frame = await call('preview_frame', { folder, scene: 2, at: { frame: 3 } })
      expect(frame.isError, text(frame)).toBeFalsy()
      expect(previewFrame).toHaveBeenLastCalledWith({ folder, at: { frame: 3 }, width: 960, scene: 2 })
      // The scene comes from the preview, which read it from the project it rendered.
      expect(text(frame).split('\n')[0]).toBe('Scene 2 of 2 · Sail: frame 3 at 0.12 s, 960 px wide. Saved to /p/scene2-frame-3.png')
      expect((frame.structuredContent as { scene: unknown }).scene).toEqual(sail)

      await call('preview_frame', { folder, at: { frame: 3 } })
      expect(previewFrame).toHaveBeenLastCalledWith({ folder, at: { frame: 3 }, width: 960, scene: undefined })

      const sheet = await call('preview_contact_sheet', { folder, scene: 'abc', count: 4 })
      expect(sheet.isError, text(sheet)).toBeFalsy()
      expect(contactSheet).toHaveBeenLastCalledWith({ folder, count: 4, width: 1920, scene: 'abc' })
      expect(text(sheet).split('\n')[0]).toBe('Scene 2 of 2 · Sail: contact sheet of 1 frames, 1920 px wide. Saved to /p/scene2-contact.png')
      expect((sheet.structuredContent as { scene: unknown }).scene).toEqual(sail)
    })

    test('a one-scene preview keeps its wording and still names the scene in data', async () => {
      const folder = path.join(tmp, 'one-scene-preview')
      const only = { id: 'a', position: 1, name: 'Drive' }
      vi.mocked(previewFrame).mockResolvedValue({ png: Buffer.from('png'), path: '/p/frame-3.png', frame: 3, seconds: 0.12, scene: only })
      vi.mocked(contactSheet).mockResolvedValue({ png: Buffer.from('png'), path: '/p/contact.png', frames: [{ frame: 0, seconds: 0 }], scene: only })

      const frame = await call('preview_frame', { folder, at: { frame: 3 } })
      expect(text(frame).split('\n')[0]).toBe('Frame 3 at 0.12 s, 960 px wide. Saved to /p/frame-3.png')
      expect((frame.structuredContent as { scene: unknown }).scene).toEqual(only)
      const sheet = await call('preview_contact_sheet', { folder })
      expect(text(sheet).split('\n')[0]).toBe('Contact sheet of 1 frames, 1920 px wide. Saved to /p/contact.png')
      expect((sheet.structuredContent as { scene: unknown }).scene).toEqual(only)
    })
  })

  test('a preview of an unsettled frame says so', async () => {
    const folder = path.join(tmp, 'unsettled-preview')
    const only = { id: 'a', position: 1, name: 'Drive' }
    const line = "Frame 3: the camera height over terrain hadn't settled, so this frame may differ slightly between renders and between layers."
    vi.mocked(previewFrame).mockResolvedValue({ png: Buffer.from('png'), path: '/p/frame-3.png', frame: 3, seconds: 0.12, scene: only, warnings: [line] })
    const frame = await call('preview_frame', { folder, at: { frame: 3 } })
    expect(text(frame).split('\n').slice(0, 2)).toEqual(['Frame 3 at 0.12 s, 960 px wide. Saved to /p/frame-3.png', line])
    expect((frame.structuredContent as { warnings: unknown }).warnings).toEqual([line])

    const sheetLine = line.replace('Frame 3', 'Frames 0 and 3').replace('this frame', 'these frames')
    vi.mocked(contactSheet).mockResolvedValue({
      png: Buffer.from('png'), path: '/p/contact.png', frames: [{ frame: 0, seconds: 0 }, { frame: 3, seconds: 0.12 }], scene: only, warnings: [sheetLine],
    })
    const sheet = await call('preview_contact_sheet', { folder, count: 2 })
    expect(text(sheet).split('\n').slice(0, 2)).toEqual(['Contact sheet of 2 frames, 1920 px wide. Saved to /p/contact.png', sheetLine])

    // A settled preview adds nothing.
    vi.mocked(previewFrame).mockResolvedValue({ png: Buffer.from('png'), path: '/p/frame-3.png', frame: 3, seconds: 0.12, scene: only })
    const settled = await call('preview_frame', { folder, at: { frame: 3 } })
    expect(text(settled)).not.toContain('settled')
    expect(settled.structuredContent).not.toHaveProperty('warnings')
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

  test('a running status says all layers only when the export has more than one', async () => {
    const running = (layers?: number): RenderStatus => ({
      jobId: 'j',
      state: 'running',
      progress: { frame: 120, totalFrames: 900, fps: 12.5, etaSeconds: 70, layers },
    })
    expect(await statusSummary(running(3))).toMatch(/^Frame 120 of 900 \(all layers\) · 12\.5 fps/)
    expect(await statusSummary(running(1))).toMatch(/^Frame 120 of 900 · 12\.5 fps/)
    expect(await statusSummary(running())).toMatch(/^Frame 120 of 900 · 12\.5 fps/)
  })

  test('render tool passes scenes and join through', async () => {
    const folder = path.join(tmp, 'picked')
    await call('create_project', { folder, name: 'Picked' })
    const added = await call('update_project', { folder, ops: [{ op: 'add_scene', name: 'Sail' }] })
    const sailId = (added.structuredContent as { project: { scenes: { id: string }[] } }).project.scenes[1]!.id
    vi.mocked(startRenderJob).mockClear()
    // Neither scene has stops, so the job fails before a render folder exists.
    const result = await call('render', { folder, scenes: [sailId, 1], join: false })
    expect(result.isError).toBe(true)
    expect(startRenderJob).toHaveBeenCalledWith(expect.objectContaining({ folder, scenes: [sailId, 1], join: false }))
    const schema = TOOLS.find((t) => t.name === 'render')!.input
    expect(schema.safeParse({ folder, scenes: ['x', 0] }).success).toBe(false)
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
    const summary = await doneSummary({ video: '/r/all.mp4', outputs: [], sceneStarts: [], frames: 25, renderFps: 10, manifest: '/nonexistent/manifest.json', dir: '/r' } as never)
    expect(summary).toContain('Video: /r/all.mp4')
  })

  test('a clean render has no warnings line', async () => {
    const result = { dir: '/r', manifest: '/nonexistent/manifest.json', video: '/r/all.mp4', frames: 25, renderFps: 10, fps: { num: 25, den: 1 }, outputs: [], sceneStarts: [], warnings: [] }
    const done = await doneSummary(result as never)
    expect(done).not.toContain('Warning')
    expect(done.split('\n').at(-1)).toMatch(/^Credit required: /)
    expect(await statusSummary({ jobId: 'j', state: 'done', result } as never)).toBe(done)
    const running: RenderStatus = { jobId: 'j', state: 'running', progress: { frame: 1, totalFrames: 25, fps: 10, etaSeconds: 2 } }
    expect(await statusSummary(running)).toBe('Frame 1 of 25 · 10.0 fps · under a minute left')
    const failed = await statusSummary({ jobId: 'j', state: 'failed', error: 'Boom.', dir: '/nonexistent/render', outputs: [] })
    expect(failed).not.toContain('Warning')
    expect(failed.split('\n').at(-1)).toMatch(/^Credit required: /)
  })

  test('a render with unsettled frames lists them', async () => {
    const warnings = [
      "Scene 1 of 2 · Drive: frames 12, 13 and 40: the camera height over terrain hadn't settled, so these frames may differ slightly between renders and between layers.",
      "Scene 2 of 2 · Sail: frame 3: the camera height over terrain hadn't settled, so this frame may differ slightly between renders and between layers.",
    ]
    const block = ['Warnings:', ...warnings]
    const result = { dir: '/r', manifest: '/nonexistent/manifest.json', video: '/r/all.mp4', frames: 25, renderFps: 10, fps: { num: 25, den: 1 }, outputs: [], sceneStarts: [], warnings }
    const done = await doneSummary(result as never)
    expect(done.split('\n').slice(-3)).toEqual(block)
    expect(await statusSummary({ jobId: 'j', state: 'done', result, warnings } as never)).toBe(done)
    const running = await statusSummary({ jobId: 'j', state: 'running', progress: { frame: 1, totalFrames: 25, fps: 10, etaSeconds: 2 }, warnings })
    expect(running.split('\n')).toEqual(['Frame 1 of 25 · 10.0 fps · under a minute left', ...block])
    for (const state of ['failed', 'cancelled'] as const) {
      const summary = await statusSummary({ jobId: 'j', state, error: 'Boom.', dir: '/nonexistent/render', outputs: [], warnings })
      expect(summary.split('\n').slice(-3), state).toEqual(block)
    }
    // The CLI reports a failed or cancelled render with leftover, so it gets the same lines.
    expect((await leftover({ dir: '/nonexistent/render', outputs: [], warnings })).slice(-3)).toEqual(block)
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
    expect(lines.at(-1)).not.toContain('(burned in)')
  })

  test('leftover names the scene of each part a joined render left', async () => {
    const dir = path.join(tmp, 'parts')
    await mkdir(dir, { recursive: true })
    const scenes = [{ id: 'a', name: 'Drive', position: 1 }, { id: 'b', name: '', position: 3 }]
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ scenes, credit: '' }))
    const part = (sceneId: string, request: string, layer: string, file: string) => ({ sceneId, request, layer, path: `${dir}/${file}` }) as never
    const lines = await leftover({
      dir,
      outputs: [part('a', 'all', 'all', '01-drive.part.mp4'), part('a', 'map', 'map', '01-drive/map.mov'), part('b', 'preview', 'all', '02-scene-preview.part.mp4')],
    })
    expect(lines.slice(0, 4)).toEqual([
      'Finished outputs kept:',
      `- clip of Drive: ${dir}/01-drive.part.mp4`,
      `- map of Drive: ${dir}/01-drive/map.mov`,
      `- preview of Scene 3: ${dir}/02-scene-preview.part.mp4`,
    ])
  })

  test('doneSummary says where each joined scene starts', async () => {
    const result = {
      dir: '/d',
      manifest: '/d/manifest.json',
      video: '/d/all.mp4',
      frames: 650,
      renderFps: 10,
      fps: { num: 25, den: 1 },
      outputs: [],
      sceneStarts: [
        { id: 'a', name: 'Drive', position: 1, seconds: 0 },
        { id: 'b', name: 'Sail', position: 3, seconds: 13 },
      ],
    }
    const text = await doneSummary(result as never)
    expect(text).toContain('Scene 1 · Drive starts at 00:00:00\nScene 3 · Sail starts at 00:13:00')
    const one = await doneSummary({ ...result, sceneStarts: result.sceneStarts.slice(0, 1) } as never)
    expect(one).not.toContain('starts at')
  })

  test('doneSummary lists every clip of a render with one file per scene', async () => {
    const out = (request: string, file: string) => ({ sceneId: 's', request, layer: 'all', path: `/d/${file}` }) as never
    const text = await doneSummary({
      dir: '/d', manifest: '/d/manifest.json', frames: 100, renderFps: 10, fps: { num: 25, den: 1 }, sceneStarts: [],
      outputs: [out('all', '01-drive.mp4'), out('all', '02-sail.mp4')],
    } as never)
    expect(text).toContain('Video: /d/01-drive.mp4\nVideo: /d/02-sail.mp4')
  })

  test('creditLine says which credit is burned in and that the full text still goes in the description', async () => {
    const manifest = path.join(tmp, 'manifest.json')
    await writeFile(manifest, JSON.stringify({ creditPlacement: 'burned', credit: 'FULL TEXT' }))
    const burned = await creditLine(manifest)
    expect(burned).toContain('FULL TEXT')
    expect(burned).toContain('short credit lines are burned into the picture')
    expect(burned).toContain('video description')
    await writeFile(manifest, JSON.stringify({ creditPlacement: 'description', credit: 'FULL TEXT' }))
    expect(await creditLine(manifest)).toBe('Credit required: FULL TEXT (put it in the video description)')
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
      sceneStarts: [],
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
      sceneStarts: [],
      fcpxml: '/d/trip.fcpxml',
      fcpxmlValidation: 'passed',
    } as never)
    expect(text).toContain('FCPXML validated against the Final Cut Pro DTD.')
  })

  describe('import_gpx', () => {
    const gpx = (name: string) => path.resolve(process.cwd(), 'test/fixtures/gpx', name)

    test('import_gpx says so when the file cannot be read', async () => {
      const folder = path.join(tmp, 'gpx')
      await call('create_project', { folder, name: 'Walk' })
      const file = path.join(tmp, 'locked.gpx')
      await copyFile(gpx('track.gpx'), file)
      await chmod(file, 0o000)
      try {
        const result = await call('import_gpx', { folder, path: file })
        expect(result.isError).toBe(true)
        expect(text(result)).toContain('Fix: Check that the file is readable.')
      } finally {
        await chmod(file, 0o644)
      }
    })

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

    test('import_gpx with scene 2 fills scene 2 and the summary names it', async () => {
      const folder = path.join(tmp, 'gpx-scene')
      await call('create_project', { folder, name: 'Walk' })
      await call('update_project', { folder, ops: [{ op: 'add_scene', name: 'Hike' }] })
      const result = await call('import_gpx', { folder, scene: 2, path: gpx('track.gpx'), stops: 'waypoints' })
      expect(result.isError, text(result)).toBeFalsy()
      const lines = text(result).split('\n')
      expect(lines[0]).toBe('Changed Scene 2 of 2 · Hike.')
      expect(lines[1]).toMatch(/^Imported \d+ stops from track "Coastal Walk"/)
      const sc = result.structuredContent as { project: { scenes: { stops: unknown[] }[] }; scene: { position: number } }
      expect(sc.project.scenes[0]!.stops).toHaveLength(0)
      expect(sc.project.scenes[1]!.stops.length).toBeGreaterThan(1)
      expect(sc.scene.position).toBe(2)
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
