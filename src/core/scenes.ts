import { z } from 'zod'
import { ProjectError, type Project, type Scene } from './schema.js'
import type { SceneOp } from './patch.js'

/** A scene by id (a string) or by 1-based position in film order (a number). */
export const SceneRefSchema = z.union([z.string().min(1), z.number().int().min(1)])
export type SceneRef = z.infer<typeof SceneRefSchema>

/** The scene `ref` names, and its 0-based index. Without a `ref`, the first scene. Throws a `ProjectError` at `['scene']`. */
export function resolveScene(project: Project, ref?: SceneRef): { scene: Scene; index: number } {
  const index = ref === undefined ? 0 : typeof ref === 'number' ? ref - 1 : project.scenes.findIndex((s) => s.id === ref)
  const scene = project.scenes[index]
  if (scene) return { scene, index }
  const scenes = project.scenes.map((s, i) => `${i + 1} "${s.name}" (id ${s.id})`).join(', ')
  const named = typeof ref === 'number' ? String(ref) : `'${ref}'`
  throw new ProjectError([{ path: ['scene'], message: `no scene ${named}; the scenes are ${scenes}` }])
}

/** The message for a scene name that is empty or only spaces. */
export const BLANK_SCENE_NAME = "a scene name can't be blank"

/**
 * What to call a scene: its name without surrounding spaces, or `Scene N` (N is `index` + 1) when the name is blank.
 * Old files can hold a blank name; new input can't.
 */
export function sceneTitleOf(name: string, index: number): string {
  return name.trim() || `Scene ${index + 1}`
}

/** `sceneTitleOf` for the scene at `index`. */
export function sceneTitle(project: Project, index: number): string {
  return sceneTitleOf(project.scenes[index]?.name ?? '', index)
}

/** For example `Scene 2 of 3 · Sail`. A scene with no name shows as `Scene 2`. */
export function sceneLabel(project: Project, index: number): string {
  return `Scene ${index + 1} of ${project.scenes.length} · ${sceneTitle(project, index)}`
}

// Scene ops

/** A new scene id: a random UUID. */
export function newSceneId(): string {
  return crypto.randomUUID()
}

function fail(path: (string | number)[], message: string): never {
  throw new ProjectError([{ path, message }])
}

/**
 * Runs one scene op on `project` (the op's position in the patch is `at`, for error paths) and returns the new
 * project. `stopId` makes the ids for a duplicated scene's stops. The input is not modified.
 */
export function applySceneOp(project: Project, op: SceneOp, at: number, stopId: () => string): Project {
  const scenes = project.scenes
  const find = (id: string): number => {
    const i = scenes.findIndex((s) => s.id === id)
    if (i < 0) fail(['ops', at, 'id'], `unknown scene id '${id}'`)
    return i
  }
  const checkIndex = (value: number, max: number): void => {
    if (value > max) fail(['ops', at, 'index'], `index ${value} is out of range; use 0 to ${max}`)
  }

  switch (op.op) {
    case 'add_scene': {
      const to = op.index ?? scenes.length
      checkIndex(to, scenes.length)
      if (op.name !== undefined && !op.name.trim()) fail(['ops', at, 'name'], BLANK_SCENE_NAME)
      if (op.id !== undefined && scenes.some((s) => s.id === op.id)) fail(['ops', at, 'id'], `scene id '${op.id}' is already in use`)
      let from: Scene
      if (op.copyLookFrom === undefined) from = scenes[Math.max(0, to - 1)]!
      else {
        try {
          from = resolveScene(project, op.copyLookFrom).scene
        } catch (e) {
          if (e instanceof ProjectError) fail(['ops', at, 'copyLookFrom'], e.issues[0]!.message)
          throw e
        }
      }
      const { mode, easing, follow } = from.camera
      const scene: Scene = {
        id: op.id ?? newSceneId(),
        name: op.name === undefined ? `Scene ${to + 1}` : op.name.trim(),
        timing: structuredClone(from.timing),
        stops: [],
        legs: [],
        look: structuredClone(from.look),
        camera: structuredClone(follow ? { mode, easing, follow } : { mode, easing }),
      }
      return { ...project, scenes: scenes.toSpliced(to, 0, scene) }
    }
    case 'duplicate_scene': {
      const i = find(op.id)
      const id = op.newId ?? newSceneId()
      if (scenes.some((s) => s.id === id)) fail(['ops', at, 'newId'], `scene id '${id}' is already in use`)
      const original = scenes[i]!
      const copy: Scene = {
        ...structuredClone(original),
        id,
        name: `${sceneTitle(project, i)} copy`,
      }
      copy.stops = copy.stops.map((s) => ({ ...s, id: stopId() }))
      return { ...project, scenes: scenes.toSpliced(i + 1, 0, copy) }
    }
    case 'remove_scene': {
      const i = find(op.id)
      if (scenes.length === 1) fail(['ops', at], 'a project needs at least one scene; add another before removing this one')
      return { ...project, scenes: scenes.toSpliced(i, 1) }
    }
    case 'move_scene': {
      const i = find(op.id)
      checkIndex(op.index, scenes.length - 1)
      return { ...project, scenes: scenes.toSpliced(i, 1).toSpliced(op.index, 0, scenes[i]!) }
    }
    case 'restore_scene': {
      checkIndex(op.index, scenes.length)
      return { ...project, scenes: scenes.toSpliced(op.index, 0, structuredClone(op.scene)) }
    }
  }
}
