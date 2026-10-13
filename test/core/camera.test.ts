import { describe, expect, test } from 'vitest'
import {
  buildRoute,
  buildTimeline,
  cameraAt,
  ease,
  fitShot,
  flyInterpolator,
  layoutSize,
  resolveShots,
  TILE_SIZE,
  toXY,
  type Aspect,
  type LngLat,
  type Project,
  type Shot,
} from '../../src/core/index.js'
import { greekIslands, pacific } from '../fixtures/projects.js'

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

const timelineOf = (p: Project) => {
  const route = buildRoute(p)
  return { route, tl: buildTimeline(p, route) }
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
    const { start } = resolveShots(p, buildRoute(p))
    expect(start.center[0]).toBeGreaterThan(178)
    expect(start.center[0]).toBeLessThan(189)
    expect(start.zoom).toBeGreaterThan(4)
  })

  test('fills only the missing shot and uses a supplied one as stored', () => {
    const stored = shot([24, 37], 9, 30, 20)
    const p = greekIslands({ camera: { mode: 'glide', easing: 'linear', start: stored } })
    const route = buildRoute(p)
    const { start, end } = resolveShots(p, route)
    expect(start).toEqual(stored)
    expect(end).toEqual(fitShot(route.bounds, '16:9'))
  })

  test('fits missing shots in the output aspect', () => {
    const p = greekIslands({ output: { aspect: '9:16', height: 1080, fps: { num: 25, den: 1 } } })
    const route = buildRoute(p)
    expect(resolveShots(p, route).start).toEqual(fitShot(route.bounds, '9:16'))
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
    for (const f of [0, tl.travelStartFrame, 100, tl.totalFrames - 1]) expect(cameraAt(p, route, tl, f)).toEqual(start)
  })

  test('glide holds at both ends and passes through endpoints', () => {
    const start = shot([23.6466, 37.942], 9)
    const end = shot([28.2278, 36.451], 7, 0, 30)
    const p = greekIslands({ camera: { mode: 'glide', easing: 'smooth', start, end } })
    const { route, tl } = timelineOf(p)
    expect(tl.travelStartFrame).toBeGreaterThan(0)
    expect(tl.travelEndFrame).toBeLessThan(tl.totalFrames - 1)
    for (let f = 0; f <= tl.travelStartFrame; f++) expectShotClose(cameraAt(p, route, tl, f), start)
    for (let f = tl.travelEndFrame; f < tl.totalFrames; f++) expectShotClose(cameraAt(p, route, tl, f), end)
    const mid = cameraAt(p, route, tl, Math.round((tl.travelStartFrame + tl.travelEndFrame) / 2))
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
      expect(cameraAt(p, route, tl, f)).toEqual(fly(ease('smooth', tl.stateAt(f).travelT)))
    }
  })

  test('follow behaves as glide', () => {
    const glide = greekIslands({ camera: { mode: 'glide', easing: 'linear' } })
    const follow = greekIslands({
      camera: {
        mode: 'follow',
        easing: 'linear',
        follow: { zoom: 10, orient: 'heading', lookAhead: 0, smoothing: 0.5 },
      },
    })
    const { route, tl } = timelineOf(glide)
    for (const f of [0, 60, 150, tl.totalFrames - 1]) {
      expect(cameraAt(follow, route, tl, f)).toEqual(cameraAt(glide, route, tl, f))
    }
  })

  test('camera is a pure function of frame', () => {
    const p = greekIslands({
      camera: { mode: 'glide', easing: 'smooth', start: shot([23.6466, 37.942], 10), end: shot([28.2278, 36.451], 6) },
    })
    const { route: r, tl } = timelineOf(p)
    const frames = Array.from({ length: tl.totalFrames }, (_, i) => i)
    const seq = frames.map((f) => cameraAt(p, r, tl, f))
    const shuffled = [...frames]
      .reverse()
      .map((f) => cameraAt(p, r, tl, f))
      .reverse()
    expect(shuffled).toEqual(seq)
  })
})
