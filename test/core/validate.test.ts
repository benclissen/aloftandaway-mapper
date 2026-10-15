import { describe, expect, test } from 'vitest'
import { validateProject, type Issue, type Project } from '../../src/core/index.js'
import { emptyProject, greekIslands, pacific, sceneOf, stopsAt } from '../fixtures/projects.js'

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
    // The agent can't see a fitted shot in the project, so the fix says where to find it.
    const fix = warnings.find((w) => w.code === 'zoom-above-max')!.fix!
    expect(fix).toContain('update_project sceneSet')
    expect(fix).toContain('camera.resolvedStart')
    expect(fix).toContain('camera.resolvedEnd')
  })

  test('a sea leg is a not-available-yet warning on its mode', () => {
    const project = greekIslands()
    sceneOf(project).legs[0] = { ...sceneOf(project).legs[0]!, mode: 'sea' }
    const { errors, warnings } = validateProject(project)
    expect(errors).toEqual([])
    expect(warnings).toEqual([
      expect.objectContaining({ code: 'not-available-yet', path: ['scenes', 0, 'legs', 0, 'mode'] }),
    ])
    expect(warnings[0]!.fix).toContain("Use 'line'")
    expect(warnings[0]!.fix).toContain('update_project')
  })

  test('an air leg is a not-available-yet warning too', () => {
    const project = greekIslands()
    sceneOf(project).legs[1] = { ...sceneOf(project).legs[1]!, mode: 'air' }
    expect(validateProject(project).warnings).toEqual([
      expect.objectContaining({ code: 'not-available-yet', path: ['scenes', 0, 'legs', 1, 'mode'] }),
    ])
  })

  test('the follow camera is a not-available-yet warning', () => {
    const project = greekIslands()
    sceneOf(project).camera = { ...sceneOf(project).camera, mode: 'follow' }
    expect(validateProject(project).warnings).toEqual([
      expect.objectContaining({ code: 'not-available-yet', path: ['scenes', 0, 'camera', 'mode'] }),
    ])
  })

  test('terrain is a not-available-yet warning', () => {
    const project = greekIslands()
    sceneOf(project).look = { ...sceneOf(project).look, terrain: true }
    expect(validateProject(project).warnings).toEqual([
      expect.objectContaining({ code: 'not-available-yet', path: ['scenes', 0, 'look', 'terrain'] }),
    ])
  })

  test('a symbol other than none or dot is a not-available-yet warning', () => {
    for (const symbol of ['none', 'dot'] as const) {
      const project = greekIslands()
      sceneOf(project).look = { ...sceneOf(project).look, symbol }
      expect(validateProject(project).warnings).toEqual([])
    }
    const project = greekIslands()
    sceneOf(project).look = { ...sceneOf(project).look, symbol: 'arrow' }
    expect(validateProject(project).warnings).toEqual([
      expect.objectContaining({ code: 'not-available-yet', path: ['scenes', 0, 'look', 'symbol'] }),
    ])
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
})
