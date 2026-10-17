import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic, type AtomicOptions } from './atomic.js'
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

/**
 * A `StoreError` naming `target` with a fix for the file-system failures a user can cause: a path through a file
 * (`ENOTDIR`) and missing permissions (`EACCES`, `EPERM`). Anything else is returned as it is.
 */
function fsError(e: unknown, target: string): unknown {
  const code = (e as NodeJS.ErrnoException).code
  if (code === 'ENOTDIR') {
    return new StoreError(
      `${target} can't be reached: part of its path is a file, not a folder.`,
      'Pass the project folder itself, not a file inside it.',
    )
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new StoreError(`Mapper isn't allowed to use ${target} (${code}).`, "Check the folder's permissions.")
  }
  return e
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
    await mkdir(folder, { recursive: true }).catch((e: unknown) => {
      throw fsError(e, folder)
    })
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
    throw fsError(e, file)
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
    const newer = e.issues[0]?.path.length === 1 && e.issues[0].path[0] === 'schemaVersion'
    throw new StoreError(
      `${file} doesn't match the project schema:\n${e.message}`,
      newer
        ? 'Update Mapper to open it.'
        : "mapper.json doesn't match the project schema. Restore it from a backup or create a new project.",
    )
  }
}

/**
 * Validates and writes the project. The saved `updatedAt` is strictly later than the project's own and than `after`,
 * even when two saves land in the same millisecond.
 */
export async function saveProject(folder: string, project: Project, opts: { after?: string } = {}): Promise<Project> {
  assertAbsolute(folder)
  return save(folder, project, opts.after)
}

async function save(
  folder: string,
  project: Project,
  after: string | undefined,
  atomic?: AtomicOptions,
): Promise<Project> {
  const valid = parseProject(project)
  const floor = Math.max(timeOf(valid.updatedAt), timeOf(after))
  const now = Date.now()
  const next = now <= floor ? floor + 1 : now
  const saved = { ...valid, updatedAt: new Date(next).toISOString() }
  await writeAtomic(folder, saved, atomic)
  return saved
}

export async function mutateProject(
  folder: string,
  fn: (project: Project) => Project,
  opts: { after?: string } = {},
): Promise<Project> {
  assertAbsolute(folder)
  return inFolderQueue(folder, async () => saveProject(folder, fn(await loadProject(folder)), opts))
}

/** Thrown inside a restamp's write when the file changed while it was being prepared. */
class Moved extends Error {}

/**
 * Saves the project on disk again with an `updatedAt` later than `expect.after`, changing nothing else. It writes only
 * if the file still holds the content with `expect.hash` and isn't already later than `expect.after`, so it never
 * stamps over a write that landed since the caller read the file. Returns the saved project, or undefined when it left
 * the file alone.
 */
export async function restampProject(
  folder: string,
  expect: { hash: string; after: string },
): Promise<Project | undefined> {
  assertAbsolute(folder)
  return inFolderQueue(folder, async () => {
    let current: Project
    try {
      current = await loadProject(folder)
    } catch {
      return undefined // Not the file the caller read; whatever wrote it fires its own change.
    }
    if (projectHash(current) !== expect.hash || timeOf(current.updatedAt) > timeOf(expect.after)) return undefined
    // The folder queue only orders this process's own writes. An editor or another Mapper can save while the new file
    // is written and flushed, so the file is read again just before the rename. POSIX has no compare-and-swap rename,
    // so this narrows the window to the moment between that read and the rename; it doesn't close it.
    const unchanged = async (): Promise<void> => {
      const onDisk = await loadProject(folder).catch(() => undefined)
      if (!onDisk || projectHash(onDisk) !== expect.hash || onDisk.updatedAt !== current.updatedAt) throw new Moved()
    }
    try {
      return await save(folder, current, expect.after, { beforeReplace: unchanged })
    } catch (e) {
      if (e instanceof Moved) return undefined // The newer write fires its own change.
      throw e
    }
  })
}

/** An ISO time in ms, or -Infinity when there's none to compare. */
function timeOf(iso: string | undefined): number {
  const ms = iso === undefined ? NaN : Date.parse(iso)
  return Number.isFinite(ms) ? ms : -Infinity
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

/** Writes mapper.json atomically (see `writeFileAtomic`). */
async function writeAtomic(folder: string, project: Project, atomic?: AtomicOptions): Promise<void> {
  try {
    await writeFileAtomic(path.join(folder, PROJECT_FILE), `${JSON.stringify(project, null, 2)}\n`, atomic)
  } catch (e) {
    // Name the folder, not the temporary file.
    throw fsError(e, folder)
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch (e) {
    if (isNotFound(e)) return false
    throw fsError(e, file)
  }
}

function isNotFound(e: unknown): boolean {
  return (e as NodeJS.ErrnoException).code === 'ENOENT'
}
