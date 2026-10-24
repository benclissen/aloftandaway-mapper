import { describe, expect, test } from 'vitest'
import {
  ALLOWED_FPS,
  MAP_CREDIT,
  ProjectError,
  THEME_MAX_ZOOM,
  THEMES,
  SYMBOL_STYLES,
  defaultProject,
  fpsValue,
  frameSize,
  layoutSize,
  outputScale,
  parseProject,
  SYMBOLS,
  defaultModeFor,
  InputLegModeSchema,
  StopInputSchema,
  TRACK_ID,
} from '../../src/core/index.js'
import { emptyProject, greekIslands, pacific, sceneOf, stopsAt } from '../fixtures/projects.js'

describe('project schema', () => {
  test('a fixed length tolerates float error in the holds', () => {
    const p = stopsAt([[0, 0], [10, 0]], { timing: { holdStart: 0.1, travel: 0, holdEnd: 0.2, length: 0.3 } })
    expect(() => parseProject(p)).not.toThrow()
    expect(sceneOf(p).timing.holdStart + sceneOf(p).timing.holdEnd).toBeGreaterThan(0.3)
  })

  test('default project is 4K 25p 16:9 and round-trips', () => {
    const p = defaultProject({ id: crypto.randomUUID(), name: 'Xcel', now: '2026-10-13T10:00:00Z' })
    expect(p.output).toEqual({ aspect: '16:9', height: 2160, fps: { num: 25, den: 1 } })
    expect(frameSize(p.output)).toEqual({ width: 3840, height: 2160 })
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
  })

  test('default project carries the documented defaults and no stops', () => {
    const p = emptyProject()
    expect(p.schemaVersion).toBe(3)
    expect(p.scenes).toHaveLength(1)
    const scene = sceneOf(p)
    expect(scene.id).toBe(p.id)
    expect(scene.name).toBe(p.name)
    expect(scene.stops).toEqual([])
    expect(scene.legs).toEqual([])
    expect(scene.timing).toEqual({ holdStart: 1, travel: 10, holdEnd: 2 })
    expect(scene.look).toEqual({
      theme: 'aloftandaway',
      labels: 'en',
      terrain: false,
      line: { color: '#dc8376', width: 4, dash: 'solid', outline: true, glow: false },
      symbol: 'dot',
      signStyle: 'tag',
    })
    expect(scene.camera).toEqual({ mode: 'glide', easing: 'smooth' })
    expect(p.credit).toBe('burned')
  })

  test('new projects use the Aloft & Away defaults', () => {
    const look = sceneOf(emptyProject()).look
    expect(look.theme).toBe('aloftandaway')
    expect(look.line).toEqual({ color: '#dc8376', width: 4, dash: 'solid', outline: true, glow: false })
    expect('symbolStyle' in look).toBe(false)
  })

  test('accepts every theme', () => {
    expect(THEMES).toEqual([
      'aloftandaway', 'aloftandaway-warm', 'paper', 'light', 'dark', 'nautical', 'atlas', 'outdoor', 'satellite', 'monochrome', 'blank',
    ])
    for (const theme of THEMES) {
      const p = greekIslands()
      sceneOf(p).look.theme = theme
      expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
    }
    const bad = greekIslands()
    ;(sceneOf(bad).look as { theme: string }).theme = 'sepia'
    expect(() => parseProject(bad)).toThrow(/scenes\.0\.look\.theme/)
  })

  test('accepts each symbolStyle and rejects others', () => {
    expect(SYMBOL_STYLES).toEqual(['badge', 'badge-line', 'icon'])
    for (const symbolStyle of SYMBOL_STYLES) {
      const p = greekIslands()
      sceneOf(p).look.symbolStyle = symbolStyle
      expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
    }
    const bad = greekIslands()
    ;(sceneOf(bad).look as { symbolStyle: string }).symbolStyle = 'round'
    expect(() => parseProject(bad)).toThrow(/scenes\.0\.look\.symbolStyle/)
  })

  test('accepts a partial camera.follow', () => {
    for (const follow of [{}, { zoom: 9 }, { orient: 'heading' as const, pitch: 45 }, { lookAhead: 0.25, smoothing: 0.2 }]) {
      const p = greekIslands()
      sceneOf(p).camera = { mode: 'follow', easing: 'linear', follow }
      expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
    }
    const bad = greekIslands()
    sceneOf(bad).camera = { mode: 'follow', easing: 'linear', follow: { pitch: 61 } }
    expect(() => parseProject(bad)).toThrow(/camera\.follow\.pitch/)
  })

  test('accepts camera keys and rejects bad ones', () => {
    const shot = { center: [24, 37] as [number, number], zoom: 8, bearing: 0, pitch: 0 }
    const p = greekIslands()
    sceneOf(p).camera = { mode: 'glide', easing: 'smooth', keys: [{ at: 0, shot }, { at: 1.5, shot: { ...shot, zoom: 10 } }] }
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
    const withKeys = (keys: unknown) => {
      const bad = greekIslands()
      ;(sceneOf(bad).camera as { keys?: unknown }).keys = keys
      return bad
    }
    expect(() => parseProject(withKeys([]))).toThrow(/scenes\.0\.camera\.keys/)
    expect(() => parseProject(withKeys([{ at: -1, shot }]))).toThrow(/scenes\.0\.camera\.keys\.0\.at/)
    expect(() => parseProject(withKeys([{ at: 0, shot: { ...shot, zoom: 23 } }]))).toThrow(/scenes\.0\.camera\.keys\.0\.shot\.zoom/)
    expect(() => parseProject(withKeys([{ at: 0, shot, ease: 'linear' }]))).toThrow(/scenes\.0\.camera\.keys\.0/)
  })

  test('loads a stage 4 project unchanged', () => {
    const p = greekIslands()
    const look = sceneOf(p).look
    look.theme = 'paper'
    look.line.color = '#d9472b'
    delete look.symbolStyle
    const loaded = parseProject(JSON.parse(JSON.stringify(p)))
    expect(loaded).toEqual(p)
    expect(sceneOf(loaded).look.theme).toBe('paper')
    expect(sceneOf(loaded).look.line.color).toBe('#d9472b')
    expect('symbolStyle' in sceneOf(loaded).look).toBe(false)
  })

  test('default project takes a scene id', () => {
    const sceneId = crypto.randomUUID()
    const p = defaultProject({ id: crypto.randomUUID(), name: 'x', now: '2026-10-13T10:00:00Z', sceneId })
    expect(sceneOf(p).id).toBe(sceneId)
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
    expect(Object.keys(THEME_MAX_ZOOM)).toEqual([...THEMES])
    for (const t of THEMES) expect(THEME_MAX_ZOOM[t]).toBe(t === 'blank' ? 22 : 14)
    expect(MAP_CREDIT).toBe('© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap')
  })

  test('fixtures are valid projects', () => {
    for (const p of [greekIslands(), pacific(), emptyProject(), stopsAt([[0, 0], [1, 1], [2, 2]])]) {
      expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
    }
    expect(sceneOf(greekIslands()).stops.map((s) => s.name)).toEqual(['Piraeus', 'Mykonos', 'Santorini', 'Rhodes'])
    expect(sceneOf(greekIslands()).legs).toHaveLength(3)
    expect(sceneOf(pacific()).stops[0]!.at).toEqual([178.4419, -18.1416])
    expect(sceneOf(stopsAt([[0, 0], [1, 1]])).stops.map((s) => s.name)).toEqual(['S0', 'S1'])
  })

  test('rejects unknown keys with a path', () => {
    expect(() => parseProject({ ...greekIslands(), extra: 1 })).toThrow(ProjectError)
    const p = greekIslands()
    expect(() => parseProject({ ...p, scenes: [{ ...sceneOf(p), look: { ...sceneOf(p).look, wat: 1 } }] })).toThrow(/scenes\.0\.look/)
  })

  test('rejects legs out of step with stops', () => {
    const p = greekIslands()
    sceneOf(p).legs.pop()
    expect(() => parseProject(p)).toThrow(/scenes\.0\.legs/)
  })

  test('rejects fps outside the allowed list', () => {
    expect(() =>
      parseProject({ ...greekIslands(), output: { aspect: '16:9', height: 1080, fps: { num: 7, den: 1 } } }),
    ).toThrow(/output\.fps/)
  })

  test('accepts every allowed fps', () => {
    for (const fps of ALLOWED_FPS) {
      expect(() => parseProject({ ...greekIslands(), output: { aspect: '16:9', height: 1080, fps } })).not.toThrow()
    }
  })

  test('rejects lat beyond Mercator range and duplicate stop ids', () => {
    expect(() => parseProject(stopsAt([[0, 89], [1, 1]]))).toThrow(/scenes\.0\.stops\.0\.at/)
    expect(() => parseProject(stopsAt([[181, 0], [1, 1]]))).toThrow(/scenes\.0\.stops\.0\.at/)
    const p = stopsAt([[0, 0], [1, 1]])
    sceneOf(p).stops[0]!.id = 'a'
    sceneOf(p).stops[1]!.id = 'a'
    expect(() => parseProject(p)).toThrow(/scenes\.0\.stops\.1\.id/)
  })

  test('error lists path: message lines and exposes issues', () => {
    try {
      parseProject({ ...greekIslands(), output: { aspect: '16:9', height: 1080, fps: { num: 7, den: 1 } } })
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
    const scene = sceneOf(base)
    const withScene = (changes: Record<string, unknown>) => ({ ...base, scenes: [{ ...scene, ...changes }] })
    expect(() => parseProject(withScene({ timing: { ...scene.timing, travel: -1 } }))).toThrow(/scenes\.0\.timing\.travel/)
    expect(() => parseProject(withScene({ look: { ...scene.look, line: { ...scene.look.line, width: 41 } } }))).toThrow(/scenes\.0\.look\.line\.width/)
    expect(() => parseProject(withScene({ look: { ...scene.look, line: { ...scene.look.line, color: 'red' } } }))).toThrow(/scenes\.0\.look\.line\.color/)
    expect(() => parseProject(withScene({ look: { ...scene.look, theme: 'neon' } }))).toThrow(/scenes\.0\.look\.theme/)
    expect(() => parseProject(withScene({ look: { ...scene.look, signStyle: 'fancy' } }))).toThrow(/scenes\.0\.look\.signStyle/)
    expect(() => parseProject(withScene({ look: { ...scene.look, symbol: 'ship' } }))).toThrow(/scenes\.0\.look\.symbol/)
    const shot = { center: [0, 0], zoom: 23, bearing: 0, pitch: 0 }
    expect(() => parseProject(withScene({ camera: { mode: 'fixed', easing: 'linear', start: shot } }))).toThrow(/scenes\.0\.camera\.start\.zoom/)
    expect(() => parseProject(withScene({ camera: { mode: 'fixed', easing: 'linear', start: { ...shot, zoom: 5, pitch: 61 } } }))).toThrow(/scenes\.0\.camera\.start\.pitch/)
    expect(() => parseProject(withScene({ camera: { mode: 'fixed', easing: 'linear', start: { ...shot, zoom: 5, bearing: 181 } } }))).toThrow(/scenes\.0\.camera\.start\.bearing/)
    expect(() => parseProject(withScene({ legs: [{ mode: 'line', via: [[24, 37]] }, ...scene.legs.slice(1)] }))).toThrow(/scenes\.0\.legs\.0\.via\.0/)
  })

  test('rejects a scene with the wrong leg count', () => {
    const p = greekIslands()
    sceneOf(p).legs.pop()
    const e = (() => {
      try {
        parseProject(p)
      } catch (err) {
        return err as ProjectError
      }
      throw new Error('expected a ProjectError')
    })()
    expect(e).toBeInstanceOf(ProjectError)
    expect(e.issues.map((i) => i.path)).toContainEqual(['scenes', 0, 'legs'])
  })

  test('rejects duplicate scene ids', () => {
    const p = greekIslands()
    const twice = { ...p, scenes: [sceneOf(p), { ...sceneOf(p), name: 'Again' }] }
    expect(() => parseProject(twice)).toThrow(/scenes\.1\.id/)
  })

  test('rejects a project with no scenes', () => {
    expect(() => parseProject({ ...greekIslands(), scenes: [] })).toThrow(/scenes/)
  })

  test('accepts sharp on stops and via points', () => {
    const p = greekIslands()
    const scene = sceneOf(p)
    scene.stops[1]!.sharp = true
    scene.legs[0] = { mode: 'line', via: [{ at: [24, 37], sharp: true }, { at: [24.5, 37.2] }] }
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
  })
})

describe('schema version 3', () => {
  function withLeg(leg: unknown): unknown {
    const p = greekIslands()
    sceneOf(p).legs[0] = leg as never
    return JSON.parse(JSON.stringify(p))
  }
  function failureOf(json: unknown): ProjectError {
    try {
      parseProject(json)
    } catch (e) {
      expect(e).toBeInstanceOf(ProjectError)
      return e as ProjectError
    }
    throw new Error('expected the call to throw')
  }

  test('a track leg needs a track id', () => {
    const e = failureOf(withLeg({ mode: 'track', via: [] }))
    expect(e.issues).toContainEqual({
      path: ['scenes', 0, 'legs', 0, 'track'],
      message: 'a recorded track leg needs a track; import one with import_track',
    })
  })

  test('a track leg has no via points', () => {
    const e = failureOf(withLeg({ mode: 'track', track: 'abcdef012345', via: [{ at: [1, 2] }] }))
    expect(e.issues).toContainEqual({
      path: ['scenes', 0, 'legs', 0, 'via'],
      message: "a recorded track leg can't have via points; remove them or change the mode",
    })
  })

  test('a track leg with a track and no via parses', () => {
    const leg = { mode: 'track', track: 'abcdef012345', via: [] }
    expect(sceneOf(parseProject(withLeg(leg))).legs[0]).toEqual(leg)
  })

  test('track may stay on a line leg', () => {
    const leg = { mode: 'line', track: 'abcdef012345', via: [] }
    expect(sceneOf(parseProject(withLeg(leg))).legs[0]).toEqual(leg)
  })

  test('a track id is 12 hex characters', () => {
    expect(() => parseProject(withLeg({ mode: 'line', track: 'ABC', via: [] }))).toThrow(/track/)
    expect(() => parseProject(withLeg({ mode: 'line', track: 'ABCDEF012345', via: [] }))).toThrow(/track/)
    expect(TRACK_ID.test('abcdef012345')).toBe(true)
    expect(TRACK_ID.test('abcdef01234')).toBe(false)
  })

  test('timing.length must be positive', () => {
    const withLength = (length: number): unknown => {
      const p = greekIslands()
      sceneOf(p).timing = { ...sceneOf(p).timing, length }
      return JSON.parse(JSON.stringify(p))
    }
    expect(() => parseProject(withLength(0))).toThrow(/length/)
    expect(sceneOf(parseProject(withLength(8))).timing.length).toBe(8)
  })

  test('set_stops refuses legMode track', () => {
    const stop = { name: 'A', at: [1, 2] }
    expect(StopInputSchema.safeParse({ ...stop, legMode: 'track' }).success).toBe(false)
    expect(StopInputSchema.safeParse({ ...stop, legMode: 'sea' }).success).toBe(true)
    expect(InputLegModeSchema.options).toEqual(['sea', 'air', 'land', 'line'])
  })
})

describe('symbols', () => {
  test('there are 22 symbols in the documented order', () => {
    expect(SYMBOLS).toEqual([
      'none', 'dot', 'arrow', 'walk', 'bike', 'motorcycle', 'scooter', 'car', 'campervan', 'bus', 'coach',
      'train', 'tram', 'cable-car', 'ferry', 'cruise-ship', 'sailboat', 'speedboat', 'kayak',
      'plane', 'helicopter', 'balloon',
    ])
  })

  test('defaultModeFor gives each transport its leg mode', () => {
    expect(defaultModeFor('ferry')).toBe('sea')
    expect(defaultModeFor('balloon')).toBe('air')
    expect(defaultModeFor('arrow')).toBe('line')
    expect(defaultModeFor('campervan')).toBe('land')
    for (const symbol of SYMBOLS) expect(['sea', 'air', 'land', 'line']).toContain(defaultModeFor(symbol))
  })
})

describe('scene context', () => {
  const context = () => ({
    from: 'Greek Islands · Scene 1',
    stops: [
      { name: 'Piraeus', at: [23.6466, 37.942] as [number, number] },
      { name: 'Mykonos', at: [25.3289, 37.4467] as [number, number] },
    ],
    legs: [{ mode: 'sea' as const, via: [{ at: [24.5, 37.8] as [number, number], sharp: true }] }],
  })

  test('a project without context still loads, and one with context round-trips', () => {
    expect(sceneOf(parseProject(greekIslands())).context).toBeUndefined()
    const p = stopsAt([[0, 0], [1, 1]])
    sceneOf(p).context = context()
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
  })

  test('needs at least 2 stops', () => {
    const p = stopsAt([[0, 0], [1, 1]])
    sceneOf(p).context = { from: 'x', stops: [context().stops[0]!], legs: [] }
    expect(() => parseProject(p)).toThrow(/scenes\.0\.context\.stops/)
  })

  test('rejects context legs out of step with its stops', () => {
    const p = stopsAt([[0, 0], [1, 1]])
    sceneOf(p).context = { ...context(), legs: [] }
    let error: ProjectError | undefined
    try {
      parseProject(p)
    } catch (e) {
      error = e as ProjectError
    }
    expect(error?.issues).toEqual([{ path: ['scenes', 0, 'context', 'legs'], message: 'expected 1 legs for 2 stops, got 0' }])
  })

  test('rejects unknown keys on a context stop and leg', () => {
    const p = stopsAt([[0, 0], [1, 1]])
    sceneOf(p).context = { ...context(), stops: [{ ...context().stops[0]!, id: 'x' } as never, context().stops[1]!] }
    expect(() => parseProject(p)).toThrow(/scenes\.0\.context\.stops\.0\.id/)
    sceneOf(p).context = { ...context(), legs: [{ ...context().legs[0]!, symbol: 'ferry' } as never] }
    expect(() => parseProject(p)).toThrow(/scenes\.0\.context\.legs\.0\.symbol/)
  })
})
