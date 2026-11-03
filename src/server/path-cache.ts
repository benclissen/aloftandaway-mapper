import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { SeaPath } from '../core/index.js'
import { writeFileAtomic } from './atomic.js'

/** The most entries a path cache keeps: the 200 used last. */
export const MAX_ENTRIES = 200

/** True when `value` is a `SeaPath` that `buildRoute` can use. */
export function wellFormed(value: unknown): value is SeaPath {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Partial<SeaPath>
  if (e.status === 'fallback') return true
  if (e.status !== 'ok') return false
  if (!Array.isArray(e.path) || e.path.length === 0) return false
  if (!Array.isArray(e.knots) || e.knots.length === 0) return false
  const n = e.path.length
  return e.knots.every((k) => Number.isInteger(k) && k >= 0 && k < n)
}

/** The last cache read or written for each file, with the file's change time and size at that moment. */
const memo = new Map<string, { stamp: string; tag: string; paths: Record<string, { usedAt: string }> }>()

/** Folders whose cache couldn't be written, logged once each per kind of route. */
const unwritable = new Set<string>()

/** The stamp the memo holds for a file that doesn't exist, so routes that couldn't be saved are still remembered. */
const UNWRITTEN = 'unwritten'

/** Changes whenever the file is rewritten; undefined if it can't be read. */
export async function stampOf(file: string): Promise<string | undefined> {
  try {
    const s = await stat(file, { bigint: true })
    return `${s.mtimeNs}:${s.size}`
  } catch {
    return undefined
  }
}

/**
 * The entries of the cache file that `keep` accepts, when `accept` takes the file's header (its fields other than
 * `paths`), else none. `tag` says what the file was read for: a file last read for another tag is read again.
 */
export async function readCache<E extends { usedAt: string }>(
  file: string,
  tag: string,
  accept: (raw: Record<string, unknown>) => boolean,
  keep: (entry: unknown) => entry is E,
): Promise<Record<string, E>> {
  const stamp = await stampOf(file)
  const known = memo.get(file)
  // A file that isn't there may be one that couldn't be written, whose routes are kept under `UNWRITTEN`.
  if (known && known.stamp === (stamp ?? UNWRITTEN) && known.tag === tag) return known.paths as Record<string, E>
  if (stamp === undefined) return {}
  const kept: Record<string, E> = {}
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown> | null
    if (raw && accept(raw) && typeof raw.paths === 'object' && raw.paths !== null) {
      for (const [key, entry] of Object.entries(raw.paths)) {
        if (keep(entry)) kept[key] = entry
      }
    }
  } catch {
    // A corrupt cache is rebuilt.
  }
  memo.set(file, { stamp, tag, paths: kept })
  return kept
}

/**
 * Saves the newest `MAX_ENTRIES` of `cache` to `file` after `header`, marking the entries in `inUse` as used at `now`.
 * If the file can't be written the error is logged once per folder and `kind`, and nothing is thrown.
 */
export async function saveNewest<E extends { usedAt: string }>(
  file: string,
  dir: string,
  kind: string,
  header: Record<string, unknown>,
  tag: string,
  cache: Record<string, E>,
  inUse: Iterable<string>,
  now: string,
): Promise<void> {
  for (const key of inUse) cache[key]!.usedAt = now
  const newest = Object.fromEntries(
    Object.entries(cache)
      .sort((a, b) => (a[1].usedAt < b[1].usedAt ? 1 : a[1].usedAt > b[1].usedAt ? -1 : 0))
      .slice(0, MAX_ENTRIES),
  )
  const label = `${kind}\0${dir}`
  try {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFileAtomic(file, JSON.stringify({ ...header, paths: newest }))
    const stamp = await stampOf(file)
    if (stamp !== undefined) memo.set(file, { stamp, tag, paths: newest })
    unwritable.delete(label)
  } catch (e) {
    // Keep the routes anyway, so they aren't worked out again on every call. A file that appears later has another stamp.
    memo.set(file, { stamp: (await stampOf(file)) ?? UNWRITTEN, tag, paths: newest })
    if (!unwritable.has(label)) {
      unwritable.add(label)
      console.error(`Mapper could not save ${kind} routes to ${file}:`, e)
    }
  }
}
