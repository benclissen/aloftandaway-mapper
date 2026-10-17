import { pointAt, type Route } from './route.js'
import { fpsValue, type Camera, type Fps, type LngLat, type Scene } from './schema.js'

/** How long an `on-arrival` sign takes to fade in, starting on the arrival frame. */
export const SIGN_FADE_SECONDS = 0.4

/** The shortest a leg may take. */
const MIN_LEG_SECONDS = 0.5

/**
 * Split `travel` seconds across legs in proportion to their lengths, giving no leg less than 0.5 s and keeping the
 * total equal to `travel`. When `travel` is too short for that, every leg gets an equal share.
 */
export function legSeconds(lengths: number[], travel: number): number[] {
  const n = lengths.length
  if (n === 0) return []
  if (travel <= MIN_LEG_SECONDS * n) return lengths.map(() => travel / n)

  const fixed = new Set<number>()
  for (;;) {
    const free: number[] = []
    let freeLength = 0
    lengths.forEach((length, i) => {
      if (fixed.has(i)) return
      free.push(i)
      freeLength += length
    })
    const remaining = travel - MIN_LEG_SECONDS * fixed.size
    const share = (i: number) => (freeLength > 0 ? (remaining * lengths[i]!) / freeLength : remaining / free.length)
    const newly = free.filter((i) => share(i) < MIN_LEG_SECONDS)
    if (newly.length === 0) return lengths.map((_, i) => (fixed.has(i) ? MIN_LEG_SECONDS : share(i)))
    for (const i of newly) fixed.add(i)
  }
}

/**
 * The seconds a scene spends travelling. With `timing.length` set, that is whatever is left of the length after the
 * holds and pauses (so a stored `travel` that has gone stale is ignored); otherwise it is `timing.travel`.
 */
export function sceneTravel(scene: Scene): number {
  const { length, holdStart, holdEnd, travel } = scene.timing
  if (length === undefined) return travel
  return Math.max(0, length - holdStart - holdEnd - scene.stops.reduce((sum, s) => sum + s.pause, 0))
}

export function ease(kind: Camera['easing'], t: number): number {
  return kind === 'smooth' ? t * t * (3 - 2 * t) : t
}

export interface FrameState {
  frame: number
  /** Distance along the whole route, in Mercator units. */
  distance: number
  /** `distance / route.length`, 0 to 1. 0 when the route has no length. */
  progress: number
  /** 0 up to the first arrival, 1 from the end of the last stop's pause, linear in between. */
  travelT: number
  head: { at: LngLat; heading: number }
  /** Signs with `always` or `on-arrival` visibility, in stop order. */
  signs: { stopId: string; opacity: number }[]
}

export interface Timeline {
  fps: Fps
  totalFrames: number
  /** `totalFrames` at `fps`. */
  durationSeconds: number
  /** The frame of stop 0's arrival, where `holdStart` ends. */
  travelStartFrame: number
  /** The frame at the end of the last stop's pause, where `holdEnd` begins. */
  travelEndFrame: number
  /** Frames of each leg's travel. A leg that rounds to no frames has `start === end`. */
  legFrames: { start: number; end: number }[]
  arrivals: { stopId: string; index: number; frame: number; seconds: number }[]
  stateAt(frame: number): FrameState
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

export function buildTimeline(scene: Scene, fps: Fps, route: Route): Timeline {
  const { holdStart, holdEnd, length } = scene.timing
  const travel = sceneTravel(scene)
  const { stops } = scene
  const toFrame = (seconds: number) => Math.round((seconds * fps.num) / fps.den)
  const rate = fpsValue(fps)

  const total = length ?? holdStart + travel + stops.reduce((sum, s) => sum + s.pause, 0) + holdEnd

  // Boundaries in seconds, accumulated in order and only then turned into frames.
  const lengths = route.legs.map((leg) => leg.length)
  const durations = legSeconds(lengths, travel)
  const arrivals: Timeline['arrivals'] = []
  const legFrames: Timeline['legFrames'] = []
  let t = holdStart
  stops.forEach((stop, index) => {
    arrivals.push({ stopId: stop.id, index, frame: toFrame(t), seconds: t })
    t += stop.pause
    const duration = durations[index]
    if (duration !== undefined) {
      const end = t + duration
      legFrames.push({ start: toFrame(t), end: toFrame(end) })
      t = end
    }
  })
  const travelStartFrame = toFrame(holdStart)
  const travelEndFrame = toFrame(t)
  // With no end hold and no last pause, the last arrival would land one past the end. Keep it on the last frame.
  const totalFrames = Math.max(toFrame(total), travelEndFrame + 1)

  // Route distance at the start and end of each leg, summed in the order `buildRoute` sums them.
  const legStartDistance: number[] = []
  const legEndDistance: number[] = []
  let sum = 0
  for (const length of lengths) {
    legStartDistance.push(sum)
    sum += length
    legEndDistance.push(sum)
  }

  const signs = stops.flatMap((stop, index) =>
    stop.sign === 'none' ? [] : [{ stopId: stop.id, always: stop.sign === 'always', arrival: arrivals[index]!.frame }],
  )
  const fadeFrames = SIGN_FADE_SECONDS * rate
  const easing = scene.camera.easing

  /** Index of the last leg that has started by `frame`, or -1. */
  function legAt(frame: number): number {
    let lo = 0
    let hi = legFrames.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (legFrames[mid]!.start <= frame) lo = mid + 1
      else hi = mid
    }
    return lo - 1
  }

  function stateAt(requested: number): FrameState {
    const frame = clamp(requested, 0, totalFrames - 1)

    let distance = 0
    const leg = legAt(frame)
    if (leg >= 0) {
      const { start, end } = legFrames[leg]!
      distance =
        frame >= end
          ? legEndDistance[leg]!
          : Math.min(legStartDistance[leg]! + ease(easing, (frame - start) / (end - start)) * lengths[leg]!, legEndDistance[leg]!)
    }

    const { at, heading } = pointAt(route, distance)
    const travelT =
      travelEndFrame === travelStartFrame
        ? frame >= travelStartFrame
          ? 1
          : 0
        : clamp((frame - travelStartFrame) / (travelEndFrame - travelStartFrame), 0, 1)

    return {
      frame,
      distance,
      progress: route.length > 0 ? distance / route.length : 0,
      travelT,
      head: { at, heading },
      signs: signs.map((s) => ({
        stopId: s.stopId,
        opacity: s.always ? 1 : clamp((frame - s.arrival) / fadeFrames, 0, 1),
      })),
    }
  }

  return {
    fps,
    totalFrames,
    durationSeconds: totalFrames / rate,
    travelStartFrame,
    travelEndFrame,
    legFrames,
    arrivals,
    stateAt,
  }
}

/** `MM:SS:FF` for a frame number, counting at the nominal integer rate without dropping frames (30 for 29.97). */
export function formatTimecode(frame: number, fps: Fps): string {
  const rate = Math.round(fps.num / fps.den)
  const pad = (n: number) => String(n).padStart(2, '0')
  const minutes = Math.floor(frame / (rate * 60))
  const seconds = Math.floor(frame / rate) % 60
  return `${pad(minutes)}:${pad(seconds)}:${pad(frame % rate)}`
}
