import { expect, test } from 'vitest'
import type { PlannedJoin, RenderPass } from '../../src/render/export-types.js'
import { assertRenderable, estimateDiskBytes, RenderError } from '../../src/render/render.js'
import { projectWithScenes } from '../fixtures/projects.js'

const pass = (layer: 'map' | 'route' | 'signs', kind: RenderPass['kind']): RenderPass => ({
  sceneId: 's1',
  request: layer,
  layer,
  kind,
  path: `${layer}.mov`,
  fromFrame: 0,
  toFrame: 750,
})

test('a 30 s 4K25 map+route+signs export is estimated near 12 GB', () => {
  const passes = [pass('map', 'prores-hq'), pass('route', 'prores-4444'), pass('signs', 'prores-4444')]
  const { bytes, neededBytes } = estimateDiskBytes(passes, { width: 3840, height: 2160 })
  const px = 750 * 3840 * 2160
  expect(bytes[1]).toBeCloseTo(px * 0.2 * 1.5, -3)
  // Every pass again for the margin is not counted; only the largest one, for the join.
  expect(neededBytes / 1e9).toBeGreaterThan(11)
  expect(neededBytes / 1e9).toBeLessThan(13)
})

test('disk estimate counts the joined copy', () => {
  const part = (scene: string, frames: number): RenderPass => ({
    sceneId: scene, request: 'all', layer: 'all', kind: 'h264', path: `${scene}.part.mp4`, fromFrame: 0, toFrame: frames,
  })
  const passes = [part('01-drive', 750), part('02-sail', 250)]
  const joins: PlannedJoin[] = [{ request: 'all', path: 'all.mp4', kind: 'h264', parts: passes.map((p) => p.path) }]
  const { bytes: [drive, sail], neededBytes } = estimateDiskBytes(passes, { width: 3840, height: 2160 }, joins)
  // The parts, then the joined copy of both while the parts still exist.
  expect(neededBytes).toBeCloseTo(2 * (drive! + sail!), -3)
  // Without a join, only the largest pass is counted again.
  expect(estimateDiskBytes(passes, { width: 3840, height: 2160 }).neededBytes).toBeCloseTo(2 * drive! + sail!, -3)
})

test('the largest pass still counts when it is bigger than a join', () => {
  const map = { ...pass('map', 'prores-hq'), toFrame: 7500 }
  const preview = (scene: string): RenderPass => ({
    sceneId: scene, request: 'preview', layer: 'all', kind: 'h264', path: `${scene}-preview.part.mp4`, fromFrame: 0, toFrame: 100,
  })
  const passes = [map, preview('01-a'), preview('02-b')]
  const joins: PlannedJoin[] = [{ request: 'preview', path: 'preview.mp4', kind: 'h264', parts: [passes[1]!.path, passes[2]!.path] }]
  const { bytes, neededBytes } = estimateDiskBytes(passes, { width: 3840, height: 2160 }, joins)
  expect(neededBytes).toBeCloseTo(bytes[0]! * 2 + bytes[1]! + bytes[2]!, -3)
})

test('an error in an unpicked scene doesn\'t block the render', () => {
  const project = projectWithScenes(2, ['Drive', 'Sail'])
  const sail = project.scenes[1]!
  project.scenes[1] = { ...sail, stops: sail.stops.slice(0, 1), legs: [] }
  expect(() => assertRenderable(project, {}, [0])).not.toThrow()
  expect(() => assertRenderable(project, {}, [0, 1])).toThrow(/too-few-stops/)
  expect(() => assertRenderable(project, {}, [1])).toThrow(RenderError)
})
