import { describe, expect, test } from 'vitest'
import { applyPatch, importTrack, invertPatch, ProjectPatchSchema, type Project, type ProjectPatch } from '../../src/core/index.js'
import { greekIslands, projectWithScenes, sceneOf } from '../fixtures/projects.js'

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

  test('undo of a symbol change on a track leg', () => {
    const p = importTrack(greekIslands(), {
      stops: [{ name: 'A', at: [23.6, 37.9] }, { name: 'B', at: [25.3, 37.4] }],
      track: '0123456789ab',
      symbol: 'cruise-ship',
    })
    const patch: ProjectPatch = { ops: [{ op: 'update_leg', index: 0, changes: { symbol: 'ferry' } }] }
    expect(sceneOf(applyPatch(p, patch)).legs[0]!.mode).toBe('track')
    roundTrip(p, patch)
    expect(invertPatch(p, patch).ops?.[0]).toEqual({ op: 'update_leg', index: 0, changes: { symbol: 'cruise-ship' } })
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

  describe('scene edits', () => {
    const NEW_ID = '11111111-1111-4111-8111-111111111111'
    const sceneId = (p: Project, i: number): string => p.scenes[i]!.id

    test('undoes a sceneSet on scene 2', () => {
      const p = projectWithScenes(3)
      const patch: ProjectPatch = { scene: 2, sceneSet: { name: 'Sail', look: { theme: 'paper' } } }
      roundTrip(p, patch)
      expect(invertPatch(p, patch).scene).toBe(sceneId(p, 1))
    })

    test('undoes a via edit on scene 2', () => {
      const p = projectWithScenes(3)
      const patch: ProjectPatch = { scene: 2, ops: [{ op: 'insert_via', leg: 0, index: 0, point: { at: [24, 37] } }] }
      roundTrip(p, patch)
      expect(invertPatch(p, patch).scene).toBe(sceneId(p, 1))
      const q = applyPatch(p, patch)
      roundTrip(q, { scene: 2, ops: [{ op: 'update_stop', id: 'mykonos', changes: { name: 'Naxos' } }] })
    })

    test('undoes add_scene with an id', () => {
      const p = projectWithScenes(2)
      const patch: ProjectPatch = { ops: [{ op: 'add_scene', index: 1, name: 'New', id: NEW_ID }] }
      roundTrip(p, patch)
      expect(invertPatch(p, patch).ops).toEqual([{ op: 'remove_scene', id: NEW_ID }])
    })

    test('undoes duplicate_scene with a newId', () => {
      const p = projectWithScenes(2)
      const patch: ProjectPatch = { ops: [{ op: 'duplicate_scene', id: sceneId(p, 0), newId: NEW_ID }] }
      roundTrip(p, patch)
      expect(invertPatch(p, patch).ops).toEqual([{ op: 'remove_scene', id: NEW_ID }])
    })

    test('undoes remove_scene, restoring ids and position', () => {
      const p = projectWithScenes(3)
      const patch: ProjectPatch = { ops: [{ op: 'remove_scene', id: sceneId(p, 1) }] }
      roundTrip(p, patch)
      expect(invertPatch(p, patch).ops).toEqual([{ op: 'restore_scene', index: 1, scene: p.scenes[1] }])
    })

    test('undoes restore_scene', () => {
      const p = projectWithScenes(3)
      const removed = p.scenes[1]!
      const patch: ProjectPatch = { ops: [{ op: 'restore_scene', index: 0, scene: { ...removed, id: NEW_ID } }] }
      roundTrip(p, patch)
      expect(invertPatch(p, patch).ops).toEqual([{ op: 'remove_scene', id: NEW_ID }])
    })

    test('undoes move_scene', () => {
      const p = projectWithScenes(3)
      const patch: ProjectPatch = { ops: [{ op: 'move_scene', id: sceneId(p, 0), index: 2 }] }
      roundTrip(p, patch)
      expect(invertPatch(p, patch).ops).toEqual([{ op: 'move_scene', id: sceneId(p, 0), index: 0 }])
    })

    test('undoes a rename then a move in one patch', () => {
      const p = projectWithScenes(3)
      roundTrip(p, { scene: 3, sceneSet: { name: 'Last' }, ops: [{ op: 'move_scene', id: sceneId(p, 2), index: 0 }] })
    })

    test('undoes a stop edit then a move of the same scene', () => {
      const p = projectWithScenes(3)
      roundTrip(p, {
        scene: 1,
        ops: [
          { op: 'update_stop', id: 'mykonos', changes: { name: 'Naxos' } },
          { op: 'move_scene', id: sceneId(p, 0), index: 2 },
          { op: 'update_stop', id: 'rhodes', changes: { pause: 4 } },
        ],
      })
    })

    test('undoes several scene ops in one patch', () => {
      const p = projectWithScenes(3)
      roundTrip(p, {
        ops: [
          { op: 'add_scene', id: NEW_ID },
          { op: 'remove_scene', id: sceneId(p, 0) },
          { op: 'move_scene', id: NEW_ID, index: 0 },
          { op: 'duplicate_scene', id: sceneId(p, 2), newId: '22222222-2222-4222-8222-222222222222' },
        ],
      })
    })

    test('undoes a sceneSet next to scene ops on other scenes', () => {
      const p = projectWithScenes(3)
      roundTrip(p, { scene: 2, sceneSet: { name: 'Sail' }, ops: [{ op: 'remove_scene', id: sceneId(p, 0) }] })
    })

    test('refuses add_scene without an id', () => {
      const p = projectWithScenes(2)
      expect(() => invertPatch(p, { ops: [{ op: 'add_scene' }] })).toThrow('invertPatch needs add_scene to carry an id')
    })

    test('refuses duplicate_scene without a newId', () => {
      const p = projectWithScenes(2)
      expect(() => invertPatch(p, { ops: [{ op: 'duplicate_scene', id: sceneId(p, 0) }] })).toThrow(
        'invertPatch needs duplicate_scene to carry a newId',
      )
    })

    test('refuses sceneSet with removing that scene', () => {
      const p = projectWithScenes(3)
      expect(() =>
        invertPatch(p, { scene: 2, sceneSet: { name: 'x' }, ops: [{ op: 'remove_scene', id: sceneId(p, 1) }] }),
      ).toThrow('invertPatch does not support sceneSet together with removing that scene')
    })

    test('refuses a stop edit with removing that scene', () => {
      const p = projectWithScenes(3)
      expect(() =>
        invertPatch(p, {
          scene: 2,
          ops: [
            { op: 'update_stop', id: 'mykonos', changes: { name: 'x' } },
            { op: 'remove_scene', id: sceneId(p, 1) },
          ],
        }),
      ).toThrow('invertPatch does not support editing stops together with removing that scene')
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

describe('invertPatch on an old file with a blank scene name', () => {
  const blank = (): Project => projectWithScenes(2, ['Drive', ''])

  test('undo of a rename on a blank-named scene restores Scene N', () => {
    const p = blank()
    const patch: ProjectPatch = { scene: p.scenes[1]!.id, sceneSet: { name: 'Boat' } }
    const renamed = applyPatch(p, patch)
    expect(renamed.scenes[1]!.name).toBe('Boat')
    const undone = applyPatch(renamed, invertPatch(p, patch))
    expect(undone.scenes[1]!.name).toBe('Scene 2')
  })

  test('redo after that undo renames it again', () => {
    const p = blank()
    const patch: ProjectPatch = { scene: p.scenes[1]!.id, sceneSet: { name: 'Boat' } }
    const inverse = invertPatch(p, patch)
    const undone = applyPatch(applyPatch(p, patch), inverse)
    const redone = applyPatch(undone, invertPatch(applyPatch(p, patch), inverse))
    expect(redone.scenes[1]!.name).toBe('Boat')
  })
})
