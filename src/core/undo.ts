import { applyPatch, ProjectPatchSchema, type ProjectPatch, type StopOp } from './patch.js'
import { defaultModeFor, type Project } from './schema.js'

type Obj = Record<string, unknown>

const SUPPORTED = new Set(['update_stop', 'update_leg', 'insert_via', 'update_via', 'remove_via'])

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The merge patch that undoes `patch` on `before`, key by key. */
function invertMerge(before: unknown, patch: Obj): Obj {
  const inverse: Obj = {}
  const prior = isObj(before) ? before : {}
  for (const [key, value] of Object.entries(patch)) {
    const had = Object.hasOwn(prior, key)
    if (isObj(value) && had && isObj(prior[key])) inverse[key] = invertMerge(prior[key], value)
    else inverse[key] = had ? structuredClone(prior[key]) : null
  }
  return inverse
}

/** Old values (or `null` where absent) for each key a change would touch. */
function oldValues(target: object, changes: Obj): Obj {
  const old: Obj = {}
  const from = target as Obj
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue
    old[key] = Object.hasOwn(from, key) ? structuredClone(from[key]) : null
  }
  return old
}

function invertOp(project: Project, op: StopOp): StopOp {
  const scene = project.scenes[0]!
  switch (op.op) {
    case 'update_stop': {
      const stop = scene.stops.find((s) => s.id === op.id)!
      return { op: 'update_stop', id: op.id, changes: oldValues(stop, op.changes) as never }
    }
    case 'update_leg': {
      const { symbol, mode } = op.changes
      // A symbol without a mode also sets the mode, so the inverse restores the mode as well.
      const changes: Obj = symbol && !mode ? { ...op.changes, mode: defaultModeFor(symbol) } : { ...op.changes }
      return { op: 'update_leg', index: op.index, changes: oldValues(scene.legs[op.index]!, changes) as never }
    }
    case 'insert_via':
      return { op: 'remove_via', leg: op.leg, index: op.index }
    case 'remove_via':
      return { op: 'insert_via', leg: op.leg, index: op.index, point: structuredClone(scene.legs[op.leg]!.via[op.index]!) }
    case 'update_via': {
      const point = scene.legs[op.leg]!.via[op.index]!
      return { op: 'update_via', leg: op.leg, index: op.index, changes: oldValues(point, op.changes) as never }
    }
    default:
      throw new Error(`invertPatch does not support ${op.op}`)
  }
}

/**
 * The patch that undoes `patch` on `before`: applied to `applyPatch(before, patch)` it gives back `before`.
 * Supports `sceneSet` and the ops update_stop, update_leg, insert_via, update_via and remove_via; throws on
 * anything else, including `set`.
 */
export function invertPatch(before: Project, patch: ProjectPatch): ProjectPatch {
  const parsed = ProjectPatchSchema.parse(patch)
  if (patch.set !== undefined) throw new Error('invertPatch does not support set')
  const ops = parsed.ops ?? []
  for (const op of ops) {
    if (!SUPPORTED.has(op.op)) throw new Error(`invertPatch does not support ${op.op}`)
  }
  const inverse: ProjectPatch = {}
  if (patch.sceneSet) inverse.sceneSet = invertMerge(before.scenes[0], patch.sceneSet)
  // Invert each op against the state it ran on, then undo them last to first.
  let state = before
  const inverted: StopOp[] = []
  for (const op of ops) {
    inverted.push(invertOp(state, op))
    state = applyPatch(state, { ops: [op] })
  }
  if (inverted.length) inverse.ops = inverted.reverse()
  return inverse
}
