import { expect, test } from 'vitest'
import type { RenderPass } from '../../src/render/export-types.js'
import { estimateDiskBytes } from '../../src/render/render.js'

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
