import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { Project } from '../../src/core/index.js'
import { renderProject } from '../../src/render/render.js'
import { getServer } from '../../src/server/server.js'
import { createProject, saveProject } from '../../src/server/store.js'
import { greekIslands } from '../fixtures/projects.js'

const run = promisify(execFile)
let tempDir: string
const previousCacheDir = process.env.MAPPER_CACHE_DIR

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'mapper-resilience-'))
  process.env.MAPPER_CACHE_DIR = path.join(tempDir, 'cache')
})

afterAll(async () => {
  await (await getServer()).close()
  if (previousCacheDir === undefined) delete process.env.MAPPER_CACHE_DIR
  else process.env.MAPPER_CACHE_DIR = previousCacheDir
  await rm(tempDir, { recursive: true, force: true })
})

async function writeFolder(project: Project, name = 'project'): Promise<string> {
  const folder = path.join(tempDir, `${name}-${randomUUID().slice(0, 8)}`)
  await mkdir(folder)
  await createProject(folder, project.name)
  await saveProject(folder, { ...project, id: randomUUID() })
  return folder
}

/** Stream info with every frame decoded and counted, since a concat with `-c copy` can misreport `nb_frames`. */
async function probe(file: string): Promise<Record<string, string | number>> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_streams', '-of', 'json', file])
  return (JSON.parse(stdout) as { streams: Record<string, string | number>[] }).streams[0]!
}

test('recovers from a lost WebGL context', async () => {
  const folder = await writeFolder(greekIslands())
  const result = await renderProject({ folder, range: { from: 0, to: 2 }, faultAtFrame: 20 })
  expect(result.frames).toBe(50)
  expect(Number((await probe(result.video)).nb_read_frames)).toBe(50)
  const manifest = JSON.parse(readFileSync(result.manifest, 'utf8')) as Record<string, unknown>
  expect(manifest.segments).toBe(2)
  expect(manifest.recoveries).toBe(1)
  expect(readdirSync(result.dir).sort()).toEqual(['all.mov', 'manifest.json'])
})

test('a render without a fault is a single segment', async () => {
  const folder = await writeFolder(greekIslands())
  const result = await renderProject({ folder, range: { from: 0, to: 1 } })
  const manifest = JSON.parse(readFileSync(result.manifest, 'utf8')) as Record<string, unknown>
  expect(manifest.segments).toBe(1)
  expect(manifest.recoveries).toBe(0)
  expect(readdirSync(result.dir).sort()).toEqual(['all.mov', 'manifest.json'])
})

test("joins H.264 segments in a render folder with an apostrophe", async () => {
  const folder = await writeFolder(greekIslands(), "Bob's Trip")
  const result = await renderProject({ folder, codec: 'h264', range: { from: 0, to: 1 }, faultAtFrame: 10 })
  expect(result.dir).toContain("Bob's Trip")
  expect(Number((await probe(result.video)).nb_read_frames)).toBe(25)
  const manifest = JSON.parse(readFileSync(result.manifest, 'utf8')) as Record<string, unknown>
  expect(manifest.segments).toBe(2)
  expect(readdirSync(result.dir).sort()).toEqual(['all.mp4', 'manifest.json'])
})
