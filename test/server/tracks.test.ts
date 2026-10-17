import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { defaultProject, trackKey, TRACK_ID, validateProject, type LngLat, type Project } from '../../src/core/index.js'
import { resolveSeaPaths } from '../../src/server/paths.js'
import { readTrackPaths, TRACKS_DIR, writeTrack } from '../../src/server/tracks.js'

let folder: string
let errors: ReturnType<typeof vi.spyOn>
beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), 'mapper-tracks-'))
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(async () => {
  errors.mockRestore()
  await rm(folder, { recursive: true, force: true })
})

const POINTS: LngLat[] = [
  [10.123456789, 55.5],
  [11, 56],
  [12.5, 57.25],
]
const file = (id: string) => path.join(folder, TRACKS_DIR, `${id}.json`)

/** A project with one `track` leg per id, A to B each. */
function projectUsing(...ids: string[]): Project {
  const p = defaultProject({ id: '00000000-0000-4000-8000-000000000001', name: 't', now: '2026-01-01T00:00:00.000Z' })
  const scene = p.scenes[0]!
  scene.stops = [0, 1].map((i) => ({ id: `s${i}`, at: POINTS[i]!, name: `S${i}` })) as never
  scene.legs = ids.map((track) => ({ mode: 'track', via: [], track })) as never
  return p
}

test('the same points give the same id and one file', async () => {
  const a = await writeTrack(folder, { points: POINTS })
  const b = await writeTrack(folder, { points: POINTS })
  expect(a).toBe(b)
  expect(a).toMatch(TRACK_ID)
  expect(await readdir(path.join(folder, TRACKS_DIR))).toEqual([`${a}.json`])
})

test('a track file is compact with 6 decimals', async () => {
  const id = await writeTrack(folder, { name: 'Ferry', points: POINTS })
  expect(await readFile(file(id), 'utf8')).toBe(
    '{"version":1,"name":"Ferry","points":[[10.123457,55.5],[11,56],[12.5,57.25]]}',
  )
  const unnamed = await writeTrack(folder, { points: POINTS })
  expect(await readFile(file(unnamed), 'utf8')).toBe('{"version":1,"points":[[10.123457,55.5],[11,56],[12.5,57.25]]}')
})

test('a file that is already there is left alone', async () => {
  const id = await writeTrack(folder, { points: POINTS })
  await writeFile(file(id), 'kept')
  expect(await writeTrack(folder, { points: POINTS })).toBe(id)
  expect(await readFile(file(id), 'utf8')).toBe('kept')
})

test('readTrackPaths reads the tracks a project uses', async () => {
  const id = await writeTrack(folder, { points: POINTS })
  await writeTrack(folder, { points: [[1, 2], [3, 4]] })
  const paths = await readTrackPaths(folder, projectUsing(id, id))
  expect(Object.keys(paths)).toEqual([trackKey(id)])
  expect(paths[trackKey(id)]).toEqual({
    status: 'ok',
    path: [[10.123457, 55.5], [11, 56], [12.5, 57.25]],
    knots: [],
  })
})

test('a project with no track legs reads nothing', async () => {
  expect(await readTrackPaths(folder, projectUsing())).toEqual({})
})

test('a corrupt or missing track file has no entry', async () => {
  await mkdir(path.join(folder, TRACKS_DIR), { recursive: true })
  const bad: Record<string, string> = {
    '000000000001': '{not json',
    '000000000002': JSON.stringify({ version: 2, points: POINTS }),
    '000000000003': JSON.stringify({ version: 1, points: [[1, 2]] }),
    '000000000004': JSON.stringify({ version: 1, points: [[1, 2], [3, 95]] }),
    '000000000005': JSON.stringify({ version: 1, points: [[1, 2], [3, 'x']] }),
    '000000000006': JSON.stringify({ version: 1, points: [[1, 2], [181, 3]] }),
  }
  for (const [id, text] of Object.entries(bad)) await writeFile(file(id), text)
  const ids = [...Object.keys(bad), '00000000000a']
  expect(await readTrackPaths(folder, projectUsing(...ids))).toEqual({})
  // Each is logged once, however often it is read.
  expect(errors).toHaveBeenCalledTimes(ids.length)
  await readTrackPaths(folder, projectUsing(...ids))
  expect(errors).toHaveBeenCalledTimes(ids.length)
})

test('a track read again after it was fixed is picked up', async () => {
  const id = '0000000000ff'
  await mkdir(path.join(folder, TRACKS_DIR), { recursive: true })
  await writeFile(file(id), 'nope')
  expect(await readTrackPaths(folder, projectUsing(id))).toEqual({})
  await writeFile(file(id), JSON.stringify({ version: 1, points: POINTS }))
  expect(Object.keys(await readTrackPaths(folder, projectUsing(id)))).toEqual([trackKey(id)])
})

test('a missing track file gives track-missing in validation', async () => {
  const id = await writeTrack(folder, { points: POINTS })
  const project = projectUsing(id)
  const ok = await resolveSeaPaths(folder, project)
  expect(validateProject(project, { seaPaths: ok }).errors.map((w) => w.code)).not.toContain('track-missing')
  await rm(file(id))
  const gone = await resolveSeaPaths(folder, project)
  expect(gone).toEqual({})
  expect(validateProject(project, { seaPaths: gone }).errors.map((w) => w.code)).toContain('track-missing')
})
