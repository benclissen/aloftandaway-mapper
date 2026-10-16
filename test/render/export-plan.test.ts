import { describe, expect, test } from 'vitest'
import { buildRoute, buildTimeline, seaLegKey, type Project, type SeaPaths } from '../../src/core/index.js'
import { pickedSceneIndexes, planExport, sceneMarkers, slug } from '../../src/render/export-plan.js'
import type { LayerRequest } from '../../src/render/export-types.js'
import { RenderError } from '../../src/render/errors.js'
import { greekIslands, sceneOf, stopsAt } from '../fixtures/projects.js'

const SAIL_ID = '00000000-0000-4000-8000-000000000002'

/** Two blank scenes at 25 fps: "Drive" of 50 frames, then "Sail" of 75. */
function driveAndSail(names: [string, string] = ['Drive', 'Sail']): Project {
  const project = stopsAt([[0, 0], [1, 1]], { name: names[0], timing: { holdStart: 0.5, travel: 1, holdEnd: 0.5 } })
  const sail = sceneOf(stopsAt([[2, 2], [3, 3]], { id: SAIL_ID, name: names[1], timing: { holdStart: 0.5, travel: 2, holdEnd: 0.5 } }))
  project.scenes.push(sail)
  return project
}

const paths = (plan: ReturnType<typeof planExport>) => plan.passes.map(p => p.path)

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
  ['日本語', ''],
  ['---', ''],
  ['a'.repeat(79) + ' b', 'a'.repeat(79)],
])('makes safe slugs for %s', (name, expected) => {
  expect(slug(name)).toBe(expected || 'project')
  expect(slug(name, 'scene')).toBe(expected || 'scene')
  const project = greekIslands({ name })
  expect(planExport(project, { seaPaths: {}, layers: ['map'] }).passes[0].path).toBe(`01-${expected || 'scene'}/map.mov`)
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

describe('scenes', () => {
  test('the fixture scenes are 50 and 75 frames long', () => {
    expect(planExport(driveAndSail(), { seaPaths: {} }).scenes.map(s => s.totalFrames)).toEqual([50, 75])
  })

  test('a one-scene project plans as before', () => {
    const project = greekIslands({ name: 'Island Hop' })
    const plan = planExport(project, { seaPaths: {} })
    expect(paths(plan)).toEqual(['all.mp4'])
    expect(plan.join).toBe(true)
    expect(plan.joins).toEqual([])
    expect(plan.scenes.map(s => [s.position, s.slug, s.offsetFrame])).toEqual([[1, 'island-hop', 0]])
    expect(plan.passes[0]).toMatchObject({ fromFrame: 0, toFrame: 350 })
    const layered = planExport(project, { seaPaths: {}, layers: ['map', 'route', 'signs', 'preview'] })
    expect(paths(layered)).toEqual(['01-island-hop/map.mov', '01-island-hop/route.mov', '01-island-hop/signs.mov', 'preview.mp4'])
    expect(layered.joins).toEqual([])
    expect(layered.fcpxml).toBe(true)
  })

  test('two scenes joined write parts and one join', () => {
    const plan = planExport(driveAndSail(), { seaPaths: {} })
    expect(plan.join).toBe(true)
    expect(paths(plan)).toEqual(['01-drive.part.mp4', '02-sail.part.mp4'])
    expect(plan.passes.map(p => [p.sceneId, p.fromFrame, p.toFrame])).toEqual([
      [plan.scenes[0]!.id, 0, 50], [SAIL_ID, 0, 75],
    ])
    expect(plan.scenes.map(s => [s.name, s.position, s.slug, s.offsetFrame])).toEqual([
      ['Drive', 1, 'drive', 0], ['Sail', 2, 'sail', 50],
    ])
    expect(plan.joins).toEqual([{ request: 'all', path: 'all.mp4', kind: 'h264', parts: ['01-drive.part.mp4', '02-sail.part.mp4'] }])

    const prores = planExport(driveAndSail(), { seaPaths: {}, codec: 'prores' })
    expect(prores.joins).toEqual([{ request: 'all', path: 'all.mov', kind: 'prores-hq', parts: ['01-drive.part.mov', '02-sail.part.mov'] }])
    const preview = planExport(driveAndSail(), { seaPaths: {}, layers: ['preview'] })
    expect(preview.joins).toEqual([
      { request: 'preview', path: 'preview.mp4', kind: 'h264', parts: ['01-drive-preview.part.mp4', '02-sail-preview.part.mp4'] },
    ])
  })

  test('join false writes one clip per scene', () => {
    const plan = planExport(driveAndSail(), { seaPaths: {}, join: false })
    expect(plan.join).toBe(false)
    expect(paths(plan)).toEqual(['01-drive.mp4', '02-sail.mp4'])
    expect(plan.joins).toEqual([])
    expect(plan.scenes.map(s => s.offsetFrame)).toEqual([0, 0])
    expect(paths(planExport(driveAndSail(), { seaPaths: {}, join: false, layers: ['preview'] })))
      .toEqual(['01-drive-preview.mp4', '02-sail-preview.mp4'])
    expect(paths(planExport(driveAndSail(), { seaPaths: {}, join: false, codec: 'prores' }))).toEqual(['01-drive.mov', '02-sail.mov'])
    // One picked scene keeps its position in the name.
    expect(paths(planExport(driveAndSail(), { seaPaths: {}, join: false, scenes: [2] }))).toEqual(['02-sail.mp4'])
  })

  test('layers go in a folder per scene', () => {
    const plan = planExport(driveAndSail(), { seaPaths: {}, layers: ['map', 'route', 'signs'] })
    expect(paths(plan)).toEqual([
      '01-drive/map.mov', '01-drive/route.mov', '01-drive/signs.mov',
      '02-sail/map.mov', '02-sail/route.mov', '02-sail/signs.mov',
    ])
    expect(plan.fcpxml).toBe(true)
    expect(plan.joins).toEqual([])
    const withAll = planExport(driveAndSail(), { seaPaths: {}, layers: ['all', 'signs', 'map', 'route'] })
    expect(paths(withAll)).toEqual([
      '01-drive/map.mov', '01-drive/route.mov', '01-drive/signs.mov', '01-drive.part.mp4',
      '02-sail/map.mov', '02-sail/route.mov', '02-sail/signs.mov', '02-sail.part.mp4',
    ])
    expect(withAll.joins.map(j => j.path)).toEqual(['all.mp4'])
  })

  test('picks scenes in film order whatever order they are given', () => {
    const project = driveAndSail()
    const plan = planExport(project, { seaPaths: {}, scenes: [2, 1] })
    expect(plan.scenes.map(s => s.name)).toEqual(['Drive', 'Sail'])
    expect(paths(plan)).toEqual(['01-drive.part.mp4', '02-sail.part.mp4'])
    expect(pickedSceneIndexes(project, [SAIL_ID, 1])).toEqual([0, 1])
    expect(pickedSceneIndexes(project)).toEqual([0, 1])
    const sailOnly = planExport(project, { seaPaths: {}, scenes: [SAIL_ID] })
    expect(sailOnly.scenes.map(s => [s.name, s.position, s.offsetFrame])).toEqual([['Sail', 2, 0]])
    expect(paths(sailOnly)).toEqual(['all.mp4'])
    expect(sailOnly.joins).toEqual([])
  })

  test('rejects a duplicate pick, by id and position', () => {
    const project = driveAndSail()
    for (const scenes of [[2, 2], [SAIL_ID, 2], [1, project.scenes[0]!.id]]) {
      expect(() => planExport(project, { seaPaths: {}, scenes })).toThrow('Each scene may be picked only once.')
    }
    expect(() => pickedSceneIndexes(project, [2, SAIL_ID])).toThrow(RenderError)
  })

  test('rejects an empty pick and an unknown scene', () => {
    const project = driveAndSail()
    expect(() => planExport(project, { seaPaths: {}, scenes: [] })).toThrow('Pick at least one scene.')
    for (const ref of [3, 'nope']) {
      let error: unknown
      try { planExport(project, { seaPaths: {}, scenes: [1, ref] }) } catch (e) { error = e }
      expect(error).toBeInstanceOf(RenderError)
      expect((error as RenderError).message).toContain(String(ref))
      expect((error as RenderError).fix).toContain('1 "Drive"')
      expect((error as RenderError).fix).toContain(`2 "Sail" (id ${SAIL_ID})`)
    }
  })

  test('a range across the cut', () => {
    const plan = planExport(driveAndSail(), { seaPaths: {}, range: { from: 1, to: 3 } })
    expect(plan.passes.map(p => [p.path, p.fromFrame, p.toFrame])).toEqual([
      ['01-drive.part.mp4', 25, 50], ['02-sail.part.mp4', 0, 25],
    ])
    expect(plan.scenes.map(s => s.offsetFrame)).toEqual([0, 25])
    expect(plan.joins).toEqual([{ request: 'all', path: 'all.mp4', kind: 'h264', parts: ['01-drive.part.mp4', '02-sail.part.mp4'] }])
  })

  test('a range inside one scene plans that scene alone with no join', () => {
    const plan = planExport(driveAndSail(), { seaPaths: {}, range: { from: 2.2, to: 2.8 } })
    expect(plan.scenes.map(s => [s.name, s.offsetFrame])).toEqual([['Sail', 0]])
    expect(plan.passes.map(p => [p.sceneId, p.path, p.fromFrame, p.toFrame])).toEqual([[SAIL_ID, 'all.mp4', 5, 20]])
    expect(plan.joins).toEqual([])
    const layered = planExport(driveAndSail(), { seaPaths: {}, layers: ['map'], range: { from: 0, to: 1 } })
    expect(layered.passes.map(p => [p.path, p.fromFrame, p.toFrame])).toEqual([['01-drive/map.mov', 0, 25]])
  })

  test('a range with join false and two scenes is refused', () => {
    let error: unknown
    try { planExport(driveAndSail(), { seaPaths: {}, join: false, range: { from: 0, to: 1 } }) } catch (e) { error = e }
    expect(error).toBeInstanceOf(RenderError)
    expect((error as RenderError).message).toBe('A range needs one scene, or a joined render.')
    expect((error as RenderError).fix).toBe('Pick one scene with scenes, or leave join on.')
    const one = planExport(driveAndSail(), { seaPaths: {}, join: false, scenes: [2], range: { from: 1, to: 2 } })
    expect(one.passes.map(p => [p.path, p.fromFrame, p.toFrame])).toEqual([['02-sail.mp4', 25, 50]])
  })

  test('a range past the end of the joined timeline has no frames', () => {
    expect(() => planExport(driveAndSail(), { seaPaths: {}, range: { from: 6, to: 7 } })).toThrow(/no frames in the 5\.00-second clip/)
  })

  test('same-named scenes get distinct folders', () => {
    const plan = planExport(driveAndSail(['Day 1', 'Day 1']), { seaPaths: {}, layers: ['map'] })
    expect(paths(plan)).toEqual(['01-day-1/map.mov', '02-day-1/map.mov'])
    expect(paths(planExport(driveAndSail(['Day 1', 'Day 1']), { seaPaths: {} }))).toEqual(['01-day-1.part.mp4', '02-day-1.part.mp4'])
  })

  test('an empty scene name gets the slug scene', () => {
    const plan = planExport(driveAndSail(['', 'Sail']), { seaPaths: {}, layers: ['map'] })
    expect(plan.scenes.map(s => s.slug)).toEqual(['scene', 'sail'])
    expect(paths(plan)).toEqual(['01-scene/map.mov', '02-sail/map.mov'])
  })
})
