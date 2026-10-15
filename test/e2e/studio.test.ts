import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Map as MapLibreMap } from 'maplibre-gl'
import type { Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { buildRoute, buildTimeline, formatTimecode, pointAt, type LngLat, type Project } from '../../src/core/index.js'
import { loadProject, mutateProject } from '../../src/server/store.js'
import { greekIslands, pacific, sceneOf } from '../fixtures/projects.js'
import { closeAll, openStudioPage } from './helpers.js'

afterAll(closeAll)

const VIEWPORT = { width: 1280, height: 800 }

type StudioWindow = Window & { mapperStudio: { map: MapLibreMap } }

/** Opens the studio on the Greek Islands fixture and waits until frame 0 is on screen. */
async function openStudio(): Promise<{ page: Page; folder: string; project: Project; close(): Promise<void> }> {
  const studio = await openStudioPage(greekIslands(), VIEWPORT)
  await studio.page.waitForSelector('[data-testid="stage"][data-shown-frame="0"]')
  return studio
}

async function stopAt(folder: string, id: string): Promise<LngLat> {
  const stop = sceneOf(await loadProject(folder)).stops.find((s) => s.id === id)
  if (!stop) throw new Error(`No stop ${id}`)
  return stop.at
}

/** The point `fraction` of the way along leg `leg` of the project's route, unwrapped as the route draws it. */
function legMiddle(project: Project, leg: number, fraction = 0.5): LngLat {
  const route = buildRoute(sceneOf(project))
  const before = route.legs.slice(0, leg).reduce((sum, l) => sum + l.length, 0)
  return pointAt(route, before + route.legs[leg]!.length * fraction).at
}

async function center(page: Page, testId: string): Promise<[number, number]> {
  const box = await page.getByTestId(testId).boundingBox()
  if (!box) throw new Error(`${testId} is not visible`)
  return [box.x + box.width / 2, box.y + box.height / 2]
}

test('scrubbing to an arrival tick shows its timecode', async () => {
  const { page, project, close } = await openStudio()
  try {
    const arrival = buildTimeline(sceneOf(project), project.output.fps, buildRoute(sceneOf(project))).arrivals.find((a) => a.stopId === 'mykonos')!
    expect(await page.locator('[data-testid="scrubber-ticks"] [title="Mykonos"]').count()).toBe(1)
    await page.getByTestId('scrubber').fill(String(arrival.frame))
    await expect.poll(() => page.getByTestId('timecode').textContent()).toBe(formatTimecode(arrival.frame, project.output.fps))
    await page.waitForSelector(`[data-testid="stage"][data-shown-frame="${arrival.frame}"]`)
  } finally {
    await close()
  }
})

test('dragging a stop saves its new position in a scaled container', async () => {
  const { page, folder, close } = await openStudio()
  try {
    // The stage really is scaled down to fit 1280×800.
    const scale = await page.evaluate(() => {
      const container = (window as unknown as StudioWindow).mapperStudio.map.getContainer()
      return container.getBoundingClientRect().width / container.offsetWidth
    })
    expect(scale).toBeLessThan(0.9)

    const before = await stopAt(folder, 'mykonos')
    const [x0, y0] = (await center(page, 'stop-marker-mykonos')).map(Math.round) as [number, number]
    await page.mouse.move(x0, y0)
    await page.mouse.down()
    await page.mouse.move(x0 + 40, y0 + 20, { steps: 4 })
    await page.mouse.move(x0 + 120, y0 + 60, { steps: 8 })
    await page.mouse.up()

    // The marker followed the mouse in screen px, so mouse positions were mapped through the scale.
    const [x1, y1] = await center(page, 'stop-marker-mykonos')
    expect(Math.abs(x1 - x0 - 120)).toBeLessThan(1)
    expect(Math.abs(y1 - y0 - 60)).toBeLessThan(1)

    // Where the marker now sits, in layout px, unprojected by the map.
    const expected = await page.evaluate(() => {
      const map = (window as unknown as StudioWindow).mapperStudio.map
      const container = map.getContainer()
      const box = container.getBoundingClientRect()
      const fit = box.width / container.offsetWidth
      const marker = document.querySelector('[data-testid="stop-marker-mykonos"]')!.getBoundingClientRect()
      const point: [number, number] = [
        (marker.left + marker.width / 2 - box.left) / fit,
        (marker.top + marker.height / 2 - box.top) / fit,
      ]
      const { lng, lat } = map.unproject(point).wrap()
      return [lng, lat] as LngLat
    })

    await expect
      .poll(async () => (await stopAt(folder, 'mykonos')).join(), { timeout: 2000, interval: 100 })
      .not.toBe(before.join())
    const at = await stopAt(folder, 'mykonos')
    expect(Math.abs(at[0] - expected[0])).toBeLessThan(1e-3)
    expect(Math.abs(at[1] - expected[1])).toBeLessThan(1e-3)
    expect(at[0]).toBeGreaterThanOrEqual(-180)
    expect(at[0]).toBeLessThanOrEqual(180)
    // Rounded to 5 decimals.
    for (const v of at) expect(Math.round(v * 1e5) / 1e5).toBe(v)
  } finally {
    await close()
  }
})

test('a drag the server rejects snaps the stop back and says why', async () => {
  const { page, folder, close } = await openStudio()
  try {
    const file = path.join(folder, 'mapper.json')
    const saved = await readFile(file, 'utf8')
    await page.route('**/patch', (route) =>
      route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Simulated failure' } }) }),
    )
    const [x0, y0] = (await center(page, 'stop-marker-mykonos')).map(Math.round) as [number, number]
    await page.mouse.move(x0, y0)
    await page.mouse.down()
    await page.mouse.move(x0 + 120, y0 + 60, { steps: 8 })
    await page.mouse.up()

    await page.getByRole('alert').filter({ hasText: 'Simulated failure' }).waitFor()
    // Back over the saved position: where the map puts the stored `at`, in screen px.
    const target = await page.evaluate(async (at) => {
      const map = (window as unknown as StudioWindow).mapperStudio.map
      const container = map.getContainer()
      const box = container.getBoundingClientRect()
      const fit = box.width / container.offsetWidth
      const p = map.project(at)
      return [box.left + p.x * fit, box.top + p.y * fit]
    }, await stopAt(folder, 'mykonos'))
    const [x1, y1] = await center(page, 'stop-marker-mykonos')
    expect(Math.abs(x1 - target[0]!)).toBeLessThan(1)
    expect(Math.abs(y1 - target[1]!)).toBeLessThan(1)
    expect(Math.abs(x1 - x0)).toBeLessThan(1)
    expect(Math.abs(y1 - y0)).toBeLessThan(1)
    expect(await readFile(file, 'utf8')).toBe(saved)
  } finally {
    await close()
  }
})

test('use this view as start shot saves the camera', async () => {
  const { page, folder, close } = await openStudio()
  try {
    expect(await page.getByTestId('free-view').count()).toBe(0)
    const box = (await page.getByTestId('stage').boundingBox())!
    // Pan from open map in the lower left, away from the stops.
    const x = box.x + box.width * 0.15
    const y = box.y + box.height * 0.85
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 150, y - 80, { steps: 10 })
    await page.mouse.up()
    await page.getByTestId('free-view').waitFor({ state: 'visible' })
    await page.waitForFunction(() => !(window as unknown as StudioWindow).mapperStudio.map.isMoving())

    // The overlay followed the pan: Mykonos's dot is drawn where the map now puts Mykonos.
    const dot = await page.evaluate(() => {
      const map = (window as unknown as StudioWindow).mapperStudio.map
      const overlay = map.getContainer().nextElementSibling as HTMLCanvasElement
      const ratio = overlay.width / map.getContainer().offsetWidth
      const p = map.project([25.3289, 37.4467])
      return [...overlay.getContext('2d')!.getImageData(Math.round(p.x * ratio), Math.round(p.y * ratio), 1, 1).data]
    })
    expect(dot[3]).toBe(255)
    expect(dot[0]).toBeGreaterThan(180)

    await page.getByTestId('use-start').click()
    await expect.poll(async () => sceneOf(await loadProject(folder)).camera.start, { timeout: 2000, interval: 100 }).toBeDefined()
    const start = sceneOf(await loadProject(folder)).camera.start!
    const view = await page.evaluate(() => {
      const map = (window as unknown as StudioWindow).mapperStudio.map
      const { lng, lat } = map.getCenter()
      return { center: [lng, lat], zoom: map.getZoom() }
    })
    expect(Math.abs(start.center[0] - view.center[0]!)).toBeLessThanOrEqual(1e-6)
    expect(Math.abs(start.center[1] - view.center[1]!)).toBeLessThanOrEqual(1e-6)
    expect(Math.abs(start.zoom - view.zoom)).toBeLessThanOrEqual(1e-4)

    // Still in free view until the user scrubs.
    expect(await page.getByTestId('free-view').isVisible()).toBe(true)
    await page.getByTestId('scrubber').fill('10')
    await page.getByTestId('free-view').waitFor({ state: 'detached' })
  } finally {
    await close()
  }
})

test('a start shot saved fully zoomed out is inside the schema', async () => {
  const { page, folder, close } = await openStudio()
  try {
    // As far out and as far north as the map lets the user go.
    const minZoom = await page.evaluate(() => {
      const map = (window as unknown as StudioWindow).mapperStudio.map
      map.jumpTo({ zoom: -5, center: [0, 89] })
      return map.getMinZoom()
    })
    expect(minZoom).toBe(0)
    await page.getByTestId('use-start').click()
    await expect.poll(async () => sceneOf(await loadProject(folder)).camera.start, { timeout: 2000, interval: 100 }).toBeDefined()
    const start = sceneOf(await loadProject(folder)).camera.start!
    expect(start.zoom).toBeGreaterThanOrEqual(0)
    expect(Math.abs(start.center[1])).toBeLessThanOrEqual(85.0511)
    expect(await page.locator('.notice-error').count()).toBe(0)
  } finally {
    await close()
  }
})

test('external edits appear live', async () => {
  const { page, folder, close } = await openStudio()
  try {
    const marker = '[data-testid="stop-marker-mykonos"]'
    expect(await page.getAttribute(marker, 'title')).toBe('Mykonos')
    await mutateProject(folder, (p) => ({
      ...p,
      scenes: [{ ...sceneOf(p), stops: sceneOf(p).stops.map((s) => (s.id === 'mykonos' ? { ...s, name: 'Mykonos Town' } : s)) }],
    }))
    await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('title') === 'Mykonos Town', marker, {
      timeout: 1000,
    })
  } finally {
    await close()
  }
})

describe('route editing on the map', () => {
  let studio: Awaited<ReturnType<typeof openStudio>>
  const via = (p: Project) => sceneOf(p).legs[1]!.via

  beforeAll(async () => {
    studio = await openStudio()
  })
  afterAll(async () => {
    await studio?.close()
  })

  /** Where `at` is on screen, in CSS px, taking the world copy nearest the map's centre. */
  async function screenPx(at: LngLat): Promise<[number, number]> {
    return studio.page.evaluate((at) => {
      const map = (window as unknown as StudioWindow).mapperStudio.map
      const container = map.getContainer()
      const box = container.getBoundingClientRect()
      const fit = box.width / container.offsetWidth
      const lng = at[0] + 360 * Math.round((map.getCenter().lng - at[0]) / 360)
      const p = map.project([lng, at[1]])
      return [box.left + p.x * fit, box.top + p.y * fit] as [number, number]
    }, at)
  }

  /** The screen position of the middle of leg 1 (Mykonos to Santorini) as saved. */
  async function legMidpoint(): Promise<[number, number]> {
    return screenPx(legMiddle(await loadProject(studio.folder), 1))
  }

  const selectedLeg = () => studio.page.getByTestId('stage').getAttribute('data-selected-leg')

  test('selects a leg by clicking its line', async () => {
    const { page } = studio
    expect(await page.evaluate(() => (window as unknown as StudioWindow).mapperStudio.map.getLayer('mapper-edit-route') !== undefined)).toBe(true)
    expect(await selectedLeg()).toBeNull()
    await page.mouse.click(...(await legMidpoint()))
    await expect.poll(selectedLeg).toBe('1')
    // Selecting saves nothing.
    expect(via(await loadProject(studio.folder))).toEqual([])
  })

  test('inserts a via point on the selected leg and the file has it', async () => {
    const { page, folder } = studio
    await page.mouse.click(...(await legMidpoint()))
    await page.getByTestId('via-marker-1-0').waitFor()
    await expect.poll(async () => via(await loadProject(folder)).length).toBe(1)
    const marker = page.getByTestId('via-marker-1-0')
    expect(await marker.getAttribute('tabindex')).toBe('0')
    expect(await marker.getAttribute('aria-label')).toBe('Via point 1 of leg 2')
    const [point] = via(await loadProject(folder))
    for (const v of point!.at) expect(Math.round(v * 1e5) / 1e5).toBe(v)
  })

  test('drags a via point', async () => {
    const { page, folder } = studio
    const before = via(await loadProject(folder))[0]!.at
    const [x, y] = (await center(page, 'via-marker-1-0')).map(Math.round) as [number, number]
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 20, y + 15, { steps: 4 })
    await page.mouse.move(x + 40, y + 30, { steps: 4 })
    await page.mouse.up()
    await expect.poll(async () => via(await loadProject(folder))[0]!.at.join(), { timeout: 2000, interval: 100 }).not.toBe(before.join())
    const after = via(await loadProject(folder))
    expect(after.length).toBe(1)
    // Down and to the right: east and south.
    expect(after[0]!.at[0]).toBeGreaterThan(before[0])
    expect(after[0]!.at[1]).toBeLessThan(before[1])
  })

  test('clicking a via handle does not insert a point', async () => {
    const { page, folder } = studio
    await page.getByTestId('via-marker-1-0').click()
    await page.waitForTimeout(500)
    expect(via(await loadProject(folder)).length).toBe(1)
    expect(await selectedLeg()).toBe('1')
  })

  test('Alt-click and the menu toggle sharp', async () => {
    const { page, folder } = studio
    await page.getByTestId('stop-marker-mykonos').click({ modifiers: ['Alt'] })
    await expect.poll(async () => sceneOf(await loadProject(folder)).stops.find((s) => s.id === 'mykonos')!.sharp).toBe(true)
    await expect.poll(() => page.getByTestId('stop-marker-mykonos').getAttribute('class')).toMatch(/\bsharp\b/)

    await page.getByTestId('via-marker-1-0').click({ button: 'right' })
    const menu = page.getByTestId('point-menu')
    await menu.waitFor()
    expect(await page.getByTestId('point-menu-remove').textContent()).toBe('Remove')
    const sharp = page.getByTestId('point-menu-sharp')
    expect(await sharp.textContent()).toBe('Sharp corner')
    await sharp.click()
    await menu.waitFor({ state: 'detached' })
    await expect.poll(async () => via(await loadProject(folder))[0]!.sharp).toBe(true)
    await expect.poll(() => page.getByTestId('via-marker-1-0').getAttribute('class')).toMatch(/\bsharp\b/)

    // The menu offers the way back, and Escape closes it without a change.
    await page.getByTestId('via-marker-1-0').click({ button: 'right' })
    expect(await page.getByTestId('point-menu-sharp').textContent()).toBe('Curve through')
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached' })
    expect(await selectedLeg()).toBe('1')

    // Alt-click curves the stop through again, which removes the key.
    await page.getByTestId('stop-marker-mykonos').click({ modifiers: ['Alt'] })
    await expect.poll(async () => 'sharp' in sceneOf(await loadProject(folder)).stops.find((s) => s.id === 'mykonos')!).toBe(false)
  })

  test('a click that dismisses the menu does not edit the route', async () => {
    const { page, folder } = studio
    await page.getByTestId('via-marker-1-0').click({ button: 'right' })
    const menu = page.getByTestId('point-menu')
    await menu.waitFor()
    // On the selected leg, away from the handle: without the menu open this click would add a via point.
    await page.mouse.click(...(await screenPx(legMiddle(await loadProject(folder), 1, 0.25))))
    await menu.waitFor({ state: 'detached' })
    await page.waitForTimeout(500)
    expect(via(await loadProject(folder)).length).toBe(1)
    expect(await selectedLeg()).toBe('1')
  })

  test('removes a via point with Delete', async () => {
    const { page, folder } = studio
    await page.getByTestId('via-marker-1-0').focus()
    await page.keyboard.press('Delete')
    await expect.poll(async () => via(await loadProject(folder)).length).toBe(0)
    await page.getByTestId('via-marker-1-0').waitFor({ state: 'detached' })
  })

  test('Escape deselects', async () => {
    const { page } = studio
    expect(await selectedLeg()).toBe('1')
    await page.keyboard.press('Escape')
    await expect.poll(selectedLeg).toBeNull()
  })
})

test('a via point across the antimeridian sits on the line and saves within ±180', async () => {
  const { page, folder, close } = await openStudioPage(pacific(), VIEWPORT)
  try {
    await page.waitForSelector('[data-testid="stage"][data-shown-frame="0"]')
    const mid = legMiddle(await loadProject(folder), 0)
    // Past 180° east: the leg is drawn unwrapped from Suva to Apia.
    expect(mid[0]).toBeGreaterThan(180)
    const [x, y] = await page.evaluate((at) => {
      const map = (window as unknown as StudioWindow).mapperStudio.map
      const container = map.getContainer()
      const box = container.getBoundingClientRect()
      const fit = box.width / container.offsetWidth
      const lng = at[0] + 360 * Math.round((map.getCenter().lng - at[0]) / 360)
      const p = map.project([lng, at[1]])
      return [box.left + p.x * fit, box.top + p.y * fit]
    }, mid)
    await page.mouse.click(x!, y!)
    await page.waitForSelector('[data-testid="stage"][data-selected-leg="0"]')
    await page.mouse.click(x!, y!)
    await page.getByTestId('via-marker-0-0').waitFor()
    const [hx, hy] = await center(page, 'via-marker-0-0')
    expect(Math.abs(hx - x!)).toBeLessThan(3)
    expect(Math.abs(hy - y!)).toBeLessThan(3)
    const [point] = sceneOf(await loadProject(folder)).legs[0]!.via
    expect(point!.at[0]).toBeGreaterThanOrEqual(-180)
    expect(point!.at[0]).toBeLessThanOrEqual(180)
    expect(Math.abs(point!.at[0] - (mid[0] - 360))).toBeLessThan(0.1)
  } finally {
    await close()
  }
})
