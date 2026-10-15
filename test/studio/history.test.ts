import { describe, expect, test } from 'vitest'
import type { PatchResponse, Project, ProjectPatch } from '../../src/core/index.js'
import { EditHistory, EditQueue } from '../../src/studio/edit/history.js'
import { greekIslands } from '../fixtures/projects.js'

const entry = (label: string) => ({
  label,
  forward: { set: { name: `${label} on` } } as ProjectPatch,
  inverse: { set: { name: `${label} off` } } as ProjectPatch,
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

describe('EditQueue', () => {
  test('queues a second edit until the first is saved', async () => {
    const initial = greekIslands()
    const saved: Project = { ...initial, name: 'First', updatedAt: '2026-10-15T10:00:00.000Z' }
    let release!: (r: PatchResponse) => void
    const sent: ProjectPatch[] = []
    const queue = new EditQueue((patch) => {
      sent.push(patch)
      if (sent.length === 1) return new Promise<PatchResponse>((resolve) => (release = resolve))
      return Promise.resolve({ project: { ...saved, name: 'Second' }, previousUpdatedAt: saved.updatedAt })
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

    release({ project: saved, previousUpdatedAt: initial.updatedAt })
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
      return { project: initial, previousUpdatedAt: initial.updatedAt }
    })
    const first = queue.run(() => ({ set: { name: 'A' } }), () => initial)
    const second = queue.run(() => ({ set: { name: 'B' } }), () => initial)
    await expect(first).rejects.toThrow('Simulated failure')
    await expect(second).resolves.toBeDefined()
  })

  test("a handler chained on run's promise runs before the next make", async () => {
    const initial = greekIslands()
    const queue = new EditQueue(async () => ({ project: initial, previousUpdatedAt: initial.updatedAt }))
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

  test('make returning undefined sends nothing', async () => {
    const initial = greekIslands()
    let calls = 0
    const queue = new EditQueue(async () => {
      calls++
      return { project: initial, previousUpdatedAt: initial.updatedAt }
    })
    expect(await queue.run(() => undefined, () => initial)).toBeUndefined()
    expect(calls).toBe(0)
  })
})
