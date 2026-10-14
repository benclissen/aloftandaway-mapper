import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { RenderCancelled } from '../../src/render/errors.js'
import type { SceneExport } from '../../src/render/export-types.js'
import { publishFcpxml } from '../../src/render/publish.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'mapper-publish-')) })
afterEach(() => rm(dir, { recursive: true, force: true }))

const scene: SceneExport = {
  id: 'a', name: 'A', frames: 25, sourceRange: { fromFrame: 0, toFrame: 25 },
  layers: { map: '/r/map.mov', route: '/r/route.mov', signs: '/r/signs.mov' }, markers: [],
}
const project = { name: 'Trip', output: { aspect: '16:9', height: 1080, fps: { num: 25, den: 1 } }, credit: 'burned' } as const

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
