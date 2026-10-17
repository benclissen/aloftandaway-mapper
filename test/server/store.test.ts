import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ProjectError, setStops, type LngLat, type Project } from '../../src/core/index.js'
import {
  PROJECT_FILE,
  StoreError,
  assertAbsolute,
  createProject,
  loadProject,
  mutateProject,
  projectHash,
  restampProject,
  saveProject,
} from '../../src/server/store.js'
import { writeFileAtomic } from '../../src/server/atomic.js'
import { greekIslands, sceneOf } from '../fixtures/projects.js'

// The real writeFileAtomic, wrapped so a test can land an outside write while a save is under way.
vi.mock('../../src/server/atomic.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/server/atomic.js')>()
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) }
})
const { writeFileAtomic: realWriteFileAtomic } =
  await vi.importActual<typeof import('../../src/server/atomic.js')>('../../src/server/atomic.js')

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

  test('a file from a newer Mapper says to update Mapper', async () => {
    const newer = { ...JSON.parse(JSON.stringify(greekIslands())), schemaVersion: 3 }
    await writeFile(path.join(tmp, PROJECT_FILE), JSON.stringify(newer))
    const error = await failure(loadProject(tmp))
    expect(error).toBeInstanceOf(StoreError)
    expect((error as StoreError).message).toContain('newer version of Mapper')
    expect((error as StoreError).fix).toBe('Update Mapper to open it.')
  })
})

describe('version 1 files', () => {
  test('load upgrades in memory, and the next save writes version 2', async () => {
    const v2 = greekIslands()
    const scene = sceneOf(v2)
    const v1 = {
      schemaVersion: 1,
      id: v2.id,
      name: v2.name,
      createdAt: v2.createdAt,
      updatedAt: v2.updatedAt,
      output: v2.output,
      timing: scene.timing,
      stops: scene.stops,
      legs: scene.legs.map((leg, i) => (i === 0 ? { mode: leg.mode, via: [[24, 37.5]] } : leg)),
      look: scene.look,
      camera: scene.camera,
      credit: v2.credit,
    }
    const file = path.join(tmp, PROJECT_FILE)
    await writeFile(file, JSON.stringify(v1))

    const loaded = await loadProject(tmp)
    expect(loaded.schemaVersion).toBe(2)
    expect(sceneOf(loaded).id).toBe(v2.id)
    expect(sceneOf(loaded).legs[0]!.via).toEqual([{ at: [24, 37.5] }])
    // Loading alone leaves the file as it was.
    expect(JSON.parse(await readFile(file, 'utf8')).schemaVersion).toBe(1)

    await mutateProject(tmp, (p) => ({ ...p, name: 'Saved' }))
    const written = JSON.parse(await readFile(file, 'utf8'))
    expect(written.schemaVersion).toBe(2)
    expect(written).not.toHaveProperty('stops')
    expect(written.scenes).toHaveLength(1)
    expect(written.scenes[0].id).toBe(v2.id)
  })
})

describe('writeFileAtomic', () => {
  test('writes the text and leaves only the file', async () => {
    const file = path.join(tmp, 'out.json')
    await writeFileAtomic(file, 'one')
    await writeFileAtomic(file, 'two')
    expect(await readFile(file, 'utf8')).toBe('two')
    expect(await readdir(tmp)).toEqual(['out.json'])
  })

  test('writeFileAtomic leaves no temp file on failure', async () => {
    const readOnly = path.join(tmp, 'read-only')
    await mkdir(readOnly)
    await writeFile(path.join(readOnly, 'out.json'), 'before')
    await chmod(readOnly, 0o555)
    try {
      await expect(writeFileAtomic(path.join(readOnly, 'out.json'), 'after')).rejects.toThrow()
    } finally {
      await chmod(readOnly, 0o755)
    }
    expect(await readdir(readOnly)).toEqual(['out.json'])
    expect(await readFile(path.join(readOnly, 'out.json'), 'utf8')).toBe('before')

    // A rename over a non-empty folder fails after the temporary file was written.
    const blocked = path.join(tmp, 'blocked')
    await mkdir(path.join(blocked, 'out.json', 'inside'), { recursive: true })
    await expect(writeFileAtomic(path.join(blocked, 'out.json'), 'text')).rejects.toThrow()
    expect(await readdir(blocked)).toEqual(['out.json'])
  })

  test('beforeReplace runs on the finished temporary file, and a throw leaves the file as it was', async () => {
    const file = path.join(tmp, 'out.json')
    await writeFile(file, 'before')
    let seen: string[] = []
    const refused = new Error('refused')
    const error = await failure(
      writeFileAtomic(file, 'after', {
        async beforeReplace() {
          const temps = (await readdir(tmp)).filter((f) => f.endsWith('.tmp'))
          seen = await Promise.all(temps.map((f) => readFile(path.join(tmp, f), 'utf8')))
          throw refused
        },
      }),
    )
    expect(error).toBe(refused)
    expect(seen).toEqual(['after'])
    expect(await readdir(tmp)).toEqual(['out.json'])
    expect(await readFile(file, 'utf8')).toBe('before')

    await writeFileAtomic(file, 'after', { beforeReplace: async () => undefined })
    expect(await readFile(file, 'utf8')).toBe('after')
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

  test('saveProject with after stamps later than after', async () => {
    const folder = path.join(tmp, 'after')
    const created = await createProject(folder, 'After')
    const after = new Date(Date.now() + 3_600_000).toISOString()
    const saved = await saveProject(folder, created, { after })
    expect(Date.parse(saved.updatedAt)).toBeGreaterThan(Date.parse(after))
    expect((await loadProject(folder)).updatedAt).toBe(saved.updatedAt)
  })

  test('refuses to write a project that fails the schema', async () => {
    const folder = path.join(tmp, 'invalid')
    const created = await createProject(folder, 'Invalid')
    const error = await failure(saveProject(folder, { ...created, output: { ...created.output, height: 1000 } } as unknown as Project))
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
    expect(sceneOf(await loadProject(folder)).stops).toHaveLength(20)
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

describe('restampProject', () => {
  test('restamp leaves a file that changed since it was read', async () => {
    const folder = path.join(tmp, 'changed')
    const created = await createProject(folder, 'Changed')
    const hash = projectHash(created)
    await mutateProject(folder, (p) => ({ ...p, name: 'Changed meanwhile' }))
    const file = path.join(folder, PROJECT_FILE)
    const before = await readFile(file, 'utf8')
    // Late enough that only the content can refuse it.
    const after = new Date(Date.now() + 3_600_000).toISOString()
    expect(await restampProject(folder, { hash, after })).toBeUndefined()
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  test('restamp leaves a newer write that lands while it saves', async () => {
    const folder = path.join(tmp, 'outside')
    const created = await createProject(folder, 'Outside')
    const file = path.join(folder, PROJECT_FILE)
    const after = new Date(Date.parse(created.updatedAt) + 3_600_000).toISOString()
    // Another process saves a valid, newer project straight to disk, past the folder queue, while the restamp saves:
    // after the restamp checked the file and wrote its temporary file, before the rename.
    const newer: Project = {
      ...created,
      name: 'Saved elsewhere',
      updatedAt: new Date(Date.parse(after) + 60_000).toISOString(),
    }
    const newerText = `${JSON.stringify(newer, null, 2)}\n`
    let landed = false
    vi.mocked(writeFileAtomic).mockImplementationOnce(async (target, text, opts) => {
      await realWriteFileAtomic(target, text, {
        async beforeReplace() {
          await writeFile(file, newerText)
          landed = true
          await opts?.beforeReplace?.()
        },
      })
    })
    expect(await restampProject(folder, { hash: projectHash(created), after })).toBeUndefined()
    expect(landed).toBe(true)
    expect(await readFile(file, 'utf8')).toBe(newerText)
    expect(await loadProject(folder)).toEqual(newer)
    expect((await readdir(folder)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  test('restamp leaves a file already newer than after', async () => {
    const folder = path.join(tmp, 'newer')
    const created = await createProject(folder, 'Newer')
    const file = path.join(folder, PROJECT_FILE)
    const before = await readFile(file, 'utf8')
    const after = new Date(Date.parse(created.updatedAt) - 1000).toISOString()
    expect(await restampProject(folder, { hash: projectHash(created), after })).toBeUndefined()
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  test('restamp saves a matching file with a later updatedAt and nothing else changed', async () => {
    const folder = path.join(tmp, 'matching')
    const created = await createProject(folder, 'Matching')
    const after = new Date(Date.parse(created.updatedAt) + 3_600_000).toISOString()
    const restamped = await restampProject(folder, { hash: projectHash(created), after })
    expect(restamped).toBeDefined()
    expect(Date.parse(restamped!.updatedAt)).toBeGreaterThan(Date.parse(after))
    const loaded = await loadProject(folder)
    expect(loaded).toEqual(restamped)
    expect(projectHash(loaded)).toBe(projectHash(created))
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
    const reversed = { ...sceneOf(base), stops: [...sceneOf(base).stops].reverse() }
    expect(projectHash({ ...base, scenes: [reversed] })).not.toBe(projectHash(base))
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
