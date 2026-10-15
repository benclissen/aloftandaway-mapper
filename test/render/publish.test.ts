import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { SATELLITE_CREDIT_WRITTEN, TERRAIN_CREDIT_WRITTEN, joinCredit, projectCredit, type Project } from '../../src/core/index.js'
import { slug } from '../../src/render/export-plan.js'
import { RenderCancelled } from '../../src/render/errors.js'
import type { SceneExport } from '../../src/render/export-types.js'
import { emptyProject } from '../fixtures/projects.js'
import { publishFcpxml } from '../../src/render/publish.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'mapper-publish-')) })
afterEach(() => rm(dir, { recursive: true, force: true }))

const scene: SceneExport = {
  id: 'a', name: 'A', frames: 25, sourceRange: { fromFrame: 0, toFrame: 25 },
  layers: { map: '/r/map.mov', route: '/r/route.mov', signs: '/r/signs.mov' }, markers: [],
}
const project = { name: 'Trip', output: { aspect: '16:9', height: 1080, fps: { num: 25, den: 1 } }, credit: 'burned', scenes: [] } as const

test('a cancel before the rename leaves no final or temporary XML', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(publishFcpxml({ dir, project, scenes: [scene], signal: controller.signal })).rejects.toBeInstanceOf(RenderCancelled)
  expect(await readdir(dir)).toEqual([])
})

test('a missing DTD keeps the temporary XML and publishes no final XML', async () => {
  await expect(publishFcpxml({ dir, project, scenes: [scene], dtdPath: path.join(dir, 'nope.dtd') })).rejects.toThrow(/DTD is missing/)
  expect(await readdir(dir)).toEqual(['trip.fcpxml.tmp'])
})

test('description credit writes the full written credit into the FCPXML notes, the same text the manifest gets', async () => {
  const base = emptyProject()
  const first = base.scenes[0]!
  const satellite = { ...first, look: { ...first.look, theme: 'satellite' as const, terrain: true } }
  const described: Project = { ...base, credit: 'description', scenes: [satellite] }
  await expect(publishFcpxml({ dir, project: described, scenes: [scene], dtdPath: path.join(dir, 'nope.dtd') })).rejects.toThrow()
  const xml = await readFile(path.join(dir, `${slug(described.name)}.fcpxml.tmp`), 'utf8')
  const written = joinCredit(projectCredit(described, 'written'))
  expect(written).toContain(SATELLITE_CREDIT_WRITTEN)
  expect(written).toContain(TERRAIN_CREDIT_WRITTEN)
  // The credit has no XML special characters. render.ts builds the manifest's credit with this exact call, so equal notes mean equal text.
  expect(xml).toContain(written)
})
