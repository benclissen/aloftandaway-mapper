import { expect, test } from 'vitest'
import { buildRoute, buildTimeline, seaLegKey, type SeaPaths } from '../../src/core/index.js'
import { planExport, sceneMarkers, slug } from '../../src/render/export-plan.js'
import type { LayerRequest } from '../../src/render/export-types.js'
import { greekIslands, sceneOf } from '../fixtures/projects.js'

test('plans the first scene without changing the project', () => {
  const project = greekIslands()
  const before = structuredClone(project)
  const plan = planExport(project, { seaPaths: {}, layers: ['map', 'route', 'signs'] })
  expect(plan.scenes).toHaveLength(1)
  expect(plan.scenes[0].id).toBe(sceneOf(project).id)
  expect(plan.scenes[0].name).toBe(sceneOf(project).name)
  expect(plan.scenes[0].scene).toEqual(sceneOf(project))
  expect(plan.passes.map(p => [p.layer, p.kind, p.path])).toEqual([
    ['map', 'prores-hq', '01-greek-islands/map.mov'],
    ['route', 'prores-4444', '01-greek-islands/route.mov'],
    ['signs', 'prores-4444', '01-greek-islands/signs.mov'],
  ])
  expect(plan.fcpxml).toBe(true)
  expect(project).toEqual(before)
})

test('planExport carries frame count and arrivals', () => {
  const project = greekIslands()
  const scene = sceneOf(project)
  const timeline = buildTimeline(scene, project.output.fps, buildRoute(scene))
  const plan = planExport(project, { seaPaths: {}, range: { from: 1, to: 2 } })
  expect(plan.scenes[0].totalFrames).toBe(timeline.totalFrames)
  expect(plan.scenes[0].arrivals).toEqual(timeline.arrivals)
  expect(plan.scenes[0].arrivals.length).toBe(4)
})

test.each([
  [undefined, undefined, [['all', 'h264', 'all.mp4']], false],
  [['all'], undefined, [['all', 'h264', 'all.mp4']], false],
  [undefined, 'prores', [['all', 'prores-hq', 'all.mov']], false],
  [['all'], 'h264', [['all', 'h264', 'all.mp4']], false],
  [['preview'], undefined, [['all', 'h264', 'preview.mp4']], false],
  [['signs', 'preview', 'map', 'route'], undefined, [
    ['map', 'prores-hq', '01-greek-islands/map.mov'],
    ['route', 'prores-4444', '01-greek-islands/route.mov'],
    ['signs', 'prores-4444', '01-greek-islands/signs.mov'],
    ['all', 'h264', 'preview.mp4'],
  ], true],
  [['route'], undefined, [['route', 'prores-4444', '01-greek-islands/route.mov']], false],
  [['all', 'map'], undefined, [['map', 'prores-hq', '01-greek-islands/map.mov'], ['all', 'h264', 'all.mp4']], false],
  [['all', 'map'], 'prores', [['map', 'prores-hq', '01-greek-islands/map.mov'], ['all', 'prores-hq', 'all.mov']], false],
] as const)('plans layers %j with codec %s', (layers, codec, expected, fcpxml) => {
  const plan = planExport(greekIslands(), { seaPaths: {}, layers: layers ? [...layers] : undefined, codec })
  expect(plan.passes.map(p => [p.layer, p.kind, p.path])).toEqual(expected)
  expect(plan.fcpxml).toBe(fcpxml)
  expect(plan.passes.every(p => p.sceneId === plan.scenes[0].id && p.fromFrame === 0 && p.toFrame === 350)).toBe(true)
})

test.each([[], ['map', 'map'], ['future'], ['all', 'preview']].map(layers => ({ layers })))('rejects invalid layers $layers', ({ layers }) => {
  expect(() => planExport(greekIslands(), { seaPaths: {}, layers: layers as LayerRequest[] })).toThrow()
})

test.each(['map', 'route', 'signs'] as const)('rejects H.264 for %s', layer => {
  expect(() => planExport(greekIslands(), { seaPaths: {}, layers: [layer], codec: 'h264' })).toThrow(/only applies to the flattened/i)
})

test('accepts H.264 for the flattened clip alongside layers', () => {
  const plan = planExport(greekIslands(), { seaPaths: {}, layers: ['map', 'route', 'signs', 'all'], codec: 'h264' })
  expect(plan.passes.map(p => [p.request, p.kind])).toEqual([
    ['map', 'prores-hq'], ['route', 'prores-4444'], ['signs', 'prores-4444'], ['all', 'h264'],
  ])
  expect(plan.fcpxml).toBe(true)
})

test.each([
  ['../../Crème & Cruise / <2026>', 'creme-cruise-2026'],
  ['日本語', 'project'],
  ['---', 'project'],
  ['a'.repeat(79) + ' b', 'a'.repeat(79)],
])('makes safe slugs for %s', (name, expected) => {
  expect(slug(name)).toBe(expected)
  expect(planExport({ ...greekIslands(), name }, { seaPaths: {}, layers: ['map'] }).passes[0].path).toBe(`01-${expected}/map.mov`)
})

test('uses the existing fractional-rate frame boundaries for every pass', () => {
  const project = greekIslands()
  project.output.fps = { num: 24000, den: 1001 }
  const plan = planExport(project, { seaPaths: {}, layers: ['map', 'route', 'signs', 'preview'], range: { from: 1, to: 2 } })
  expect(plan.passes.map(p => [p.fromFrame, p.toFrame])).toEqual(Array(4).fill([23, 48]))
  const full = planExport(project, { seaPaths: {} })
  expect(full.passes[0].toFrame).toBe(buildTimeline(sceneOf(project), project.output.fps, buildRoute(sceneOf(project))).totalFrames)
  expect(() => planExport(project, { seaPaths: {}, range: { from: 2, to: 1 } })).toThrow(/range/)
})

test('rebases only arrivals inside the requested range', () => {
  const p = sceneOf(greekIslands())
  const arrivals = p.stops.map((s, index) => ({ stopId: s.id, index, frame: [24, 25, 49, 50][index]!, seconds: 0 }))
  expect(sceneMarkers(p.stops, arrivals, { fromFrame: 25, toFrame: 50 }).map(m => m.frame)).toEqual([0, 24])
})

test('marker values prefer label, then day and name, then name and preserve XML punctuation', () => {
  const p = sceneOf(greekIslands())
  p.stops[0] = { ...p.stops[0], label: '<Port> & "harbour"', day: 1 }
  p.stops[1] = { ...p.stops[1], day: 0 }
  p.stops[3] = { ...p.stops[3], label: '' }
  const arrivals = p.stops.map((s, index) => ({ stopId: s.id, index, frame: index, seconds: 0 }))
  expect(sceneMarkers(p.stops, arrivals, { fromFrame: 0, toFrame: 4 }).map(m => m.value)).toEqual([
    '<Port> & "harbour"', 'Day 0 · Mykonos', 'Santorini', '',
  ])
})

test("arrival frames follow the sea path's length", () => {
  const project = greekIslands()
  const scene = sceneOf(project)
  scene.legs[0]!.mode = 'sea'
  const [from, to] = [scene.stops[0]!.at, scene.stops[1]!.at]
  // A long detour, so the leg is much longer than the straight line it falls back to.
  const path: [number, number][] = [from, [from[0], from[1] + 8], [to[0] + 8, to[1] + 8], to]
  const seaPaths: SeaPaths = { [seaLegKey(from, to, scene.legs[0]!.via)]: { status: 'ok', path, knots: [0, path.length - 1] } }
  const without = planExport(project, { seaPaths: {} })
  const withPaths = planExport(project, { seaPaths })
  expect(withPaths.scenes[0].arrivals).not.toEqual(without.scenes[0].arrivals)
  const timeline = buildTimeline(scene, project.output.fps, buildRoute(scene, seaPaths))
  expect(withPaths.scenes[0].totalFrames).toBe(timeline.totalFrames)
  expect(withPaths.scenes[0].arrivals).toEqual(timeline.arrivals)
})
