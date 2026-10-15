import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildRoute } from '../../src/core/index.js'
import { resolveSeaPaths } from '../../src/server/paths.js'
import { mutateProject } from '../../src/server/store.js'
import { cruise, sceneOf } from '../fixtures/projects.js'
import { closeAll, openStudioPage } from './helpers.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const MAIN = path.join(ROOT, 'dist', 'cli', 'main.js')
const PNG_SIGNATURE = '89504e470d0a1a0a'

type StudioWindow = Window & { mapperStudio: { map: MapLibreMap } }

let tmp: string
let client: Client

beforeAll(async () => {
  expect(existsSync(MAIN), `${MAIN} is missing; run npm run build`).toBe(true)
  tmp = await mkdtemp(path.join(os.tmpdir(), 'mapper-routes-e2e-'))
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
  await closeAll()
  await rm(tmp, { recursive: true, force: true })
})

const textOf = (result: CallToolResult) => result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult
  expect(result.isError, `${name}: ${textOf(result)}`).toBeFalsy()
  return result
}

test('MCP: create, set_stops with sea legs, validate, preview', async () => {
  const folder = path.join(tmp, 'sea')
  await call('create_project', { folder, name: 'Sea' })
  const set = await call('set_stops', {
    folder,
    legMode: 'sea',
    stops: [
      { name: 'Piraeus', at: [23.6466, 37.942] },
      { name: 'Mykonos', at: [25.3289, 37.4467] },
      { name: 'Santorini', at: [25.4317, 36.4166] },
    ],
  })
  await call('update_project', { folder, sceneSet: { look: { theme: 'blank' } } })

  const validation = await call('validate_project', { folder })
  const found = validation.structuredContent as { errors: unknown[]; warnings: { message?: string; code?: string }[] }
  expect(found.errors).toEqual([])
  expect(found.warnings).toEqual([])
  expect(textOf(set)).toContain('0 errors, 0 warnings')

  const frame = await call('preview_frame', { folder, at: { progress: 1 }, width: 480 })
  const image = frame.content.find((c) => c.type === 'image') as { data: string; mimeType: string } | undefined
  expect(image).toMatchObject({ mimeType: 'image/png' })
  expect(Buffer.from(image!.data, 'base64').subarray(0, 8).toString('hex')).toBe(PNG_SIGNATURE)

  const paths = JSON.parse(await readFile(path.join(folder, '.mapper', 'paths.json'), 'utf8')) as { paths: Record<string, unknown> }
  expect(Object.keys(paths.paths)).toHaveLength(2)
}, 60_000)

test('MCP: import_gpx then validate', async () => {
  const folder = path.join(tmp, 'gpx')
  await call('create_project', { folder, name: 'GPX' })
  const imported = await call('import_gpx', { folder, path: path.join(ROOT, 'test', 'fixtures', 'gpx', 'track.gpx') })
  expect(textOf(imported)).toMatch(/GPX|track/i)
  const validation = await call('validate_project', { folder })
  expect((validation.structuredContent as { errors: unknown[] }).errors).toEqual([])
  const got = await call('get_project', { folder })
  const data = got.structuredContent as { project: { scenes: { stops: unknown[] }[] } }
  expect(data.project.scenes[0]!.stops.length).toBeGreaterThanOrEqual(2)
})

test('studio draws the routed sea leg', async () => {
  const studio = await openStudioPage(cruise(), { width: 1280, height: 800 })
  const { page, folder, project } = studio
  try {
    await page.waitForSelector('[data-testid="stage"][data-shown-frame="0"]')
    const seaPaths = await resolveSeaPaths(folder, project)
    const expected = buildRoute(sceneOf(project), seaPaths).legs[0]!.path.length
    expect(expected).toBeGreaterThan(2)

    const drawn = () =>
      page.evaluate(() => {
        const map = (window as unknown as StudioWindow).mapperStudio.map
        const data = (map.getSource('mapper-edit') as unknown as { serialize(): { data: { features: { properties: { leg: number }; geometry: { coordinates: unknown[] } }[] } } }).serialize().data
        return data.features.find((f) => f.properties.leg === 0)?.geometry.coordinates.length ?? 0
      })
    await expect.poll(drawn, { timeout: 10_000 }).toBe(expected)

    // Bern to Prague is nowhere near the sea, so leg 0 falls back to a line and says why.
    await mutateProject(folder, (p) => ({
      ...p,
      scenes: [
        {
          ...sceneOf(p),
          stops: sceneOf(p).stops.map((s, i) => (i === 0 ? { ...s, at: [7.4474, 46.948] } : i === 1 ? { ...s, at: [14.4378, 50.0755] } : s)),
        },
      ],
    }))
    await page
      .getByText('No sea route found: The start stop is more than 30 km from the sea. Drawn as a line.')
      .first()
      .waitFor({ timeout: 10_000 })
  } finally {
    await studio.close()
  }
}, 60_000)
