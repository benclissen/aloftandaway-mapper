import { describe, expect, test } from 'vitest'
import {
  buildRoute,
  buildTimeline,
  ease,
  formatTimecode,
  legSeconds,
  sceneTravel,
  SIGN_FADE_SECONDS,
  type Project,
} from '../../src/core/index.js'
import { emptyProject, greekIslands, pacific, sceneOf, stopsAt } from '../fixtures/projects.js'

const timelineOf = (p: Project) => {
  const scene = sceneOf(p)
  const route = buildRoute(scene)
  return { route, tl: buildTimeline(scene, p.output.fps, route) }
}

describe('legSeconds', () => {
  test('keeps the 0.5 s minimum and the total', () => {
    expect(legSeconds([1, 1, 98], 10)).toEqual([0.5, 0.5, 9])
    expect(legSeconds([1, 1], 10)).toEqual([5, 5])
    expect(legSeconds([1, 2, 3], 1)).toEqual([1 / 3, 1 / 3, 1 / 3])
  })

  test('shares in proportion to length when nothing is short', () => {
    expect(legSeconds([1, 3], 8)).toEqual([2, 6])
  })

  test('returns nothing for no legs', () => {
    expect(legSeconds([], 10)).toEqual([])
  })

  test('gives zero-length legs the minimum and keeps the total', () => {
    const s = legSeconds([0, 4, 0, 4], 10)
    expect(s).toEqual([0.5, 4.5, 0.5, 4.5])
    expect(s.reduce((a, b) => a + b, 0)).toBeCloseTo(10, 12)
  })

  test('splits equally when every length is zero', () => {
    expect(legSeconds([0, 0], 10)).toEqual([5, 5])
  })

  test('a cascade of short legs still totals travel', () => {
    const s = legSeconds([1, 10, 100, 1000], 4)
    expect(s.every((v) => v >= 0.5 - 1e-12)).toBe(true)
    expect(s.reduce((a, b) => a + b, 0)).toBeCloseTo(4, 12)
  })
})

describe('ease', () => {
  test('linear is t and smooth is smoothstep', () => {
    expect(ease('linear', 0.3)).toBe(0.3)
    expect(ease('smooth', 0)).toBe(0)
    expect(ease('smooth', 1)).toBe(1)
    expect(ease('smooth', 0.5)).toBe(0.5)
    expect(ease('smooth', 0.25)).toBeCloseTo(0.15625, 12)
  })
})

describe('buildTimeline', () => {
  test('25 fps totals and arrivals', () => {
    const p = greekIslands({ timing: { holdStart: 1, travel: 10, holdEnd: 2 } }) // Santorini pause 1
    const { tl } = timelineOf(p)
    expect(tl.totalFrames).toBe(350)
    expect(tl.durationSeconds).toBe(14)
    expect(tl.arrivals[0]!.frame).toBe(25)
    expect(tl.arrivals.at(-1)!.frame).toBe(300)
    expect(tl.arrivals.map((a) => a.stopId)).toEqual(['piraeus', 'mykonos', 'santorini', 'rhodes'])
    expect(tl.arrivals.map((a) => a.index)).toEqual([0, 1, 2, 3])
    expect(tl.arrivals[0]!.seconds).toBe(1)
    expect(tl.travelStartFrame).toBe(25)
    expect(tl.travelEndFrame).toBe(300)
  })

  test('legs run from the end of one pause to the next arrival', () => {
    const { tl } = timelineOf(greekIslands())
    expect(tl.legFrames).toHaveLength(3)
    expect(tl.legFrames[0]!.start).toBe(tl.arrivals[0]!.frame)
    expect(tl.legFrames[0]!.end).toBe(tl.arrivals[1]!.frame)
    expect(tl.legFrames[1]!.start).toBe(tl.arrivals[1]!.frame)
    expect(tl.legFrames[1]!.end).toBe(tl.arrivals[2]!.frame)
    // Santorini pauses for 1 s (25 frames) before leg 2.
    expect(tl.legFrames[2]!.start).toBe(tl.arrivals[2]!.frame + 25)
    expect(tl.legFrames[2]!.end).toBe(tl.arrivals[3]!.frame)
  })

  test('29.97 fps boundaries', () => {
    const p = {
      ...stopsAt([[23.6466, 37.942], [25.3289, 37.4467]]),
      output: { aspect: '16:9' as const, height: 1080 as const, fps: { num: 30000, den: 1001 } },
    }
    const { tl } = timelineOf(p)
    expect(tl.totalFrames).toBe(390)
    expect(tl.arrivals[0]!.frame).toBe(30)
    expect(tl.arrivals[1]!.frame).toBe(330)
    expect(formatTimecode(330, p.output.fps)).toBe('00:11:00')
  })

  test('head is at each stop on its arrival frame', () => {
    const { route, tl } = timelineOf(greekIslands())
    for (const a of tl.arrivals) {
      const expected = a.index === 0 ? route.legs[0]!.path[0]! : route.legs[a.index - 1]!.path.at(-1)!
      const at = tl.stateAt(a.frame).head.at
      expect(at[0]).toBeCloseTo(expected[0], 9)
      expect(at[1]).toBeCloseTo(expected[1], 9)
    }
  })

  test('head is at the unwrapped stop on its arrival frame across the antimeridian', () => {
    const { route, tl } = timelineOf(pacific())
    const end = tl.stateAt(tl.arrivals[1]!.frame).head.at
    expect(end[0]).toBeCloseTo(route.legs[0]!.path.at(-1)![0], 9)
    expect(end[0]).toBeGreaterThan(180)
  })

  test('distance holds through holds and pauses and reaches the route length', () => {
    const { route, tl } = timelineOf(greekIslands())
    expect(tl.stateAt(0).distance).toBe(0)
    expect(tl.stateAt(tl.arrivals[0]!.frame).distance).toBe(0)
    const santorini = tl.arrivals[2]!.frame
    const before = tl.stateAt(santorini).distance
    expect(tl.stateAt(santorini + 12).distance).toBe(before)
    expect(tl.stateAt(santorini + 25).distance).toBe(before)
    expect(tl.stateAt(santorini + 26).distance).toBeGreaterThan(before)
    expect(tl.stateAt(tl.arrivals[3]!.frame).distance).toBe(route.length)
    expect(tl.stateAt(tl.totalFrames - 1).distance).toBe(route.length)
    expect(tl.stateAt(tl.totalFrames - 1).progress).toBe(1)
    expect(tl.stateAt(0).progress).toBe(0)
  })

  test('distance never decreases', () => {
    const { tl } = timelineOf(greekIslands())
    let last = 0
    for (let f = 0; f < tl.totalFrames; f++) {
      const d = tl.stateAt(f).distance
      expect(d).toBeGreaterThanOrEqual(last)
      last = d
    }
  })

  test('easing shapes the distance within a leg', () => {
    const linear = timelineOf(greekIslands({ camera: { mode: 'fixed', easing: 'linear' } }))
    const smooth = timelineOf(greekIslands({ camera: { mode: 'fixed', easing: 'smooth' } }))
    const { start, end } = linear.tl.legFrames[0]!
    const frame = start + (end - start) / 4
    const len = linear.route.legs[0]!.length
    expect(Number.isInteger(frame)).toBe(true)
    expect(linear.tl.stateAt(frame).distance).toBeCloseTo(len * 0.25, 12)
    expect(smooth.tl.stateAt(frame).distance).toBeCloseTo(len * ease('smooth', 0.25), 12)
  })

  test('stateAt clamps the frame to the timeline', () => {
    const { tl } = timelineOf(greekIslands())
    expect(tl.stateAt(-5).frame).toBe(0)
    expect(tl.stateAt(10_000).frame).toBe(tl.totalFrames - 1)
  })

  test('travelT is 0 up to the first arrival, 1 from the end of the last pause, linear between', () => {
    const { tl } = timelineOf(greekIslands())
    expect(tl.stateAt(0).travelT).toBe(0)
    expect(tl.stateAt(tl.travelStartFrame).travelT).toBe(0)
    expect(tl.stateAt(tl.travelEndFrame).travelT).toBe(1)
    expect(tl.stateAt(tl.totalFrames - 1).travelT).toBe(1)
    const mid = (tl.travelStartFrame + tl.travelEndFrame) / 2
    expect(tl.stateAt(mid).travelT).toBeCloseTo(0.5, 12)
  })

  test('on-arrival sign fades in over 0.4 s', () => {
    const p = greekIslands()
    sceneOf(p).stops[1]!.sign = 'on-arrival'
    const { tl } = timelineOf(p)
    expect(SIGN_FADE_SECONDS).toBe(0.4)
    const a = tl.arrivals[1]!.frame
    const opacity = (f: number) => tl.stateAt(f).signs.find((s) => s.stopId === 'mykonos')!.opacity
    expect(opacity(a - 1)).toBe(0)
    expect(opacity(a)).toBe(0)
    expect(opacity(a + 5)).toBeCloseTo(0.5, 12)
    expect(opacity(a + 10)).toBe(1)
    expect(opacity(a + 20)).toBe(1)
  })

  test('always signs are opaque from frame 0, none are omitted, order follows the stops', () => {
    const p = greekIslands()
    sceneOf(p).stops[2]!.sign = 'none'
    sceneOf(p).stops[3]!.sign = 'on-arrival'
    const { tl } = timelineOf(p)
    expect(tl.stateAt(0).signs).toEqual([
      { stopId: 'piraeus', opacity: 1 },
      { stopId: 'mykonos', opacity: 1 },
      { stopId: 'rhodes', opacity: 0 },
    ])
  })

  test('zero-length leg stays finite', () => {
    const p = stopsAt([[25.33, 37.45], [25.33, 37.45], [25.43, 36.42]])
    const { tl } = timelineOf(p)
    expect(tl.legFrames[0]!.end - tl.legFrames[0]!.start).toBe(Math.round(0.5 * 25))
    for (let f = 0; f < tl.totalFrames; f++) {
      const s = tl.stateAt(f)
      expect(Number.isFinite(s.distance) && Number.isFinite(s.head.heading) && Number.isFinite(s.travelT)).toBe(true)
    }
  })

  test('legs that round to no frames put the head at their end', () => {
    const p = stopsAt([[0, 0], [1, 1], [2, 0]], { timing: { holdStart: 0, travel: 0.01, holdEnd: 0 } })
    const { route, tl } = timelineOf(p)
    expect(tl.legFrames.every((l) => l.start === l.end)).toBe(true)
    expect(tl.totalFrames).toBe(1)
    expect(tl.travelStartFrame).toBe(tl.travelEndFrame)
    expect(tl.stateAt(0).distance).toBe(route.length)
    expect(tl.stateAt(0).travelT).toBe(1)
  })

  test('no stops: no legs, no arrivals, the head at the origin', () => {
    const { tl } = timelineOf(emptyProject())
    expect(tl.legFrames).toEqual([])
    expect(tl.arrivals).toEqual([])
    expect(tl.totalFrames).toBe(13 * 25)
    expect(tl.stateAt(100).head.at).toEqual([0, 0])
    expect(tl.stateAt(100).signs).toEqual([])
  })

  test('one stop: its arrival, and the head stays on it', () => {
    const p = greekIslands()
    sceneOf(p).stops = [{ ...sceneOf(p).stops[0]!, pause: 2 }]
    sceneOf(p).legs = []
    const { tl } = timelineOf(p)
    expect(tl.legFrames).toEqual([])
    expect(tl.arrivals).toEqual([{ stopId: 'piraeus', index: 0, frame: 25, seconds: 1 }])
    expect(tl.travelStartFrame).toBe(25)
    expect(tl.travelEndFrame).toBe(75)
    expect(tl.totalFrames).toBe((1 + 10 + 2 + 2) * 25)
    expect(tl.stateAt(60).head.at).toEqual(sceneOf(p).stops[0]!.at)
    expect(tl.stateAt(60).distance).toBe(0)
    expect(tl.stateAt(60).progress).toBe(0)
  })

  test('the total is at least one frame', () => {
    const p = emptyProject()
    sceneOf(p).timing = { holdStart: 0, travel: 0, holdEnd: 0 }
    const { tl } = timelineOf(p)
    expect(tl.totalFrames).toBe(1)
    expect(tl.stateAt(0).frame).toBe(0)
  })

  test('with no end hold and no last pause, the last frame shows the last stop', () => {
    const base = greekIslands()
    const p = greekIslands({
      timing: { holdStart: 1, travel: 10, holdEnd: 0 },
      camera: { ...sceneOf(base).camera, easing: 'linear' },
    })
    expect(sceneOf(p).stops.at(-1)!.pause).toBe(0)
    const { route, tl } = timelineOf(p)
    expect(tl.arrivals.at(-1)!.frame).toBe(tl.totalFrames - 1)
    const last = tl.stateAt(tl.totalFrames - 1)
    expect(last.head.at).toEqual(sceneOf(p).stops.at(-1)!.at)
    expect(last.distance).toBe(route.length)
    expect(tl.durationSeconds).toBe(tl.totalFrames / 25)
  })
})

describe('a fixed length', () => {
  // Holds 1 and 2, and two pauses of 1.5, so 3 s of travel is left over when the length is 8 s.
  const fixed = (timing: Record<string, number>, fps?: { num: number; den: number }) => {
    const p = stopsAt([[0, 0], [10, 0], [20, 0]], { timing: { holdStart: 1, travel: 5, holdEnd: 2, ...timing } })
    sceneOf(p).stops[0]!.pause = 1.5
    sceneOf(p).stops[1]!.pause = 1.5
    if (fps) p.output.fps = fps
    return p
  }

  test('sceneTravel is the stored travel without a length, and the rest of the length with one', () => {
    expect(sceneTravel(sceneOf(fixed({})))).toBe(5)
    expect(sceneTravel(sceneOf(fixed({ length: 8 })))).toBe(2)
    expect(sceneTravel(sceneOf(fixed({ length: 3 })))).toBe(0)
  })

  test('length 8 at 25 fps is 200 frames', () => {
    const p = fixed({ length: 8 })
    expect(sceneTravel(sceneOf(p))).toBe(2)
    expect(timelineOf(p).tl.totalFrames).toBe(200)
  })

  test('length 8 at 30000/1001 is 240 frames', () => {
    expect(timelineOf(fixed({ length: 8 }, { num: 30000, den: 1001 })).tl.totalFrames).toBe(240)
  })

  test('a stale travel is ignored', () => {
    expect(timelineOf(fixed({ length: 8, travel: 99 })).tl.totalFrames).toBe(200)
  })
})

describe('formatTimecode', () => {
  test('counts MM:SS:FF at the nominal rate', () => {
    const f25 = { num: 25, den: 1 }
    expect(formatTimecode(0, f25)).toBe('00:00:00')
    expect(formatTimecode(24, f25)).toBe('00:00:24')
    expect(formatTimecode(25, f25)).toBe('00:01:00')
    expect(formatTimecode(25 * 60 + 3, f25)).toBe('01:00:03')
    expect(formatTimecode(25 * 60 * 100, f25)).toBe('100:00:00')
  })

  test('uses 30 for 29.97 and 24 for 23.976', () => {
    expect(formatTimecode(30, { num: 30000, den: 1001 })).toBe('00:01:00')
    expect(formatTimecode(24, { num: 24000, den: 1001 })).toBe('00:01:00')
    expect(formatTimecode(30 * 60 + 29, { num: 30000, den: 1001 })).toBe('01:00:29')
  })
})
