import { createHash } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { MAX_LAT, trackKey, type LngLat, type Project, type SeaPath, type SeaPaths } from '../core/index.js'
import { writeFileAtomic } from './atomic.js'

/** Recorded tracks live here, next to mapper.json, one file per track. */
export const TRACKS_DIR = 'tracks'

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6

/**
 * Stores `track` as `tracks/<id>.json` in `folder` and returns its id: the first 12 hex characters of the SHA-256 of
 * the file's text, so the same points always give the same id and file. The file is written when it isn't there, or
 * when its text isn't exactly that text, so importing again repairs a damaged file. An intact file is left alone.
 */
export async function writeTrack(folder: string, track: { name?: string; points: LngLat[] }): Promise<string> {
  const points = track.points.map(([lng, lat]) => [round6(lng), round6(lat)])
  const text = JSON.stringify({ version: 1, ...(track.name !== undefined ? { name: track.name } : {}), points })
  const id = createHash('sha256').update(text).digest('hex').slice(0, 12)
  const dir = path.join(path.resolve(folder), TRACKS_DIR)
  const file = path.join(dir, `${id}.json`)
  const found = await readFile(file, 'utf8').catch(() => undefined)
  if (found !== text) {
    await mkdir(dir, { recursive: true })
    await writeFileAtomic(file, text)
  }
  return id
}

/** The last read of each track file, stamped with its `mtimeNs` and size. `path` is undefined if it was unusable. */
const memo = new Map<string, { stamp: string; path: LngLat[] | undefined }>()
/** Track files already reported as missing or unreadable, so each is logged once. */
const reported = new Set<string>()

function report(file: string, why: string): void {
  if (reported.has(file)) return
  reported.add(file)
  console.error(`Mapper could not use the recorded track ${file}: ${why}`)
}

/** True when `p` is a `[lng, lat]` pair of finite numbers in range, up to the importers' latitude limit, `MAX_LAT`. */
function validPoint(p: unknown): p is LngLat {
  return (
    Array.isArray(p) &&
    p.length === 2 &&
    typeof p[0] === 'number' &&
    typeof p[1] === 'number' &&
    Number.isFinite(p[0]) &&
    Number.isFinite(p[1]) &&
    Math.abs(p[0]) <= 180 &&
    Math.abs(p[1]) <= MAX_LAT
  )
}

/** The points of the track file `file`, or undefined (after logging once) when it is missing or isn't a usable track. */
async function readPoints(file: string): Promise<LngLat[] | undefined> {
  let stamp: string
  try {
    const s = await stat(file, { bigint: true })
    stamp = `${s.mtimeNs}:${s.size}`
  } catch {
    memo.delete(file)
    report(file, 'the file is missing')
    return undefined
  }
  const known = memo.get(file)
  if (known && known.stamp === stamp) return known.path
  let points: LngLat[] | undefined
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as { version?: unknown; points?: unknown } | null
    if (raw?.version !== 1) report(file, 'it is not a version 1 track')
    else if (!Array.isArray(raw.points) || raw.points.length < 2 || !raw.points.every(validPoint)) {
      report(file, 'it needs at least 2 valid [lng, lat] points')
    } else {
      points = raw.points
      reported.delete(file)
    }
  } catch (e) {
    report(file, `it can't be read as JSON (${e instanceof Error ? e.message : String(e)})`)
  }
  memo.set(file, { stamp, path: points })
  return points
}

/**
 * Every recorded track a `track` leg in `project` uses, read from `<folder>/tracks/`, keyed by `trackKey` as
 * `{ status: 'ok', path: points, knots: [] }`. A track whose file is missing or unusable has no entry.
 */
export async function readTrackPaths(folder: string, project: Project): Promise<SeaPaths> {
  const ids = new Set<string>()
  for (const scene of project.scenes) {
    for (const leg of scene.legs) if (leg.mode === 'track' && leg.track !== undefined) ids.add(leg.track)
  }
  const dir = path.join(path.resolve(folder), TRACKS_DIR)
  const out: SeaPaths = {}
  await Promise.all(
    [...ids].map(async (id) => {
      const points = await readPoints(path.join(dir, `${id}.json`))
      if (points) out[trackKey(id)] = { status: 'ok', path: points, knots: [] } satisfies SeaPath
    }),
  )
  return out
}
