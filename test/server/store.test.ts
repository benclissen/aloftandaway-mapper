import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ProjectError, setStops, type LngLat, type Project } from '../../src/core/index.js'
import {
  PROJECT_FILE,
  StoreError,
  assertAbsolute,
  createProject,
  loadProject,
  mutateProject,
  projectHash,
  saveProject,
} from '../../src/server/store.js'
import { greekIslands } from '../fixtures/projects.js'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'mapper-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (e) {
    return e
  }
  throw new Error('expected the call to reject')
}

describe('createProject and loadProject', () => {
  test('creates and reloads a project in a folder with spaces and accents', async () => {
    const folder = path.join(tmp, 'Trips', 'Café Tour')
    const created = await createProject(folder, 'Café Tour')
    const loaded = await loadProject(folder)
    expect(loaded).toEqual(created)
    expect(loaded.name).toBe('Café Tour')
    expect(JSON.parse(await readFile(path.join(folder, PROJECT_FILE), 'utf8'))).toEqual(created)
  })

  test('applies output overrides and ignores undefined ones', async () => {
    const folder = path.join(tmp, 'out')
    const project = await createProject(folder, 'Out', { aspect: undefined, height: 1080 })
    expect(project.output).toEqual({ aspect: '16:9', height: 1080, fps: { num: 25, den: 1 } })
  })

  test('rejects an invalid output without writing anything', async () => {
    const folder = path.join(tmp, 'bad')
    const error = await failure(createProject(folder, 'Bad', { height: 1000 as 1080 }))
    expect(error).toBeInstanceOf(ProjectError)
    await expect(readdir(tmp)).resolves.toEqual([])
  })

  test('rejects relative paths', async () => {
    const error = await failure(createProject('trips/x', 'X'))
    expect(error).toBeInstanceOf(StoreError)
    expect((error as StoreError).fix).toMatch(/absolute folder path/)
  })

  test('refuses to overwrite an existing project', async () => {
    const folder = path.join(tmp, 'once')
    const first = await createProject(folder, 'First')
    const error = await failure(createProject(folder, 'Second'))
    expect(error).toBeInstanceOf(StoreError)
    expect((await loadProject(folder)).id).toBe(first.id)
  })

  test('loadProject explains a missing project', async () => {
    const error = await failure(loadProject(path.join(tmp, 'nothing')))
    expect(error).toBeInstanceOf(StoreError)
    expect((error as StoreError).fix).toBe('Create the project first with create_project.')
  })

  test('loadProject explains invalid JSON', async () => {
    await writeFile(path.join(tmp, PROJECT_FILE), '{ not json')
    const error = await failure(loadProject(tmp))
    expect(error).toBeInstanceOf(StoreError)
    expect((error as StoreError).fix).toBe("mapper.json isn't valid JSON. Restore it from a backup or create a new project.")
  })

  test('loadProject lists the schema issues', async () => {
    const broken = { ...JSON.parse(JSON.stringify(greekIslands())), name: 42 }
    await writeFile(path.join(tmp, PROJECT_FILE), JSON.stringify(broken))
    const error = await failure(loadProject(tmp))
    expect(error).toBeInstanceOf(StoreError)
    expect((error as StoreError).message).toContain('name')
    expect((error as StoreError).fix).toBe(
      "mapper.json doesn't match the project schema. Restore it from a backup or create a new project.",
    )
  })
})

describe('saveProject', () => {
  test('save is atomic and bumps updatedAt', async () => {
    const folder = path.join(tmp, 'atomic')
    const created = await createProject(folder, 'Atomic')
    const saved = await saveProject(folder, { ...created, name: 'Renamed' })
    expect(Date.parse(saved.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt))
    expect((await loadProject(folder)).updatedAt).toBe(saved.updatedAt)
    expect((await readdir(folder)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  test('uses the previous updatedAt plus 1 ms when the clock has not moved past it', async () => {
    const folder = path.join(tmp, 'tie')
    const created = await createProject(folder, 'Tie')
    const future = new Date(Date.now() + 60_000).toISOString()
    const saved = await saveProject(folder, { ...created, updatedAt: future })
    expect(Date.parse(saved.updatedAt)).toBe(Date.parse(future) + 1)
  })

  test('refuses to write a project that fails the schema', async () => {
    const folder = path.join(tmp, 'invalid')
    const created = await createProject(folder, 'Invalid')
    const error = await failure(saveProject(folder, { ...created, output: { ...created.output, height: 1000 } } as Project))
    expect(error).toBeInstanceOf(ProjectError)
    expect((await loadProject(folder)).output.height).toBe(2160)
  })
})

describe('mutateProject', () => {
  test('concurrent mutations serialise', async () => {
    const folder = path.join(tmp, 'race')
    await createProject(folder, 'Race')
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        mutateProject(folder, (p) => setStops(p, { stops: [{ name: `Stop ${i}`, at: [i, 0] as LngLat }], replace: false })),
      ),
    )
    expect((await loadProject(folder)).stops).toHaveLength(20)
  })

  test('a failing mutation releases the folder lock', async () => {
    const folder = path.join(tmp, 'lock')
    await createProject(folder, 'Lock')
    await failure(
      mutateProject(folder, () => {
        throw new Error('boom')
      }),
    )
    const after = await mutateProject(folder, (p) => ({ ...p, name: 'Still works' }))
    expect(after.name).toBe('Still works')
  })

  test('rejects relative paths', async () => {
    const error = await failure(mutateProject('relative', (p) => p))
    expect(error).toBeInstanceOf(StoreError)
  })
})

describe('assertAbsolute', () => {
  test('accepts absolute paths and rejects others', () => {
    expect(() => assertAbsolute(path.join(tmp, 'ok'))).not.toThrow()
    expect(() => assertAbsolute('ok')).toThrow(StoreError)
  })
})

describe('projectHash', () => {
  test('ignores updatedAt only', () => {
    const base = greekIslands()
    const later: Project = { ...base, updatedAt: '2030-01-01T00:00:00.000Z' }
    expect(projectHash(later)).toBe(projectHash(base))
    expect(projectHash({ ...base, name: 'Other' })).not.toBe(projectHash(base))
    expect(projectHash({ ...base, stops: [...base.stops].reverse() })).not.toBe(projectHash(base))
  })

  test('does not depend on key order', () => {
    const base = greekIslands()
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as Project
    expect(projectHash(reordered)).toBe(projectHash(base))
  })

  test('returns a sha256 hex digest', () => {
    expect(projectHash(greekIslands())).toMatch(/^[0-9a-f]{64}$/)
  })
})
