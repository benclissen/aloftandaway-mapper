import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { defaultProject, parseProject, ProjectError, type Output, type Project } from '../core/index.js'

export const PROJECT_FILE = 'mapper.json'

export class StoreError extends Error {
  readonly fix: string

  constructor(message: string, fix: string) {
    super(message)
    this.name = 'StoreError'
    this.fix = fix
  }
}

export function assertAbsolute(folder: string): void {
  if (!path.isAbsolute(folder)) {
    throw new StoreError(
      `Project folder must be an absolute path, got '${folder}'`,
      'Pass an absolute folder path, for example /Users/you/Trips/greek-islands.',
    )
  }
}

// Each folder runs its mutations one after another. A failed task still releases the folder.
const queues = new Map<string, Promise<void>>()

function inFolderQueue<T>(folder: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(folder)
  const run = (queues.get(key) ?? Promise.resolve()).then(task)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return run
}

export async function createProject(folder: string, name: string, output?: Partial<Output>): Promise<Project> {
  assertAbsolute(folder)
  const definedOutput = Object.fromEntries(Object.entries(output ?? {}).filter(([, value]) => value !== undefined))
  const project = parseProject(
    defaultProject({ id: randomUUID(), name, now: new Date().toISOString(), output: definedOutput }),
  )
  return inFolderQueue(folder, async () => {
    const file = path.join(folder, PROJECT_FILE)
    if (await exists(file)) {
      throw new StoreError(
        `A project already exists at ${file}`,
        'Open the existing project, or choose another folder.',
      )
    }
    await mkdir(folder, { recursive: true })
    await writeAtomic(folder, project)
    return project
  })
}

export async function loadProject(folder: string): Promise<Project> {
  assertAbsolute(folder)
  const file = path.join(folder, PROJECT_FILE)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e) {
    if (isNotFound(e)) {
      throw new StoreError(`No project found at ${file}`, 'Create the project first with create_project.')
    }
    throw e
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (e) {
    throw new StoreError(
      `${file} isn't valid JSON: ${(e as Error).message}`,
      "mapper.json isn't valid JSON. Restore it from a backup or create a new project.",
    )
  }
  try {
    return parseProject(json)
  } catch (e) {
    if (!(e instanceof ProjectError)) throw e
    throw new StoreError(
      `${file} doesn't match the project schema:\n${e.message}`,
      "mapper.json doesn't match the project schema. Restore it from a backup or create a new project.",
    )
  }
}

export async function saveProject(folder: string, project: Project): Promise<Project> {
  assertAbsolute(folder)
  const valid = parseProject(project)
  const previous = Date.parse(valid.updatedAt)
  const now = Date.now()
  // Keep updatedAt strictly increasing, even when two saves land in the same millisecond.
  const next = Number.isFinite(previous) && now <= previous ? previous + 1 : now
  const saved = { ...valid, updatedAt: new Date(next).toISOString() }
  await writeAtomic(folder, saved)
  return saved
}

export async function mutateProject(folder: string, fn: (project: Project) => Project): Promise<Project> {
  assertAbsolute(folder)
  return inFolderQueue(folder, async () => saveProject(folder, fn(await loadProject(folder))))
}

/** SHA-256 of the project as canonical JSON (object keys sorted), leaving out `updatedAt`. */
export function projectHash(project: Project): string {
  const { updatedAt: _updatedAt, ...rest } = project
  return createHash('sha256').update(JSON.stringify(canonical(rest))).digest('hex')
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]))
  }
  return value
}

/** Writes to a temporary file in the same folder, flushes it to disk, then renames it over mapper.json. */
async function writeAtomic(folder: string, project: Project): Promise<void> {
  const file = path.join(folder, PROJECT_FILE)
  const tmp = path.join(folder, `${PROJECT_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    const handle = await open(tmp, 'w')
    try {
      await handle.writeFile(`${JSON.stringify(project, null, 2)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, file)
  } catch (e) {
    await unlink(tmp).catch(() => undefined)
    throw e
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch (e) {
    if (isNotFound(e)) return false
    throw e
  }
}

function isNotFound(e: unknown): boolean {
  return (e as NodeJS.ErrnoException).code === 'ENOENT'
}
