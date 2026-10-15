import { afterEach, describe, expect, test, vi } from 'vitest'
import { rollingProgress } from '../../src/render/render.js'
import type { RenderProgress } from '../../src/render/render.js'

describe('rollingProgress', () => {
  let now = 0
  afterEach(() => vi.restoreAllMocks())

  function clock() {
    now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
  }

  test('a page switch restarts the fps window', () => {
    clock()
    const seen: RenderProgress[] = []
    const report = rollingProgress(1000, (p) => seen.push(p), 2)
    now = 1000
    report(10, { sceneId: 'a', layer: 'map' })
    // A 30 s page load, then the next scene's route layer.
    now = 31_000
    report(20, { sceneId: 'b', layer: 'route' })
    // The window now starts at the switch, so this fps is measured on the new page alone: 10 frames in 1 s.
    now = 32_000
    report(30, { sceneId: 'b', layer: 'route' })
    expect(seen[1]!.fps).toBe(0)
    expect(seen[2]!.fps).toBe(10)
    expect(seen[2]!.layers).toBe(2)
  })

  test('frames on the same page keep the window', () => {
    clock()
    const seen: RenderProgress[] = []
    const report = rollingProgress(1000, (p) => seen.push(p))
    now = 1000
    report(10, { sceneId: 'a', layer: 'map' })
    now = 31_000
    report(20, { sceneId: 'a', layer: 'map' })
    // Same page both times, so the 30 s gap still counts: 20 frames in 31 s.
    expect(seen[1]!.fps).toBe(0.65)
    expect(seen[1]).not.toHaveProperty('layers')
  })
})
