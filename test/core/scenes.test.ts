import { describe, expect, test } from 'vitest'
import { ProjectError, SceneRefSchema, resolveScene, sceneLabel } from '../../src/core/index.js'
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
    expect(sceneLabel(project, 0)).toBe('Scene 1 of 2 · Untitled')
  })
})
