import { expect, test } from 'vitest'
import { buildRoute, buildTimeline, parseProject } from '../../src/core/index.js'
import { adaptV1Scene, planExport, sceneMarkers, slug, toPageProject } from '../../src/render/export-plan.js'
import type { LayerRequest } from '../../src/render/export-types.js'
import { greekIslands } from '../fixtures/projects.js'

test('adapts a v1 project without changing its schema', () => {
  const project = greekIslands()
  const before = structuredClone(project)
  const plan = planExport(project, { layers: ['map', 'route', 'signs'] })
  expect(plan.scenes).toHaveLength(1)
  expect(plan.scenes[0].id).toBe(project.id)
  expect(plan.passes.map(p => [p.layer, p.kind, p.path])).toEqual([
    ['map', 'prores-hq', '01-greek-islands/map.mov'],
    ['route', 'prores-4444', '01-greek-islands/route.mov'],
    ['signs', 'prores-4444', '01-greek-islands/signs.mov'],
  ])
  expect(plan.fcpxml).toBe(true)
  expect(project).toEqual(before)
  const page = toPageProject(plan.scenes[0])
  expect(parseProject(page)).toEqual(page)
  expect(page.schemaVersion).toBe(1)
  expect(adaptV1Scene(page)).toEqual(plan.scenes[0])
  expect(toPageProject(adaptV1Scene({ ...project, updatedAt: '2026-10-14T00:00:00.000Z' }))).toEqual(page)
})

test.each([
  [undefined, undefined, [['all', 'prores-hq', 'all.mov']], false],
  [['all'], 'h264', [['all', 'h264', 'all.mp4']], false],
  [['preview'], undefined, [['all', 'h264', 'preview.mp4']], false],
  [['signs', 'preview', 'map', 'route'], undefined, [
    ['map', 'prores-hq', '01-greek-islands/map.mov'],
    ['route', 'prores-4444', '01-greek-islands/route.mov'],
    ['signs', 'prores-4444', '01-greek-islands/signs.mov'],
    ['all', 'h264', 'preview.mp4'],
  ], true],
  [['route'], undefined, [['route', 'prores-4444', '01-greek-islands/route.mov']], false],
  [['all', 'map'], undefined, [['map', 'prores-hq', '01-greek-islands/map.mov'], ['all', 'prores-hq', 'all.mov']], false],
] as const)('plans layers %j with codec %s', (layers, codec, expected, fcpxml) => {
  const plan = planExport(greekIslands(), { layers: layers ? [...layers] : undefined, codec })
  expect(plan.passes.map(p => [p.layer, p.kind, p.path])).toEqual(expected)
  expect(plan.fcpxml).toBe(fcpxml)
  expect(plan.passes.every(p => p.sceneId === plan.scenes[0].id && p.fromFrame === 0 && p.toFrame === 350)).toBe(true)
})

test.each([[], ['map', 'map'], ['future'], ['all', 'preview']].map(layers => ({ layers })))('rejects invalid layers $layers', ({ layers }) => {
  expect(() => planExport(greekIslands(), { layers: layers as LayerRequest[] })).toThrow()
})

test.each(['map', 'route', 'signs'] as const)('rejects H.264 for %s', layer => {
  expect(() => planExport(greekIslands(), { layers: [layer], codec: 'h264' })).toThrow(/ProRes/i)
})

test.each([
  ['../../Crème & Cruise / <2026>', 'creme-cruise-2026'],
  ['日本語', 'project'],
  ['---', 'project'],
  ['a'.repeat(79) + ' b', 'a'.repeat(79)],
])('makes safe slugs for %s', (name, expected) => {
  expect(slug(name)).toBe(expected)
  expect(planExport(greekIslands({ name }), { layers: ['map'] }).passes[0].path).toBe(`01-${expected}/map.mov`)
})

test('uses the existing fractional-rate frame boundaries for every pass', () => {
  const project = greekIslands()
  project.output.fps = { num: 24000, den: 1001 }
  const plan = planExport(project, { layers: ['map', 'route', 'signs', 'preview'], range: { from: 1, to: 2 } })
  expect(plan.passes.map(p => [p.fromFrame, p.toFrame])).toEqual(Array(4).fill([23, 48]))
  const full = planExport(project, {})
  expect(full.passes[0].toFrame).toBe(buildTimeline(project, buildRoute(project)).totalFrames)
  expect(() => planExport(project, { range: { from: 2, to: 1 } })).toThrow(/range/)
})

test('rebases only arrivals inside the requested range', () => {
  const p = greekIslands()
  const arrivals = p.stops.map((s, index) => ({ stopId: s.id, index, frame: [24, 25, 49, 50][index]!, seconds: 0 }))
  expect(sceneMarkers(p.stops, arrivals, { fromFrame: 25, toFrame: 50 }).map(m => m.frame)).toEqual([0, 24])
})

test('marker values prefer label, then day and name, then name and preserve XML punctuation', () => {
  const p = greekIslands()
  p.stops[0] = { ...p.stops[0], label: '<Port> & "harbour"', day: 1 }
  p.stops[1] = { ...p.stops[1], day: 0 }
  p.stops[3] = { ...p.stops[3], label: '' }
  const arrivals = p.stops.map((s, index) => ({ stopId: s.id, index, frame: index, seconds: 0 }))
  expect(sceneMarkers(p.stops, arrivals, { fromFrame: 0, toFrame: 4 }).map(m => m.value)).toEqual([
    '<Port> & "harbour"', 'Day 0 · Mykonos', 'Santorini', '',
  ])
})
