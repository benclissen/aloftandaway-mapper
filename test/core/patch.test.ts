import { describe, expect, test } from 'vitest'
import {
  ProjectError,
  buildRoute,
  ProjectPatchSchema,
  SCENE_OP_NAMES,
  SceneOpSchema,
  isSceneOp,
  applyPatch,
  importTrack,
  mergePatch,
  newStopId,
  setStops,
  buildTimeline,
  type LngLat,
  type Project,
  type StopInput,
  type StopOp,
} from '../../src/core/index.js'
import { emptyProject, greekIslands, pacific, projectWithScenes, sceneOf, stopsAt } from '../fixtures/projects.js'

const s = (name: string, at: LngLat = [0, 0]): StopInput => ({ name, at })

function failure(fn: () => unknown): ProjectError {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(ProjectError)
    return e as ProjectError
  }
  throw new Error('expected the call to throw')
}

describe('setStops', () => {
  test('builds one leg per pair with per-stop legMode', () => {
    const p = setStops(emptyProject(), { stops: [s('A'), { ...s('B', [1, 1]), legMode: 'sea' }, s('C', [2, 2])], legMode: 'line' })
    expect(sceneOf(p).stops.map((x) => x.name)).toEqual(['A', 'B', 'C'])
    expect(sceneOf(p).legs.map((l) => l.mode)).toEqual(['line', 'sea'])
    expect(sceneOf(p).stops[0]).toMatchObject({ pause: 0, sign: 'always' })
  })

  test('legMode on a stop is not stored on the stop', () => {
    const p = setStops(emptyProject(), { stops: [{ ...s('A'), legMode: 'air' }, s('B', [1, 1])] })
    expect(sceneOf(p).stops[0]).not.toHaveProperty('legMode')
    expect(sceneOf(p).legs).toEqual([{ mode: 'air', via: [] }])
  })

  test('uses the call-level legMode, then line, for stops without their own', () => {
    expect(sceneOf(setStops(emptyProject(), { stops: [s('A'), s('B', [1, 1])], legMode: 'sea' })).legs[0]?.mode).toBe('sea')
    expect(sceneOf(setStops(emptyProject(), { stops: [s('A'), s('B', [1, 1])] })).legs[0]?.mode).toBe('line')
  })

  test('gives every stop a distinct generated id and keeps optional fields', () => {
    const p = setStops(emptyProject(), {
      stops: [{ ...s('A'), day: 2, label: 'Start', pause: 3, sign: 'none', terminal: true, ref: 'x' }, s('B', [1, 1])],
    })
    expect(sceneOf(p).stops[0]).toMatchObject({ day: 2, label: 'Start', pause: 3, sign: 'none', terminal: true, ref: 'x' })
    expect(new Set(sceneOf(p).stops.map((x) => x.id)).size).toBe(2)
    expect(sceneOf(p).stops[0]?.id).toMatch(/^s_[0-9a-z]{8}$/)
  })

  test('replaces by default', () => {
    const p = setStops(greekIslands(), { stops: [s('A'), s('B', [1, 1])] })
    expect(sceneOf(p).stops.map((x) => x.name)).toEqual(['A', 'B'])
    expect(sceneOf(p).legs).toHaveLength(1)
  })

  test('replace:false appends', () => {
    const base = setStops(emptyProject(), { stops: [s('A'), { ...s('B', [1, 1]), legMode: 'sea' }] })
    const p = setStops(base, { stops: [s('C', [2, 2])], replace: false })
    expect(sceneOf(p).stops.map((x) => x.name)).toEqual(['A', 'B', 'C'])
    expect(sceneOf(p).legs).toHaveLength(2)
    expect(sceneOf(p).legs[0]).toEqual(sceneOf(base).legs[0])
    expect(sceneOf(p).stops[0]?.id).toBe(sceneOf(base).stops[0]?.id)
  })

  test('accepts an empty list', () => {
    const p = setStops(greekIslands(), { stops: [] })
    expect(sceneOf(p).stops).toEqual([])
    expect(sceneOf(p).legs).toEqual([])
  })

  test('rejects a bad stop with a path into the input', () => {
    const e = failure(() => setStops(emptyProject(), { stops: [s('A'), { name: 'B', at: [200, 0] }] }))
    expect(e.issues[0]?.path).toEqual(['stops', 1, 'at', 0])
  })

  test('rejects an unknown key on a stop', () => {
    const e = failure(() => setStops(emptyProject(), { stops: [{ ...s('A'), colour: 'red' } as StopInput] }))
    expect(e.issues[0]).toEqual({ path: ['stops', 0, 'colour'], message: 'unknown key' })
  })

  test('does not touch the input project or updatedAt', () => {
    const p = emptyProject()
    const before = structuredClone(p)
    const out = setStops(p, { stops: [s('A'), s('B', [1, 1])] })
    expect(p).toEqual(before)
    expect(out.updatedAt).toBe(before.updatedAt)
  })
})

describe('applyPatch set', () => {
  test('merge patch sets nested fields and null deletes optional ones', () => {
    const base = greekIslands({ camera: { mode: 'glide', easing: 'smooth', start: { center: [24, 37], zoom: 6, bearing: 0, pitch: 0 } } })
    const p = applyPatch(base, {
      set: { name: 'Renamed', output: { height: 2160 } },
      sceneSet: { look: { line: { color: '#000000' } }, camera: { start: null } },
    })
    expect(p.name).toBe('Renamed')
    expect(p.output.height).toBe(2160)
    expect(p.output.aspect).toBe('16:9')
    expect(sceneOf(p).name).toBe('Greek Islands')
    expect(sceneOf(p).look.line.color).toBe('#000000')
    expect(sceneOf(p).look.line.width).toBe(4)
    expect(sceneOf(p).camera.start).toBeUndefined()
    expect(sceneOf(p).camera.mode).toBe('glide')
  })

  test.each(['stops', 'legs', 'schemaVersion', 'id', 'createdAt'])('set cannot touch %s', (key) => {
    const e = failure(() => applyPatch(greekIslands(), { set: { [key]: key === 'stops' || key === 'legs' ? [] : 'x' } }))
    expect(e.issues[0]?.path).toEqual(['set', key])
    expect(e.message).toContain(key)
  })

  test('the message for stops and legs points at ops and set_stops', () => {
    expect(failure(() => applyPatch(greekIslands(), { set: { stops: [] } })).message).toMatch(/set_stops|ops/)
    expect(failure(() => applyPatch(greekIslands(), { set: { legs: [] } })).message).toMatch(/set_stops|ops/)
  })

  test('invalid result reports the Zod path', () => {
    expect(() => applyPatch(greekIslands(), { set: { output: { fps: { num: 7, den: 1 } } } })).toThrow(/output\.fps/)
  })

  test('an unknown top-level key is rejected', () => {
    const e = failure(() => applyPatch(greekIslands(), { set: { colour: 'red' } }))
    expect(e.issues).toEqual([{ path: ['colour'], message: 'unknown key' }])
  })

  test('Object.prototype names are ordinary unknown keys', () => {
    const e = failure(() => applyPatch(greekIslands(), { set: { constructor: 1, toString: 1 } }))
    expect(e.issues.map((i) => i.path)).toEqual([['constructor'], ['toString']])
  })

  test('a __proto__ key does not reach the prototype and is rejected', () => {
    const set = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>
    const e = failure(() => applyPatch(greekIslands(), { set }))
    expect(e.issues).toEqual([{ path: ['__proto__'], message: 'unknown key' }])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test('an empty patch returns an equal project', () => {
    expect(applyPatch(greekIslands(), {})).toEqual(greekIslands())
  })

  test('does not touch updatedAt', () => {
    expect(applyPatch(greekIslands(), { set: { name: 'x' } }).updatedAt).toBe(greekIslands().updatedAt)
  })
})

describe('applyPatch ops', () => {
  const ids = (p: Project) => sceneOf(p).stops.map((x) => x.id)

  test('insert_stop adds a stop with defaults and syncs legs', () => {
    const base = greekIslands()
    const p = applyPatch(base, { ops: [{ op: 'insert_stop', index: 1, stop: { name: 'Naxos', at: [25.4, 37.1], legMode: 'sea' } }] })
    expect(sceneOf(p).stops.map((x) => x.name)).toEqual(['Piraeus', 'Naxos', 'Mykonos', 'Santorini', 'Rhodes'])
    expect(sceneOf(p).stops[1]).toMatchObject({ pause: 0, sign: 'always' })
    expect(sceneOf(p).stops[1]).not.toHaveProperty('legMode')
    // Piraeus->Naxos has no legMode of its own, so it takes the mode of the old leg leaving Piraeus.
    expect(sceneOf(p).legs.map((l) => l.mode)).toEqual(['line', 'sea', 'line', 'line'])
    expect(sceneOf(p).legs).toHaveLength(4)
  })

  test('insert_stop at the end and at the start', () => {
    const p = applyPatch(greekIslands(), {
      ops: [
        { op: 'insert_stop', index: 4, stop: s('End') },
        { op: 'insert_stop', index: 0, stop: { ...s('Start'), legMode: 'air' } },
      ],
    })
    expect(sceneOf(p).stops.map((x) => x.name)).toEqual(['Start', 'Piraeus', 'Mykonos', 'Santorini', 'Rhodes', 'End'])
    expect(sceneOf(p).legs.map((l) => l.mode)).toEqual(['air', 'line', 'line', 'line', 'line'])
  })

  test('insert_stop into an empty project makes no legs', () => {
    const p = applyPatch(emptyProject(), { ops: [{ op: 'insert_stop', index: 0, stop: s('A') }] })
    expect(sceneOf(p).stops).toHaveLength(1)
    expect(sceneOf(p).legs).toEqual([])
  })

  test.each([-1, 5, 1.5])('insert_stop index %s is out of range', (index) => {
    const e = failure(() => applyPatch(greekIslands(), { ops: [{ op: 'insert_stop', index, stop: s('X') }] }))
    expect(e.issues[0]?.path).toEqual(['ops', 0, 'index'])
  })

  test('update_stop changes fields and keeps legs and id', () => {
    const base = greekIslands()
    const p = applyPatch(base, { ops: [{ op: 'update_stop', id: 'mykonos', changes: { name: 'Mýkonos', pause: 2, at: [25.33, 37.45] } }] })
    expect(sceneOf(p).stops[1]).toMatchObject({ id: 'mykonos', name: 'Mýkonos', pause: 2, at: [25.33, 37.45] })
    expect(sceneOf(p).legs).toEqual(sceneOf(base).legs)
  })

  test('update_stop rejects an unknown key and a changed id', () => {
    const unknown = failure(() => applyPatch(greekIslands(), { ops: [{ op: 'update_stop', id: 'mykonos', changes: { colour: 'red' } as never }] }))
    expect(unknown.issues).toEqual([{ path: ['ops', 0, 'changes', 'colour'], message: 'unknown key' }])
    const id = failure(() => applyPatch(greekIslands(), { ops: [{ op: 'update_stop', id: 'mykonos', changes: { id: 'other' } as never }] }))
    expect(id.issues[0]?.path).toEqual(['ops', 0, 'changes', 'id'])
  })

  test('update_stop with a bad value reports the schema path', () => {
    const e = failure(() => applyPatch(greekIslands(), { ops: [{ op: 'update_stop', id: 'mykonos', changes: { at: [0, 99] } }] }))
    expect(e.issues[0]?.path).toEqual(['ops', 0, 'changes', 'at', 1])
  })

  test('unknown stop ids are ProjectErrors pointing at the op id', () => {
    for (const op of [
      { op: 'update_stop', id: 'nope', changes: {} },
      { op: 'remove_stop', id: 'nope' },
      { op: 'move_stop', id: 'nope', index: 0 },
    ] as StopOp[]) {
      const e = failure(() => applyPatch(greekIslands(), { ops: [{ op: 'remove_stop', id: 'piraeus' }, op] }))
      expect(e.issues[0]?.path).toEqual(['ops', 1, 'id'])
      expect(e.message).toContain('nope')
    }
  })

  test('remove_stop merges into a new leg with the previous mode', () => {
    const base = setStops(emptyProject(), {
      stops: [{ ...s('A'), legMode: 'air' }, { ...s('B', [1, 1]), legMode: 'sea' }, s('C', [2, 2])],
    })
    const p = applyPatch(base, { ops: [{ op: 'remove_stop', id: sceneOf(base).stops[1]!.id }] })
    expect(sceneOf(p).stops.map((x) => x.name)).toEqual(['A', 'C'])
    expect(sceneOf(p).legs).toEqual([{ mode: 'air', via: [] }])
  })

  test('remove_stop of the first or last stop drops its leg and keeps the others', () => {
    const base = greekIslands()
    sceneOf(base).legs[1] = { mode: 'sea', via: [{ at: [25, 37] }] }
    const first = applyPatch(base, { ops: [{ op: 'remove_stop', id: 'piraeus' }] })
    expect(sceneOf(first).legs).toEqual([sceneOf(base).legs[1], sceneOf(base).legs[2]])
    const last = applyPatch(base, { ops: [{ op: 'remove_stop', id: 'rhodes' }] })
    expect(sceneOf(last).legs).toEqual([sceneOf(base).legs[0], sceneOf(base).legs[1]])
  })

  test('remove_stop down to nothing leaves no legs', () => {
    const base = stopsAt([[0, 0], [1, 1]])
    const p = applyPatch(base, { ops: [{ op: 'remove_stop', id: 's0' }, { op: 'remove_stop', id: 's1' }] })
    expect(sceneOf(p).stops).toEqual([])
    expect(sceneOf(p).legs).toEqual([])
  })

  test('move_stop reuses legs whose endpoints survive', () => {
    const base = stopsAt([[0, 0], [1, 1], [2, 2], [3, 3]])
    sceneOf(base).legs = [
      { mode: 'line', via: [] },
      { mode: 'sea', via: [{ at: [1, 1] }] },
      { mode: 'air', via: [] },
    ]
    const p = applyPatch(base, { ops: [{ op: 'move_stop', id: 's0', index: 3 }] })
    expect(ids(p)).toEqual(['s1', 's2', 's3', 's0'])
    expect(sceneOf(p).legs[0]).toEqual(sceneOf(base).legs[1])
    expect(sceneOf(p).legs[1]).toEqual(sceneOf(base).legs[2])
    expect(sceneOf(p).legs[2]).toEqual({ mode: 'line', via: [] })
  })

  test('move_stop to the same place changes nothing', () => {
    const base = greekIslands()
    sceneOf(base).legs[1] = { mode: 'sea', via: [{ at: [25, 37] }] }
    expect(applyPatch(base, { ops: [{ op: 'move_stop', id: 'mykonos', index: 1 }] })).toEqual(base)
  })

  test('move_stop into the middle takes the mode of the old leg leaving the previous stop', () => {
    const base = stopsAt([[0, 0], [1, 1], [2, 2]])
    sceneOf(base).legs = [{ mode: 'air', via: [] }, { mode: 'sea', via: [] }]
    const p = applyPatch(base, { ops: [{ op: 'move_stop', id: 's2', index: 1 }] })
    expect(ids(p)).toEqual(['s0', 's2', 's1'])
    // s0->s2: old leg leaving s0 (air). s2->s1: nothing leaves s2, old leg arriving at s1 is air.
    expect(sceneOf(p).legs.map((l) => l.mode)).toEqual(['air', 'air'])
  })

  test.each([-1, 4, 0.5])('move_stop index %s is out of range', (index) => {
    const e = failure(() => applyPatch(greekIslands(), { ops: [{ op: 'move_stop', id: 'piraeus', index }] }))
    expect(e.issues[0]?.path).toEqual(['ops', 0, 'index'])
  })

  test('update_leg changes a leg', () => {
    const p = applyPatch(greekIslands(), { ops: [{ op: 'update_leg', index: 1, changes: { mode: 'sea', via: [{ at: [25.4, 37] }], symbol: 'cruise-ship' }}] })
    expect(sceneOf(p).legs[1]).toEqual({ mode: 'sea', via: [{ at: [25.4, 37] }], symbol: 'cruise-ship' })
    expect(sceneOf(p).legs[0]).toEqual({ mode: 'line', via: [] })
  })

  test('update_leg rejects a bad index, an unknown key and a bad value', () => {
    const range = failure(() => applyPatch(greekIslands(), { ops: [{ op: 'update_leg', index: 3, changes: { mode: 'sea' } }] }))
    expect(range.issues[0]?.path).toEqual(['ops', 0, 'index'])
    const unknown = failure(() => applyPatch(greekIslands(), { ops: [{ op: 'update_leg', index: 0, changes: { speed: 1 } as never }] }))
    expect(unknown.issues[0]).toEqual({ path: ['ops', 0, 'changes', 'speed'], message: 'unknown key' })
    const bad = failure(() => applyPatch(greekIslands(), { ops: [{ op: 'update_leg', index: 0, changes: { mode: 'boat' } as never }] }))
    expect(bad.issues[0]?.path).toEqual(['ops', 0, 'changes', 'mode'])
  })

  test('ops apply in order, each seeing the result of the one before', () => {
    const p = applyPatch(greekIslands(), {
      ops: [
        { op: 'remove_stop', id: 'mykonos' },
        { op: 'update_leg', index: 0, changes: { mode: 'sea' } },
        { op: 'insert_stop', index: 1, stop: s('Naxos', [25.4, 37.1]) },
      ],
    })
    expect(sceneOf(p).stops.map((x) => x.name)).toEqual(['Piraeus', 'Naxos', 'Santorini', 'Rhodes'])
    // Piraeus->Naxos follows the sea leg that left Piraeus; Naxos->Santorini follows the one that arrived at Santorini.
    expect(sceneOf(p).legs.map((l) => l.mode)).toEqual(['sea', 'sea', 'line'])
  })

  test('set and ops combine', () => {
    const p = applyPatch(greekIslands(), { set: { name: 'Cruise' }, ops: [{ op: 'remove_stop', id: 'rhodes' }] })
    expect(p.name).toBe('Cruise')
    expect(sceneOf(p).stops).toHaveLength(3)
  })

  test('a failing op leaves the project unchanged', () => {
    const p = greekIslands()
    const before = structuredClone(p)
    expect(() =>
      applyPatch(p, { ops: [{ op: 'update_stop', id: sceneOf(p).stops[0]!.id, changes: { name: 'X' } }, { op: 'remove_stop', id: 'nope' }] }),
    ).toThrow(/nope/)
    expect(p).toEqual(before)
  })

  test('a successful patch does not mutate its input either', () => {
    const p = greekIslands()
    const before = structuredClone(p)
    applyPatch(p, { set: { name: 'x' }, ops: [{ op: 'move_stop', id: 'piraeus', index: 2 }, { op: 'update_leg', index: 0, changes: { mode: 'air' } }] })
    expect(p).toEqual(before)
  })

  test('a malformed op is a ProjectError at the op', () => {
    const unknownOp = failure(() => applyPatch(greekIslands(), { ops: [{ op: 'explode' } as never] }))
    expect(unknownOp.issues[0]?.path).toEqual(['ops', 0, 'op'])
    const missing = failure(() => applyPatch(greekIslands(), { ops: [{ op: 'remove_stop' } as never] }))
    expect(missing.issues[0]?.path).toEqual(['ops', 0, 'id'])
    const extra = failure(() => applyPatch(greekIslands(), { ops: [{ op: 'remove_stop', id: 'rhodes', hard: true } as never] }))
    expect(extra.issues[0]).toEqual({ path: ['ops', 0, 'hard'], message: 'unknown key' })
  })

  test('an unknown patch key is a ProjectError', () => {
    const e = failure(() => applyPatch(greekIslands(), { stops: [] } as never))
    expect(e.issues[0]).toEqual({ path: ['stops'], message: 'unknown key' })
  })
})

describe('ProjectPatchSchema', () => {
  test('accepts set and ops', () => {
    expect(ProjectPatchSchema.safeParse({ set: { name: 'x' }, ops: [{ op: 'remove_stop', id: 'a' }] }).success).toBe(true)
    expect(ProjectPatchSchema.safeParse({ sceneSet: { name: 'x' } }).success).toBe(true)
    expect(ProjectPatchSchema.safeParse({}).success).toBe(true)
  })
  test('rejects unknown keys, non-object set and bad ops', () => {
    expect(ProjectPatchSchema.safeParse({ extra: 1 }).success).toBe(false)
    expect(ProjectPatchSchema.safeParse({ set: [] }).success).toBe(false)
    expect(ProjectPatchSchema.safeParse({ sceneSet: [] }).success).toBe(false)
    expect(ProjectPatchSchema.safeParse({ ops: [{ op: 'move_stop', id: 'a' }] }).success).toBe(false)
  })
})

describe('mergePatch (RFC 7396)', () => {
  test.each([
    [{ a: 'b' }, { a: 'c' }, { a: 'c' }],
    [{ a: 'b' }, { b: 'c' }, { a: 'b', b: 'c' }],
    [{ a: 'b' }, { a: null }, {}],
    [{ a: 'b', b: 'c' }, { a: null }, { b: 'c' }],
    [{ a: ['b'] }, { a: 'c' }, { a: 'c' }],
    [{ a: 'c' }, { a: ['b'] }, { a: ['b'] }],
    [{ a: { b: 'c' } }, { a: { b: 'd', c: null } }, { a: { b: 'd' } }],
    [{ a: [{ b: 'c' }] }, { a: [1] }, { a: [1] }],
    [['a', 'b'], ['c', 'd'], ['c', 'd']],
    [{ a: 'b' }, ['c'], ['c']],
    [{ a: 'foo' }, null, null],
    [{ a: 'foo' }, 'bar', 'bar'],
    [{ e: null }, { a: 1 }, { e: null, a: 1 }],
    [[1, 2], { a: 'b', c: null }, { a: 'b' }],
    [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
  ])('mergePatch(%j, %j) = %j', (target, patch, expected) => {
    expect(mergePatch(target, patch)).toEqual(expected)
  })

  test('does not mutate the target or the patch', () => {
    const target = { a: { b: 1 } }
    const patch = { a: { c: 2 } }
    const out = mergePatch(target, patch) as typeof target
    expect(target).toEqual({ a: { b: 1 } })
    expect(patch).toEqual({ a: { c: 2 } })
    expect(out).not.toBe(target)
  })
})

describe('newStopId', () => {
  test('is s_ plus 8 base-36 characters and varies', () => {
    const made = Array.from({ length: 200 }, newStopId)
    for (const id of made) expect(id).toMatch(/^s_[0-9a-z]{8}$/)
    expect(new Set(made).size).toBe(200)
  })
})

describe('applyPatch sceneSet', () => {
  test('sceneSet patches the first scene', () => {
    const p = applyPatch(greekIslands(), { sceneSet: { look: { theme: 'blank' } } })
    expect(p.scenes[0]!.look.theme).toBe('blank')
    const q = applyPatch(greekIslands(), { sceneSet: { look: { theme: 'paper' } } })
    expect(q.scenes[0]!.look.theme).toBe('paper')
    expect(q.scenes[0]!.look.line).toEqual(greekIslands().scenes[0]!.look.line)
  })

  test.each(['timing', 'look', 'camera', 'stops', 'legs'])('set rejects the scene field %s', (key) => {
    const e = failure(() => applyPatch(greekIslands(), { set: { [key]: {} } }))
    expect(e.issues[0]?.path).toEqual(['set', key])
    expect(e.message).toMatch(/sceneSet|ops/)
  })

  test.each(['scenes', 'id', 'createdAt', 'schemaVersion'])('set rejects %s', (key) => {
    const e = failure(() => applyPatch(greekIslands(), { set: { [key]: 'x' } }))
    expect(e.issues[0]?.path).toEqual(['set', key])
  })

  test.each(['id', 'stops', 'legs'])('sceneSet rejects %s', (key) => {
    const e = failure(() => applyPatch(greekIslands(), { sceneSet: { [key]: [] } }))
    expect(e.issues[0]?.path).toEqual(['sceneSet', key])
  })
})


describe('via ops and clearing fields', () => {
  const via = (p: Project, leg = 0) => sceneOf(p).legs[leg]!.via
  const ins = (p: Project, index: number, point: { at: LngLat; sharp?: boolean }) =>
    applyPatch(p, { ops: [{ op: 'insert_via', leg: 0, index, point }] })

  test('insert_via adds a point at the index', () => {
    let p = ins(greekIslands(), 0, { at: [24, 37.5] })
    p = ins(p, 1, { at: [24.5, 37.6], sharp: true })
    p = ins(p, 1, { at: [24.2, 37.55] })
    expect(via(p).map((v) => v.at[0])).toEqual([24, 24.2, 24.5])
    expect(via(p)[2]).toEqual({ at: [24.5, 37.6], sharp: true })
    expect(via(greekIslands())).toEqual([])
  })

  test('update_via moves and toggles sharp', () => {
    let p = ins(greekIslands(), 0, { at: [24, 37.5] })
    p = applyPatch(p, { ops: [{ op: 'update_via', leg: 0, index: 0, changes: { at: [24.1, 37.6], sharp: true } }] })
    expect(via(p)).toEqual([{ at: [24.1, 37.6], sharp: true }])
  })

  test('update_via with sharp null removes the key', () => {
    let p = ins(greekIslands(), 0, { at: [24, 37.5], sharp: true })
    p = applyPatch(p, { ops: [{ op: 'update_via', leg: 0, index: 0, changes: { sharp: null } }] })
    expect(via(p)[0]).toEqual({ at: [24, 37.5] })
    expect(via(p)[0]).not.toHaveProperty('sharp')
  })

  test('remove_via removes the point', () => {
    let p = ins(greekIslands(), 0, { at: [24, 37.5] })
    p = ins(p, 1, { at: [24.5, 37.6] })
    p = applyPatch(p, { ops: [{ op: 'remove_via', leg: 0, index: 0 }] })
    expect(via(p).map((v) => v.at[0])).toEqual([24.5])
  })

  test('via ops reject out-of-range leg and via indexes', () => {
    const base = ins(greekIslands(), 0, { at: [24, 37.5] })
    const withVia = applyPatch(base, { ops: [{ op: 'insert_via', leg: 0, index: 1, point: { at: [24.5, 37.5] } }, { op: 'insert_via', leg: 0, index: 2, point: { at: [24.6, 37.5] } }] })
    const e1 = failure(() => applyPatch(withVia, { ops: [{ op: 'insert_via', leg: 3, index: 0, point: { at: [1, 1] } }] }))
    expect(e1.issues[0]).toMatchObject({ path: ['ops', 0, 'leg'], message: 'leg index 3 is out of range; use 0 to 2' })
    const e2 = failure(() => applyPatch(withVia, { ops: [{ op: 'insert_via', leg: 0, index: 4, point: { at: [1, 1] } }] }))
    expect(e2.issues[0]).toMatchObject({ path: ['ops', 0, 'index'], message: 'via index 4 is out of range; use 0 to 3' })
    const e3 = failure(() => applyPatch(withVia, { ops: [{ op: 'remove_via', leg: 0, index: 3 }] }))
    expect(e3.issues[0]).toMatchObject({ path: ['ops', 0, 'index'], message: 'via index 3 is out of range; use 0 to 2' })
    const e5 = failure(() => applyPatch(greekIslands(), { ops: [{ op: 'remove_via', leg: 0, index: 0 }] }))
    expect(e5.issues[0]).toMatchObject({ path: ['ops', 0, 'index'], message: 'via index 0 is out of range; there are no via points' })
    const e4 = failure(() => applyPatch(greekIslands(), { ops: [{ op: 'insert_via', leg: 0, index: 1, point: { at: [1, 1] } }] }))
    expect(e4.issues[0]).toMatchObject({ path: ['ops', 0, 'index'], message: 'via index 1 is out of range; use 0 to 0' })
  })

  test('update_stop with label null removes the label', () => {
    let p = applyPatch(greekIslands(), { ops: [{ op: 'update_stop', id: 'piraeus', changes: { label: 'Port', sharp: true, day: 1 } }] })
    expect(sceneOf(p).stops[0]).toMatchObject({ label: 'Port', sharp: true, day: 1 })
    p = applyPatch(p, { ops: [{ op: 'update_stop', id: 'piraeus', changes: { label: null, sharp: null, day: null, terminal: null, ref: null } }] })
    for (const k of ['label', 'sharp', 'day', 'terminal', 'ref']) expect(sceneOf(p).stops[0]).not.toHaveProperty(k)
  })

  test('null for a required key is a schema error at the op path', () => {
    const e1 = failure(() => applyPatch(greekIslands(), { ops: [{ op: 'update_stop', id: 'piraeus', changes: { name: null } as never }] }))
    expect(e1.issues[0]?.path.slice(0, 3)).toEqual(['ops', 0, 'changes'])
    const e2 = failure(() => applyPatch(greekIslands(), { ops: [{ op: 'update_leg', index: 0, changes: { mode: null } as never }] }))
    expect(e2.issues[0]?.path.slice(0, 3)).toEqual(['ops', 0, 'changes'])
  })

  test('update_leg symbol sets the default mode', () => {
    const leg = (changes: object) => sceneOf(applyPatch(greekIslands(), { ops: [{ op: 'update_leg', index: 0, changes }] })).legs[0]
    expect(leg({ symbol: 'ferry' })).toMatchObject({ mode: 'sea', symbol: 'ferry' })
    expect(leg({ symbol: 'plane', mode: 'line' })).toMatchObject({ mode: 'line', symbol: 'plane' })
    const withSym = applyPatch(greekIslands(), { ops: [{ op: 'update_leg', index: 0, changes: { symbol: 'ferry' } }] })
    const cleared = sceneOf(applyPatch(withSym, { ops: [{ op: 'update_leg', index: 0, changes: { symbol: null } }] })).legs[0]!
    expect(cleared).not.toHaveProperty('symbol')
    expect(cleared.mode).toBe('sea')
  })

  test('update_leg via replaces the via list', () => {
    const p = applyPatch(greekIslands(), { ops: [{ op: 'update_leg', index: 0, changes: { via: [{ at: [24, 37.5], sharp: true }] } }] })
    expect(via(p)).toEqual([{ at: [24, 37.5], sharp: true }])
  })

  test('set_stops symbol sets the leaving leg', () => {
    const two = (extra: object) =>
      sceneOf(setStops(emptyProject(), { stops: [{ ...s('A'), ...extra }, s('B', [1, 1])] })).legs[0]
    expect(two({ symbol: 'train' })).toEqual({ mode: 'land', symbol: 'train', via: [] })
    expect(two({ symbol: 'train', legMode: 'line' })).toEqual({ mode: 'line', symbol: 'train', via: [] })
  })

  test('insert_via with a wrapped point keeps the Pacific route continuous', () => {
    const base = pacific()
    const before = buildRoute(sceneOf(base)).length
    const after = buildRoute(sceneOf(ins(base, 0, { at: [-179.9, -17.4] }))).length
    expect(Math.abs(after - before) / before).toBeLessThan(0.01)
  })

  test('ops are all or nothing', () => {
    const base = greekIslands()
    const copy = structuredClone(base)
    failure(() =>
      applyPatch(base, { ops: [{ op: 'insert_via', leg: 0, index: 0, point: { at: [24, 37.5] } }, { op: 'remove_via', leg: 0, index: 5 }] }),
    )
    expect(base).toEqual(copy)
  })
})

describe('scene-targeted patches', () => {
  test('sceneSet and ops act on the chosen scene', () => {
    const project = projectWithScenes(2, ['Drive', 'Sail'])
    const before = structuredClone(project)
    const out = applyPatch(project, {
      scene: 2,
      sceneSet: { name: 'Cruise', look: { theme: 'paper' } },
      ops: [{ op: 'update_stop', id: 'mykonos', changes: { name: 'Naxos' } }],
    })
    expect(out.scenes[0]).toEqual(before.scenes[0])
    expect(out.scenes[1]!.name).toBe('Cruise')
    expect(out.scenes[1]!.look.theme).toBe('paper')
    expect(out.scenes[1]!.stops.find((x) => x.id === 'mykonos')!.name).toBe('Naxos')
    expect(project).toEqual(before)
    // The same scene by id.
    const byId = applyPatch(project, { scene: before.scenes[1]!.id, sceneSet: { name: 'Cruise' } })
    expect(byId.scenes[1]!.name).toBe('Cruise')
    expect(byId.scenes[0]).toEqual(before.scenes[0])
  })

  test('a stop id from another scene fails', () => {
    const project = projectWithScenes(2)
    project.scenes[0]!.stops[0]!.id = 'only-in-one'
    const e = failure(() => applyPatch(project, { scene: 2, ops: [{ op: 'update_stop', id: 'only-in-one', changes: { name: 'X' } }] }))
    expect(e.issues[0]!.path).toEqual(['ops', 0, 'id'])
  })

  test('an unknown scene fails with the scene path', () => {
    const e = failure(() => applyPatch(projectWithScenes(2), { scene: 5, sceneSet: { name: 'X' } }))
    expect(e.issues[0]!.path).toEqual(['scene'])
  })

  test('setStops replaces only the chosen scene', () => {
    const project = projectWithScenes(2)
    const out = setStops(project, { scene: 2, stops: [s('A', [1, 1]), s('B', [2, 2])] })
    expect(out.scenes[0]).toEqual(project.scenes[0])
    expect(out.scenes[1]!.stops.map((x) => x.name)).toEqual(['A', 'B'])
    expect(out.scenes[1]!.legs).toHaveLength(1)
  })
})

describe('scene ops', () => {
  test('SCENE_OP_NAMES matches the scene op schema', () => {
    const schemaNames = SceneOpSchema.options.map((option) => option.shape.op.value)
    expect([...SCENE_OP_NAMES]).toEqual(schemaNames)
  })

  test('isSceneOp is true for the scene ops and false for the stop ops', () => {
    for (const name of SCENE_OP_NAMES) expect(isSceneOp({ op: name })).toBe(true)
    for (const name of ['insert_stop', 'update_stop', 'remove_stop', 'update_leg', 'insert_via', 'remove_via', 'scene_note']) {
      expect(isSceneOp({ op: name })).toBe(false)
    }
  })
})

describe('a fixed length', () => {
  // Holds 1 and 2, pauses 1.5 and 1.5, a length of 8 s: travel is 2 s.
  const fixed = (length: number | undefined = 8): Project => {
    const p = stopsAt([[0, 0], [10, 0], [20, 0]], { timing: { holdStart: 1, travel: 99, holdEnd: 2, ...(length ? { length } : {}) } })
    sceneOf(p).stops[0]!.pause = 1.5
    sceneOf(p).stops[1]!.pause = 1.5
    return p
  }
  const frames = (p: Project) => buildTimeline(sceneOf(p), p.output.fps, buildRoute(sceneOf(p))).totalFrames

  test('length holds when a pause changes', () => {
    const start = applyPatch(fixed(), { sceneSet: { timing: { length: 8 } } })
    expect(sceneOf(start).timing.travel).toBe(2)
    const id = sceneOf(start).stops[1]!.id
    const p = applyPatch(start, { ops: [{ op: 'update_stop', id, changes: { pause: 3 } }] })
    expect(sceneOf(p).timing.travel).toBe(0.5)
    expect(sceneOf(p).timing.length).toBe(8)
    expect(frames(p)).toBe(200)
  })

  test('a pause that overruns the length is refused', () => {
    const p = stopsAt([[0, 0], [10, 0]], { timing: { holdStart: 1, travel: 1, holdEnd: 2, length: 4 } })
    const id = sceneOf(p).stops[0]!.id
    const e = failure(() => applyPatch(p, { ops: [{ op: 'update_stop', id, changes: { pause: 2 } }] }))
    expect(e.issues).toEqual([
      {
        path: ['scenes', 0, 'timing', 'length'],
        message: 'the holds and pauses add up to 5 s, more than the length of 4 s. Shorten them, or clear timing.length with null',
      },
    ])
  })

  test('null clears the length, and travel keeps its last value', () => {
    const start = applyPatch(fixed(), { sceneSet: { timing: { length: 8 } } })
    const p = applyPatch(start, { sceneSet: { timing: { length: null } } })
    expect(sceneOf(p).timing).toEqual({ holdStart: 1, travel: 2, holdEnd: 2 })
    expect(sceneOf(p).timing).not.toHaveProperty('length')
  })

  test('setStops refits the length', () => {
    const start = applyPatch(fixed(), { sceneSet: { timing: { length: 8 } } })
    const p = setStops(start, { stops: [{ name: 'A', at: [0, 0], pause: 2 }, { name: 'B', at: [5, 0] }, { name: 'C', at: [9, 0], pause: 1 }] })
    expect(sceneOf(p).timing.travel).toBe(2)
    expect(frames(p)).toBe(200)
  })

  test('travel is rounded to 1e-6', () => {
    const p = applyPatch(fixed(), { sceneSet: { timing: { length: 8.1234567 } } })
    expect(sceneOf(p).timing.travel).toBe(2.123457)
  })
})

describe('track legs', () => {
  const TRACK = '0123456789ab'
  const four = [s('A', [0, 0]), s('B', [1, 0]), s('C', [2, 0]), s('D', [3, 0])]
  const imported = () => importTrack(emptyProject(), { stops: four, track: TRACK, symbol: 'cruise-ship' })
  const onTrack = { mode: 'track', track: TRACK, via: [], symbol: 'cruise-ship' }

  test('importTrack puts every leg on the track', () => {
    const p = imported()
    expect(sceneOf(p).stops.map((x) => x.name)).toEqual(['A', 'B', 'C', 'D'])
    expect(sceneOf(p).legs).toEqual([onTrack, onTrack, onTrack])
    const bare = importTrack(emptyProject(), { stops: four.slice(0, 2), track: TRACK })
    expect(sceneOf(bare).legs).toEqual([{ mode: 'track', track: TRACK, via: [] }])
  })

  test('importTrack replaces the chosen scene and refits its length', () => {
    const base = applyPatch(projectWithScenes(2), { scene: 2, sceneSet: { timing: { length: 20 } } })
    const p = importTrack(base, { scene: 2, stops: [{ ...s('A', [0, 0]), pause: 3 }, s('B', [1, 0])], track: TRACK })
    expect(p.scenes[0]).toEqual(base.scenes[0])
    expect(p.scenes[1]!.stops.map((x) => x.name)).toEqual(['A', 'B'])
    expect(p.scenes[1]!.timing.travel).toBe(20 - p.scenes[1]!.timing.holdStart - p.scenes[1]!.timing.holdEnd - 3)
  })

  test('importTrack refuses a bad track id', () => {
    const e = failure(() => importTrack(emptyProject(), { stops: four, track: 'nope' }))
    expect(e.issues[0]?.path).toEqual(['track'])
  })

  test('remove then insert keeps every leg on the track', () => {
    let p = imported()
    p = applyPatch(p, { ops: [{ op: 'remove_stop', id: sceneOf(p).stops[1]!.id }] })
    expect(sceneOf(p).legs).toEqual([onTrack, onTrack])
    p = applyPatch(p, { ops: [{ op: 'insert_stop', index: 1, stop: s('Missed', [1.5, 0]) }] })
    expect(sceneOf(p).stops.map((x) => x.name)).toEqual(['A', 'Missed', 'C', 'D'])
    expect(sceneOf(p).legs).toEqual([onTrack, onTrack, onTrack])
  })

  test('a new leg joining two track legs only shares a symbol they both have', () => {
    let p = imported()
    p = applyPatch(p, { ops: [{ op: 'update_leg', index: 1, changes: { symbol: 'ferry' } }] })
    p = applyPatch(p, { ops: [{ op: 'remove_stop', id: sceneOf(p).stops[1]!.id }] })
    expect(sceneOf(p).legs[0]).toEqual({ mode: 'track', track: TRACK, via: [] })
  })

  test('a new leg joining two different tracks is a line', () => {
    const p = imported()
    const scene = sceneOf(p)
    scene.legs[1] = { mode: 'track', track: 'ba9876543210', via: [] }
    const out = applyPatch(p, { ops: [{ op: 'remove_stop', id: scene.stops[1]!.id }] })
    expect(sceneOf(out).legs[0]).toEqual({ mode: 'line', via: [] })
  })

  test('a new leg next to a track leg of another kind is a line', () => {
    const p = imported()
    const scene = sceneOf(p)
    scene.legs[1] = { mode: 'sea', via: [] }
    const out = applyPatch(p, { ops: [{ op: 'remove_stop', id: scene.stops[1]!.id }] })
    expect(sceneOf(out).legs[0]).toEqual({ mode: 'line', via: [] })
  })

  test("an inserted stop's legMode wins over the track", () => {
    const three = importTrack(emptyProject(), { stops: four.slice(0, 3), track: TRACK })
    const p = applyPatch(three, { ops: [{ op: 'insert_stop', index: 1, stop: { ...s('X', [0.5, 0]), legMode: 'air', symbol: 'plane' } }] })
    expect(sceneOf(p).stops.map((x) => x.name)).toEqual(['A', 'X', 'B', 'C'])
    expect(sceneOf(p).legs[0]).toEqual({ mode: 'track', track: TRACK, via: [] })
    expect(sceneOf(p).legs[1]).toEqual({ mode: 'air', via: [], symbol: 'plane' })
    expect(sceneOf(p).legs[2]).toEqual(sceneOf(three).legs[1])
  })

  test('move_stop on a track project never makes a track leg without a track', () => {
    const p = imported()
    const ids = sceneOf(p).stops.map((x) => x.id)
    for (const id of ids) {
      for (let index = 0; index < ids.length; index++) {
        const moved = applyPatch(p, { ops: [{ op: 'move_stop', id, index }] })
        for (const leg of sceneOf(moved).legs) {
          if (leg.mode === 'track') expect(leg).toMatchObject({ track: TRACK, via: [] })
        }
      }
    }
    // Moving the first stop to the end makes D → A, which no old leg joins, so it is a line.
    const last = applyPatch(p, { ops: [{ op: 'move_stop', id: ids[0]!, index: 3 }] })
    expect(sceneOf(last).legs.at(-1)).toEqual({ mode: 'line', via: [] })
  })

  test('set_stops replace:false after a track leaves the new legs off the track', () => {
    const p = setStops(imported(), { stops: [s('E', [4, 0]), s('F', [5, 0])], replace: false })
    expect(sceneOf(p).legs.slice(0, 3)).toEqual([onTrack, onTrack, onTrack])
    expect(sceneOf(p).legs.slice(3)).toEqual([{ mode: 'line', via: [] }, { mode: 'line', via: [] }])
  })

  test('a symbol alone keeps a track leg on its track', () => {
    const p = applyPatch(imported(), { ops: [{ op: 'update_leg', index: 0, changes: { symbol: 'ferry' } }] })
    expect(sceneOf(p).legs[0]).toEqual({ mode: 'track', track: TRACK, via: [], symbol: 'ferry' })
    const off = applyPatch(imported(), { ops: [{ op: 'update_leg', index: 0, changes: { symbol: 'plane', mode: 'air' } }] })
    expect(sceneOf(off).legs[0]).toEqual({ mode: 'air', track: TRACK, via: [], symbol: 'plane' })
  })
})
