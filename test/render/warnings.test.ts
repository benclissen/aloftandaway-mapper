import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { renderProject } from '../../src/render/render.js'
import { renderPass } from '../../src/render/render-pass.js'
import { seaLegKey, type SeaPaths } from '../../src/core/index.js'
import { describeWarnings, mergeWarnings, NO_WARNINGS, seaWarningLines } from '../../src/render/warnings.js'
import { resolveSeaPaths } from '../../src/server/paths.js'
import { saveProject } from '../../src/server/store.js'
import { twoScenes } from '../fixtures/projects.js'

vi.mock('../../src/render/chrome.js', () => ({
  launchBrowser: async () => ({ browser: { close: async () => undefined } as unknown as Browser, channel: 'chrome', webgl: 'fake' }),
}))

vi.mock('../../src/render/render-pass.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/render/render-pass.js')>()),
  renderPass: vi.fn(),
}))

vi.mock('../../src/server/paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/server/paths.js')>()),
  resolveSeaPaths: vi.fn(),
}))

let tmp: string

beforeAll(async () => {
  const { resolveSeaPaths: real } = await vi.importActual<typeof import('../../src/server/paths.js')>('../../src/server/paths.js')
  vi.mocked(resolveSeaPaths).mockImplementation(real)
  tmp = await mkdtemp(path.join(os.tmpdir(), 'mapper-warnings-'))
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const UNSETTLED = "the camera height over terrain hadn't settled, so these frames may differ slightly between renders and between layers."

describe('render warnings', () => {
  test('warnings from several passes are merged by frame', () => {
    // The map, route and signs passes of one scene each render frame 12 on their own page.
    const map = { unsettled: [40, 12], other: [] }
    const route = { unsettled: [12, 13], other: [] }
    const signs = { unsettled: [12], other: ['Something else happened.'] }
    const merged = [map, route, signs].reduce(mergeWarnings, NO_WARNINGS)
    expect(merged).toEqual({ unsettled: [12, 13, 40], other: ['Something else happened.'] })
    expect(describeWarnings(merged)).toEqual([`Frames 12, 13 and 40: ${UNSETTLED}`, 'Something else happened.'])
    // Frame numbers are the scene's own, so a multi-scene render names the scene.
    expect(describeWarnings(merged, 'Scene 2 of 2 · Sail')).toEqual([
      `Scene 2 of 2 · Sail: frames 12, 13 and 40: ${UNSETTLED}`,
      'Something else happened.',
    ])
    expect(describeWarnings({ unsettled: [7], other: [] })).toEqual([
      "Frame 7: the camera height over terrain hadn't settled, so this frame may differ slightly between renders and between layers.",
    ])
  })

  test('more than ten frames are summed up', () => {
    const unsettled = Array.from({ length: 14 }, (_, i) => i * 2)
    expect(describeWarnings({ unsettled, other: [] })).toEqual([`Frames 0, 2, 4, 6, 8, 10, 12, 14, 16, 18 and 4 more: ${UNSETTLED}`])
    const ten = Array.from({ length: 10 }, (_, i) => i + 1)
    expect(describeWarnings({ unsettled: ten, other: [] })).toEqual([`Frames 1, 2, 3, 4, 5, 6, 7, 8, 9 and 10: ${UNSETTLED}`])
  })

  test('no warnings describe as nothing', () => {
    expect(describeWarnings(NO_WARNINGS)).toEqual([])
    expect(describeWarnings({ unsettled: [], other: [] }, 'Scene 1 of 2 · Drive')).toEqual([])
    expect(mergeWarnings(NO_WARNINGS, NO_WARNINGS)).toEqual({ unsettled: [], other: [] })
  })
})

describe('a render with warnings', () => {
  test('each scene of a multi-scene render names its own frames', async () => {
    const folder = await mkdtemp(path.join(tmp, 'scenes-'))
    const project = twoScenes()
    await saveProject(folder, project)
    const [drive, sail] = project.scenes
    // Drive's map and route passes both report frame 2; Sail's route pass reports frames 1 and 3.
    const unsettled: Record<string, number[]> = { [`${drive!.id}/map`]: [2], [`${drive!.id}/route`]: [2], [`${sail!.id}/route`]: [3, 1] }
    vi.mocked(renderPass).mockImplementation(async ({ pass, onFrame, onUnsettled }) => {
      for (const frame of unsettled[`${pass.sceneId}/${pass.layer}`] ?? []) onUnsettled?.(frame)
      const frames = pass.toFrame - pass.fromFrame
      onFrame?.(frames)
      return { ...pass, frames, segments: 1, recoveries: 0 }
    })
    const reported: string[][] = []
    const result = await renderProject({ folder, layers: ['map', 'route'], onWarnings: (w) => reported.push(w) })
    const expected = [
      `Scene 1 of 2 · Drive: frame 2: the camera height over terrain hadn't settled, so this frame may differ slightly between renders and between layers.`,
      `Scene 2 of 2 · Sail: frames 1 and 3: ${UNSETTLED}`,
    ]
    expect(result.warnings).toEqual(expected)
    expect(reported.at(-1)).toEqual(expected)
    const manifest = JSON.parse(await readFile(result.manifest, 'utf8')) as { warnings?: string[] }
    expect(manifest.warnings).toEqual(expected)
  })
})

describe('unverified sea paths', () => {
  const OFFLINE = "Leg 2: the sea route was checked against Natural Earth only (OpenFreeMap couldn't be reached), so it may cross small islands."

  /** Sail's second leg by sea, with a path whose water was checked as `unverified` says (or fully when it is undefined). */
  function sailBySea(unverified?: 'offline' | 'budget' | 'unsettled') {
    const project = twoScenes()
    const sail = project.scenes[1]!
    sail.legs[1] = { ...sail.legs[1]!, mode: 'sea' }
    const [, from, to] = sail.stops.map((stop) => stop.at)
    const seaPaths: SeaPaths = {
      [seaLegKey(from!, to!, [])]: { status: 'ok', path: [from!, to!], knots: [0, 1], ...(unverified && { unverified }) },
    }
    return { project, sail, seaPaths }
  }

  test('an unverified path adds one render warning per leg', () => {
    const { sail, seaPaths } = sailBySea('offline')
    expect(seaWarningLines(sail, seaPaths)).toEqual([OFFLINE])
    const two = structuredClone(sail)
    two.legs[2] = { ...two.legs[2]!, mode: 'sea' }
    const [, , from, to] = two.stops.map((stop) => stop.at)
    const both: SeaPaths = { ...seaPaths, [seaLegKey(from!, to!, [])]: { status: 'ok', path: [from!, to!], knots: [0, 1], unverified: 'budget' } }
    expect(seaWarningLines(two, both)).toEqual([
      OFFLINE,
      'Leg 3: the sea route was checked against Natural Earth only (the project needed more map tiles at once than Mapper fetches in one go), so it may cross small islands.',
    ])
  })

  test('the cause is named for each reason, and a scene label leads on a multi-scene project', () => {
    expect(seaWarningLines(sailBySea('unsettled').sail, sailBySea('unsettled').seaPaths, 'Scene 2 of 2 · Sail')).toEqual([
      'Scene 2 of 2 · Sail: leg 2: the sea route was only partly checked (it kept finding new islands), so it may cross small islands near the ones it found.',
    ])
  })

  test('a leg that fell back while unverified has the line too', () => {
    const { sail } = sailBySea()
    const [, from, to] = sail.stops.map((stop) => stop.at)
    const fellBack: SeaPaths = { [seaLegKey(from!, to!, [])]: { status: 'fallback', reason: 'No sea route found', path: [], knots: [], unverified: 'offline' } }
    expect(seaWarningLines(sail, fellBack)).toEqual([OFFLINE])
    // One that fell back with every tile it needed has none.
    const checked: SeaPaths = { [seaLegKey(from!, to!, [])]: { status: 'fallback', reason: 'No sea route found', path: [], knots: [] } }
    expect(seaWarningLines(sail, checked)).toEqual([])
  })

  test('a verified path, a path not yet routed and a scene with no sea leg have none', () => {
    const verified = sailBySea()
    expect(seaWarningLines(verified.sail, verified.seaPaths)).toEqual([])
    expect(seaWarningLines(verified.sail, {})).toEqual([])
    expect(seaWarningLines(verified.project.scenes[0]!, verified.seaPaths)).toEqual([])
  })

  test('a render names the scene of each unverified leg, and a clean one has no warnings', async () => {
    vi.mocked(renderPass).mockImplementation(async ({ pass, onFrame }) => {
      const frames = pass.toFrame - pass.fromFrame
      onFrame?.(frames)
      return { ...pass, frames, segments: 1, recoveries: 0 }
    })
    const folder = await mkdtemp(path.join(tmp, 'unverified-'))
    const { project, seaPaths } = sailBySea('offline')
    await saveProject(folder, project)
    vi.mocked(resolveSeaPaths).mockResolvedValueOnce(seaPaths)
    const reported: string[][] = []
    const result = await renderProject({ folder, layers: ['map'], onWarnings: (w) => reported.push(w) })
    const expected = [`Scene 2 of 2 · Sail: l${OFFLINE.slice(1)}`]
    expect(result.warnings).toEqual(expected)
    expect(reported.at(-1)).toEqual(expected)
    const manifest = JSON.parse(await readFile(result.manifest, 'utf8')) as { warnings?: string[] }
    expect(manifest.warnings).toEqual(expected)

    // Only picked scenes count: Drive alone has none, Sail alone keeps its label.
    vi.mocked(resolveSeaPaths).mockResolvedValueOnce(seaPaths)
    expect((await renderProject({ folder, layers: ['map'], scenes: [2] })).warnings).toEqual(expected)
    vi.mocked(resolveSeaPaths).mockResolvedValueOnce(seaPaths)
    expect((await renderProject({ folder, layers: ['map'], scenes: [1] })).warnings).toEqual([])

    // A verified path adds nothing.
    vi.mocked(resolveSeaPaths).mockResolvedValueOnce(sailBySea().seaPaths)
    const clean = await renderProject({ folder, layers: ['map'] })
    expect(clean.warnings).toEqual([])
    expect(JSON.parse(await readFile(clean.manifest, 'utf8'))).not.toHaveProperty('warnings')
  })
})
