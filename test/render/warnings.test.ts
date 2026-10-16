import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { renderProject } from '../../src/render/render.js'
import { renderPass } from '../../src/render/render-pass.js'
import { describeWarnings, mergeWarnings, NO_WARNINGS } from '../../src/render/warnings.js'
import { saveProject } from '../../src/server/store.js'
import { twoScenes } from '../fixtures/projects.js'

vi.mock('../../src/render/chrome.js', () => ({
  launchBrowser: async () => ({ browser: { close: async () => undefined } as unknown as Browser, channel: 'chrome', webgl: 'fake' }),
}))

vi.mock('../../src/render/render-pass.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/render/render-pass.js')>()),
  renderPass: vi.fn(),
}))

let tmp: string

beforeAll(async () => {
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
