import { z } from 'zod'
import { ProjectError, type Project, type Scene } from './schema.js'

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

/** For example `Scene 2 of 3 · Sail`. A scene with no name shows as `Untitled`. */
export function sceneLabel(project: Project, index: number): string {
  return `Scene ${index + 1} of ${project.scenes.length} · ${project.scenes[index]?.name || 'Untitled'}`
}
