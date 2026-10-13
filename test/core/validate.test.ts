import { describe, expect, test } from 'vitest'
import { validateProject, type Issue, type Project } from '../../src/core/index.js'
import { emptyProject, greekIslands, pacific, stopsAt } from '../fixtures/projects.js'

const paperLook = { ...greekIslands().look, theme: 'paper' as const }

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
      expect.objectContaining({ code: 'too-few-stops', path: ['stops'] }),
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
      expect.objectContaining({ path: ['stops', 1], fix: expect.stringContaining('pause') }),
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
    expect(legs.map((w) => w.path)).toEqual([['legs', 0], ['legs', 1]])
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
      expect.objectContaining({ code: 'zoom-above-max', path: ['camera', 'start', 'zoom'] }),
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
      expect.objectContaining({ path: ['camera'], fix: expect.stringContaining('blank') }),
    ])
  })

  test('a sea leg is a not-available-yet warning on its mode', () => {
    const project = greekIslands()
    project.legs[0] = { ...project.legs[0]!, mode: 'sea' }
    const { errors, warnings } = validateProject(project)
    expect(errors).toEqual([])
    expect(warnings).toEqual([
      expect.objectContaining({ code: 'not-available-yet', path: ['legs', 0, 'mode'] }),
    ])
    expect(warnings[0]!.fix).toContain("Use 'line'")
  })

  test('an air leg is a not-available-yet warning too', () => {
    const project = greekIslands()
    project.legs[1] = { ...project.legs[1]!, mode: 'air' }
    expect(validateProject(project).warnings).toEqual([
      expect.objectContaining({ code: 'not-available-yet', path: ['legs', 1, 'mode'] }),
    ])
  })

  test('the follow camera is a not-available-yet warning', () => {
    const project = greekIslands()
    project.camera = { ...project.camera, mode: 'follow' }
    expect(validateProject(project).warnings).toEqual([
      expect.objectContaining({ code: 'not-available-yet', path: ['camera', 'mode'] }),
    ])
  })

  test('terrain is a not-available-yet warning', () => {
    const project = greekIslands()
    project.look = { ...project.look, terrain: true }
    expect(validateProject(project).warnings).toEqual([
      expect.objectContaining({ code: 'not-available-yet', path: ['look', 'terrain'] }),
    ])
  })

  test('a symbol other than none or dot is a not-available-yet warning', () => {
    for (const symbol of ['none', 'dot'] as const) {
      const project = greekIslands()
      project.look = { ...project.look, symbol }
      expect(validateProject(project).warnings).toEqual([])
    }
    const project = greekIslands()
    project.look = { ...project.look, symbol: 'arrow' }
    expect(validateProject(project).warnings).toEqual([
      expect.objectContaining({ code: 'not-available-yet', path: ['look', 'symbol'] }),
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
    project.legs[1] = { ...project.legs[1]!, mode: 'sea' }
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
})
