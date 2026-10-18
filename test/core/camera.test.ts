import { describe, expect, test } from 'vitest'
import {
  buildRoute,
  buildTimeline,
  cameraAt,
  contextShot,
  ease,
  fitShot,
  flyInterpolator,
  haversineKm,
  keyedShot,
  layoutSize,
  projectToLayout,
  resolveFollow,
  resolveShots,
  THEME_MAX_ZOOM,
  TILE_SIZE,
  toXY,
  type Aspect,
  type CameraKey,
  type FollowSettings,
  type LngLat,
  type Project,
  type Shot,
} from '../../src/core/index.js'
import { greekIslands, pacific, sceneOf, stopsAt } from '../fixtures/projects.js'

const shot = (center: LngLat, zoom: number, bearing = 0, pitch = 0): Shot => ({ center, zoom, bearing, pitch })

function expectShotClose(actual: Shot, expected: Shot, tol = 1e-9) {
  expect(Math.abs(actual.center[0] - expected.center[0])).toBeLessThan(tol)
  expect(Math.abs(actual.center[1] - expected.center[1])).toBeLessThan(tol)
  expect(Math.abs(actual.zoom - expected.zoom)).toBeLessThan(tol)
  expect(Math.abs(actual.bearing - expected.bearing)).toBeLessThan(tol)
  expect(Math.abs(actual.pitch - expected.pitch)).toBeLessThan(tol)
}

/** Layout-frame pixel position of `at` in a view of `s`. */
function project(s: Shot, at: LngLat, aspect: Aspect): [number, number] {
  const { width, height } = layoutSize(aspect)
  const scale = TILE_SIZE * 2 ** s.zoom
  const c = toXY(s.center)
  const p = toXY(at)
  return [(p[0] - c[0]) * scale + width / 2, (p[1] - c[1]) * scale + height / 2]
}

function expectFramed(s: Shot, bounds: [LngLat, LngLat], aspect: Aspect, padding = 0.12) {
  const { width, height } = layoutSize(aspect)
  const corners = bounds.map((b) => project(s, b, aspect))
  const sizes = [width, height]
  let touches = false
  for (const axis of [0, 1]) {
    const lo = padding * sizes[axis]!
    const hi = (1 - padding) * sizes[axis]!
    for (const c of corners) {
      expect(c[axis]!).toBeGreaterThanOrEqual(lo - 1e-6)
      expect(c[axis]!).toBeLessThanOrEqual(hi + 1e-6)
      if (Math.abs(c[axis]! - lo) <= 1 || Math.abs(c[axis]! - hi) <= 1) touches = true
    }
  }
  expect(touches).toBe(true)
}

/** South-west and north-east corners of `path`. */
function boundsOf(path: LngLat[]): [LngLat, LngLat] {
  const lngs = path.map((p) => p[0])
  const lats = path.map((p) => p[1])
  return [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]]
}

const timelineOf = (p: Project) => {
  const route = buildRoute(sceneOf(p))
  return { route, tl: buildTimeline(sceneOf(p), p.output.fps, route) }
}

describe('fitShot', () => {
  test('fitShot frames bounds with padding', () => {
    const bounds: [LngLat, LngLat] = [[23.6466, 36.4166], [28.2278, 37.942]]
    const s = fitShot(bounds, '16:9')
    expect(s.bearing).toBe(0)
    expect(s.pitch).toBe(0)
    expectFramed(s, bounds, '16:9')
  })

  test('frames in the portrait layout and honours a custom padding', () => {
    const bounds: [LngLat, LngLat] = [[23.6466, 36.4166], [28.2278, 37.942]]
    expectFramed(fitShot(bounds, '9:16'), bounds, '9:16')
    expectFramed(fitShot(bounds, '1:1', 0.2), bounds, '1:1', 0.2)
  })

  test('zero-size bounds give zoom 12 at the point', () => {
    const s = fitShot([[25.3289, 37.4467], [25.3289, 37.4467]], '16:9')
    expect(s.zoom).toBe(12)
    expect(s.center[0]).toBeCloseTo(25.3289, 9)
    expect(s.center[1]).toBeCloseTo(37.4467, 9)
  })

  test('a flat line of bounds fits on its long axis', () => {
    const bounds: [LngLat, LngLat] = [[20, 0], [30, 0]]
    expectFramed(fitShot(bounds, '16:9'), bounds, '16:9')
  })

  test('clamps zoom to 0..16', () => {
    expect(fitShot([[25, 37], [25.00001, 37.00001]], '16:9').zoom).toBe(16)
    expect(fitShot([[-180, -85], [900, 85]], '16:9').zoom).toBe(0)
  })
})

describe('resolveShots', () => {
  test('fits an antimeridian route', () => {
    const p = pacific()
    const { start } = resolveShots(sceneOf(p), p.output.aspect, buildRoute(sceneOf(p)))
    expect(start.center[0]).toBeGreaterThan(178)
    expect(start.center[0]).toBeLessThan(189)
    expect(start.zoom).toBeGreaterThan(4)
  })

  test('fills only the missing shot and uses a supplied one as stored', () => {
    const stored = shot([24, 37], 9, 30, 20)
    const p = greekIslands({ camera: { mode: 'glide', easing: 'linear', start: stored } })
    const route = buildRoute(sceneOf(p))
    const { start, end } = resolveShots(sceneOf(p), p.output.aspect, route)
    expect(start).toEqual(stored)
    expect(end).toEqual(fitShot(route.bounds, '16:9'))
  })

  test('fits missing shots in the output aspect', () => {
    const p = { ...greekIslands(), output: { aspect: '9:16' as const, height: 1080 as const, fps: { num: 25, den: 1 } } }
    const route = buildRoute(sceneOf(p))
    const { start, end } = resolveShots(sceneOf(p), p.output.aspect, route)
    expect(start).toEqual(fitShot(boundsOf(route.legs[0]!.path), '9:16'))
    expect(end).toEqual(fitShot(route.bounds, '9:16'))
  })

  test('default glide opens on the first leg and ends on the whole route', () => {
    const p = greekIslands()
    expect(sceneOf(p).camera).toEqual({ mode: 'glide', easing: 'smooth' })
    const { route, tl } = timelineOf(p)
    const { start, end } = resolveShots(sceneOf(p), p.output.aspect, route)
    expect(start).toEqual(fitShot(boundsOf(route.legs[0]!.path), '16:9'))
    expect(end).toEqual(fitShot(route.bounds, '16:9'))
    expect(start.zoom).toBeGreaterThan(end.zoom + 0.5)
    // The camera pulls out from frame 0 to the end of the first leg's travel, eased, then holds the whole route.
    const at = (f: number) => cameraAt(sceneOf(p), p.output.aspect, route, tl, f)
    const legEnd = tl.legFrames[0]!.end
    const fly = flyInterpolator(start, end, '16:9')
    expectShotClose(at(0), start)
    for (const f of [1, 30, Math.round(legEnd / 2), legEnd - 1]) expectShotClose(at(f), fly(ease('smooth', f / legEnd)))
    for (let f = legEnd; f < tl.totalFrames; f++) expectShotClose(at(f), end)
    expect(at(Math.round(legEnd / 2)).zoom).toBeLessThan(start.zoom)
    // A stored start keeps the glide across the whole travel section.
    const stored = greekIslands({ camera: { mode: 'glide', easing: 'smooth', start } })
    const midTravel = Math.round((tl.travelStartFrame + tl.travelEndFrame) / 2)
    expect(cameraAt(sceneOf(stored), '16:9', route, tl, midTravel)).toEqual(fly(ease('smooth', tl.stateAt(midTravel).travelT)))
    // A fixed camera with no start still shows the whole route.
    const fixed = greekIslands({ camera: { mode: 'fixed', easing: 'smooth' } })
    expect(resolveShots(sceneOf(fixed), '16:9', route).start).toEqual(fitShot(route.bounds, '16:9'))
    expect(cameraAt(sceneOf(fixed), '16:9', route, tl, 0)).toEqual(fitShot(route.bounds, '16:9'))
  })

  test('the default glide keeps the head in frame', () => {
    const p = greekIslands()
    const { route, tl } = timelineOf(p)
    const { width, height } = layoutSize('16:9')
    for (let f = tl.travelStartFrame; f <= tl.travelEndFrame; f++) {
      const [x, y] = projectToLayout(cameraAt(sceneOf(p), '16:9', route, tl, f), '16:9', tl.stateAt(f).head.at)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(width)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(height)
    }
  })

  test('the default glide pulls out further when the head would outrun it', () => {
    // A loop whose first leg is nearly the whole route and heads south first, as a cruise from Miami does through the
    // Florida Straits. The glide opens close in on the first stop, so pulling out on its own timetable lost the head.
    for (const via of [[[0.5, -7]], [[1, -5], [4, -8]], [[3, -6]]] as LngLat[][]) {
      const p = stopsAt([[0, 0], [17, -8], [15, -7.5], [2, 0], [0, 0]])
      const scene = sceneOf(p)
      scene.legs[0] = { ...scene.legs[0]!, via: via.map((at) => ({ at, sharp: true })) }
      const route = buildRoute(scene)
      const tl = buildTimeline(scene, p.output.fps, route)
      const { start, end } = resolveShots(scene, '16:9', route)
      expect(start.zoom).toBeCloseTo(end.zoom + 2)
      const { width, height } = layoutSize('16:9')
      const at = (f: number) => cameraAt(scene, '16:9', route, tl, f)
      const zooms: number[] = []
      for (let f = 0; f < tl.totalFrames; f++) {
        const shot = at(f)
        zooms.push(shot.zoom)
        // At least 8% of the frame in from each side.
        const [x, y] = projectToLayout(shot, '16:9', tl.stateAt(f).head.at)
        expect(x).toBeGreaterThanOrEqual(0.08 * width - 1e-6)
        expect(x).toBeLessThanOrEqual(0.92 * width + 1e-6)
        expect(y).toBeGreaterThanOrEqual(0.08 * height - 1e-6)
        expect(y).toBeLessThanOrEqual(0.92 * height + 1e-6)
      }
      // Still opens on the start shot and holds the whole route once the first leg is done. The pull-out eases in and
      // out, so it may start a hair early and settle into the hold within 2 seconds.
      expectShotClose({ ...at(0), zoom: start.zoom }, start)
      expect(Math.abs(at(0).zoom - start.zoom)).toBeLessThan(1e-3)
      const legEnd = tl.legFrames[0]!.end
      for (let f = legEnd; f < tl.totalFrames; f++) {
        expectShotClose({ ...at(f), zoom: end.zoom }, end)
        expect(at(f).zoom).toBeLessThanOrEqual(end.zoom + 1e-9)
        if (f >= legEnd + 50) expect(Math.abs(at(f).zoom - end.zoom)).toBeLessThan(1e-9)
      }
      // No jolt: the zoom's rate of change moves by little from one frame to the next.
      for (let f = 1; f < zooms.length - 1; f++) expect(Math.abs(zooms[f + 1]! - 2 * zooms[f]! + zooms[f - 1]!)).toBeLessThan(0.01)
    }
  })

  test('a short first hop starts no closer than the theme allows', () => {
    const p = stopsAt([[25, 37], [25.01, 37], [27, 37]], { look: { ...sceneOf(greekIslands()).look, theme: 'paper' } })
    const route = buildRoute(sceneOf(p))
    expect(fitShot(boundsOf(route.legs[0]!.path), '16:9').zoom).toBeGreaterThan(THEME_MAX_ZOOM.paper)
    const { start } = resolveShots(sceneOf(p), '16:9', route)
    expect(start).toEqual({ ...fitShot(boundsOf(route.legs[0]!.path), '16:9'), zoom: THEME_MAX_ZOOM.paper })
  })

  test('a one-leg glide starts closer in on the first stop', () => {
    const p = stopsAt([[25, 37], [26.5, 37.5]])
    const route = buildRoute(sceneOf(p))
    const routeZoom = fitShot(route.bounds, '16:9').zoom
    const { start, end } = resolveShots(sceneOf(p), '16:9', route)
    expect(start).toEqual({ center: [25, 37], zoom: routeZoom + 2, bearing: 0, pitch: 0 })
    expect(end).toEqual(fitShot(route.bounds, '16:9'))
    // A first leg that is nearly the whole route counts as one leg.
    const nearly = stopsAt([[0, 0], [10, 0], [10.2, 0]])
    const nearlyRoute = buildRoute(sceneOf(nearly))
    const nearlyZoom = fitShot(nearlyRoute.bounds, '16:9').zoom
    expect(Math.abs(fitShot(boundsOf(nearlyRoute.legs[0]!.path), '16:9').zoom - nearlyZoom)).toBeLessThanOrEqual(0.5)
    expect(resolveShots(sceneOf(nearly), '16:9', nearlyRoute).start).toEqual({ center: [0, 0], zoom: nearlyZoom + 2, bearing: 0, pitch: 0 })
    // Capped at the theme's maximum zoom.
    const tight = stopsAt([[25, 37], [25.01, 37]], { look: { ...sceneOf(p).look, theme: 'paper' } })
    const tightRoute = buildRoute(sceneOf(tight))
    expect(fitShot(tightRoute.bounds, '16:9').zoom + 2).toBeGreaterThan(THEME_MAX_ZOOM.paper)
    expect(resolveShots(sceneOf(tight), '16:9', tightRoute).start.zoom).toBe(THEME_MAX_ZOOM.paper)
  })
})

describe('flyInterpolator', () => {
  test('returns both endpoints', () => {
    const a = shot([23.6466, 37.942], 10, 10, 5)
    const b = shot([28.2278, 36.451], 7, -20, 40)
    const fly = flyInterpolator(a, b, '16:9')
    expectShotClose(fly(0), a)
    expectShotClose(fly(1), b)
  })

  test('fly interpolator: same centre zooms linearly', () => {
    const fly = flyInterpolator(shot([25, 37], 4), shot([25, 37], 8), '16:9')
    expect(fly(0.5).zoom).toBeCloseTo(6, 12)
    expect(fly(0.25).zoom).toBeCloseTo(5, 12)
    expect(fly(0.5).center[0]).toBeCloseTo(25, 12)
    expect(fly(0.5).center[1]).toBeCloseTo(37, 12)
  })

  test('zooms out mid-flight on a long move at the same zoom', () => {
    const fly = flyInterpolator(shot([23.6466, 37.942], 12), shot([28.2278, 36.451], 12), '16:9')
    const mid = fly(0.5)
    expect(mid.zoom).toBeLessThan(10)
    // Symmetric endpoints: the mid-point of the path is the mid-point of the move in Mercator.
    const [ax, ay] = toXY([23.6466, 37.942])
    const [bx, by] = toXY([28.2278, 36.451])
    const [mx, my] = toXY(mid.center)
    expect(mx).toBeCloseTo((ax + bx) / 2, 12)
    expect(my).toBeCloseTo((ay + by) / 2, 12)
  })

  test('moves monotonically along the straight Mercator line', () => {
    const a = shot([23.6466, 37.942], 10)
    const b = shot([28.2278, 36.451], 6)
    const fly = flyInterpolator(a, b, '16:9')
    const [ax, ay] = toXY(a.center)
    const [bx, by] = toXY(b.center)
    let prev = -Infinity
    for (let i = 0; i <= 20; i++) {
      const [x, y] = toXY(fly(i / 20).center)
      const along = (x - ax) / (bx - ax)
      expect((y - ay) / (by - ay)).toBeCloseTo(along, 9)
      expect(along).toBeGreaterThanOrEqual(prev - 1e-12)
      prev = along
    }
  })

  test('crosses the antimeridian the short way', () => {
    const fly = flyInterpolator(shot([179, -15], 8), shot([-179, -15], 8), '16:9')
    for (let i = 0; i <= 10; i++) {
      const lng = fly(i / 10).center[0]
      expect(lng).toBeGreaterThanOrEqual(179 - 1e-9)
      expect(lng).toBeLessThanOrEqual(181 + 1e-9)
    }
    expect(fly(1).center[0]).toBeCloseTo(181, 9)
  })

  test('bearing takes the short way', () => {
    const fly = flyInterpolator(shot([25, 37], 6, 170), shot([25, 37], 6, -170), '16:9')
    expect(Math.abs(fly(0.5).bearing)).toBeCloseTo(180, 9)
    expect(fly(0.25).bearing).toBeCloseTo(175, 9)
    expect(fly(0.75).bearing).toBeCloseTo(-175, 9)
  })

  test('normalises bearing to (-180, 180] and interpolates pitch linearly', () => {
    const fly = flyInterpolator(shot([25, 37], 6, -180, 0), shot([25, 37], 6, -180, 60), '16:9')
    expect(fly(0).bearing).toBe(180)
    expect(fly(0.5).pitch).toBeCloseTo(30, 12)
  })

  test('clamps u to [0, 1]', () => {
    const a = shot([23.6466, 37.942], 10)
    const b = shot([28.2278, 36.451], 7)
    const fly = flyInterpolator(a, b, '16:9')
    expect(fly(-1)).toEqual(fly(0))
    expect(fly(2)).toEqual(fly(1))
  })
})

describe('cameraAt', () => {
  test('fixed uses start on every frame', () => {
    const start = shot([25, 37], 7, 15, 10)
    const p = greekIslands({ camera: { mode: 'fixed', easing: 'smooth', start, end: shot([20, 30], 3) } })
    const { route, tl } = timelineOf(p)
    for (const f of [0, tl.travelStartFrame, 100, tl.totalFrames - 1]) expect(cameraAt(sceneOf(p), p.output.aspect, route, tl, f)).toEqual(start)
  })

  test('glide holds at both ends and passes through endpoints', () => {
    const start = shot([23.6466, 37.942], 9)
    const end = shot([28.2278, 36.451], 7, 0, 30)
    const p = greekIslands({ camera: { mode: 'glide', easing: 'smooth', start, end } })
    const { route, tl } = timelineOf(p)
    expect(tl.travelStartFrame).toBeGreaterThan(0)
    expect(tl.travelEndFrame).toBeLessThan(tl.totalFrames - 1)
    for (let f = 0; f <= tl.travelStartFrame; f++) expectShotClose(cameraAt(sceneOf(p), p.output.aspect, route, tl, f), start)
    for (let f = tl.travelEndFrame; f < tl.totalFrames; f++) expectShotClose(cameraAt(sceneOf(p), p.output.aspect, route, tl, f), end)
    const mid = cameraAt(sceneOf(p), p.output.aspect, route, tl, Math.round((tl.travelStartFrame + tl.travelEndFrame) / 2))
    expect(mid.center[0]).toBeGreaterThan(start.center[0])
    expect(mid.center[0]).toBeLessThan(end.center[0])
  })

  test('glide eases the overall travel progress once', () => {
    const start = shot([23.6466, 37.942], 9)
    const end = shot([28.2278, 36.451], 7)
    const p = greekIslands({ camera: { mode: 'glide', easing: 'smooth', start, end } })
    const { route, tl } = timelineOf(p)
    const fly = flyInterpolator(start, end, '16:9')
    for (const f of [tl.travelStartFrame + 7, 120, tl.travelEndFrame - 3]) {
      expect(cameraAt(sceneOf(p), p.output.aspect, route, tl, f)).toEqual(fly(ease('smooth', tl.stateAt(f).travelT)))
    }
  })

  test('camera is a pure function of frame', () => {
    const p = greekIslands({
      camera: { mode: 'glide', easing: 'smooth', start: shot([23.6466, 37.942], 10), end: shot([28.2278, 36.451], 6) },
    })
    const { route: r, tl } = timelineOf(p)
    const frames = Array.from({ length: tl.totalFrames }, (_, i) => i)
    const seq = frames.map((f) => cameraAt(sceneOf(p), p.output.aspect, r, tl, f))
    const shuffled = [...frames]
      .reverse()
      .map((f) => cameraAt(sceneOf(p), p.output.aspect, r, tl, f))
      .reverse()
    expect(shuffled).toEqual(seq)
  })
})

describe('camera keys', () => {
  const k0: CameraKey = { at: 1, shot: shot([20, 30], 4, 10, 0) }
  const k1: CameraKey = { at: 3, shot: shot([23.6466, 37.942], 9, -20, 30) }
  const k2: CameraKey = { at: 6, shot: shot([25.3289, 37.4467], 8, 0, 0) }
  const keyed = (keys: CameraKey[], over: Partial<Project['scenes'][number]['camera']> = {}) =>
    greekIslands({ camera: { mode: 'glide', easing: 'smooth', keys, ...over } })
  const camOf = (p: Project) => {
    const { route, tl } = timelineOf(p)
    return { route, tl, at: (f: number) => cameraAt(sceneOf(p), p.output.aspect, route, tl, f) }
  }

  test('holds the first key, hits each key on its frame, eases between and holds the last', () => {
    const { tl, at } = camOf(keyed([k0, k1, k2]))
    expect(tl.fps).toEqual({ num: 25, den: 1 })
    for (let f = 0; f <= 25; f++) expect(at(f)).toEqual(k0.shot)
    expect(at(75)).toEqual(k1.shot)
    expect(at(150)).toEqual(k2.shot)
    for (let f = 150; f < tl.totalFrames; f++) expect(at(f)).toEqual(k2.shot)
    const first = flyInterpolator(k0.shot, k1.shot, '16:9')
    for (const f of [26, 40, 50, 74]) expect(at(f)).toEqual(first(ease('smooth', (f / 25 - 1) / 2)))
    const second = flyInterpolator(k1.shot, k2.shot, '16:9')
    for (const f of [76, 100, 149]) expect(at(f)).toEqual(second(ease('smooth', (f / 25 - 3) / 3)))
    // The camera moves on the keys' clock, not the ship's: it is already flying during the opening hold.
    expect(tl.travelStartFrame).toBe(25)
    expect(at(50)).not.toEqual(at(25))
  })

  test('applies the easing per segment', () => {
    const { at } = camOf(keyed([k0, k1], { easing: 'linear' }))
    const fly = flyInterpolator(k0.shot, k1.shot, '16:9')
    for (const f of [30, 50, 70]) expect(at(f)).toEqual(fly((f / 25 - 1) / 2))
  })

  test('unsorted keys behave as sorted', () => {
    const sorted = camOf(keyed([k0, k1, k2]))
    const shuffled = camOf(keyed([k2, k0, k1]))
    for (let f = 0; f < sorted.tl.totalFrames; f++) expect(shuffled.at(f)).toEqual(sorted.at(f))
  })

  test('a single key holds on every frame', () => {
    const { tl, at } = camOf(keyed([k1]))
    for (const f of [0, 75, tl.totalFrames - 1]) expect(at(f)).toEqual(k1.shot)
  })

  test('keys at the same time never divide by zero', () => {
    const twin: CameraKey = { at: 3, shot: shot([26, 37], 7) }
    for (const s of [0, 2, 3, 3.5, 10]) {
      const out = keyedShot([k0, k1, twin, k2], '16:9', 'smooth', s)
      for (const v of [...out.center, out.zoom, out.bearing, out.pitch]) expect(Number.isFinite(v)).toBe(true)
    }
    expect(keyedShot([k0, k1, twin, k2], '16:9', 'smooth', 3)).toEqual(twin.shot)
  })

  test("leave the ship's timing alone", () => {
    const plain = greekIslands({ camera: { mode: 'glide', easing: 'smooth', start: k0.shot, end: k2.shot } })
    const a = timelineOf(plain).tl
    const b = timelineOf(keyed([k0, k1, k2], { start: k0.shot, end: k2.shot })).tl
    expect(b.totalFrames).toBe(a.totalFrames)
    expect(b.legFrames).toEqual(a.legFrames)
    for (let f = 0; f < a.totalFrames; f++) expect(b.stateAt(f)).toEqual(a.stateAt(f))
  })

  test('resolveShots gives the first and last keys in time order, and ignores start and end', () => {
    const p = keyed([k2, k0, k1], { start: shot([0, 0], 2), end: shot([1, 1], 3) })
    const { route } = timelineOf(p)
    expect(resolveShots(sceneOf(p), '16:9', route)).toEqual({ start: k0.shot, end: k2.shot })
  })

  test('fixed and follow cameras ignore keys', () => {
    const start = shot([25, 37], 7, 15, 10)
    const fixed = greekIslands({ camera: { mode: 'fixed', easing: 'smooth', start, keys: [k0, k1] } })
    const { route, tl, at } = camOf(fixed)
    expect(resolveShots(sceneOf(fixed), '16:9', route).start).toEqual(start)
    for (const f of [0, 75, tl.totalFrames - 1]) expect(at(f)).toEqual(start)
    const follow = { zoom: 10, orient: 'north' as const, lookAhead: 1, smoothing: 0.5, pitch: 0 }
    const withKeys = camOf(greekIslands({ camera: { mode: 'follow', easing: 'linear', follow, keys: [k0, k1] } }))
    const without = camOf(greekIslands({ camera: { mode: 'follow', easing: 'linear', follow } }))
    for (const f of [0, 75, 200]) expect(withKeys.at(f)).toEqual(without.at(f))
  })
})

describe('follow camera', () => {
  const followCamera = (follow?: FollowSettings) => ({ mode: 'follow' as const, easing: 'linear' as const, ...(follow ? { follow } : {}) })
  const settings = (over: Partial<FollowSettings> = {}): FollowSettings => ({ zoom: 10, orient: 'north', lookAhead: 1, smoothing: 0.5, pitch: 0, ...over })
  const camOf = (p: Project) => {
    const { route, tl } = timelineOf(p)
    return { route, tl, at: (f: number) => cameraAt(sceneOf(p), p.output.aspect, route, tl, f) }
  }

  test("follow is the same frame however it's reached", () => {
    const p = greekIslands({ camera: followCamera(settings({ orient: 'heading' })) })
    const { tl, at } = camOf(p)
    const frames = Array.from({ length: tl.totalFrames }, (_, i) => i)
    const forwards = frames.map(at)
    const backwards = [...frames].reverse().map(at).reverse()
    expect(backwards).toEqual(forwards)
    for (const f of [0, 17, 120, tl.totalFrames - 1]) expect(camOf(p).at(f)).toEqual(forwards[f])
    for (const s of forwards) {
      expect(s.zoom).toBe(10)
      expect(s.pitch).toBe(0)
      expect(s.bearing).toBeGreaterThan(-180)
      expect(s.bearing).toBeLessThanOrEqual(180)
    }
  })

  test('smoothing 0 centres on the look-ahead point', () => {
    for (const lookAhead of [0, 1]) {
      // Zoomed out far enough that the quarter-frame cap on the aim point is never reached.
      const p = greekIslands({ camera: followCamera(settings({ zoom: 5, lookAhead, smoothing: 0 })) })
      const { tl, at } = camOf(p)
      expect(p.output.fps).toEqual({ num: 25, den: 1 })
      for (let f = tl.travelStartFrame; f <= tl.travelEndFrame; f += 7) {
        const head = tl.stateAt(f + lookAhead * 25).head.at
        const c = at(f).center
        expect(c[0]).toBeCloseTo(head[0], 9)
        expect(c[1]).toBeCloseTo(head[1], 9)
        expect(at(f).bearing).toBe(0)
      }
    }
  })

  test('holds before and after travel', () => {
    const p = greekIslands({ camera: followCamera(settings({ zoom: 5, smoothing: 0, orient: 'heading' })) })
    const { tl, at } = camOf(p)
    expect(tl.travelStartFrame).toBeGreaterThan(0)
    expect(tl.travelEndFrame).toBeLessThan(tl.totalFrames - 1)
    for (let f = 0; f < tl.travelStartFrame; f++) expect(at(f)).toEqual(at(tl.travelStartFrame))
    for (let f = tl.travelEndFrame + 1; f < tl.totalFrames; f++) expect(at(f)).toEqual(at(tl.travelEndFrame))
    // The look-ahead target of the travel start is a second into the route, not the first stop.
    expect(at(0).center).toEqual(tl.stateAt(tl.travelStartFrame + 25).head.at)
  })

  test('orient heading turns the bearing with the route', () => {
    // Light smoothing, as the bearing smooths 3 times more slowly than the position.
    const p = stopsAt([[0, 0], [10, 0], [10, -10]], { camera: followCamera(settings({ orient: 'heading', lookAhead: 0, smoothing: 0.05 })) })
    sceneOf(p).stops[1] = { ...sceneOf(p).stops[1]!, sharp: true }
    const { tl, at } = camOf(p)
    const [first, second] = tl.legFrames
    const mid = (l: { start: number; end: number }) => Math.round((l.start + l.end) / 2)
    expect(at(mid(first!)).bearing).toBeCloseTo(90, 0)
    expect(Math.abs(at(mid(second!)).bearing)).toBeCloseTo(180, 0)
    const north = stopsAt([[0, 0], [10, 0], [10, -10]], { camera: followCamera(settings({ orient: 'north', lookAhead: 0 })) })
    expect(camOf(north).at(mid(first!)).bearing).toBe(0)
  })

  test('smoothing settles on the stop during a long pause', () => {
    const p = stopsAt([[23.6466, 37.942], [25.3289, 37.4467], [28.2278, 36.451]], {
      camera: followCamera(settings({ lookAhead: 0, smoothing: 0.5 })),
      timing: { holdStart: 1, travel: 6, holdEnd: 1 },
    })
    sceneOf(p).stops[1] = { ...sceneOf(p).stops[1]!, pause: 30 }
    const { tl, at } = camOf(p)
    const arrival = tl.arrivals[1]!.frame
    const middle = arrival + 15 * 25
    const c = at(middle).center
    expect(Math.abs(c[0] - 25.3289)).toBeLessThan(1e-6)
    expect(Math.abs(c[1] - 37.4467)).toBeLessThan(1e-6)
    // Smoothing does something while moving: the camera is off the head mid-leg.
    const moving = Math.round((tl.legFrames[0]!.start + tl.legFrames[0]!.end) / 2)
    const head = tl.stateAt(moving).head.at
    expect(Math.hypot(at(moving).center[0] - head[0], at(moving).center[1] - head[1])).toBeGreaterThan(1e-4)
  })

  test('resolveFollow fills missing follow fields from defaults', () => {
    const blank = greekIslands({ camera: followCamera({ orient: 'heading' } as FollowSettings) })
    const route = buildRoute(sceneOf(blank))
    const fitted = fitShot(route.bounds, blank.output.aspect).zoom
    expect(resolveFollow(sceneOf(blank), blank.output.aspect, route)).toEqual({
      zoom: fitted + 3,
      orient: 'heading',
      lookAhead: 0.25,
      smoothing: 0.2,
      pitch: 0,
    })
    const partial = greekIslands({ camera: followCamera({ zoom: 7, smoothing: 0 } as FollowSettings) })
    expect(resolveFollow(sceneOf(partial), '16:9', route)).toEqual({ zoom: 7, orient: 'north', lookAhead: 0.25, smoothing: 0, pitch: 0 })
  })

  test('resolves default follow settings', () => {
    const blank = greekIslands({ camera: followCamera() })
    const route = buildRoute(sceneOf(blank))
    const fitted = fitShot(route.bounds, blank.output.aspect).zoom
    expect(resolveFollow(sceneOf(blank), blank.output.aspect, route)).toEqual({
      zoom: fitted + 3,
      orient: 'north',
      lookAhead: 0.25,
      smoothing: 0.2,
      pitch: 0,
    })
    const tight = stopsAt([[25, 37], [25.01, 37]], { camera: followCamera(), look: { ...sceneOf(blank).look, theme: 'paper' } })
    const tightRoute = buildRoute(sceneOf(tight))
    expect(fitShot(tightRoute.bounds, '16:9').zoom + 3).toBeGreaterThan(THEME_MAX_ZOOM.paper)
    expect(resolveFollow(sceneOf(tight), tight.output.aspect, tightRoute).zoom).toBe(14)
    const stored = settings({ zoom: 7, orient: 'heading' })
    expect(resolveFollow(sceneOf(greekIslands({ camera: followCamera(stored) })), '16:9', route)).toEqual(stored)
    // With nothing stored, the camera uses the defaults.
    const { at } = camOf(blank)
    expect(at(0).zoom).toBe(fitted + 3)
  })

  test('follow pitch defaults and resolves', () => {
    const tilted = shot([25, 37], 8, 0, 30)
    const cases: [Project, number][] = [
      [greekIslands({ camera: followCamera({ pitch: 45 } as FollowSettings) }), 45],
      [greekIslands({ camera: { ...followCamera({ pitch: 45 } as FollowSettings), start: tilted } }), 45],
      [greekIslands({ camera: { ...followCamera({ zoom: 9 } as FollowSettings), start: tilted } }), 30],
      [greekIslands({ camera: followCamera() }), 0],
    ]
    for (const [p, pitch] of cases) {
      const { route, tl, at } = camOf(p)
      expect(resolveFollow(sceneOf(p), p.output.aspect, route).pitch).toBe(pitch)
      for (const f of [0, Math.round(tl.totalFrames / 2), tl.totalFrames - 1]) expect(at(f).pitch).toBe(pitch)
    }
  })

  test('follow keeps the head inside the frame on a fast leg', () => {
    // An invented Baltic cruise: one long flight in, then sea legs (drawn as lines here) of 80 to 680 km each, at
    // 225 km of route per second of clip. Not a general guarantee: with the defaults, very short fast legs (about 300 km
    // at 225 km/s) can put the head slightly outside the middle 80%.
    const ports: LngLat[] = [
      [8.6821, 50.1109], // Frankfurt
      [18.0686, 59.3293], // Stockholm
      [24.9384, 60.1699], // Helsinki
      [24.7536, 59.437], // Tallinn
      [24.1052, 56.9496], // Riga
      [21.0118, 56.5047], // Liepāja
      [18.6466, 54.352], // Gdańsk
      [12.5683, 55.6761], // Copenhagen
      [5.3221, 60.3913], // Bergen
    ]
    const legs = ports.slice(1).map((_, i) => ({ mode: i === 0 ? ('air' as const) : ('sea' as const), via: [] }))
    const route = buildRoute(sceneOf(stopsAt(ports, { legs })))
    const km = route.legs.reduce((sum, leg) => sum + leg.path.slice(1).reduce((s, q, i) => s + haversineKm(leg.path[i]!, q), 0), 0)
    const { width, height } = layoutSize('16:9')
    for (const orient of [undefined, 'heading' as const]) {
      const camera = { mode: 'follow' as const, easing: 'smooth' as const, ...(orient ? { follow: { orient } } : {}) }
      const p = stopsAt(ports, { camera, legs, timing: { holdStart: 1, travel: km / 225, holdEnd: 2 } })
      const { tl, at } = camOf(p)
      expect(p.output.fps).toEqual({ num: 25, den: 1 })
      expect(km / ((tl.travelEndFrame - tl.travelStartFrame) / 25)).toBeCloseTo(225, -1)
      for (let f = 0; f < tl.totalFrames; f++) {
        const [x, y] = projectToLayout(at(f), '16:9', tl.stateAt(f).head.at)
        expect(x).toBeGreaterThanOrEqual(0.1 * width)
        expect(x).toBeLessThanOrEqual(0.9 * width)
        expect(y).toBeGreaterThanOrEqual(0.1 * height)
        expect(y).toBeLessThanOrEqual(0.9 * height)
      }
    }
  })

  test('caps the aim point at a quarter of the frame', () => {
    // A 1 s look-ahead on the fast Greek route at zoom 10 is far more than a quarter of the frame.
    const p = greekIslands({ camera: followCamera(settings({ zoom: 10, lookAhead: 1, smoothing: 0 })) })
    const { tl, at } = camOf(p)
    const { width, height } = layoutSize('16:9')
    const cap = Math.min(width, height) / 4 / (TILE_SIZE * 2 ** 10)
    let capped = 0
    for (let f = tl.travelStartFrame; f <= tl.travelEndFrame; f++) {
      const head = toXY(tl.stateAt(f).head.at)
      const aim = toXY(tl.stateAt(f + 25).head.at)
      const c = toXY(at(f).center)
      const offset = Math.hypot(c[0] - head[0], c[1] - head[1])
      const ahead = Math.hypot(aim[0] - head[0], aim[1] - head[1])
      expect(offset).toBeLessThanOrEqual(cap + 1e-12)
      if (ahead > cap) {
        capped++
        expect(offset).toBeCloseTo(cap, 12)
        // Along the same direction as the uncapped aim point.
        const cross = (c[0] - head[0]) * (aim[1] - head[1]) - (c[1] - head[1]) * (aim[0] - head[0])
        expect(Math.abs(cross) / (offset * ahead)).toBeLessThan(1e-9)
      } else {
        expect(offset).toBeCloseTo(ahead, 12)
      }
    }
    expect(capped).toBeGreaterThan(0)
  })

  test('follow bearing turns more slowly than position', () => {
    // Out east, then back west from a sharp stop with a 4 s pause: a 180° turn through ±180°.
    const turnAround = (smoothing: number) => {
      const p = stopsAt([[0, 0], [10, 0], [0, 0]], {
        camera: followCamera(settings({ zoom: 5, orient: 'heading', lookAhead: 0, smoothing })),
        timing: { holdStart: 1, travel: 10, holdEnd: 1 },
      })
      sceneOf(p).stops[1] = { ...sceneOf(p).stops[1]!, sharp: true, pause: 4 }
      return camOf(p)
    }
    /** Frames the bearing takes from 10% to 90% of the turn, unwrapped across ±180°, and how far it is at `frame`. */
    const turn = (smoothing: number) => {
      const { tl, at } = turnAround(smoothing)
      const bearings: number[] = []
      for (let f = 0; f < tl.totalFrames; f++) {
        const b = at(f).bearing
        expect(b).toBeGreaterThan(-180)
        expect(b).toBeLessThanOrEqual(180)
        const prev = bearings[f - 1]
        const unwrapped = prev === undefined ? b : prev + ((((b - prev) % 360) + 540) % 360) - 180
        bearings.push(unwrapped)
      }
      const [first, last] = [bearings[0]!, bearings.at(-1)!]
      expect(Math.abs(last - first)).toBeCloseTo(180, 0)
      const done = (f: number) => (bearings[f]! - first) / (last - first)
      const from = bearings.findIndex((_, f) => done(f) >= 0.1)
      const to = bearings.findIndex((_, f) => done(f) >= 0.9)
      const steepest = Math.max(...bearings.slice(1).map((b, f) => Math.abs(b - bearings[f]!)))
      return { frames: to - from, steepest, tl, done }
    }
    const slow = turn(0.2)
    // Gentle, with no jump where the bearing crosses ±180°.
    expect(slow.steepest).toBeLessThan(4)
    // A third of the smoothing time gives the bearing the rate the position uses at smoothing 0.2.
    const positionRate = turn(0.2 / 3)
    expect(slow.frames / positionRate.frames).toBeGreaterThan(2.5)
    expect(slow.frames / positionRate.frames).toBeLessThan(3.5)
    // The heading target switches mid-pause, so most of the turn happens while the ship is in port.
    const arrival = slow.tl.arrivals[1]!.frame
    const departure = slow.tl.legFrames[1]!.start
    expect(departure - arrival).toBe(100)
    expect(slow.done(departure) - slow.done(arrival)).toBeGreaterThan(0.5)
    expect(slow.done(Math.round((arrival + departure) / 2))).toBeCloseTo(0.5, 1)
    // Mid-pause, the position (at the full rate) is far closer to settled on the stop than the bearing is to its new
    // heading, each as a share of its whole move: 10° of longitude, and the turn.
    const mid = Math.round((arrival + departure) / 2)
    const c = turnAround(0.2).at(mid).center
    const positionLeft = Math.hypot(c[0] - 10, c[1]) / 10
    expect(positionLeft).toBeLessThan((1 - slow.done(mid)) / 10)
  })

  test('follow on a single-stop or zero-length route returns finite values', () => {
    for (const p of [
      stopsAt([[25, 37]], { camera: followCamera(), timing: { holdStart: 1, travel: 0, holdEnd: 1 } }),
      stopsAt([[25, 37], [25, 37]], { camera: followCamera(settings({ orient: 'heading' })) }),
    ]) {
      const { tl, at } = camOf(p)
      for (let f = 0; f < tl.totalFrames; f++) {
        const s = at(f)
        for (const v of [...s.center, s.zoom, s.bearing, s.pitch]) expect(Number.isFinite(v)).toBe(true)
        expect(s.center[0]).toBeCloseTo(25, 9)
        expect(s.center[1]).toBeCloseTo(37, 9)
      }
    }
  })

  test('uses the start shot pitch', () => {
    // With no follow.pitch stored.
    const follow = { zoom: 10, orient: 'north', lookAhead: 1, smoothing: 0.5 } as FollowSettings
    const p = greekIslands({ camera: { ...followCamera(follow), start: shot([25, 37], 6, 0, 40) } })
    expect(camOf(p).at(50).pitch).toBe(40)
  })

  test('crosses the antimeridian without jumping', () => {
    const p = pacific()
    p.scenes[0] = { ...sceneOf(p), camera: followCamera(settings({ smoothing: 0.5 })) }
    const { tl, at } = camOf(p)
    for (let f = 1; f < tl.totalFrames; f++) {
      expect(Math.abs(at(f).center[0] - at(f - 1).center[0])).toBeLessThan(180)
    }
  })
})

describe('projectToLayout', () => {
  test('puts the shot centre at the layout centre, and east of it to the right', () => {
    const { width, height } = layoutSize('16:9')
    const s = shot([25, 37], 6)
    const [cx, cy] = projectToLayout(s, '16:9', [25, 37])
    expect(cx).toBeCloseTo(width / 2, 6)
    expect(cy).toBeCloseTo(height / 2, 6)
    const [ex] = projectToLayout(s, '16:9', [25.5, 37])
    expect(ex).toBeGreaterThan(cx)
    const [, ny] = projectToLayout(s, '16:9', [25, 38])
    expect(ny).toBeLessThan(cy)
    // 0.5 degrees of longitude is TILE_SIZE * 2^zoom / 720 px.
    expect(ex - cx).toBeCloseTo((TILE_SIZE * 2 ** 6) / 720, 6)
  })

  test('rotates by the bearing and unwraps across the antimeridian', () => {
    const { width, height } = layoutSize('16:9')
    const [x, y] = projectToLayout(shot([25, 37], 6, 90), '16:9', [25.5, 37])
    expect(x).toBeCloseTo(width / 2, 6)
    expect(y).toBeLessThan(height / 2)
    const [wx] = projectToLayout(shot([179.9, 0], 6), '16:9', [-179.9, 0])
    expect(wx).toBeGreaterThan(width / 2)
    expect(wx).toBeLessThan(width / 2 + 200)
  })
})

describe('contextShot', () => {
  test('is undefined without context', () => {
    expect(contextShot(sceneOf(greekIslands()), '16:9')).toBeUndefined()
  })

  test('fits the context route, not the scene', () => {
    const greek = sceneOf(greekIslands())
    const scene = {
      ...sceneOf(stopsAt([[0, 0], [0.1, 0.1]])),
      context: { from: 'Greek Islands · Scene 1', stops: greek.stops.map(({ name, at }) => ({ name, at })), legs: greek.legs },
    }
    expect(contextShot(scene, '16:9')).toEqual(fitShot(buildRoute(greek).bounds, '16:9'))
    expect(contextShot(scene, '9:16')).toEqual(fitShot(buildRoute(greek).bounds, '9:16'))
  })
})
