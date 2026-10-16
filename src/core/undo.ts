import { applyPatch, isSceneOp, ProjectPatchSchema, type PatchOp, type ProjectPatch } from './patch.js'
import { resolveScene } from './scenes.js'
import { defaultModeFor, type Project } from './schema.js'

type Obj = Record<string, unknown>

const SUPPORTED = new Set([
  'update_stop',
  'update_leg',
  'insert_via',
  'update_via',
  'remove_via',
  'add_scene',
  'duplicate_scene',
  'remove_scene',
  'move_scene',
  'restore_scene',
])

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

/** Inverts one op against `project`, the state it runs on. `sceneId` is the scene the stop, leg and via ops act on. */
function invertOp(project: Project, op: PatchOp, sceneId: string): PatchOp {
  const scene = project.scenes.find((s) => s.id === sceneId)
  switch (op.op) {
    case 'update_stop': {
      const stop = scene!.stops.find((s) => s.id === op.id)!
      return { op: 'update_stop', id: op.id, changes: oldValues(stop, op.changes) as never }
    }
    case 'update_leg': {
      const { symbol, mode } = op.changes
      // A symbol without a mode also sets the mode, so the inverse restores the mode as well.
      const changes: Obj = symbol && !mode ? { ...op.changes, mode: defaultModeFor(symbol) } : { ...op.changes }
      return { op: 'update_leg', index: op.index, changes: oldValues(scene!.legs[op.index]!, changes) as never }
    }
    case 'insert_via':
      return { op: 'remove_via', leg: op.leg, index: op.index }
    case 'remove_via':
      return { op: 'insert_via', leg: op.leg, index: op.index, point: structuredClone(scene!.legs[op.leg]!.via[op.index]!) }
    case 'update_via': {
      const point = scene!.legs[op.leg]!.via[op.index]!
      return { op: 'update_via', leg: op.leg, index: op.index, changes: oldValues(point, op.changes) as never }
    }
    case 'add_scene':
      if (op.id === undefined) throw new Error('invertPatch needs add_scene to carry an id')
      return { op: 'remove_scene', id: op.id }
    case 'duplicate_scene':
      if (op.newId === undefined) throw new Error('invertPatch needs duplicate_scene to carry a newId')
      return { op: 'remove_scene', id: op.newId }
    case 'remove_scene': {
      const index = project.scenes.findIndex((s) => s.id === op.id)
      return { op: 'restore_scene', index, scene: structuredClone(project.scenes[index]!) }
    }
    case 'restore_scene':
      return { op: 'remove_scene', id: op.scene.id }
    case 'move_scene':
      return { op: 'move_scene', id: op.id, index: project.scenes.findIndex((s) => s.id === op.id) }
    default:
      throw new Error(`invertPatch does not support ${(op as { op: string }).op}`)
  }
}

/**
 * The patch that undoes `patch` on `before`: applied to `applyPatch(before, patch)` it gives back `before`.
 * Supports `scene`, `sceneSet`, the stop, leg and via ops, and the scene ops. The inverse names the scene by id.
 * Throws on anything else, including `set`, `add_scene` without an `id` and `duplicate_scene` without a `newId`, and
 * on a patch that edits a scene (`sceneSet`, or stop, leg or via ops) and also removes it, because the inverse
 * can't edit a scene before it is restored.
 */
export function invertPatch(before: Project, patch: ProjectPatch): ProjectPatch {
  const parsed = ProjectPatchSchema.parse(patch)
  if (patch.set !== undefined) throw new Error('invertPatch does not support set')
  const ops = parsed.ops ?? []
  for (const op of ops) {
    if (!SUPPORTED.has(op.op)) throw new Error(`invertPatch does not support ${op.op}`)
  }
  const sceneId = resolveScene(before, parsed.scene).scene.id
  const editsStops = ops.some((op) => !isSceneOp(op))
  const removesScene = ops.some((op) => op.op === 'remove_scene' && op.id === sceneId)
  if (removesScene && patch.sceneSet) throw new Error('invertPatch does not support sceneSet together with removing that scene')
  if (removesScene && editsStops) throw new Error('invertPatch does not support editing stops together with removing that scene')

  const inverse: ProjectPatch = {}
  if (patch.sceneSet || editsStops) inverse.scene = sceneId
  if (patch.sceneSet) inverse.sceneSet = invertMerge(resolveScene(before, sceneId).scene, patch.sceneSet)
  // Invert each op against the state it ran on, then undo them last to first.
  let state = before
  const inverted: PatchOp[] = []
  for (const op of ops) {
    inverted.push(invertOp(state, op, sceneId))
    // A scene op doesn't need the chosen scene, which it may have removed.
    state = applyPatch(state, isSceneOp(op) ? { ops: [op] } : { scene: sceneId, ops: [op] })
  }
  if (inverted.length) inverse.ops = inverted.reverse()
  return inverse
}
