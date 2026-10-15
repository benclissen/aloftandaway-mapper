import { describe, expect, test } from 'vitest'
import { ProjectError, parseProject } from '../../src/core/index.js'

const ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

function v1Project(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: ID,
    name: 'Aegean',
    createdAt: '2026-10-13T10:00:00.000Z',
    updatedAt: '2026-10-13T11:00:00.000Z',
    output: { aspect: '16:9', height: 2160, fps: { num: 25, den: 1 } },
    timing: { holdStart: 1, travel: 8, holdEnd: 2 },
    stops: [
      { id: 'piraeus', name: 'Piraeus', at: [23.6466, 37.942], pause: 0, sign: 'always', terminal: true },
      { id: 'mykonos', name: 'Mykonos', at: [25.3289, 37.4467], pause: 1, sign: 'on-arrival', day: 2 },
    ],
    legs: [{ mode: 'line', via: [[24, 37]], symbol: 'ship' }],
    look: {
      theme: 'paper',
      labels: 'en',
      terrain: false,
      line: { color: '#d9472b', width: 4, dash: 'solid', outline: true, glow: false },
      symbol: 'ship',
      signStyle: 'tag',
    },
    camera: { mode: 'glide', easing: 'smooth', start: { center: [24, 37], zoom: 6, bearing: 0, pitch: 0 } },
    credit: 'burned',
  }
}

function failure(fn: () => unknown): ProjectError {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(ProjectError)
    return e as ProjectError
  }
  throw new Error('expected the call to throw')
}

describe('version 1 upgrade', () => {
  test('upgrades a version 1 project to one scene', () => {
    const v1 = v1Project()
    const project = parseProject(JSON.parse(JSON.stringify(v1)))
    expect(project.schemaVersion).toBe(2)
    expect(project.id).toBe(ID)
    expect(project.name).toBe('Aegean')
    expect(project.createdAt).toBe(v1.createdAt)
    expect(project.updatedAt).toBe(v1.updatedAt)
    expect(project.output).toEqual(v1.output)
    expect(project.credit).toBe('burned')
    expect(project).not.toHaveProperty('stops')
    expect(project.scenes).toHaveLength(1)
    const scene = project.scenes[0]!
    expect(scene.id).toBe(project.id)
    expect(scene.name).toBe(project.name)
    expect(scene.legs[0]!.via).toEqual([{ at: [24, 37] }])
    expect(scene.legs[0]!.mode).toBe('line')
    expect(scene.legs[0]!.symbol).toBe('cruise-ship')
    expect(scene.look.symbol).toBe('cruise-ship')
    expect(scene.timing).toEqual(v1.timing)
    expect(scene.stops).toEqual(v1.stops)
    expect(scene.camera).toEqual(v1.camera)
    expect({ ...scene.look, symbol: 'ship' }).toEqual(v1.look)
  })

  test('upgrade is stable across loads', () => {
    const json = JSON.stringify(v1Project())
    expect(parseProject(JSON.parse(json))).toEqual(parseProject(JSON.parse(json)))
  })

  test('reports version 1 paths for a broken version 1 file', () => {
    const v1 = v1Project()
    const stops = v1.stops as { at: number[] }[]
    stops[0]!.at = [200, 0]
    const e = failure(() => parseProject(v1))
    expect(e.issues[0]!.path).toEqual(['stops', 0, 'at', 0])
  })

  test('rejects a newer schema version', () => {
    const e = failure(() => parseProject({ ...v1Project(), schemaVersion: 3 }))
    expect(e.issues).toEqual([
      {
        path: ['schemaVersion'],
        message: 'This project was made by a newer version of Mapper (schema version 3). Update Mapper to open it.',
      },
    ])
  })
})
