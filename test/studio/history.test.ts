import { describe, expect, test } from 'vitest'
import { applyPatch, PATHS_ORIGIN, type PatchResponse, type Project, type ProjectPatch } from '../../src/core/index.js'
import { EditHistory, EditQueue, OutsideWrites, pathsUpdate, redoPatch, scenesAround } from '../../src/studio/edit/history.js'
import { greekIslands, twoScenes } from '../fixtures/projects.js'

const SCENE = 'a0000000-0000-4000-8000-000000000001'

const entry = (label: string) => ({
  label,
  forward: { set: { name: `${label} on` } } as ProjectPatch,
  inverse: { set: { name: `${label} off` } } as ProjectPatch,
  sceneBefore: SCENE,
  sceneAfter: SCENE,
})

describe('EditHistory', () => {
  test('undo then redo moves entries between stacks', () => {
    const history = new EditHistory()
    expect(history.canUndo).toBe(false)
    expect(history.canRedo).toBe(false)
    history.push(entry('one'))
    history.push(entry('two'))
    expect(history.undoLabel).toBe('two')

    expect(history.takeUndo()?.label).toBe('two')
    expect(history.undoLabel).toBe('one')
    expect(history.redoLabel).toBe('two')
    expect(history.takeUndo()?.label).toBe('one')
    expect(history.canUndo).toBe(false)
    expect(history.takeUndo()).toBeUndefined()

    expect(history.takeRedo()?.label).toBe('one')
    expect(history.redoLabel).toBe('two')
    expect(history.undoLabel).toBe('one')
    expect(history.takeRedo()?.label).toBe('two')
    expect(history.canRedo).toBe(false)
    expect(history.takeRedo()).toBeUndefined()

    history.clear()
    expect(history.canUndo).toBe(false)
    expect(history.undoLabel).toBeUndefined()
  })

  test('push clears redo', () => {
    const history = new EditHistory()
    history.push(entry('one'))
    history.takeUndo()
    expect(history.canRedo).toBe(true)
    history.push(entry('two'))
    expect(history.canRedo).toBe(false)
    expect(history.redoLabel).toBeUndefined()
    expect(history.undoLabel).toBe('two')
  })
})

describe('scenes around an edit', () => {
  const project = twoScenes()
  const [drive, sail] = project.scenes.map((s) => s.id) as [string, string]
  const NEW = '00000000-0000-4000-8000-0000000000aa'

  test('an entry keeps the scenes to show before and after', () => {
    // An edit inside a scene shows that scene both ways.
    expect(scenesAround(project, { scene: sail, sceneSet: { name: 'Boat' } }, sail)).toEqual({ sceneBefore: sail, sceneAfter: sail })
    // Add and duplicate show the new scene after.
    expect(scenesAround(project, { ops: [{ op: 'add_scene', index: 1, id: NEW }] }, drive)).toEqual({ sceneBefore: drive, sceneAfter: NEW })
    expect(scenesAround(project, { ops: [{ op: 'duplicate_scene', id: sail, newId: NEW }] }, drive)).toEqual({
      sceneBefore: drive,
      sceneAfter: NEW,
    })
    // Deleting the scene on screen shows the one that takes its place, or the one before it at the end.
    expect(scenesAround(project, { ops: [{ op: 'remove_scene', id: drive }] }, drive)).toEqual({ sceneBefore: drive, sceneAfter: sail })
    expect(scenesAround(project, { ops: [{ op: 'remove_scene', id: sail }] }, sail)).toEqual({ sceneBefore: sail, sceneAfter: drive })
    // Deleting another scene keeps the one on screen.
    expect(scenesAround(project, { ops: [{ op: 'remove_scene', id: sail }] }, drive)).toEqual({ sceneBefore: drive, sceneAfter: drive })

    const history = new EditHistory()
    history.push({ ...entry('add'), sceneBefore: drive, sceneAfter: NEW })
    expect(history.takeUndo()).toMatchObject({ sceneBefore: drive, sceneAfter: NEW })
    expect(history.takeRedo()).toMatchObject({ sceneBefore: drive, sceneAfter: NEW })
  })

  test('redo of a duplicate restores the copy as saved', () => {
    const forward: ProjectPatch = { ops: [{ op: 'duplicate_scene', id: sail, newId: NEW }] }
    const saved = applyPatch(project, forward)
    const redo = redoPatch(forward, saved)
    expect(redo).toEqual({ ops: [{ op: 'restore_scene', index: 2, scene: saved.scenes[2] }] })
    // Redone, the copy keeps the stop ids that later edits name.
    expect(applyPatch(project, redo).scenes).toEqual(saved.scenes)
    // Anything else is redone as it was made.
    const edit: ProjectPatch = { scene: sail, sceneSet: { name: 'Boat' } }
    expect(redoPatch(edit, applyPatch(project, edit))).toBe(edit)
  })
})

describe('EditQueue', () => {
  test('queues a second edit until the first is saved', async () => {
    const initial = greekIslands()
    const saved: Project = { ...initial, name: 'First', updatedAt: '2026-10-15T10:00:00.000Z' }
    let release!: (r: PatchResponse) => void
    const sent: ProjectPatch[] = []
    const queue = new EditQueue((patch) => {
      sent.push(patch)
      if (sent.length === 1) return new Promise<PatchResponse>((resolve) => (release = resolve))
      return Promise.resolve({ project: { ...saved, name: 'Second' }, seaPaths: {}, previousUpdatedAt: saved.updatedAt })
    })

    const seen: Project[] = []
    const first = queue.run((p) => {
      seen.push(p)
      return { set: { name: 'First' } }
    }, () => initial)
    const second = queue.run((p) => {
      seen.push(p)
      return { set: { name: 'Second' } }
    }, () => initial)

    await new Promise((r) => setTimeout(r, 10))
    // The second edit waits for the first to settle.
    expect(sent).toHaveLength(1)
    expect(seen).toEqual([initial])

    release({ project: saved, seaPaths: {}, previousUpdatedAt: initial.updatedAt })
    expect((await first)?.project.name).toBe('First')
    expect((await second)?.project.name).toBe('Second')
    expect(sent).toHaveLength(2)
    // `make` for the second edit saw the project from the first response.
    expect(seen[1]).toBe(saved)
  })

  test('a failed send rejects that run and the queue carries on', async () => {
    const initial = greekIslands()
    let calls = 0
    const queue = new EditQueue(async () => {
      calls++
      if (calls === 1) throw new Error('Simulated failure')
      return { project: initial, seaPaths: {}, previousUpdatedAt: initial.updatedAt }
    })
    const first = queue.run(() => ({ set: { name: 'A' } }), () => initial)
    const second = queue.run(() => ({ set: { name: 'B' } }), () => initial)
    await expect(first).rejects.toThrow('Simulated failure')
    await expect(second).resolves.toBeDefined()
  })

  test("a handler chained on run's promise runs before the next make", async () => {
    const initial = greekIslands()
    const queue = new EditQueue(async () => ({ project: initial, seaPaths: {}, previousUpdatedAt: initial.updatedAt }))
    const order: string[] = []
    const first = queue.run(() => {
      order.push('make 1')
      return { set: { name: 'A' } }
    }, () => initial).then(() => order.push('handler 1'))
    const second = queue.run(() => {
      order.push('make 2')
      return { set: { name: 'B' } }
    }, () => initial)
    await Promise.all([first, second])
    expect(order).toEqual(['make 1', 'handler 1', 'make 2'])
  })

  test('a conditional run sends the base it was made against', async () => {
    const initial = greekIslands()
    const bases: Array<string | undefined> = []
    const queue = new EditQueue(async (_patch, base) => {
      bases.push(base)
      return { project: initial, seaPaths: {}, previousUpdatedAt: initial.updatedAt }
    })
    await queue.run(() => ({ set: { name: 'A' } }), () => initial)
    await queue.run(() => ({ set: { name: 'B' } }), () => initial, { conditional: true })
    expect(bases).toEqual([undefined, initial.updatedAt])
  })

  test('make returning undefined sends nothing', async () => {
    const initial = greekIslands()
    let calls = 0
    const queue = new EditQueue(async () => {
      calls++
      return { project: initial, seaPaths: {}, previousUpdatedAt: initial.updatedAt }
    })
    expect(await queue.run(() => undefined, () => initial)).toBeUndefined()
    expect(calls).toBe(0)
  })
})

describe('OutsideWrites', () => {
  const T0 = '2026-10-16T10:00:00.000Z'
  const T1 = '2026-10-16T10:00:01.000Z'
  const T2 = '2026-10-16T10:00:02.000Z'

  test('nothing is stale before any outside write', () => {
    expect(new OutsideWrites().since(T0)).toBe(false)
  })

  test('a view older than the last outside write is stale; the same or a newer one is not', () => {
    const outside = new OutsideWrites()
    outside.saw(T1)
    expect(outside.since(T0)).toBe(true)
    expect(outside.since(T1)).toBe(false)
    expect(outside.since(T2)).toBe(false)
  })

  test('keeps the newest write it was told of, in whatever order they arrive', () => {
    const outside = new OutsideWrites()
    outside.saw(T2)
    outside.saw(T0)
    expect(outside.since(T1)).toBe(true)
  })
})

describe('pathsUpdate', () => {
  const at = (updatedAt: string): Project => ({ ...greekIslands(), updatedAt })
  const shown = at('2026-01-01T00:00:01.000Z')

  test('new routes for the version on screen only change the routes', () => {
    expect(pathsUpdate(PATHS_ORIGIN, at(shown.updatedAt), shown)).toBe('paths')
  })

  test('routes of a version already replaced are dropped', () => {
    expect(pathsUpdate(PATHS_ORIGIN, at('2026-01-01T00:00:00.000Z'), shown)).toBe('drop')
  })

  test('a newer version, or nothing on screen yet, is an ordinary message', () => {
    expect(pathsUpdate(PATHS_ORIGIN, at('2026-01-01T00:00:02.000Z'), shown)).toBe('project')
    expect(pathsUpdate(PATHS_ORIGIN, shown, undefined)).toBe('project')
  })

  test('other origins are ordinary messages, even for the same version', () => {
    expect(pathsUpdate(undefined, at(shown.updatedAt), shown)).toBe('project')
    expect(pathsUpdate('abc', at(shown.updatedAt), shown)).toBe('project')
  })
})
