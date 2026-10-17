import { describe, expect, test, vi } from 'vitest'
import {
  NO_LAND_DATA,
  SYMBOLS,
  SYMBOL_STYLES,
  seaLegKey,
  validateProject,
  type Issue,
  type Project,
  type SeaPaths,
} from '../../src/core/index.js'
import { signBox } from '../../src/core/signs.js'
import { emptyProject, greekIslands, pacific, projectWithScenes, sceneOf, stopsAt } from '../fixtures/projects.js'

vi.mock('../../src/core/signs.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/signs.js')>()
  return { ...real, signBox: vi.fn(real.signBox) }
})

const paperLook = { ...sceneOf(greekIslands()).look, theme: 'paper' as const }

const codes = (issues: Issue[]) => issues.map((i) => i.code)

describe('validateProject', () => {
  test('the Greek islands project has no errors and no warnings', () => {
    expect(validateProject(greekIslands())).toEqual({ errors: [], warnings: [] })
  })

  test('the Pacific project has no errors and no warnings', () => {
    expect(validateProject(pacific())).toEqual({ errors: [], warnings: [] })
  })

  test('an empty project gives exactly too-few-stops', () => {
    const { errors, warnings } = validateProject(emptyProject())
    expect(errors).toEqual([
      expect.objectContaining({ code: 'too-few-stops', path: ['scenes', 0, 'stops'] }),
    ])
    expect(errors).toHaveLength(1)
    expect(warnings).toEqual([])
  })

  test('one stop is an error, and short-leg and zoom checks are skipped', () => {
    const project = stopsAt([[25, 37]], {
      look: paperLook,
      timing: { holdStart: 1, travel: 0, holdEnd: 0 },
      camera: { mode: 'glide', easing: 'smooth', start: { center: [25, 37], zoom: 20, bearing: 0, pitch: 0 } },
    })
    const { errors, warnings } = validateProject(project)
    expect(codes(errors)).toEqual(['too-few-stops'])
    expect(warnings).toEqual([])
  })

  test('same-place is a warning on the second stop of a close pair', () => {
    const project = stopsAt([
      [25.3289, 37.4467],
      [25.3289, 37.4467],
      [25.4317, 36.4166],
    ])
    const { errors, warnings } = validateProject(project)
    expect(errors).toEqual([])
    const found = warnings.filter((w) => w.code === 'same-place')
    expect(found).toEqual([
      expect.objectContaining({ path: ['scenes', 0, 'stops', 1], fix: expect.stringContaining('pause') }),
    ])
    expect(found[0]!.message).toContain('S0 and S1')
  })

  test('short-leg is a warning on each leg under one second', () => {
    const project = stopsAt(
      [
        [23.6466, 37.942],
        [25.3289, 37.4467],
        [25.4317, 36.4166],
      ],
      { timing: { holdStart: 1, travel: 1, holdEnd: 2 } },
    )
    const { errors, warnings } = validateProject(project)
    expect(errors).toEqual([])
    const legs = warnings.filter((w) => w.code === 'short-leg')
    expect(legs.map((w) => w.path)).toEqual([['scenes', 0, 'legs', 0], ['scenes', 0, 'legs', 1]])
    expect(legs[0]!.message).toBe('Leg 1 (S0 → S1) lasts 0.5 s')
    expect(legs[0]!.fix).toBeTruthy()
  })

  test('zoom-above-max names a stored shot by its path', () => {
    const project = stopsAt([
      [23.6466, 37.942],
      [25.3289, 37.4467],
    ], {
      look: paperLook,
      camera: {
        mode: 'glide',
        easing: 'smooth',
        start: { center: [23.6466, 37.942], zoom: 15, bearing: 0, pitch: 0 },
      },
    })
    const { errors, warnings } = validateProject(project)
    expect(errors).toEqual([])
    expect(warnings).toEqual([
      expect.objectContaining({ code: 'zoom-above-max', path: ['scenes', 0, 'camera', 'start', 'zoom'] }),
    ])
  })

  test('zoom-above-max reports fitted shots once, at the camera path', () => {
    const project = stopsAt([
      [25, 37],
      [25.01, 37],
    ], { look: paperLook })
    const { errors, warnings } = validateProject(project)
    expect(errors).toEqual([])
    expect(warnings.filter((w) => w.code === 'zoom-above-max')).toEqual([
      expect.objectContaining({ path: ['scenes', 0, 'camera'], fix: expect.stringContaining('blank') }),
    ])
    // One leg: the default start is the first stop, capped at the theme's maximum, so only the end is over it.
    const only = warnings.find((w) => w.code === 'zoom-above-max')!
    expect(only.message).toContain('fitted end view is at zoom')
    // The agent can't see a fitted shot in the project, so the fix says where to find it.
    expect(only.fix).toContain('update_project sceneSet')
    expect(only.fix).toContain('camera.end')
    expect(only.fix).not.toContain('camera.start')
    expect(only.fix).toContain('camera.resolvedEnd')
    expect(only.fix).not.toContain('resolvedStart')
    // Both fitted shots over the maximum: still one warning, naming both.
    sceneOf(project).camera = { mode: 'fixed', easing: 'smooth' }
    const both = validateProject(project).warnings.filter((w) => w.code === 'zoom-above-max')
    expect(both).toEqual([expect.objectContaining({ path: ['scenes', 0, 'camera'] })])
    expect(both[0]!.message).toContain('fitted start and end views are at zoom 16')
    expect(both[0]!.fix).toContain('scenes[0].camera.resolvedStart and scenes[0].camera.resolvedEnd')
  })

  test("zoom fix string names the scene's index", () => {
    const project = projectWithScenes(2)
    const close = sceneOf(stopsAt([[25, 37], [25.01, 37]], { look: paperLook, camera: { mode: 'fixed', easing: 'smooth' } }))
    project.scenes[1] = { ...close, id: project.scenes[1]!.id }
    const warning = validateProject(project).warnings.find((w) => w.code === 'zoom-above-max')!
    expect(warning.path).toEqual(['scenes', 1, 'camera'])
    expect(warning.fix).toContain('scenes[1].camera.resolvedStart and scenes[1].camera.resolvedEnd')
    expect(warning.fix).not.toContain('scenes[0]')
  })

  test('a short first hop gives no zoom-above-max warning', () => {
    // The default glide opens on the 1 km hop, but no closer than the paper theme's maximum.
    const project = stopsAt([
      [25, 37],
      [25.01, 37],
      [27, 37],
    ], { look: paperLook })
    expect(codes(validateProject(project).warnings)).not.toContain('zoom-above-max')
  })

  test('sea and air legs are not warnings', () => {
    const project = greekIslands()
    sceneOf(project).legs[0] = { ...sceneOf(project).legs[0]!, mode: 'sea' }
    sceneOf(project).legs[1] = { ...sceneOf(project).legs[1]!, mode: 'air' }
    expect(validateProject(project)).toEqual({ errors: [], warnings: [] })
  })

  test('sea legs are measured along their seaPaths', () => {
    const project = greekIslands()
    const scene = sceneOf(project)
    scene.legs[0] = { ...scene.legs[0]!, mode: 'sea' }
    expect(validateProject(project).warnings).toEqual([])
    // A sea path that wanders far away takes nearly all the travel time from the other legs.
    const [from, to] = [scene.stops[0]!.at, scene.stops[1]!.at]
    const seaPaths: SeaPaths = {
      [seaLegKey(from, to, [])]: { status: 'ok', path: [from, [60, -60], to], knots: [0, 2] },
    }
    expect(codes(validateProject(project, { seaPaths }).warnings)).toContain('short-leg')
  })

  test('follow no longer warns as unavailable', () => {
    const project = greekIslands()
    sceneOf(project).camera = { ...sceneOf(project).camera, mode: 'follow' }
    expect(validateProject(project)).toEqual({ errors: [], warnings: [] })
  })

  test('follow.zoom above the theme maximum warns', () => {
    const project = greekIslands({
      look: paperLook,
      camera: { mode: 'follow', easing: 'smooth', follow: { zoom: 15, orient: 'north', lookAhead: 1, smoothing: 0.5 } },
    })
    expect(validateProject(project).warnings).toEqual([
      expect.objectContaining({
        code: 'zoom-above-max',
        path: ['scenes', 0, 'camera', 'follow', 'zoom'],
        fix: expect.stringContaining('camera.follow.zoom'),
      }),
    ])
    sceneOf(project).camera.follow!.zoom = 14
    expect(validateProject(project).warnings).toEqual([])
  })

  test('validate no longer warns for terrain', () => {
    const project = greekIslands()
    sceneOf(project).look = { ...sceneOf(project).look, terrain: true }
    expect(validateProject(project).warnings).toEqual([])
  })

  test('validate no longer warns for transport symbols', () => {
    for (const symbol of ['none', 'dot', 'arrow', 'car', 'cruise-ship', 'plane', 'helicopter', 'balloon'] as const) {
      const project = greekIslands()
      sceneOf(project).look = { ...sceneOf(project).look, symbol }
      expect(validateProject(project).warnings).toEqual([])
    }
  })

  test('no buildable project emits not-available-yet', () => {
    // Every look option and leg mode the schema allows, on one project at a time.
    const modes = ['line', 'sea', 'air'] as const
    for (const symbol of SYMBOLS) {
      for (const symbolStyle of SYMBOL_STYLES) {
        const project = greekIslands()
        const scene = sceneOf(project)
        scene.look = { ...scene.look, terrain: true, symbol, symbolStyle }
        scene.legs = scene.legs.map((leg, i) => ({ ...leg, mode: modes[i % modes.length]!, symbol }))
        scene.camera = { ...scene.camera, mode: 'follow', follow: { zoom: 12, orient: 'north', lookAhead: 1, smoothing: 0.5 } }
        const { errors, warnings } = validateProject(project)
        expect(codes([...errors, ...warnings])).not.toContain('not-available-yet')
      }
    }
  })

  test('satellite warns for a shot over zoom 14, and not at 14', () => {
    const satellite = (zoom: number) =>
      stopsAt([
        [23.6466, 37.942],
        [25.3289, 37.4467],
      ], {
        look: { ...sceneOf(greekIslands()).look, theme: 'satellite' },
        camera: { mode: 'glide', easing: 'smooth', start: { center: [23.6466, 37.942], zoom, bearing: 0, pitch: 0 } },
      })
    const over = validateProject(satellite(15)).warnings.filter((w) => w.code === 'zoom-above-max')
    expect(over).toEqual([expect.objectContaining({ path: ['scenes', 0, 'camera', 'start', 'zoom'] })])
    expect(over[0]!.message).toContain('satellite theme')
    expect(over[0]!.message).toContain('zoom 14')
    expect(codes(validateProject(satellite(14)).warnings)).not.toContain('zoom-above-max')
  })

  test('terrain with no tilt gives no warning', () => {
    const project = stopsAt([
      [6.8694, 45.9237],
      [6.9724, 45.7967],
    ], {
      look: { ...sceneOf(greekIslands()).look, theme: 'outdoor', terrain: true },
      camera: {
        mode: 'glide',
        easing: 'smooth',
        start: { center: [6.8694, 45.9237], zoom: 9, bearing: 0, pitch: 0 },
        end: { center: [6.9724, 45.7967], zoom: 9, bearing: 0, pitch: 0 },
      },
    })
    expect(validateProject(project)).toEqual({ errors: [], warnings: [] })
  })

  test('every issue has a path and a fix sentence', () => {
    const project: Project = stopsAt(
      [
        [25, 37],
        [25.001, 37],
        [25.01, 37],
      ],
      {
        look: { ...paperLook, terrain: true, symbol: 'car' },
        camera: { mode: 'follow', easing: 'smooth' },
        timing: { holdStart: 1, travel: 1, holdEnd: 2 },
      },
    )
    sceneOf(project).legs[1] = { ...sceneOf(project).legs[1]!, mode: 'sea' }
    const { errors, warnings } = validateProject(project)
    const issues = [...errors, ...warnings]
    expect(issues.length).toBeGreaterThan(3)
    for (const issue of issues) {
      expect(issue.path?.length).toBeGreaterThan(0)
      expect(issue.fix?.length).toBeGreaterThan(0)
    }
  })

  test('two identical stops do not throw', () => {
    const { errors, warnings } = validateProject(stopsAt([[25, 37], [25, 37]], { look: paperLook }))
    expect(errors).toEqual([])
    expect(codes(warnings)).toContain('same-place')
  })

  test('every scene is checked, with paths under its index', () => {
    const project = greekIslands()
    const second = { ...sceneOf(stopsAt([[25, 37]])), id: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', name: 'Second' }
    project.scenes.push(second)
    const { errors } = validateProject(project)
    expect(errors).toEqual([expect.objectContaining({ code: 'too-few-stops', path: ['scenes', 1, 'stops'] })])
  })

  describe('sea and sign warnings', () => {
    const seaProject = () => {
      const project = greekIslands()
      const scene = sceneOf(project)
      scene.legs[0] = { ...scene.legs[0]!, mode: 'sea' }
      const key = seaLegKey(scene.stops[0]!.at, scene.stops[1]!.at, [])
      return { project, key, from: scene.stops[0]!.at, to: scene.stops[1]!.at }
    }

    test('warns when a sea leg falls back', () => {
      const { project, key } = seaProject()
      const seaPaths: SeaPaths = { [key]: { status: 'fallback', reason: 'no water near Piraeus', path: [], knots: [] } }
      const found = validateProject(project, { seaPaths }).warnings.filter((w) => w.code === 'sea-fallback')
      expect(found).toEqual([
        expect.objectContaining({
          path: ['scenes', 0, 'legs', 0, 'mode'],
          message: 'Leg 1 (Piraeus → Mykonos) has no sea route: no water near Piraeus',
          fix: expect.stringContaining('insert_via'),
        }),
      ])
    })

    test('points at the land data when a sea leg falls back for lack of it', () => {
      const { project, key } = seaProject()
      const seaPaths: SeaPaths = { [key]: { status: 'fallback', reason: NO_LAND_DATA, path: [], knots: [] } }
      const [found] = validateProject(project, { seaPaths }).warnings.filter((w) => w.code === 'sea-fallback')
      expect(found?.message).toBe(`Leg 1 (Piraeus → Mykonos) has no sea route: ${NO_LAND_DATA}`)
      expect(found?.fix).toContain('build:land')
      expect(found?.fix).not.toContain('insert_via')
    })

    test('warns when a sea route crosses land', () => {
      const { project, key, from, to } = seaProject()
      const seaPaths: SeaPaths = {
        [key]: { status: 'ok', path: [from, to], knots: [0, 1], crossesLand: [24.123456, 37.5] },
      }
      const found = validateProject(project, { seaPaths }).warnings.filter((w) => w.code === 'sea-crosses-land')
      expect(found).toEqual([
        expect.objectContaining({
          path: ['scenes', 0, 'legs', 0, 'via'],
          message: "Leg 1 (Piraeus → Mykonos)'s sea route crosses land near [24.1235, 37.5000]",
        }),
      ])
    })

    describe('sea-unverified', () => {
      const unverifiedFor = (unverified: 'offline' | 'budget' | 'unsettled') => {
        const { project, key, from, to } = seaProject()
        const seaPaths: SeaPaths = { [key]: { status: 'ok', path: [from, to], knots: [0, 1], unverified } }
        return validateProject(project, { seaPaths }).warnings.filter((w) => w.code === 'sea-unverified')
      }

      test.each([
        ['offline', "because OpenFreeMap couldn't be reached.", 'Reconnect to the internet; Mapper routes the leg again by itself within a minute. Then validate again.'],
        ['budget', "because the project needed more map tiles at once than Mapper fetches in one go.", 'Validate again in a minute; Mapper carries on where it stopped.'],
        ['unsettled', 'because the route kept finding new islands.', 'Add a via point over open water with insert_via to steer it.'],
      ] as const)('warns for %s', (reason, because, fix) => {
        expect(unverifiedFor(reason)).toEqual([
          {
            code: 'sea-unverified',
            message: `Leg 1 (Piraeus → Mykonos)'s sea route was checked against Natural Earth only, ${because} It may cross small islands.`,
            path: ['scenes', 0, 'legs', 0],
            fix,
          },
        ])
      })

      test('names the leg by its number', () => {
        const project = greekIslands()
        const scene = sceneOf(project)
        scene.legs[1] = { ...scene.legs[1]!, mode: 'sea' }
        const key = seaLegKey(scene.stops[1]!.at, scene.stops[2]!.at, [])
        const seaPaths: SeaPaths = { [key]: { status: 'ok', path: [scene.stops[1]!.at, scene.stops[2]!.at], knots: [0, 1], unverified: 'offline' } }
        const [found] = validateProject(project, { seaPaths }).warnings.filter((w) => w.code === 'sea-unverified')
        expect(found?.message.startsWith("Leg 2 (")).toBe(true)
        expect(found?.path).toEqual(['scenes', 0, 'legs', 1])
      })

      test('a verified path has none', () => {
        const { project, key, from, to } = seaProject()
        const seaPaths: SeaPaths = { [key]: { status: 'ok', path: [from, to], knots: [0, 1] } }
        expect(codes(validateProject(project, { seaPaths }).warnings)).not.toContain('sea-unverified')
      })
    })

    describe('sea-stop-far', () => {
      const withGap = (stopGapKm?: [number, number]) => {
        const { project, key, from, to } = seaProject()
        const seaPaths: SeaPaths = { [key]: { status: 'ok', path: [from, to], knots: [0, 1], ...(stopGapKm && { stopGapKm }) } }
        return validateProject(project, { seaPaths }).warnings.filter((w) => w.code === 'sea-stop-far')
      }
      const fix = 'Move the stop to the quay with update_stop, or add a via point at the harbour mouth with insert_via.'

      test('warns for a start stop more than 2 km from its water', () => {
        expect(withGap([4.23, 0])).toEqual([
          {
            code: 'sea-stop-far',
            message: 'Piraeus is 4.2 km from the water its sea route starts in, so the line crosses land to reach it.',
            path: ['scenes', 0, 'stops', 0],
            fix,
          },
        ])
      })

      test('warns for an end stop, with the route ending in the water', () => {
        expect(withGap([0, 12])).toEqual([
          expect.objectContaining({
            message: 'Mykonos is 12.0 km from the water its sea route ends in, so the line crosses land to reach it.',
            path: ['scenes', 0, 'stops', 1],
          }),
        ])
      })

      test('2 km is allowed, and no gap means none', () => {
        expect(withGap([2, 2])).toEqual([])
        expect(withGap([0, 0])).toEqual([])
        expect(withGap(undefined)).toEqual([])
      })

      test('a stop far from two adjacent legs is warned once, for the worse gap', () => {
        const project = greekIslands()
        const scene = sceneOf(project)
        scene.legs[0] = { ...scene.legs[0]!, mode: 'sea' }
        scene.legs[1] = { ...scene.legs[1]!, mode: 'sea' }
        const [a, b, c] = scene.stops.map((s) => s.at)
        const seaPaths: SeaPaths = {
          [seaLegKey(a!, b!, [])]: { status: 'ok', path: [a!, b!], knots: [0, 1], stopGapKm: [0, 3] },
          [seaLegKey(b!, c!, [])]: { status: 'ok', path: [b!, c!], knots: [0, 1], stopGapKm: [5, 0] },
        }
        const found = validateProject(project, { seaPaths }).warnings.filter((w) => w.code === 'sea-stop-far')
        expect(found).toHaveLength(1)
        expect(found[0]!.path).toEqual(['scenes', 0, 'stops', 1])
        expect(found[0]!.message).toBe(`${scene.stops[1]!.name} is 5.0 km from the water its sea route starts in, so the line crosses land to reach it.`)
      })
    })

    test('skips sea checks without seaPaths', () => {
      const { project } = seaProject()
      expect(codes(validateProject(project).warnings)).not.toContain('sea-fallback')
      expect(codes(validateProject(project).warnings)).not.toContain('sea-crosses-land')
      expect(codes(validateProject(project).warnings)).not.toContain('sea-unverified')
      expect(codes(validateProject(project).warnings)).not.toContain('sea-stop-far')
    })

    test('warns once when two signs overlap', () => {
      const project = stopsAt(
        [
          [25, 37],
          [25.009, 37],
        ],
        { camera: { mode: 'fixed', easing: 'linear', start: { center: [25, 37], zoom: 5, bearing: 0, pitch: 0 } } },
      )
      const stops = sceneOf(project).stops
      stops[0] = { ...stops[0]!, label: 'A very long sign label' }
      stops[1] = { ...stops[1]!, label: 'Another long sign label' }
      const found = validateProject(project).warnings.filter((w) => w.code === 'sign-overlap')
      expect(found).toHaveLength(1)
      expect(found[0]!.path).toEqual(['scenes', 0, 'stops', 1, 'label'])
      expect(found[0]!.message).toMatch(/^The S0 and S1 signs overlap at \d\d:\d\d:\d\d$/)
      expect(found[0]!.fix).toContain("'none'")
    })

    test("sign overlap measures with the scene's lift", () => {
      // Every sign sits the same distance above its dot, so a shared lift never changes which signs overlap. What it
      // must do is size the boxes to the scene's vehicle, so validation measures what the overlay draws.
      const project = stopsAt(
        [
          [25, 37],
          [25.009, 37],
        ],
        { camera: { mode: 'fixed', easing: 'linear', start: { center: [25, 37], zoom: 5, bearing: 0, pitch: 0 } } },
      )
      const scene = sceneOf(project)
      scene.look.symbol = 'car'
      scene.look.symbolStyle = 'badge'
      scene.stops[0] = { ...scene.stops[0]!, label: 'A very long sign label' }
      scene.stops[1] = { ...scene.stops[1]!, label: 'Another long sign label' }
      vi.mocked(signBox).mockClear()
      const found = validateProject(project).warnings.filter((w) => w.code === 'sign-overlap')
      expect(found).toHaveLength(1)
      expect(vi.mocked(signBox).mock.calls.length).toBeGreaterThan(0)
      for (const call of vi.mocked(signBox).mock.calls) expect(call[2]).toBe(41)
    })

    test('does not warn for signs far apart', () => {
      expect(codes(validateProject(greekIslands()).warnings)).not.toContain('sign-overlap')
    })
  })

  describe('follow and zoom messages', () => {
    test('follow mode skips the start and end zoom check', () => {
      const project = stopsAt([[25, 37], [25.01, 37]], { look: paperLook })
      expect(codes(validateProject(project).warnings)).toContain('zoom-above-max')
      sceneOf(project).camera = {
        mode: 'follow',
        easing: 'smooth',
        follow: { zoom: 10, orient: 'north', lookAhead: 1, smoothing: 0.5 },
      }
      expect(codes(validateProject(project).warnings)).not.toContain('zoom-above-max')
    })

    test('a zoom just over the maximum never prints as the maximum', () => {
      const project = stopsAt([[25, 37], [26, 37]], { look: paperLook })
      sceneOf(project).camera = {
        mode: 'follow',
        easing: 'smooth',
        follow: { zoom: 14.004, orient: 'north', lookAhead: 1, smoothing: 0.5 },
      }
      const w = validateProject(project).warnings.find((x) => x.code === 'zoom-above-max')!
      expect(w.message).toContain('zoom 14.01')
    })
  })
})
