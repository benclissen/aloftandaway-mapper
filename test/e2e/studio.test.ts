import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Map as MapLibreMap } from 'maplibre-gl'
import type { Page, WebSocketRoute } from 'playwright'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { applyPatch, buildRoute, buildTimeline, formatTimecode, pointAt, type LngLat, type Project, type Scene } from '../../src/core/index.js'
import { loadProject, mutateProject } from '../../src/server/store.js'
import { greekIslands, pacific, sceneOf, twoScenes } from '../fixtures/projects.js'
import { closeAll, openStudioPage } from './helpers.js'

afterAll(closeAll)

const VIEWPORT = { width: 1280, height: 800 }

type StudioWindow = Window & { mapperStudio: { map: MapLibreMap } }

/**
 * `project` framed on its whole route on every frame. These tests drag and click stops and legs anywhere on the route,
 * and a default glide opens on the first leg only; a fixed camera with no start shows the whole route.
 */
function wholeRoute(project: Project): Project {
  sceneOf(project).camera = { mode: 'fixed', easing: 'smooth' }
  return project
}

/** Opens the studio on the Greek Islands fixture, framed on the whole route, and waits until frame 0 is on screen. */
async function openStudio(): Promise<{ page: Page; folder: string; project: Project; close(): Promise<void> }> {
  const studio = await openStudioPage(wholeRoute(greekIslands()), VIEWPORT)
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

  test('Escape in a leg picker does not deselect the leg', async () => {
    const { page } = studio
    await page.getByTestId('leg-row-1').click()
    await expect.poll(selectedLeg).toBe('1')
    await page.getByTestId('leg-symbol-0').focus()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    expect(await selectedLeg()).toBe('1')
    await page.getByTestId('leg-symbol-0').blur()
  })

  test('Escape deselects', async () => {
    const { page } = studio
    expect(await selectedLeg()).toBe('1')
    await page.keyboard.press('Escape')
    await expect.poll(selectedLeg).toBeNull()
  })
})

test('a via point across the antimeridian sits on the line and saves within ±180', async () => {
  const { page, folder, close } = await openStudioPage(wholeRoute(pacific()), VIEWPORT)
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

describe('legs panel and style picker', () => {
  let studio: Awaited<ReturnType<typeof openStudio>>
  const leg = async (i: number) => sceneOf(await loadProject(studio.folder)).legs[i]!

  beforeAll(async () => {
    studio = await openStudio()
  })
  afterAll(async () => {
    await studio?.close()
  })

  test('lists legs', async () => {
    const { page } = studio
    await page.getByTestId('leg-row-2').waitFor()
    expect(await page.locator('[data-testid^="leg-row-"]').count()).toBe(3)
    expect(await page.getByTestId('leg-row-0').locator('.leg-title').textContent()).toBe('1 · Piraeus → Mykonos')
    expect(await page.getByTestId('leg-row-0').locator('.leg-note').count()).toBe(0)
  })

  test('transport picker sets symbol and mode', async () => {
    const { page } = studio
    await page.getByTestId('leg-symbol-0').selectOption('ferry')
    await expect.poll(async () => ({ symbol: (await leg(0)).symbol, mode: (await leg(0)).mode })).toEqual({ symbol: 'ferry', mode: 'sea' })
    // The select follows the saved project, which reaches the page a moment after the file changes.
    await expect.poll(() => page.getByTestId('leg-mode-0').inputValue()).toBe('sea')
    // The sea route settles to a path or a fallback; either way the note "Finding a sea route…" goes away.
    await expect.poll(() => page.getByTestId('leg-row-0').getByText('Finding a sea route…').count()).toBe(0)
  })

  test('Default clears the symbol', async () => {
    const { page } = studio
    await page.getByTestId('leg-symbol-0').selectOption('')
    await expect.poll(async () => 'symbol' in (await leg(0))).toBe(false)
    expect(await page.getByTestId('leg-symbol-0').inputValue()).toBe('')
  })

  test('mode picker overrides the mode', async () => {
    const { page } = studio
    await page.getByTestId('leg-mode-1').selectOption('air')
    await expect.poll(async () => (await leg(1)).mode).toBe('air')
    await page.getByTestId('leg-mode-1').selectOption('land')
    await expect.poll(async () => (await leg(1)).mode).toBe('land')
  })

  test('style picker changes the theme', async () => {
    const { page, folder } = studio
    await page.getByTestId('theme-picker').selectOption('blank')
    await expect.poll(async () => sceneOf(await loadProject(folder)).look.theme).toBe('blank')
  })

  test('style picker lists eleven styles and switches theme', async () => {
    const { page, folder } = studio
    const values = await page.getByTestId('theme-picker').locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))
    expect(values).toEqual(['aloftandaway', 'aloftandaway-warm', 'paper', 'light', 'dark', 'nautical', 'atlas', 'outdoor', 'satellite', 'monochrome', 'blank'])
    await page.getByTestId('theme-picker').selectOption('nautical')
    await expect.poll(async () => sceneOf(await loadProject(folder)).look.theme).toBe('nautical')
  })

  test('terrain toggle sets look.terrain', async () => {
    const { page, folder } = studio
    const toggle = page.getByTestId('terrain-toggle')
    expect(await toggle.isChecked()).toBe(false)
    await toggle.click()
    await expect.poll(async () => sceneOf(await loadProject(folder)).look.terrain).toBe(true)
    await expect.poll(() => toggle.isChecked()).toBe(true)
    await toggle.click()
    await expect.poll(async () => sceneOf(await loadProject(folder)).look.terrain).toBe(false)
  })

  test('transport picker shows icons', async () => {
    const { page } = studio
    // The row's current transport shows its icon: the default (a ship or a dot) or the leg's own.
    await page.getByTestId('leg-symbol-1').selectOption('car')
    await expect.poll(async () => (await leg(1)).symbol).toBe('car')
    const icon = page.getByTestId('leg-icon-1')
    await icon.locator('svg path').first().waitFor()
    expect(await icon.locator('svg').getAttribute('stroke')).toBe('currentColor')
    expect(await icon.locator('svg').getAttribute('fill')).toBe('none')
    // Picking 'none' shows no icon.
    await page.getByTestId('leg-symbol-1').selectOption('none')
    await expect.poll(() => page.getByTestId('leg-icon-1').locator('svg path').count()).toBe(0)
    await page.getByTestId('leg-symbol-1').selectOption('')
  })

  test('clicking a row selects the leg on the map', async () => {
    const { page } = studio
    await page.getByTestId('leg-row-2').click()
    await page.waitForSelector('[data-testid="stage"][data-selected-leg="2"]')
    expect(await page.getByTestId('leg-row-2').getAttribute('aria-selected')).toBe('true')
  })
})

describe('undo and redo', () => {
  const via = (p: Project) => sceneOf(p).legs[1]!.via
  const symbol = async (folder: string) => sceneOf(await loadProject(folder)).legs[0]!.symbol

  /** Leg 1's midpoint (Mykonos to Santorini) on screen, in CSS px. */
  async function legMidpoint(page: Page, folder: string): Promise<[number, number]> {
    const at = legMiddle(await loadProject(folder), 1)
    return page.evaluate((at) => {
      const map = (window as unknown as StudioWindow).mapperStudio.map
      const container = map.getContainer()
      const box = container.getBoundingClientRect()
      const fit = box.width / container.offsetWidth
      const p = map.project(at)
      return [box.left + p.x * fit, box.top + p.y * fit] as [number, number]
    }, at)
  }

  const enabled = (page: Page, testId: 'undo' | 'redo') => page.getByTestId(testId).isEnabled()

  /** Sets leg 0's transport to ferry and waits for it to save. */
  async function setFerry(page: Page, folder: string): Promise<void> {
    await page.getByTestId('leg-symbol-0').selectOption('ferry')
    await expect.poll(() => symbol(folder)).toBe('ferry')
  }

  test('undo and redo a via insert', async () => {
    const { page, folder, close } = await openStudio()
    try {
      expect(await enabled(page, 'undo')).toBe(false)
      expect(await enabled(page, 'redo')).toBe(false)
      await page.mouse.click(...(await legMidpoint(page, folder)))
      await page.waitForSelector('[data-testid="stage"][data-selected-leg="1"]')
      await page.mouse.click(...(await legMidpoint(page, folder)))
      await expect.poll(async () => via(await loadProject(folder)).length).toBe(1)
      await expect.poll(() => enabled(page, 'undo')).toBe(true)
      expect(await page.getByTestId('undo').getAttribute('title')).toBe('Undo Add a via point (⌘Z)')
      expect(await enabled(page, 'redo')).toBe(false)

      await page.getByTestId('undo').click()
      await expect.poll(async () => via(await loadProject(folder)).length).toBe(0)
      await page.getByTestId('via-marker-1-0').waitFor({ state: 'detached' })
      await expect.poll(() => enabled(page, 'redo')).toBe(true)
      expect(await page.getByTestId('redo').getAttribute('title')).toBe('Redo Add a via point (⇧⌘Z)')
      expect(await enabled(page, 'undo')).toBe(false)

      await page.getByTestId('redo').click()
      await expect.poll(async () => via(await loadProject(folder)).length).toBe(1)
      await page.getByTestId('via-marker-1-0').waitFor()
      await expect.poll(() => enabled(page, 'undo')).toBe(true)
      expect(await enabled(page, 'redo')).toBe(false)
    } finally {
      await close()
    }
  })

  test('Cmd-Z undoes a transport change', async () => {
    const { page, folder, close } = await openStudio()
    try {
      const before = sceneOf(await loadProject(folder)).legs[0]!
      await setFerry(page, folder)
      await expect.poll(() => enabled(page, 'undo')).toBe(true)
      // Out of the select, so the shortcut belongs to the studio.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.keyboard.press('Meta+z')
      await expect.poll(async () => 'symbol' in sceneOf(await loadProject(folder)).legs[0]!).toBe(false)
      expect(sceneOf(await loadProject(folder)).legs[0]!.mode).toBe(before.mode)
      await expect.poll(() => page.getByTestId('leg-symbol-0').inputValue()).toBe('')

      await page.keyboard.press('Meta+Shift+z')
      await expect.poll(() => symbol(folder)).toBe('ferry')
    } finally {
      await close()
    }
  })

  test('Cmd-Z in a select does not undo', async () => {
    const { page, folder, close } = await openStudio()
    try {
      await setFerry(page, folder)
      await expect.poll(() => enabled(page, 'undo')).toBe(true)
      await page.getByTestId('leg-symbol-0').focus()
      await page.keyboard.press('Meta+z')
      await page.waitForTimeout(500)
      expect(await symbol(folder)).toBe('ferry')
      expect(await enabled(page, 'undo')).toBe(true)
    } finally {
      await close()
    }
  })

  test('an agent write clears the history', async () => {
    const { page, folder, close } = await openStudio()
    try {
      await setFerry(page, folder)
      await expect.poll(() => enabled(page, 'undo')).toBe(true)
      await mutateProject(folder, (p) => ({ ...p, name: 'Renamed by the agent' }))
      await page.getByRole('status').filter({ hasText: 'Your agent changed the project. Undo history cleared.' }).waitFor()
      expect(await enabled(page, 'undo')).toBe(false)
      expect(await enabled(page, 'redo')).toBe(false)
    } finally {
      await close()
    }
  })

  test('a step saved before an outside change is not recorded after it', async () => {
    const { page, folder, close } = await openStudio()
    try {
      await setFerry(page, folder)
      await expect.poll(() => enabled(page, 'undo')).toBe(true)
      const cleared = page.getByRole('status').filter({ hasText: 'Your agent changed the project. Undo history cleared.' })
      // The server saves the studio's edit, the agent writes after it, and the agent's broadcast reaches the studio
      // before the response to the edit does.
      await page.route('**/patch', async (route) => {
        const response = await route.fetch()
        await mutateProject(folder, (p) => ({ ...p, name: 'Renamed by the agent' }))
        await cleared.waitFor()
        await route.fulfill({ response })
      })
      await page.getByTestId('leg-mode-1').selectOption('air')
      await expect.poll(async () => sceneOf(await loadProject(folder)).legs[1]!.mode).toBe('air')
      await expect.poll(() => page.getByTestId('leg-mode-1').inputValue()).toBe('air')
      await page.waitForTimeout(500)
      expect(await enabled(page, 'undo')).toBe(false)
    } finally {
      await close()
    }
  })

  test('undo after an unseen agent write does not overwrite it', async () => {
    const { page, folder, close } = await openStudio()
    try {
      await setFerry(page, folder)
      await expect.poll(() => enabled(page, 'undo')).toBe(true)
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      // The agent changes the same leg's transport just as the undo goes out, before the studio can hear about it.
      await page.route('**/patch', async (route) => {
        await mutateProject(folder, (p) => ({
          ...p,
          scenes: [{ ...sceneOf(p), legs: sceneOf(p).legs.map((l, i) => (i === 0 ? { ...l, symbol: 'sailboat' } : l)) }],
        }))
        await route.continue()
      })
      await page.keyboard.press('Meta+z')
      await page.getByRole('status').filter({ hasText: 'Your agent changed the project. Undo history cleared.' }).waitFor()
      expect(await symbol(folder)).toBe('sailboat')
      expect(await enabled(page, 'undo')).toBe(false)
      expect(await enabled(page, 'redo')).toBe(false)
      expect(await page.locator('.notice-error').count()).toBe(0)
    } finally {
      await close()
    }
  })

  test("clears history when the saved project's base is not the one the studio held", async () => {
    const { page, folder, close } = await openStudio()
    try {
      // The agent writes while the studio's patch is on its way, so the server applies the patch on top of that write.
      // A camera change is applied whatever the base; an index edit would be refused instead.
      await page.route('**/patch', async (route) => {
        await mutateProject(folder, (p) => ({ ...p, name: 'Renamed by the agent' }))
        await route.continue()
      })
      await page.getByRole('button', { name: 'Glide' }).click()
      await expect.poll(async () => sceneOf(await loadProject(folder)).camera.mode).toBe('glide')
      expect((await loadProject(folder)).name).toBe('Renamed by the agent')
      await page.waitForTimeout(500)
      expect(await enabled(page, 'undo')).toBe(false)
    } finally {
      await close()
    }
  })
})

describe('scene tabs', () => {
  const SAIL = '00000000-0000-4000-8000-000000000002'

  /** Opens the studio on "Drive" and "Sail", showing Drive, and waits until frame 0 is on screen. */
  async function openTwo() {
    const studio = await openStudioPage(twoScenes(), VIEWPORT)
    await studio.page.waitForSelector('[data-testid="stage"][data-shown-frame="0"]')
    return studio
  }

  const tabNames = (page: Page) => page.getByTestId('scene-tab').allTextContents()
  const activeTab = (page: Page) => page.locator('[data-testid="scene-tab"][aria-selected="true"]')
  const handles = (page: Page) => page.locator('.stop-handle')
  const sceneNames = async (folder: string) => (await loadProject(folder)).scenes.map((s) => s.name)
  const byName = async (folder: string, name: string): Promise<Scene> =>
    (await loadProject(folder)).scenes.find((s) => s.name === name)!

  /** Opens the menu of tab `i` with its button and picks `item`. */
  async function choose(page: Page, i: number, item: string, how: 'button' | 'right-click' = 'button') {
    const tab = page.locator('.scene-tab').nth(i)
    if (how === 'button') await tab.getByRole('button', { name: 'Scene menu' }).click()
    else await tab.getByRole('tab').click({ button: 'right' })
    await page.getByTestId('scene-menu').getByRole('menuitem', { name: item }).click()
  }

  async function dragStop(page: Page, id: string, dx: number, dy: number) {
    const [x, y] = (await center(page, `stop-marker-${id}`)).map(Math.round) as [number, number]
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 })
    await page.mouse.move(x + dx, y + dy, { steps: 4 })
    await page.mouse.up()
  }

  test('tabs list the scenes in order with their lengths', async () => {
    const { page, close } = await openTwo()
    try {
      expect(await tabNames(page)).toEqual(['Drive · 13 s', 'Sail · 14 s'])
      expect(await page.getByRole('tablist').count()).toBe(1)
      expect(await activeTab(page).textContent()).toBe('Drive · 13 s')
    } finally {
      await close()
    }
  })

  test("switching tabs shows that scene's stops", async () => {
    const { page, close } = await openTwo()
    try {
      await expect.poll(() => handles(page).count()).toBe(3)
      expect(await page.getByTestId('leg-row-0').textContent()).toContain('1 · Nice → Cannes')
      await page.getByTestId('scene-tab').nth(1).click()
      await expect.poll(() => handles(page).count()).toBe(4)
      await expect.poll(() => page.getByTestId('leg-row-0').textContent()).toContain('1 · Piraeus → Mykonos')
      expect(await page.locator('[data-testid^="leg-row-"]').count()).toBe(3)
      expect(await activeTab(page).textContent()).toBe('Sail · 14 s')
      await page.getByTestId('scene-tab').nth(0).click()
      await expect.poll(() => handles(page).count()).toBe(3)
    } finally {
      await close()
    }
  })

  test('switching tabs goes back to frame 0, free view off and no selected leg', async () => {
    const { page, close } = await openTwo()
    try {
      await page.getByTestId('scrubber').fill('40')
      await page.waitForSelector('[data-testid="stage"][data-shown-frame="40"]')
      await page.getByTestId('leg-row-1').click()
      await expect.poll(() => page.getByTestId('stage').getAttribute('data-selected-leg')).toBe('1')
      await page.getByTestId('scene-tab').nth(1).click()
      await page.waitForSelector('[data-testid="stage"][data-shown-frame="0"]')
      expect(await page.getByTestId('stage').getAttribute('data-selected-leg')).toBeNull()
      expect(await page.getByTestId('scrubber').inputValue()).toBe('0')
    } finally {
      await close()
    }
  })

  test('edits go to the active scene', async () => {
    const { page, folder, close } = await openTwo()
    try {
      await page.getByTestId('scene-tab').nth(1).click()
      await page.waitForSelector('[data-testid="stage"][data-shown-frame="0"]')
      await expect.poll(() => handles(page).count()).toBe(4)
      const before = await loadProject(folder)
      await dragStop(page, 'mykonos', 60, 30)
      await expect
        .poll(async () => (await byName(folder, 'Sail')).stops.find((s) => s.id === 'mykonos')!.at.join(), { timeout: 2000, interval: 100 })
        .not.toBe(before.scenes[1]!.stops[1]!.at.join())
      const after = await loadProject(folder)
      expect(after.scenes[0]).toEqual(before.scenes[0])
      expect(after.scenes[1]!.stops.filter((s) => s.id !== 'mykonos')).toEqual(before.scenes[1]!.stops.filter((s) => s.id !== 'mykonos'))

      // A scene-level edit goes to the active scene too.
      await page.getByRole('button', { name: 'Glide' }).click()
      await expect.poll(async () => (await byName(folder, 'Sail')).camera.mode).toBe('glide')
      expect((await byName(folder, 'Drive')).camera.mode).toBe('fixed')
    } finally {
      await close()
    }
  })

  test('add, rename, duplicate, move and delete a scene', async () => {
    const { page, folder, close } = await openTwo()
    try {
      // Add: a new scene after the active one, shown at once.
      await page.getByTestId('scene-add').click()
      await expect.poll(() => sceneNames(folder)).toEqual(['Drive', 'Scene 2', 'Sail'])
      await expect.poll(() => tabNames(page)).toHaveLength(3)
      await expect.poll(async () => (await activeTab(page).textContent())?.startsWith('Scene 2')).toBe(true)
      await expect.poll(() => page.getByTestId('legs-panel').textContent()).toContain('Add stops through your agent to see legs here.')
      expect(await page.getByTestId('undo').getAttribute('title')).toContain('Undo Add a scene')

      // Rename: Escape and an empty name leave it alone.
      await choose(page, 1, 'Rename')
      await page.getByTestId('scene-rename').fill('Nope')
      await page.keyboard.press('Escape')
      await page.getByTestId('scene-rename').waitFor({ state: 'detached' })
      await choose(page, 1, 'Rename')
      await page.getByTestId('scene-rename').fill('   ')
      await page.keyboard.press('Enter')
      await page.getByTestId('scene-rename').waitFor({ state: 'detached' })
      expect(await sceneNames(folder)).toEqual(['Drive', 'Scene 2', 'Sail'])
      await choose(page, 1, 'Rename')
      await page.getByTestId('scene-rename').fill('Detour')
      await page.keyboard.press('Enter')
      await expect.poll(() => sceneNames(folder)).toEqual(['Drive', 'Detour', 'Sail'])
      expect(await page.getByTestId('undo').getAttribute('title')).toContain('Undo Rename Scene 2 to Detour')
      await expect.poll(() => tabNames(page)).toEqual(['Drive · 13 s', 'Detour · 13 s', 'Sail · 14 s'])

      // Duplicate Sail: the copy sits after it and is shown.
      await choose(page, 2, 'Duplicate')
      await expect.poll(() => sceneNames(folder)).toEqual(['Drive', 'Detour', 'Sail', 'Sail copy'])
      await expect.poll(async () => (await activeTab(page).textContent())?.startsWith('Sail copy')).toBe(true)
      await expect.poll(() => handles(page).count()).toBe(4)
      expect(await page.getByTestId('undo').getAttribute('title')).toContain('Undo Duplicate Sail')

      // Move: ends are turned off, and moving doesn't change the active tab.
      await choose(page, 3, 'Move left', 'right-click')
      await expect.poll(() => sceneNames(folder)).toEqual(['Drive', 'Detour', 'Sail copy', 'Sail'])
      expect(await page.getByTestId('undo').getAttribute('title')).toContain('Undo Move Sail copy left')
      expect((await activeTab(page).textContent())?.startsWith('Sail copy')).toBe(true)
      await page.locator('.scene-tab').nth(3).getByRole('button', { name: 'Scene menu' }).click()
      expect(await page.getByRole('menuitem', { name: 'Move right' }).isDisabled()).toBe(true)
      await page.keyboard.press('Escape')
      await page.locator('.scene-tab').nth(0).getByRole('button', { name: 'Scene menu' }).click()
      expect(await page.getByRole('menuitem', { name: 'Move left' }).isDisabled()).toBe(true)
      await page.getByRole('menuitem', { name: 'Move right' }).click()
      await expect.poll(() => sceneNames(folder)).toEqual(['Detour', 'Drive', 'Sail copy', 'Sail'])
      expect(await page.getByTestId('undo').getAttribute('title')).toContain('Undo Move Drive right')

      // Delete the active scene: the one now at its place is shown, with no notice.
      await choose(page, 2, 'Delete')
      await expect.poll(() => sceneNames(folder)).toEqual(['Detour', 'Drive', 'Sail'])
      await expect.poll(async () => (await activeTab(page).textContent())?.startsWith('Sail ·')).toBe(true)
      expect(await page.getByTestId('undo').getAttribute('title')).toContain('Undo Delete Sail copy')
      // Delete the last one: the scene before it is shown.
      await choose(page, 2, 'Delete')
      await expect.poll(() => sceneNames(folder)).toEqual(['Detour', 'Drive'])
      await expect.poll(async () => (await activeTab(page).textContent())?.startsWith('Drive')).toBe(true)
      expect(await page.getByText('That scene was removed').count()).toBe(0)

      // Delete another tab: the active one stays.
      await choose(page, 0, 'Delete')
      await expect.poll(() => sceneNames(folder)).toEqual(['Drive'])
      expect((await activeTab(page).textContent())?.startsWith('Drive')).toBe(true)
      await page.locator('.scene-tab').nth(0).getByRole('button', { name: 'Scene menu' }).click()
      expect(await page.getByRole('menuitem', { name: 'Delete' }).isDisabled()).toBe(true)
    } finally {
      await close()
    }
  })

  test('reload keeps the active scene', async () => {
    const { page, close } = await openTwo()
    try {
      await page.getByTestId('scene-tab').nth(1).click()
      await expect.poll(() => new URL(page.url()).searchParams.get('scene')).toBe(SAIL)
      expect(new URL(page.url()).searchParams.get('project')).toBeTruthy()
      await page.reload()
      await page.waitForSelector('[data-testid="stage"][data-shown-frame="0"]')
      await expect.poll(async () => (await activeTab(page).textContent())?.startsWith('Sail')).toBe(true)
      await expect.poll(() => handles(page).count()).toBe(4)
    } finally {
      await close()
    }
  })

  test('an agent move keeps the active tab on the same scene', async () => {
    const { page, folder, close } = await openTwo()
    try {
      await page.getByTestId('scene-tab').nth(1).click()
      await expect.poll(() => handles(page).count()).toBe(4)
      await mutateProject(folder, (p) => applyPatch(p, { ops: [{ op: 'move_scene', id: SAIL, index: 0 }] }))
      await expect.poll(() => tabNames(page)).toEqual(['Sail · 14 s', 'Drive · 13 s'])
      expect((await activeTab(page).textContent())?.startsWith('Sail')).toBe(true)
      expect(await handles(page).count()).toBe(4)
      expect(await page.locator('.notice').count()).toBe(0)
    } finally {
      await close()
    }
  })

  test('the agent removing the active scene switches tabs with a notice', async () => {
    const { page, folder, close } = await openTwo()
    try {
      await page.getByTestId('scene-tab').nth(1).click()
      await expect.poll(() => handles(page).count()).toBe(4)
      await mutateProject(folder, (p) => applyPatch(p, { ops: [{ op: 'remove_scene', id: SAIL }] }))
      await page.getByRole('status').filter({ hasText: 'That scene was removed. Showing Drive.' }).waitFor()
      expect(await tabNames(page)).toEqual(['Drive · 13 s'])
      await expect.poll(() => handles(page).count()).toBe(3)
    } finally {
      await close()
    }
  })

  test('pressing another tab or its menu button while a scene menu is open is not lost', async () => {
    const { page, close } = await openTwo()
    try {
      const menuButton = (i: number) => page.locator('.scene-tab').nth(i).getByRole('button', { name: 'Scene menu' })
      await menuButton(0).click()
      await page.getByTestId('scene-menu').waitFor()
      await page.getByTestId('scene-tab').nth(1).click()
      await page.getByTestId('scene-menu').waitFor({ state: 'detached' })
      await expect.poll(async () => (await activeTab(page).textContent())?.startsWith('Sail')).toBe(true)

      // From Drive's menu straight to Sail's: the menu that opens is Sail's, the last, so it can't move right.
      await menuButton(0).click()
      expect(await page.getByRole('menuitem', { name: 'Move right' }).isDisabled()).toBe(false)
      await menuButton(1).click()
      await page.getByTestId('scene-menu').waitFor()
      expect(await page.getByRole('menuitem', { name: 'Move right' }).isDisabled()).toBe(true)

      // Its own ⋯ closes it, and it stays closed.
      await menuButton(1).click()
      await page.getByTestId('scene-menu').waitFor({ state: 'detached' })
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      expect(await page.getByTestId('scene-menu').count()).toBe(0)
      // A press after that opens it again.
      await menuButton(1).click()
      await page.getByTestId('scene-menu').waitFor()
    } finally {
      await close()
    }
  })

  test('undo of a stop drag on a non-first scene reverts only that scene', async () => {
    const { page, folder, close } = await openTwo()
    try {
      await page.getByTestId('scene-tab').nth(1).click()
      await expect.poll(() => handles(page).count()).toBe(4)
      const before = await loadProject(folder)
      await dragStop(page, 'mykonos', 60, 30)
      await expect
        .poll(async () => (await byName(folder, 'Sail')).stops[1]!.at.join(), { timeout: 2000, interval: 100 })
        .not.toBe(before.scenes[1]!.stops[1]!.at.join())
      await page.getByTestId('undo').click()
      await expect.poll(async () => (await loadProject(folder)).scenes).toEqual(before.scenes)
      expect((await activeTab(page).textContent())?.startsWith('Sail')).toBe(true)
    } finally {
      await close()
    }
  })

  test('undo of a via move on another tab switches back to it', async () => {
    const project = twoScenes()
    project.scenes[0]!.legs[0]!.via = [{ at: [7.14, 43.66] }]
    const { page, folder, close } = await openStudioPage(project, VIEWPORT)
    try {
      await page.waitForSelector('[data-testid="stage"][data-shown-frame="0"]')
      const sail = (await loadProject(folder)).scenes[1]
      await page.getByTestId('leg-row-0').click()
      await page.getByTestId('via-marker-0-0').waitFor()
      const [x, y] = (await center(page, 'via-marker-0-0')).map(Math.round) as [number, number]
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + 20, y + 15, { steps: 4 })
      await page.mouse.move(x + 40, y + 30, { steps: 4 })
      await page.mouse.up()
      await expect
        .poll(async () => (await byName(folder, 'Drive')).legs[0]!.via[0]!.at.join(), { timeout: 2000, interval: 100 })
        .not.toBe('7.14,43.66')

      await page.getByTestId('scene-tab').nth(1).click()
      await expect.poll(() => handles(page).count()).toBe(4)
      await page.getByTestId('undo').click()
      await expect.poll(async () => (await byName(folder, 'Drive')).legs[0]!.via[0]!.at).toEqual([7.14, 43.66])
      await expect.poll(async () => (await activeTab(page).textContent())?.startsWith('Drive')).toBe(true)
      await expect.poll(() => handles(page).count()).toBe(3)
      expect((await loadProject(folder)).scenes[1]).toEqual(sail)
    } finally {
      await close()
    }
  })

  test('undo of delete restores the scene in its place', async () => {
    const { page, folder, close } = await openTwo()
    try {
      const before = await loadProject(folder)
      await choose(page, 0, 'Delete')
      await expect.poll(() => sceneNames(folder)).toEqual(['Sail'])
      await expect.poll(async () => (await activeTab(page).textContent())?.startsWith('Sail')).toBe(true)

      await page.getByTestId('undo').click()
      await expect.poll(() => sceneNames(folder)).toEqual(['Drive', 'Sail'])
      expect((await loadProject(folder)).scenes).toEqual(before.scenes)
      await expect.poll(async () => (await activeTab(page).textContent())?.startsWith('Drive')).toBe(true)
      await expect.poll(() => handles(page).count()).toBe(3)

      // Redo deletes it again and shows the scene now in its place, without the agent's notice.
      await page.getByTestId('redo').click()
      await expect.poll(() => sceneNames(folder)).toEqual(['Sail'])
      await expect.poll(async () => (await activeTab(page).textContent())?.startsWith('Sail')).toBe(true)
      expect(await page.getByText('That scene was removed').count()).toBe(0)
    } finally {
      await close()
    }
  })

  test('redo of add shows the new scene', async () => {
    const { page, folder, close } = await openTwo()
    try {
      await page.getByTestId('scene-add').click()
      await expect.poll(() => sceneNames(folder)).toEqual(['Drive', 'Scene 2', 'Sail'])
      await expect.poll(async () => (await activeTab(page).textContent())?.startsWith('Scene 2')).toBe(true)
      const added = (await loadProject(folder)).scenes[1]

      // Undo takes away the scene on screen and goes back to the tab it was added from, without the agent's notice.
      await page.getByTestId('undo').click()
      await expect.poll(() => sceneNames(folder)).toEqual(['Drive', 'Sail'])
      await expect.poll(async () => (await activeTab(page).textContent())?.startsWith('Drive')).toBe(true)
      expect(await page.getByText('That scene was removed').count()).toBe(0)

      await page.getByTestId('redo').click()
      await expect.poll(() => sceneNames(folder)).toEqual(['Drive', 'Scene 2', 'Sail'])
      expect((await loadProject(folder)).scenes[1]).toEqual(added)
      await expect.poll(async () => (await activeTab(page).textContent())?.startsWith('Scene 2')).toBe(true)
    } finally {
      await close()
    }
  })

  test('redo of duplicate then redo of an edit on the copy works', async () => {
    const { page, folder, close } = await openTwo()
    try {
      await choose(page, 1, 'Duplicate')
      await expect.poll(() => sceneNames(folder)).toEqual(['Drive', 'Sail', 'Sail copy'])
      await expect.poll(async () => (await activeTab(page).textContent())?.startsWith('Sail copy')).toBe(true)
      await expect.poll(() => handles(page).count()).toBe(4)
      const copy = await byName(folder, 'Sail copy')
      const stop = copy.stops[1]!
      await dragStop(page, stop.id, 60, 30)
      await expect
        .poll(async () => (await byName(folder, 'Sail copy')).stops[1]!.at.join(), { timeout: 2000, interval: 100 })
        .not.toBe(stop.at.join())
      const moved = await byName(folder, 'Sail copy')

      await page.getByTestId('undo').click()
      await expect.poll(async () => (await byName(folder, 'Sail copy')).stops[1]!.at).toEqual(stop.at)
      await page.getByTestId('undo').click()
      await expect.poll(() => sceneNames(folder)).toEqual(['Drive', 'Sail'])

      // The copy comes back with the stop ids the move names.
      await page.getByTestId('redo').click()
      await expect.poll(() => sceneNames(folder)).toEqual(['Drive', 'Sail', 'Sail copy'])
      expect(await byName(folder, 'Sail copy')).toEqual(copy)
      await expect.poll(async () => (await activeTab(page).textContent())?.startsWith('Sail copy')).toBe(true)
      await page.getByTestId('redo').click()
      await expect.poll(() => byName(folder, 'Sail copy')).toEqual(moved)
      expect(await page.locator('.notice-error').count()).toBe(0)
    } finally {
      await close()
    }
  })

  test('an empty scene shows the add-stops message', async () => {
    const { page, folder, close } = await openTwo()
    try {
      await mutateProject(folder, (p) => applyPatch(p, { ops: [{ op: 'add_scene', name: 'Blank' }] }))
      await expect.poll(() => tabNames(page)).toHaveLength(3)
      await page.getByTestId('scene-tab').nth(2).click()
      await expect.poll(() => page.getByTestId('legs-panel').textContent()).toContain('Add stops through your agent to see legs here.')
      await expect.poll(() => handles(page).count()).toBe(0)
      expect(await page.locator('.notice-error').count()).toBe(0)
    } finally {
      await close()
    }
  })
})

describe('index edits', () => {
  const selectedLeg = (page: Page) => page.getByTestId('stage').getAttribute('data-selected-leg')
  /** Leg 1's via point as the studio opens, and the one the agent puts in front of it. */
  const VIA: LngLat = [25.6, 36.95]
  const AGENT_VIA: LngLat = [25.7, 37.05]
  const ROUTE_CHANGED = 'The route changed while you were editing. Try again.'

  /**
   * Opens the studio with one via point on leg 1 and that leg selected. With `socket`, the studio's WebSocket runs
   * through it first, so a test can hold the server's messages back.
   */
  async function openWithVia(socket?: (ws: WebSocketRoute) => void) {
    const project = wholeRoute(greekIslands())
    sceneOf(project).legs[1]!.via = [{ at: VIA }]
    const studio = await openStudioPage(project, VIEWPORT)
    if (socket) {
      await studio.page.routeWebSocket(/\/ws\//, socket)
      await studio.page.reload()
    }
    await studio.page.waitForSelector('[data-testid="stage"][data-shown-frame="0"]')
    await studio.page.getByTestId('leg-row-1').click()
    await studio.page.getByTestId('via-marker-1-0').waitFor()
    return { ...studio, file: path.join(studio.folder, 'mapper.json') }
  }

  /** The agent puts a via point at `at` in front of leg 1's others. */
  const agentInsertsVia = (folder: string, at: LngLat) =>
    mutateProject(folder, (p) => {
      const scene = sceneOf(p)
      return { ...p, scenes: [{ ...scene, legs: scene.legs.map((l, i) => (i === 1 ? { ...l, via: [{ at }, ...l.via] } : l)) }] }
    })

  /** How far handle `testId` is from where the map puts `at` now, in screen px. */
  async function offBy(page: Page, testId: string, at: LngLat): Promise<number> {
    const target = await page.evaluate((at) => {
      const map = (window as unknown as StudioWindow).mapperStudio.map
      const container = map.getContainer()
      const box = container.getBoundingClientRect()
      const fit = box.width / container.offsetWidth
      const p = map.project(at)
      return [box.left + p.x * fit, box.top + p.y * fit] as [number, number]
    }, at)
    const [hx, hy] = await center(page, testId)
    return Math.hypot(hx - target[0], hy - target[1])
  }

  test('a via drag is refused when the agent changes the route mid-drag', async () => {
    const { page, folder, file, close } = await openWithVia()
    try {
      const [x, y] = (await center(page, 'via-marker-1-0')).map(Math.round) as [number, number]
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + 20, y + 15, { steps: 4 })
      // The agent puts a point in front of the one held, and the studio hears of it before the drop. The held handle
      // is now the first of two, so its index points at the agent's point.
      await agentInsertsVia(folder, AGENT_VIA)
      await page.getByTestId('via-marker-1-1').waitFor()
      const saved = await readFile(file, 'utf8')
      await page.mouse.move(x + 40, y + 30, { steps: 4 })
      await page.mouse.up()
      await page.getByRole('alert').filter({ hasText: ROUTE_CHANGED }).waitFor({ timeout: 5000 })
      await page.waitForTimeout(300)
      expect(await readFile(file, 'utf8')).toBe(saved)
      // Each handle sits over its point as saved.
      await expect.poll(() => offBy(page, 'via-marker-1-0', AGENT_VIA)).toBeLessThan(2)
      expect(await offBy(page, 'via-marker-1-1', VIA)).toBeLessThan(2)
    } finally {
      await close()
    }
  })

  // The removal is pressed while a camera change is still saving, and the agent writes before the camera change
  // reaches the server. The studio learns of the write from the WebSocket, or only from the camera change's response.
  test.each([
    ['hears of the write', false],
    ['has not heard of the write', true],
  ])('a via removal queued behind a saving edit is refused after an agent write (the studio %s)', async (_, hold) => {
    const { page, folder, close } = await openWithVia((ws) => {
      const server = ws.connectToServer()
      server.onMessage((m) => {
        if (!hold) ws.send(m)
      })
    })
    try {
      let release!: () => void
      const released = new Promise<void>((resolve) => (release = resolve))
      let patches = 0
      await page.route('**/patch', async (route) => {
        if (patches++ === 0) await released
        await route.continue()
      })
      await page.getByRole('button', { name: 'Glide' }).click()
      await expect.poll(() => patches).toBe(1)
      await page.getByTestId('via-marker-1-0').focus()
      await page.keyboard.press('Delete')

      await agentInsertsVia(folder, AGENT_VIA)
      if (!hold) await page.getByTestId('via-marker-1-1').waitFor()
      release()

      await page.getByRole('alert').filter({ hasText: ROUTE_CHANGED }).waitFor({ timeout: 5000 })
      await page.waitForTimeout(300)
      const saved = sceneOf(await loadProject(folder))
      expect(saved.camera.mode).toBe('glide')
      expect(saved.legs[1]!.via.map((v) => v.at)).toEqual([AGENT_VIA, VIA])
    } finally {
      await close()
    }
  })

  test('the point menu closes when the agent changes the project', async () => {
    const { page, folder, close } = await openWithVia()
    try {
      await page.getByTestId('via-marker-1-0').click({ button: 'right' })
      const menu = page.getByTestId('point-menu')
      await menu.waitFor()
      await agentInsertsVia(folder, AGENT_VIA)
      await menu.waitFor({ state: 'detached', timeout: 5000 })
      await page.waitForTimeout(300)
      expect(sceneOf(await loadProject(folder)).legs[1]!.via.map((v) => v.at)).toEqual([AGENT_VIA, VIA])
    } finally {
      await close()
    }
  })

  test('the selected leg follows its stops when the agent inserts a stop before it', async () => {
    const { page, folder, close } = await openStudio()
    try {
      await page.getByTestId('leg-row-1').click()
      await expect.poll(() => selectedLeg(page)).toBe('1')
      // Syros goes in between Piraeus and Mykonos, so Mykonos to Santorini is now leg 2.
      await mutateProject(folder, (p) => {
        const scene = sceneOf(p)
        const syros = { ...scene.stops[1]!, id: 'syros', name: 'Syros', at: [24.9412, 37.4448] as LngLat }
        return { ...p, scenes: [{ ...scene, stops: scene.stops.toSpliced(1, 0, syros), legs: scene.legs.toSpliced(0, 0, structuredClone(scene.legs[0]!)) }] }
      })
      await expect.poll(() => selectedLeg(page)).toBe('2')
      expect(await page.getByTestId('leg-row-2').getAttribute('aria-selected')).toBe('true')
      expect(await page.getByTestId('leg-row-2').textContent()).toContain('Mykonos → Santorini')

      // With Santorini gone, Mykonos and Santorini are no longer a leg, so nothing is selected.
      await mutateProject(folder, (p) => {
        const scene = sceneOf(p)
        return { ...p, scenes: [{ ...scene, stops: scene.stops.filter((s) => s.id !== 'santorini'), legs: scene.legs.toSpliced(2, 1) }] }
      })
      await expect.poll(() => page.locator('[data-testid^="leg-row-"]').count()).toBe(3)
      await expect.poll(() => selectedLeg(page)).toBeNull()
    } finally {
      await close()
    }
  })

  test('a via drag after an unseen agent write is refused and the handle goes back', async () => {
    const project = wholeRoute(greekIslands())
    sceneOf(project).legs[1]!.via = [{ at: [25.6, 36.95] }]
    const { page, folder, close } = await openStudioPage(project, VIEWPORT)
    try {
      // The studio's WebSocket runs through here, so the test can hold the server's messages back.
      let holding = false
      const held: Array<string | Buffer> = []
      let toPage: WebSocketRoute | undefined
      await page.routeWebSocket(/\/ws\//, (ws) => {
        const server = ws.connectToServer()
        server.onMessage((m) => (holding ? held.push(m) : ws.send(m)))
        toPage = ws
      })
      await page.reload()
      await page.waitForSelector('[data-testid="stage"][data-shown-frame="0"]')
      await page.getByTestId('leg-row-1').click()
      await page.getByTestId('via-marker-1-0').waitFor()

      // The agent moves the via point, and the studio doesn't hear of it.
      holding = true
      const agentAt: LngLat = [25.7, 37.05]
      await mutateProject(folder, (p) => {
        const scene = sceneOf(p)
        return { ...p, scenes: [{ ...scene, legs: scene.legs.map((l, i) => (i === 1 ? { ...l, via: [{ at: agentAt }] } : l)) }] }
      })
      const file = path.join(folder, 'mapper.json')
      const saved = await readFile(file, 'utf8')
      /** How far the via handle is from where the map puts `at` now, in screen px. */
      const offBy = async (at: LngLat) => {
        const target = await page.evaluate((at) => {
          const map = (window as unknown as StudioWindow).mapperStudio.map
          const container = map.getContainer()
          const box = container.getBoundingClientRect()
          const fit = box.width / container.offsetWidth
          const p = map.project(at)
          return [box.left + p.x * fit, box.top + p.y * fit] as [number, number]
        }, at)
        const [hx, hy] = await center(page, 'via-marker-1-0')
        return Math.hypot(hx - target[0], hy - target[1])
      }

      const [x, y] = (await center(page, 'via-marker-1-0')).map(Math.round) as [number, number]
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + 20, y + 15, { steps: 4 })
      await page.mouse.move(x + 40, y + 30, { steps: 4 })
      await page.mouse.up()
      await page.getByRole('alert').filter({ hasText: 'The route changed while you were editing. Try again.' }).waitFor()
      expect(await readFile(file, 'utf8')).toBe(saved)
      // Back over the point as the studio last saw it.
      expect(await offBy([25.6, 36.95])).toBeLessThan(2)

      // Once the messages arrive, the handle moves to where the agent put the point.
      holding = false
      for (const m of held.splice(0)) toPage!.send(m)
      await expect.poll(() => offBy(agentAt)).toBeLessThan(2)
      expect(await readFile(file, 'utf8')).toBe(saved)
    } finally {
      await close()
    }
  })
})
