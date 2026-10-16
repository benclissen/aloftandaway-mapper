import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Map as MapLibreMap } from 'maplibre-gl'
import type { Browser, Page } from 'playwright'
import { PNG } from 'pngjs'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildRoute, pointAt, type LngLat } from '../../src/core/index.js'
import { launchBrowser } from '../../src/render/chrome.js'
import { loadProject } from '../../src/server/store.js'
import { sceneOf } from '../fixtures/projects.js'
import { pixelDiff } from './helpers.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const MAIN = path.join(ROOT, 'dist', 'cli', 'main.js')
const VIEWPORT = { width: 1280, height: 800 }

type StudioWindow = Window & { mapperStudio: { map: MapLibreMap } }

const STOPS = [
  { name: 'Piraeus', at: [23.6466, 37.942] },
  { name: 'Mykonos', at: [25.3289, 37.4467] },
  { name: 'Santorini', at: [25.4317, 36.4166], pause: 1 },
  { name: 'Rhodes', at: [28.2278, 36.451] },
]

let tmp: string
let client: Client
let browser: Browser

beforeAll(async () => {
  expect(existsSync(MAIN), `${MAIN} is missing; run npm run build`).toBe(true)
  tmp = await mkdtemp(path.join(os.tmpdir(), 'mapper-route-e2e-'))
  client = new Client({ name: 'e2e', version: '0.0.0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [MAIN, 'mcp'],
      env: { ...(process.env as Record<string, string>), MAPPER_CACHE_DIR: path.join(tmp, 'cache') },
      stderr: 'inherit',
    }),
  )
  ;({ browser } = await launchBrowser())
})

afterAll(async () => {
  await browser?.close()
  await client?.close()
  await rm(tmp, { recursive: true, force: true })
})

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult
  const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
  expect(result.isError, `${name}: ${text}`).toBeFalsy()
  return result
}

async function previewPng(folder: string): Promise<Buffer> {
  const result = await call('preview_frame', { folder, at: { progress: 1 }, width: 640 })
  const image = result.content.find((c) => c.type === 'image') as { data: string } | undefined
  expect(image).toBeDefined()
  return Buffer.from(image!.data, 'base64')
}

async function openStudio(folder: string): Promise<{ page: Page; close(): Promise<void> }> {
  const { url } = (await call('open_studio', { folder })).structuredContent as { url: string }
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 })
  const page = await context.newPage()
  page.on('pageerror', (error) => process.stderr.write(`page error: ${error.message}\n`))
  await page.goto(url)
  await page.waitForSelector('[data-testid="stage"][data-shown-frame="0"]')
  return { page, close: () => context.close() }
}

/** Where `at` is on screen, in CSS px. */
function screenPx(page: Page, at: LngLat): Promise<[number, number]> {
  return page.evaluate((at) => {
    const map = (window as unknown as StudioWindow).mapperStudio.map
    const container = map.getContainer()
    const box = container.getBoundingClientRect()
    const fit = box.width / container.offsetWidth
    const lng = at[0] + 360 * Math.round((map.getCenter().lng - at[0]) / 360)
    const p = map.project([lng, at[1]])
    return [box.left + p.x * fit, box.top + p.y * fit] as [number, number]
  }, at)
}

async function center(page: Page, testId: string): Promise<[number, number]> {
  const box = await page.getByTestId(testId).boundingBox()
  if (!box) throw new Error(`${testId} is not visible`)
  return [box.x + box.width / 2, box.y + box.height / 2]
}

test('studio edits reach the agent', async () => {
  const folder = path.join(tmp, 'greek')
  await call('create_project', { folder, name: 'Greek' })
  await call('set_stops', { folder, stops: STOPS })
  const before = await previewPng(folder)

  const { page, close } = await openStudio(folder)
  try {
    // Select leg 0, then click its middle again to insert a via point.
    const middle = async (): Promise<[number, number]> => {
      const route = buildRoute(sceneOf(await loadProject(folder)))
      return screenPx(page, pointAt(route, route.legs[0]!.length / 2).at)
    }
    await page.mouse.click(...(await middle()))
    await page.waitForSelector('[data-testid="stage"][data-selected-leg="0"]')
    await page.mouse.click(...(await middle()))
    await page.getByTestId('via-marker-0-0').waitFor()
    await expect.poll(async () => sceneOf(await loadProject(folder)).legs[0]!.via.length).toBe(1)

    // Drag it 80 px north.
    const inserted = sceneOf(await loadProject(folder)).legs[0]!.via[0]!.at
    const [x, y] = (await center(page, 'via-marker-0-0')).map(Math.round) as [number, number]
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x, y - 40, { steps: 5 })
    await page.mouse.move(x, y - 80, { steps: 5 })
    await page.mouse.up()
    await expect.poll(async () => sceneOf(await loadProject(folder)).legs[0]!.via[0]!.at[1], { timeout: 3000 }).toBeGreaterThan(inserted[1])

    // Make it sharp from the menu.
    await page.getByTestId('via-marker-0-0').click({ button: 'right' })
    await page.getByTestId('point-menu-sharp').click()
    await expect.poll(async () => sceneOf(await loadProject(folder)).legs[0]!.via[0]!.sharp).toBe(true)

    // Leg 1 goes by ferry.
    await page.getByTestId('leg-symbol-1').selectOption('ferry')
    await expect.poll(async () => sceneOf(await loadProject(folder)).legs[1]!.symbol).toBe('ferry')
  } finally {
    await close()
  }

  // The agent sees the edits.
  const got = (await call('get_project', { folder })).structuredContent as {
    project: { scenes: { legs: { via: { at: number[]; sharp?: boolean }[]; symbol?: string; mode: string }[] }[] }
  }
  const legs = got.project.scenes[0]!.legs
  expect(legs[0]!.via).toHaveLength(1)
  expect(legs[0]!.via[0]!.sharp).toBe(true)
  expect(legs[1]).toMatchObject({ symbol: 'ferry', mode: 'sea' })

  // And the preview changed.
  const after = await previewPng(folder)
  const { width, height } = PNG.sync.read(before)
  const differing = pixelDiff(before, after)
  expect(differing, `${differing} of ${width * height} pixels differ`).toBeGreaterThan(width * height * 0.005)
}, 120_000)

test('an agent edit to another scene clears history and keeps the tab', async () => {
  const folder = path.join(tmp, 'two-scenes')
  await call('create_project', { folder, name: 'Two' })
  await call('set_stops', { folder, stops: STOPS })
  await call('update_project', { folder, ops: [{ op: 'add_scene', name: 'Sail' }] })
  await call('set_stops', { folder, scene: 2, stops: STOPS.slice(0, 3) })

  const { page, close } = await openStudio(folder)
  try {
    const activeTab = () => page.locator('[data-testid="scene-tab"][aria-selected="true"]').textContent()
    await page.getByTestId('scene-tab').nth(1).click()
    await expect.poll(() => page.locator('.stop-handle').count()).toBe(3)
    await page.getByTestId('leg-symbol-0').selectOption('ferry')
    await expect.poll(async () => (await loadProject(folder)).scenes[1]!.legs[0]!.symbol).toBe('ferry')
    await expect.poll(() => page.getByTestId('undo').isEnabled()).toBe(true)

    // The agent renames scene 1 while the user is on scene 2.
    await call('update_project', { folder, scene: 1, sceneSet: { name: 'Drive' } })
    await page.getByRole('status').filter({ hasText: 'Your agent changed the project. Undo history cleared.' }).waitFor()
    expect(await page.getByTestId('undo').isEnabled()).toBe(false)
    expect((await page.getByTestId('scene-tab').first().textContent())?.startsWith('Drive')).toBe(true)
    expect((await activeTab())?.startsWith('Sail')).toBe(true)
    expect(await page.locator('.stop-handle').count()).toBe(3)
  } finally {
    await close()
  }
}, 60_000)

test('a version 1 file opens in the studio and is saved as version 2', async () => {
  const folder = path.join(tmp, 'legacy')
  await mkdir(folder, { recursive: true })
  const file = path.join(folder, 'mapper.json')
  const v1 = {
    schemaVersion: 1,
    id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    name: 'Legacy',
    createdAt: '2026-10-13T10:00:00.000Z',
    updatedAt: '2026-10-13T11:00:00.000Z',
    output: { aspect: '16:9', height: 2160, fps: { num: 25, den: 1 } },
    timing: { holdStart: 1, travel: 8, holdEnd: 2 },
    stops: [
      { id: 'piraeus', name: 'Piraeus', at: [23.6466, 37.942], pause: 0, sign: 'always' },
      { id: 'mykonos', name: 'Mykonos', at: [25.3289, 37.4467], pause: 1, sign: 'on-arrival' },
      { id: 'santorini', name: 'Santorini', at: [25.4317, 36.4166], pause: 1, sign: 'on-arrival' },
    ],
    legs: [
      { mode: 'sea', via: [[24.4, 37.9]], symbol: 'ship' },
      { mode: 'sea', via: [] },
    ],
    look: {
      theme: 'paper',
      labels: 'en',
      terrain: false,
      line: { color: '#d9472b', width: 4, dash: 'solid', outline: true, glow: false },
      symbol: 'ship',
      signStyle: 'tag',
    },
    camera: { mode: 'glide', easing: 'smooth' },
    credit: 'burned',
  }
  await writeFile(file, JSON.stringify(v1, null, 2))

  const { page, close } = await openStudio(folder)
  try {
    await page.getByTestId('leg-row-0').waitFor()
    await page.getByTestId('leg-row-1').waitFor()
    expect(JSON.parse(await readFile(file, 'utf8')).schemaVersion).toBe(1)

    await page.getByTestId('leg-symbol-1').selectOption('ferry')
    await expect.poll(async () => JSON.parse(await readFile(file, 'utf8')).schemaVersion, { timeout: 3000 }).toBe(2)
    const saved = JSON.parse(await readFile(file, 'utf8'))
    expect(saved.scenes[0].legs[0].via).toEqual([{ at: [24.4, 37.9] }])
    expect(saved.scenes[0].legs[0].symbol).toBe('cruise-ship')
    expect(saved.scenes[0].legs[1].symbol).toBe('ferry')
  } finally {
    await close()
  }
}, 60_000)
