import { describe, expect, test } from 'vitest'
import {
  ALLOWED_FPS,
  MAP_CREDIT,
  ProjectError,
  THEME_MAX_ZOOM,
  defaultProject,
  fpsValue,
  frameSize,
  layoutSize,
  outputScale,
  parseProject,
} from '../../src/core/index.js'
import { emptyProject, greekIslands, pacific, stopsAt } from '../fixtures/projects.js'

describe('project schema', () => {
  test('default project is 4K 25p 16:9 and round-trips', () => {
    const p = defaultProject({ id: crypto.randomUUID(), name: 'Xcel', now: '2026-10-13T10:00:00Z' })
    expect(p.output).toEqual({ aspect: '16:9', height: 2160, fps: { num: 25, den: 1 } })
    expect(frameSize(p.output)).toEqual({ width: 3840, height: 2160 })
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
  })

  test('default project carries the documented defaults and no stops', () => {
    const p = emptyProject()
    expect(p.schemaVersion).toBe(1)
    expect(p.stops).toEqual([])
    expect(p.legs).toEqual([])
    expect(p.timing).toEqual({ holdStart: 1, travel: 10, holdEnd: 2 })
    expect(p.look).toEqual({
      theme: 'paper',
      labels: 'en',
      terrain: false,
      line: { color: '#d9472b', width: 4, dash: 'solid', outline: true, glow: false },
      symbol: 'dot',
      signStyle: 'tag',
    })
    expect(p.camera).toEqual({ mode: 'glide', easing: 'smooth' })
    expect(p.credit).toBe('burned')
  })

  test('default project applies output overrides', () => {
    const p = defaultProject({ id: crypto.randomUUID(), name: 'x', now: '2026-10-13T10:00:00Z', output: { height: 1080 } })
    expect(p.output).toEqual({ aspect: '16:9', height: 1080, fps: { num: 25, den: 1 } })
  })

  test('height is the short side', () => {
    expect(frameSize({ aspect: '9:16', height: 2160, fps: { num: 25, den: 1 } })).toEqual({ width: 2160, height: 3840 })
    expect(frameSize({ aspect: '4:5', height: 1080, fps: { num: 25, den: 1 } })).toEqual({ width: 1080, height: 1350 })
    expect(frameSize({ aspect: '1:1', height: 1440, fps: { num: 25, den: 1 } })).toEqual({ width: 1440, height: 1440 })
    expect(layoutSize('16:9')).toEqual({ width: 1920, height: 1080 })
    expect(layoutSize('9:16')).toEqual({ width: 1080, height: 1920 })
  })

  test('output scale and fps value', () => {
    expect(outputScale({ aspect: '16:9', height: 2160, fps: { num: 25, den: 1 } })).toBe(2)
    expect(outputScale({ aspect: '16:9', height: 1080, fps: { num: 25, den: 1 } })).toBe(1)
    expect(fpsValue({ num: 30000, den: 1001 })).toBeCloseTo(29.97, 2)
    expect(fpsValue({ num: 25, den: 1 })).toBe(25)
  })

  test('constants', () => {
    expect(ALLOWED_FPS).toHaveLength(8)
    expect(THEME_MAX_ZOOM).toEqual({ paper: 14, blank: 22 })
    expect(MAP_CREDIT).toBe('© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap')
  })

  test('fixtures are valid projects', () => {
    for (const p of [greekIslands(), pacific(), emptyProject(), stopsAt([[0, 0], [1, 1], [2, 2]])]) {
      expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
    }
    expect(greekIslands().stops.map((s) => s.name)).toEqual(['Piraeus', 'Mykonos', 'Santorini', 'Rhodes'])
    expect(greekIslands().legs).toHaveLength(3)
    expect(pacific().stops[0]!.at).toEqual([178.4419, -18.1416])
    expect(stopsAt([[0, 0], [1, 1]]).stops.map((s) => s.name)).toEqual(['S0', 'S1'])
  })

  test('rejects unknown keys with a path', () => {
    expect(() => parseProject({ ...greekIslands(), extra: 1 })).toThrow(ProjectError)
    const p = greekIslands()
    expect(() => parseProject({ ...p, look: { ...p.look, wat: 1 } })).toThrow(/look/)
  })

  test('rejects legs out of step with stops', () => {
    const p = greekIslands()
    p.legs.pop()
    expect(() => parseProject(p)).toThrow(/legs/)
  })

  test('rejects fps outside the allowed list', () => {
    expect(() =>
      parseProject(greekIslands({ output: { aspect: '16:9', height: 1080, fps: { num: 7, den: 1 } } })),
    ).toThrow(/output\.fps/)
  })

  test('accepts every allowed fps', () => {
    for (const fps of ALLOWED_FPS) {
      expect(() => parseProject(greekIslands({ output: { aspect: '16:9', height: 1080, fps } }))).not.toThrow()
    }
  })

  test('rejects lat beyond Mercator range and duplicate stop ids', () => {
    expect(() => parseProject(stopsAt([[0, 89], [1, 1]]))).toThrow(/stops\.0\.at/)
    expect(() => parseProject(stopsAt([[181, 0], [1, 1]]))).toThrow(/stops\.0\.at/)
    const p = stopsAt([[0, 0], [1, 1]])
    p.stops[0]!.id = 'a'
    p.stops[1]!.id = 'a'
    expect(() => parseProject(p)).toThrow(/id/)
  })

  test('error lists path: message lines and exposes issues', () => {
    try {
      parseProject(greekIslands({ output: { aspect: '16:9', height: 1080, fps: { num: 7, den: 1 } } }))
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ProjectError)
      const err = e as ProjectError
      expect(err.issues.length).toBeGreaterThan(0)
      expect(err.issues[0]!.path).toEqual(['output', 'fps'])
      expect(err.message).toMatch(/^output\.fps: .+/m)
    }
  })

  test('rejects out-of-range values', () => {
    const base = greekIslands()
    expect(() => parseProject({ ...base, timing: { ...base.timing, travel: -1 } })).toThrow(/timing\.travel/)
    expect(() => parseProject({ ...base, look: { ...base.look, line: { ...base.look.line, width: 41 } } })).toThrow(/look\.line\.width/)
    expect(() => parseProject({ ...base, look: { ...base.look, line: { ...base.look.line, color: 'red' } } })).toThrow(/look\.line\.color/)
    expect(() => parseProject({ ...base, look: { ...base.look, theme: 'neon' } })).toThrow(/look\.theme/)
    expect(() => parseProject({ ...base, look: { ...base.look, signStyle: 'fancy' } })).toThrow(/look\.signStyle/)
    const shot = { center: [0, 0], zoom: 23, bearing: 0, pitch: 0 }
    expect(() => parseProject({ ...base, camera: { mode: 'fixed', easing: 'linear', start: shot } })).toThrow(/camera\.start\.zoom/)
    expect(() => parseProject({ ...base, camera: { mode: 'fixed', easing: 'linear', start: { ...shot, zoom: 5, pitch: 61 } } })).toThrow(/camera\.start\.pitch/)
    expect(() => parseProject({ ...base, camera: { mode: 'fixed', easing: 'linear', start: { ...shot, zoom: 5, bearing: 181 } } })).toThrow(/camera\.start\.bearing/)
  })
})
