import { describe, expect, test } from 'vitest'
import { ProjectError, SceneRefSchema, applyPatch, newSceneId, resolveScene, sceneLabel, sceneTitle, sceneTitleOf, type Project } from '../../src/core/index.js'
import { projectWithScenes } from '../fixtures/projects.js'

describe('scene references', () => {
  test('resolves a scene by id and by position', () => {
    const project = projectWithScenes(3, ['Drive', 'Sail', 'Fly'])
    const second = project.scenes[1]!
    expect(resolveScene(project, second.id)).toEqual({ scene: second, index: 1 })
    expect(resolveScene(project, 3)).toEqual({ scene: project.scenes[2], index: 2 })
  })

  test('defaults to the first scene', () => {
    const project = projectWithScenes(2)
    expect(resolveScene(project)).toEqual({ scene: project.scenes[0], index: 0 })
  })

  test('an unknown reference lists the scenes', () => {
    const project = projectWithScenes(2, ['Drive', 'Sail'])
    for (const ref of [3, 'nope']) {
      try {
        resolveScene(project, ref)
        throw new Error('expected the call to throw')
      } catch (e) {
        expect(e).toBeInstanceOf(ProjectError)
        const [issue] = (e as ProjectError).issues
        expect(issue!.path).toEqual(['scene'])
        expect(issue!.message).toContain(typeof ref === 'number' ? 'no scene 3' : "no scene 'nope'")
        expect(issue!.message).toContain(`1 "Drive" (id ${project.scenes[0]!.id})`)
        expect(issue!.message).toContain(`2 "Sail" (id ${project.scenes[1]!.id})`)
      }
    }
  })

  test('position 0 is rejected by the schema', () => {
    expect(SceneRefSchema.safeParse(0).success).toBe(false)
    expect(SceneRefSchema.safeParse(1.5).success).toBe(false)
    expect(SceneRefSchema.safeParse('').success).toBe(false)
    expect(SceneRefSchema.safeParse(2).success).toBe(true)
    expect(SceneRefSchema.safeParse('abc').success).toBe(true)
  })

  test('sceneLabel names the position and count', () => {
    const project = projectWithScenes(2, ['Drive', 'Sail'])
    expect(sceneLabel(project, 1)).toBe('Scene 2 of 2 · Sail')
    project.scenes[0]!.name = ''
    expect(sceneLabel(project, 0)).toBe('Scene 1 of 2 · Scene 1')
  })

  test('a blank name shows as Scene N', () => {
    const project = projectWithScenes(3, ['Drive', '', '   '])
    expect(sceneTitle(project, 0)).toBe('Drive')
    expect(sceneTitle(project, 1)).toBe('Scene 2')
    expect(sceneTitle(project, 2)).toBe('Scene 3')
    expect(sceneTitleOf('  Sail  ', 0)).toBe('Sail')
    expect(sceneTitleOf('\t', 4)).toBe('Scene 5')
  })

  test('a whitespace name is refused on add_scene', () => {
    const project = projectWithScenes(2, ['Drive', 'Sail'])
    for (const name of ['', '   ']) {
      const e = failure(() => applyPatch(project, { ops: [{ op: 'add_scene', name }] }))
      expect(e.issues[0]?.path).toEqual(['ops', 0, 'name'])
      expect(e.issues[0]?.message).toBe("a scene name can't be blank")
    }
    const later = failure(() => applyPatch(project, { ops: [{ op: 'add_scene' }, { op: 'add_scene', name: ' ' }] }))
    expect(later.issues[0]?.path).toEqual(['ops', 1, 'name'])
  })

  test('a whitespace name is refused on sceneSet', () => {
    const project = projectWithScenes(2, ['Drive', 'Sail'])
    for (const name of ['', '   ']) {
      const e = failure(() => applyPatch(project, { sceneSet: { name } }))
      expect(e.issues[0]?.path).toEqual(['sceneSet', 'name'])
      expect(e.issues[0]?.message).toBe("a scene name can't be blank")
    }
  })

  test('names are stored trimmed', () => {
    const project = projectWithScenes(2, ['Drive', 'Sail'])
    const added = applyPatch(project, { ops: [{ op: 'add_scene', name: '  Fly  ' }] })
    expect(added.scenes[2]!.name).toBe('Fly')
    const set = applyPatch(project, { scene: 2, sceneSet: { name: ' Boat ' } })
    expect(set.scenes[1]!.name).toBe('Boat')
  })

  test('duplicating a scene with a blank name gives Scene N copy', () => {
    const project = projectWithScenes(2, ['Drive', ''])
    const p = applyPatch(project, { ops: [{ op: 'duplicate_scene', id: project.scenes[1]!.id }] })
    expect(p.scenes[2]!.name).toBe('Scene 2 copy')
  })
})

function failure(fn: () => unknown): ProjectError {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(ProjectError)
    return e as ProjectError
  }
  throw new Error('expected the call to throw')
}

/** A project whose scenes differ in look and timing, so a copy can be told from a fresh default. */
function distinct(): Project {
  const project = projectWithScenes(2, ['Drive', 'Sail'])
  project.scenes[0]!.look.theme = 'outdoor'
  project.scenes[0]!.look.line.color = '#112233'
  project.scenes[0]!.timing = { holdStart: 3, travel: 7, holdEnd: 4 }
  project.scenes[0]!.camera = { mode: 'follow', easing: 'linear', follow: { zoom: 9 }, start: { center: [1, 1], zoom: 3, bearing: 0, pitch: 0 } }
  project.scenes[1]!.look.theme = 'blank'
  project.scenes[1]!.timing = { holdStart: 0, travel: 20, holdEnd: 0 }
  project.scenes[1]!.camera = { mode: 'glide', easing: 'smooth', keys: [{ at: 1, shot: { center: [2, 2], zoom: 5, bearing: 0, pitch: 0 } }] }
  return project
}

describe('scene ops', () => {
  test('add_scene copies look and timing but not the shots', () => {
    const base = distinct()
    const p = applyPatch(base, { ops: [{ op: 'add_scene', name: 'Fly' }] })
    expect(p.scenes).toHaveLength(3)
    const added = p.scenes[2]!
    expect(added.name).toBe('Fly')
    expect(added.stops).toEqual([])
    expect(added.legs).toEqual([])
    expect(added.look).toEqual(base.scenes[1]!.look)
    expect(added.timing).toEqual(base.scenes[1]!.timing)
    expect(added.camera).toEqual({ mode: 'glide', easing: 'smooth' })
    expect(added.id).not.toBe(base.scenes[1]!.id)
    // A deep copy: changing the new scene leaves the source alone.
    expect(added.look).not.toBe(p.scenes[1]!.look)

    const copied = applyPatch(base, { ops: [{ op: 'add_scene', copyLookFrom: 1 }] }).scenes[2]!
    expect(copied.name).toBe('Scene 3')
    expect(copied.look).toEqual(base.scenes[0]!.look)
    expect(copied.camera).toEqual({ mode: 'follow', easing: 'linear', follow: { zoom: 9 } })
    expect(base.scenes).toHaveLength(2)
  })

  test('add_scene at index 0 copies the scene after it', () => {
    const base = distinct()
    const p = applyPatch(base, { ops: [{ op: 'add_scene', index: 0 }] })
    expect(p.scenes).toHaveLength(3)
    expect(p.scenes[0]!.name).toBe('Scene 1')
    expect(p.scenes[0]!.look).toEqual(base.scenes[0]!.look)
    expect(p.scenes[1]!.id).toBe(base.scenes[0]!.id)
    const e = failure(() => applyPatch(base, { ops: [{ op: 'add_scene', index: 3 }] }))
    expect(e.issues[0]!.path).toEqual(['ops', 0, 'index'])
  })

  test('add_scene takes a given id; a used id fails', () => {
    const base = distinct()
    const id = newSceneId()
    expect(applyPatch(base, { ops: [{ op: 'add_scene', id }] }).scenes[2]!.id).toBe(id)
    const e = failure(() => applyPatch(base, { ops: [{ op: 'add_scene', id: base.scenes[0]!.id }] }))
    expect(e.issues[0]!.path).toEqual(['ops', 0, 'id'])
    const bad = failure(() => applyPatch(base, { ops: [{ op: 'add_scene', copyLookFrom: 9 }] }))
    expect(bad.issues[0]!.path).toEqual(['ops', 0, 'copyLookFrom'])
  })

  test('duplicate_scene gives fresh scene and stop ids', () => {
    const base = projectWithScenes(2, ['Drive', 'Sail'])
    const original = base.scenes[0]!
    original.camera = { mode: 'glide', easing: 'linear', keys: [{ at: 0.5, shot: { center: [2, 2], zoom: 5, bearing: 0, pitch: 0 } }] }
    const p = applyPatch(base, { ops: [{ op: 'duplicate_scene', id: original.id }] })
    expect(p.scenes.map((s) => s.name)).toEqual(['Drive', 'Drive copy', 'Sail'])
    const copy = p.scenes[1]!
    expect(copy.id).not.toBe(original.id)
    expect(copy.stops.map((s) => s.name)).toEqual(original.stops.map((s) => s.name))
    const oldStopIds = new Set(p.scenes.flatMap((s) => (s === copy ? [] : s.stops.map((x) => x.id))))
    for (const stop of copy.stops) expect(oldStopIds.has(stop.id)).toBe(false)
    expect(new Set(copy.stops.map((s) => s.id)).size).toBe(copy.stops.length)
    expect(copy.legs).toEqual(original.legs)
    expect(copy.look).toEqual(original.look)
    expect(copy.camera).toEqual(original.camera)
    const id = newSceneId()
    expect(applyPatch(base, { ops: [{ op: 'duplicate_scene', id: original.id, newId: id }] }).scenes[1]!.id).toBe(id)
    const e = failure(() => applyPatch(base, { ops: [{ op: 'duplicate_scene', id: 'nope' }] }))
    expect(e.issues[0]!.path).toEqual(['ops', 0, 'id'])
    expect(e.message).toContain("unknown scene id 'nope'")
  })

  test('cannot remove the last scene', () => {
    const base = projectWithScenes(1)
    const e = failure(() => applyPatch(base, { ops: [{ op: 'remove_scene', id: base.scenes[0]!.id }] }))
    expect(e.message).toContain('a project needs at least one scene; add another before removing this one')
    const two = applyPatch(base, { ops: [{ op: 'add_scene' }, { op: 'remove_scene', id: base.scenes[0]!.id }] })
    expect(two.scenes).toHaveLength(1)
    expect(two.scenes[0]!.id).not.toBe(base.scenes[0]!.id)
  })

  test('move_scene reorders; stop ops still hit the chosen scene', () => {
    const base = projectWithScenes(3, ['A', 'B', 'C'])
    const second = base.scenes[1]!
    const p = applyPatch(base, {
      scene: second.id,
      ops: [
        { op: 'move_scene', id: second.id, index: 2 },
        { op: 'update_stop', id: second.stops[0]!.id, changes: { name: 'Moved' } },
      ],
    })
    expect(p.scenes.map((s) => s.name)).toEqual(['A', 'C', 'B'])
    expect(p.scenes[2]!.stops[0]!.name).toBe('Moved')
    expect(p.scenes[1]!.stops[0]!.name).toBe(base.scenes[2]!.stops[0]!.name)
    const e = failure(() => applyPatch(base, { ops: [{ op: 'move_scene', id: second.id, index: 3 }] }))
    expect(e.issues[0]!.path).toEqual(['ops', 0, 'index'])
  })

  test('a stop op after its scene was removed fails', () => {
    const base = projectWithScenes(2)
    const first = base.scenes[0]!
    const e = failure(() =>
      applyPatch(base, {
        scene: first.id,
        ops: [
          { op: 'remove_scene', id: first.id },
          { op: 'update_stop', id: first.stops[0]!.id, changes: { name: 'x' } },
        ],
      }),
    )
    expect(e.issues).toEqual([{ path: ['ops', 1], message: `scene '${first.id}' was removed earlier in this patch` }])
  })

  test('restore_scene puts a removed scene back with its ids', () => {
    const base = projectWithScenes(3, ['A', 'B', 'C'])
    const removed = base.scenes[1]!
    const without = applyPatch(base, { ops: [{ op: 'remove_scene', id: removed.id }] })
    expect(without.scenes.map((s) => s.name)).toEqual(['A', 'C'])
    const back = applyPatch(without, { ops: [{ op: 'restore_scene', index: 1, scene: removed }] })
    expect(back).toEqual(base)
    const dup = failure(() => applyPatch(base, { ops: [{ op: 'restore_scene', index: 0, scene: removed }] }))
    expect(dup.message).toContain('duplicate scene id')
    const range = failure(() => applyPatch(without, { ops: [{ op: 'restore_scene', index: 3, scene: removed }] }))
    expect(range.issues[0]!.path).toEqual(['ops', 0, 'index'])
  })

  test('a scene patch is all or nothing', () => {
    const base = projectWithScenes(2)
    const before = structuredClone(base)
    failure(() => applyPatch(base, { ops: [{ op: 'add_scene' }, { op: 'move_scene', id: base.scenes[0]!.id, index: 9 }] }))
    expect(base).toEqual(before)
  })
})
