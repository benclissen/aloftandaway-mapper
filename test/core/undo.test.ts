import { describe, expect, test } from 'vitest'
import { applyPatch, invertPatch, ProjectPatchSchema, type Project, type ProjectPatch } from '../../src/core/index.js'
import { greekIslands, sceneOf } from '../fixtures/projects.js'

function roundTrip(p: Project, patch: ProjectPatch): void {
  const inverse = invertPatch(p, patch)
  expect(ProjectPatchSchema.safeParse(inverse).success).toBe(true)
  expect(applyPatch(applyPatch(p, patch), inverse)).toEqual(p)
}

const camera = { start: { center: [24, 37], zoom: 6, bearing: 0, pitch: 0 }, end: { center: [28, 36], zoom: 8, bearing: 0, pitch: 0 } }
const id = (p: Project, i: number): string => sceneOf(p).stops[i]!.id

describe('invertPatch', () => {
  test('update_stop changing and adding keys', () => {
    const p = greekIslands()
    roundTrip(p, { ops: [{ op: 'update_stop', id: id(p, 1), changes: { name: 'Naxos', pause: 3, sharp: true, label: 'x' } }] })
  })

  test('update_stop removing keys', () => {
    const p = greekIslands()
    roundTrip(p, { ops: [{ op: 'update_stop', id: id(p, 0), changes: { terminal: null } }] })
  })

  test('update_leg symbol ferry restores the mode too', () => {
    const p = greekIslands()
    const patch: ProjectPatch = { ops: [{ op: 'update_leg', index: 0, changes: { symbol: 'ferry' } }] }
    roundTrip(p, patch)
    expect(invertPatch(p, patch).ops?.[0]).toMatchObject({
      op: 'update_leg',
      changes: { symbol: null, mode: sceneOf(p).legs[0]!.mode },
    })
  })

  test('update_leg symbol null', () => {
    const p = applyPatch(greekIslands(), { ops: [{ op: 'update_leg', index: 1, changes: { symbol: 'ferry' } }] })
    roundTrip(p, { ops: [{ op: 'update_leg', index: 1, changes: { symbol: null } }] })
  })

  test('via ops', () => {
    const p = applyPatch(greekIslands(), { ops: [{ op: 'insert_via', leg: 0, index: 0, point: { at: [24, 37] } }] })
    roundTrip(p, { ops: [{ op: 'insert_via', leg: 0, index: 1, point: { at: [25, 37], sharp: true } }] })
    roundTrip(p, { ops: [{ op: 'remove_via', leg: 0, index: 0 }] })
    roundTrip(p, { ops: [{ op: 'update_via', leg: 0, index: 0, changes: { at: [1, 2], sharp: true } }] })
    const q = applyPatch(p, { ops: [{ op: 'update_via', leg: 0, index: 0, changes: { sharp: true } }] })
    roundTrip(q, { ops: [{ op: 'update_via', leg: 0, index: 0, changes: { sharp: null } }] })
  })

  test('sceneSet round trips', () => {
    const p = greekIslands()
    roundTrip(p, { sceneSet: { look: { theme: 'paper' } } })
    roundTrip(p, { sceneSet: { camera: { start: { center: [1, 2], zoom: 3, bearing: 0, pitch: 0 } } } })
    const withCam = greekIslands({ camera: { mode: 'glide', easing: 'smooth', ...camera } } as never)
    roundTrip(withCam, { sceneSet: { camera: { start: null, end: null } } })
  })

  test('a multi-op patch round trips', () => {
    const p = greekIslands()
    roundTrip(p, {
      ops: [
        { op: 'insert_via', leg: 0, index: 0, point: { at: [24, 37] } },
        { op: 'update_via', leg: 0, index: 0, changes: { sharp: true } },
        { op: 'insert_via', leg: 0, index: 1, point: { at: [25, 37] } },
      ],
    })
  })

  test('throws for insert_stop and set', () => {
    const p = greekIslands()
    expect(() => invertPatch(p, { ops: [{ op: 'insert_stop', index: 0, stop: { name: 'A', at: [0, 0] } }] })).toThrow(
      'invertPatch does not support insert_stop',
    )
    expect(() => invertPatch(p, { set: { name: 'x' } })).toThrow('invertPatch does not support set')
  })
})
