import { headingDeg, toLngLat, toXY, unwrapLng, type XY } from './geo.js'
import type { Route } from './route.js'
import {
  fpsValue,
  layoutSize,
  THEME_MAX_ZOOM,
  type Aspect,
  type Camera,
  type CameraKey,
  type LngLat,
  type Scene,
  type Shot,
} from './schema.js'
import { ease, type Timeline } from './timeline.js'

/** Tile size in layout px. The world is `TILE_SIZE · 2^zoom` layout px across at `zoom`. */
export const TILE_SIZE = 512

const DEFAULT_PADDING = 0.12
const FIT_MIN_ZOOM = 0
const FIT_MAX_ZOOM = 16
/** Zoom for bounds that are a single point. */
const POINT_ZOOM = 12
const MIN_ZOOM = 0
const MAX_ZOOM = 22
/** van Wijk & Nuij's ρ: how far the fly path zooms out for a given move. */
const RHO = 1.42
/** Below this distance in world units the centres count as the same. */
const SAME_CENTRE = 1e-9

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

/** `deg` in (-180, 180]. */
function normaliseBearing(deg: number): number {
  const n = ((deg % 360) + 360) % 360
  return n > 180 ? n - 360 : n
}

/**
 * The shot that frames `bounds` (south-west and north-east corners) in the layout frame of `aspect`, leaving `padding`
 * of each side clear. The centre is the Mercator mid-point, so its longitude may be unwrapped beyond 180.
 */
export function fitShot(bounds: [LngLat, LngLat], aspect: Aspect, padding: number = DEFAULT_PADDING): Shot {
  const [sw, ne] = bounds
  const a = toXY(sw)
  const b = toXY(ne)
  const center = toLngLat([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])
  const dx = Math.abs(b[0] - a[0])
  const dy = Math.abs(b[1] - a[1])
  const { width, height } = layoutSize(aspect)
  const inner = 1 - 2 * padding
  // World size in layout px that fits each axis; the tighter axis wins.
  const fits = [dx > 0 ? (width * inner) / dx : Infinity, dy > 0 ? (height * inner) / dy : Infinity]
  const worldPx = Math.min(...fits)
  const zoom = worldPx === Infinity ? POINT_ZOOM : clamp(Math.log2(worldPx / TILE_SIZE), FIT_MIN_ZOOM, FIT_MAX_ZOOM)
  return { center, zoom, bearing: 0, pitch: 0 }
}

/** South-west and north-east corners of `path`, whose longitudes are already unwrapped. */
function pathBounds(path: LngLat[]): [LngLat, LngLat] {
  let [west, south, east, north] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [lng, lat] of path) {
    west = Math.min(west, lng)
    east = Math.max(east, lng)
    south = Math.min(south, lat)
    north = Math.max(north, lat)
  }
  return [[west, south], [east, north]]
}

/** A first-leg fit within this many zoom steps of the whole-route fit counts as the whole route. */
const SAME_FIT_ZOOM = 0.5
/** How far in from the whole-route fit the default start sits when the first leg is nearly the whole route. */
const FIRST_STOP_ZOOM_IN = 2

/**
 * The default start shot. A fixed camera shows the whole route. Otherwise it's the first leg fitted in the output
 * aspect, or, when that's barely closer than the whole route (a one-leg route, say), the first stop 2 zoom steps in from
 * the whole-route fit. Either is capped at the theme's maximum.
 */
function defaultStart(scene: Scene, aspect: Aspect, route: Route, whole: Shot): Shot {
  const first = route.legs[0]
  if (scene.camera.mode === 'fixed' || !first) return whole
  const max = THEME_MAX_ZOOM[scene.look.theme]
  const leg = fitShot(pathBounds(first.path), aspect)
  if (leg.zoom - whole.zoom > SAME_FIT_ZOOM) return { ...leg, zoom: Math.min(leg.zoom, max) }
  const [lng, lat] = scene.stops[0]!.at
  return { center: [lng, lat], zoom: Math.min(whole.zoom + FIRST_STOP_ZOOM_IN, max), bearing: 0, pitch: 0 }
}

/** A copy of `keys` in time order. Keys at the same time keep their stored order. */
const byTime = (keys: CameraKey[]): CameraKey[] => [...keys].sort((a, b) => a.at - b.at)

/**
 * The scene camera's start and end shots, in the output aspect. A glide with keys starts on its first key and ends on
 * its last, in time order. Otherwise a missing end is fitted to the whole route, and a missing start is the first leg,
 * so a default glide pulls out from the first leg to the whole route (see `defaultStart` and `cameraAt`).
 */
export function resolveShots(scene: Scene, aspect: Aspect, route: Route): { start: Shot; end: Shot } {
  const { start, end, keys } = scene.camera
  if (scene.camera.mode === 'glide' && keys?.length) {
    const sorted = byTime(keys)
    return { start: sorted[0]!.shot, end: sorted[sorted.length - 1]!.shot }
  }
  const whole = fitShot(route.bounds, aspect)
  return { start: start ?? defaultStart(scene, aspect, route, whole), end: end ?? whole }
}

/**
 * Smooth zoom-and-pan from `a` (u = 0) to `b` (u = 1) after van Wijk & Nuij (2003), "Smooth and efficient zooming and
 * panning", worked in Mercator world units with the viewport width taken as the layout frame's larger side. `b`'s
 * longitude is unwrapped against `a`'s, so the move takes the short way round. Bearing takes the shortest turn and
 * pitch is linear.
 */
export function flyInterpolator(a: Shot, b: Shot, aspect: Aspect): (u: number) => Shot {
  const { width, height } = layoutSize(aspect)
  const side = Math.max(width, height)
  /** Viewport width in world units at `zoom`, and back. */
  const widthAt = (zoom: number) => side / (TILE_SIZE * 2 ** zoom)
  const zoomAt = (w: number) => Math.log2(side / (TILE_SIZE * w))

  const c0 = toXY(a.center)
  const c1 = toXY([unwrapLng(a.center[0], b.center[0]), b.center[1]])
  const w0 = widthAt(a.zoom)
  const w1 = widthAt(b.zoom)
  const u1 = Math.hypot(c1[0] - c0[0], c1[1] - c0[1])

  const turn = normaliseBearing(b.bearing - a.bearing)
  const rest = (u: number) => ({
    bearing: normaliseBearing(a.bearing + turn * u),
    pitch: a.pitch + (b.pitch - a.pitch) * u,
  })

  if (u1 < SAME_CENTRE) {
    return (raw) => {
      const u = clamp(raw, 0, 1)
      const xy: XY = [c0[0] + (c1[0] - c0[0]) * u, c0[1] + (c1[1] - c0[1]) * u]
      return { center: toLngLat(xy), zoom: a.zoom + (b.zoom - a.zoom) * u, ...rest(u) }
    }
  }

  // b_i = (w1² − w0² ± ρ⁴u1²) / (2 w_i ρ² u1), r_i = ln(−b_i + √(b_i² + 1)) = −asinh(b_i).
  const rho2 = RHO * RHO
  const r0 = -Math.asinh((w1 * w1 - w0 * w0 + rho2 * rho2 * u1 * u1) / (2 * w0 * rho2 * u1))
  const r1 = -Math.asinh((w1 * w1 - w0 * w0 - rho2 * rho2 * u1 * u1) / (2 * w1 * rho2 * u1))
  const pathLength = (r1 - r0) / RHO
  const dir: XY = [(c1[0] - c0[0]) / u1, (c1[1] - c0[1]) / u1]
  const k = w0 / rho2

  return (raw) => {
    const u = clamp(raw, 0, 1)
    const s = u * pathLength
    // Distance along the move and viewport width at path parameter s.
    const along = k * Math.cosh(r0) * Math.tanh(RHO * s + r0) - k * Math.sinh(r0)
    const w = (w0 * Math.cosh(r0)) / Math.cosh(RHO * s + r0)
    const xy: XY = [c0[0] + dir[0] * along, c0[1] + dir[1] * along]
    return { center: toLngLat(xy), zoom: clamp(zoomAt(w), MIN_ZOOM, MAX_ZOOM), ...rest(u) }
  }
}

export interface FollowSettings {
  zoom: number
  orient: 'north' | 'heading'
  /** Seconds ahead of the head that the camera aims at. */
  lookAhead: number
  /** Seconds; the smoothing rate is `1 / smoothing` per second. 0 tracks the target exactly. */
  smoothing: number
  /** Degrees of tilt, 0 to 60. */
  pitch: number
}

/** Follow-camera zoom above the fitted route zoom when none is stored. */
const FOLLOW_ZOOM_IN = 3

/**
 * The scene's follow settings: `camera.follow` where stored, with any missing field filled from the defaults: north-up,
 * a quarter second of look-ahead, 0.2 s of smoothing, a zoom 3 steps in from the route's fitted zoom, capped at the
 * theme's maximum, and the start shot's pitch, or none.
 */
export function resolveFollow(scene: Scene, aspect: Aspect, route: Route): FollowSettings {
  const stored = scene.camera.follow
  const zoom = Math.min(fitShot(route.bounds, aspect).zoom + FOLLOW_ZOOM_IN, THEME_MAX_ZOOM[scene.look.theme])
  return {
    zoom: stored?.zoom ?? zoom,
    orient: stored?.orient ?? 'north',
    lookAhead: stored?.lookAhead ?? 0.25,
    smoothing: stored?.smoothing ?? 0.2,
    pitch: stored?.pitch ?? scene.camera.start?.pitch ?? 0,
  }
}

/** Centre and bearing for every frame. Longitude and bearing are unwrapped across frames. */
interface FollowTrack {
  centers: LngLat[]
  bearings: number[]
}

const followTracks = new WeakMap<Timeline, { key: string; track: FollowTrack }>()

/** One exact step of a critically damped spring towards `target`. */
function dampedStep(x: number, v: number, target: number, dt: number, omega: number): [number, number] {
  const e = Math.exp(-omega * dt)
  const d = x - target
  const k = v + omega * d
  return [target + (d + k * dt) * e, (v - omega * k * dt) * e]
}

/**
 * Smooth `xs` with a critically damped spring run forward from the first frame, then backward over that result from
 * the last. The backward pass cancels the forward pass's lag.
 */
function smoothZeroLag(xs: number[], dt: number, omega: number): number[] {
  const n = xs.length
  const fwd = new Array<number>(n)
  let x = xs[0]!
  let v = 0
  fwd[0] = x
  for (let i = 1; i < n; i++) {
    ;[x, v] = dampedStep(x, v, xs[i]!, dt, omega)
    fwd[i] = x
  }
  const out = new Array<number>(n)
  x = fwd[n - 1]!
  v = 0
  out[n - 1] = x
  for (let i = n - 2; i >= 0; i--) {
    ;[x, v] = dampedStep(x, v, fwd[i]!, dt, omega)
    out[i] = x
  }
  return out
}

/** The bearing smooths this many times more slowly than the position, so heading-up turns unwind gently. */
const BEARING_SLOWDOWN = 3

/** Heading at the end of `leg`: its last segment with length, or `undefined` when it has none. */
function arrivalHeading(leg: Route['legs'][number]): number | undefined {
  for (let i = leg.xy.length - 1; i > 0; i--) {
    const [a, b] = [leg.xy[i - 1]!, leg.xy[i]!]
    if (a[0] !== b[0] || a[1] !== b[1]) return headingDeg(a, b)
  }
  return undefined
}

/**
 * The heading the follow camera turns towards on `frame`: the head's heading, except in the first half of a pause at
 * a stop between two legs, where it's still the heading the leg arrived on. The timeline turns the head on arrival; the
 * camera turns mid-pause, so a heading-up turn at a port happens mostly while the vehicle waits there.
 */
function headingTarget(route: Route, timeline: Timeline, frame: number, heading: number): number {
  const { legFrames } = timeline
  for (let k = 1; k < legFrames.length; k++) {
    const arrival = legFrames[k - 1]!.end
    const departure = legFrames[k]!.start
    if (frame < arrival) break
    if (frame < (arrival + departure) / 2) return arrivalHeading(route.legs[k - 1]!) ?? heading
  }
  return heading
}

/**
 * Raw per-frame targets, then smoothed. The aim point is the head `lookAhead` seconds on, pulled back towards the
 * current head to at most `maxAhead` world units.
 */
function buildFollowTrack(route: Route, timeline: Timeline, follow: FollowSettings, maxAhead: number): FollowTrack {
  const rate = fpsValue(timeline.fps)
  const ahead = Math.round(follow.lookAhead * rate)
  const centers: LngLat[] = []
  const bearings: number[] = []
  for (let f = 0; f < timeline.totalFrames; f++) {
    const held = clamp(f, timeline.travelStartFrame, timeline.travelEndFrame)
    const now = timeline.stateAt(held).head.at
    const { at: aim, heading: aimHeading } = timeline.stateAt(held + ahead).head
    const heading = follow.orient === 'heading' ? headingTarget(route, timeline, held + ahead, aimHeading) : 0
    const h = toXY(now)
    const a = toXY([unwrapLng(now[0], aim[0]), aim[1]])
    const offset = Math.hypot(a[0] - h[0], a[1] - h[1])
    const k = offset > maxAhead ? maxAhead / offset : 1
    const at = toLngLat([h[0] + (a[0] - h[0]) * k, h[1] + (a[1] - h[1]) * k])
    const prev = centers[f - 1]
    centers.push(prev ? [unwrapLng(prev[0], at[0]), at[1]] : [at[0], at[1]])
    const prevBearing = bearings[f - 1]
    bearings.push(prevBearing === undefined ? heading : prevBearing + normaliseBearing(heading - prevBearing))
  }
  if (follow.smoothing <= 0 || centers.length < 2) return { centers, bearings: bearings.map(normaliseBearing) }

  const dt = 1 / rate
  const omega = 1 / follow.smoothing
  const xy = centers.map(toXY)
  const xs = smoothZeroLag(xy.map((p) => p[0]), dt, omega)
  const ys = smoothZeroLag(xy.map((p) => p[1]), dt, omega)
  return {
    centers: xs.map((x, i) => toLngLat([x, ys[i]!])),
    bearings: smoothZeroLag(bearings, dt, omega / BEARING_SLOWDOWN).map(normaliseBearing),
  }
}

/** A quarter of the shorter side of the layout frame at `zoom`, in world units: the farthest the aim point may lead. */
function maxLookAhead(aspect: Aspect, zoom: number): number {
  const { width, height } = layoutSize(aspect)
  return Math.min(width, height) / 4 / (TILE_SIZE * 2 ** zoom)
}

/** The follow track for `timeline`, built once per timeline and camera, aspect and theme. */
function followTrack(scene: Scene, aspect: Aspect, route: Route, timeline: Timeline, follow: FollowSettings): FollowTrack {
  const key = JSON.stringify([scene.camera, aspect, scene.look.theme])
  const cached = followTracks.get(timeline)
  if (cached?.key === key) return cached.track
  const track = buildFollowTrack(route, timeline, follow, maxLookAhead(aspect, follow.zoom))
  followTracks.set(timeline, { key, track })
  return track
}

/** `shot` held still: a fresh copy with its bearing in (-180, 180]. */
function held(shot: Shot): Shot {
  const [lng, lat] = shot.center
  return { center: [lng, lat], zoom: shot.zoom, bearing: normaliseBearing(shot.bearing), pitch: shot.pitch }
}

/**
 * The keyed glide's view `seconds` from the scene's first frame. It holds the first key's shot until that key's time,
 * flies from each key to the next with `easing` applied per segment, and holds the last key's shot after it. `keys`
 * needn't be in order and must not be empty.
 */
export function keyedShot(keys: CameraKey[], aspect: Aspect, easing: Camera['easing'], seconds: number): Shot {
  const sorted = byTime(keys)
  let k = 0
  while (k + 1 < sorted.length && sorted[k + 1]!.at <= seconds) k++
  const a = sorted[k]!
  const b = sorted[k + 1]
  if (!b || seconds <= a.at) return held(a.shot)
  return flyInterpolator(a.shot, b.shot, aspect)(ease(easing, (seconds - a.at) / (b.at - a.at)))
}

/**
 * How far along the glide `frame` is, 0 to 1, before easing. A stored start glides across the travel section. A default
 * start (the first leg) pulls out from frame 0 to the end of the first leg's travel, then holds the end shot.
 */
function glideProgress(scene: Scene, timeline: Timeline, frame: number): number {
  const firstLeg = timeline.legFrames[0]
  if (scene.camera.start || !firstLeg) return timeline.stateAt(frame).travelT
  return firstLeg.end > 0 ? clamp(frame / firstLeg.end, 0, 1) : 1
}

/**
 * How far in from each side the default glide keeps the head, as a fraction of the frame. Less than the fitted shots'
 * padding, so a head arriving at the route's edge doesn't nudge the camera as it settles on the whole route.
 */
const HEAD_PADDING = 0.08
/** Roughly how many seconds the default glide takes to ease into an extra pull-out, and back out of it. */
const PULL_OUT_SECONDS = 1

const pullOuts = new WeakMap<Timeline, { key: string; extra: number[] }>()

/** The highest zoom at which `at` sits inside the head padding on a view centred and turned like `shot`. */
function zoomKeeping(shot: Shot, aspect: Aspect, at: LngLat): number {
  const { width, height } = layoutSize(aspect)
  const [x, y] = projectToLayout({ ...shot, zoom: 0 }, aspect, at)
  const dx = Math.abs(x - width / 2)
  const dy = Math.abs(y - height / 2)
  const half = 0.5 - HEAD_PADDING
  return Math.log2(Math.min(dx > 0 ? (width * half) / dx : Infinity, dy > 0 ? (height * half) / dy : Infinity))
}

/**
 * Zoom steps the default glide pulls out beyond `glide` on each frame, so the head stays inside the head padding. A
 * glide that opens close in on the first stop pulls out on its own timetable, which a vehicle heading away from the
 * route's middle can outrun. The shortfall is widened by a running maximum over `2r` frames each side, then box-blurred
 * twice over `r` frames each side. Every blurred value averages maxima whose reach covers the frame, so the result is
 * smooth and never less than that frame's shortfall.
 */
function buildPullOut(glide: (frame: number) => Shot, aspect: Aspect, timeline: Timeline): number[] {
  const n = timeline.totalFrames
  const short = Array.from({ length: n }, (_, f) => {
    const shot = glide(f)
    return Math.max(0, shot.zoom - zoomKeeping(shot, aspect, timeline.stateAt(f).head.at))
  })
  if (short.every((d) => d === 0)) return short
  const r = Math.max(1, Math.round((PULL_OUT_SECONDS * fpsValue(timeline.fps)) / 2))
  const at = (xs: number[], i: number) => xs[clamp(i, 0, n - 1)]!
  const widened = short.map((_, f) => {
    let m = 0
    for (let k = -2 * r; k <= 2 * r; k++) m = Math.max(m, at(short, f + k))
    return m
  })
  const blur = (xs: number[]) =>
    xs.map((_, f) => {
      let sum = 0
      for (let k = -r; k <= r; k++) sum += at(xs, f + k)
      return sum / (2 * r + 1)
    })
  return blur(blur(widened))
}

/** The default glide's extra pull-out for `timeline`, built once per timeline and camera, aspect and theme. */
function pullOut(scene: Scene, aspect: Aspect, timeline: Timeline, glide: (frame: number) => Shot): number[] {
  const key = JSON.stringify([scene.camera, aspect, scene.look.theme])
  const cached = pullOuts.get(timeline)
  if (cached?.key === key) return cached.extra
  const extra = buildPullOut(glide, aspect, timeline)
  pullOuts.set(timeline, { key, extra })
  return extra
}

/**
 * The map view on `frame`. `fixed` holds `start`. `glide` with keys follows them on the scene's clock (see `keyedShot`)
 * and ignores `start` and `end`. Otherwise `glide` with a stored start flies from `start` to `end` across the
 * travel section with `camera.easing` applied once to the overall travel progress, holding at both ends. With a default
 * start it flies from frame 0, through the opening hold, to the end of the first leg's travel, then holds `end` (see
 * `glideProgress`), pulling out further where needed to keep the head inside the head padding (see
 * `buildPullOut`). That pull-out eases off over about a second, so it may run a little way into the hold. `follow` centres on the head
 * `lookAhead` seconds ahead, at most a quarter of the frame from the head, holding on travel's first and last frames,
 * smoothed without lag. A heading-up bearing smooths 3 times more slowly than the position.
 */
export function cameraAt(scene: Scene, aspect: Aspect, route: Route, timeline: Timeline, frame: number): Shot {
  if (scene.camera.mode === 'follow') {
    const follow = resolveFollow(scene, aspect, route)
    const track = followTrack(scene, aspect, route, timeline, follow)
    const f = clamp(Math.round(frame), 0, track.centers.length - 1)
    const [lng, lat] = track.centers[f]!
    return { center: [lng, lat], zoom: follow.zoom, bearing: track.bearings[f]!, pitch: follow.pitch }
  }
  const { keys } = scene.camera
  if (scene.camera.mode === 'glide' && keys?.length) {
    return keyedShot(keys, aspect, scene.camera.easing, frame / fpsValue(timeline.fps))
  }
  const { start, end } = resolveShots(scene, aspect, route)
  if (scene.camera.mode === 'fixed') return held(start)
  const fly = flyInterpolator(start, end, aspect)
  const glide = (f: number) => fly(ease(scene.camera.easing, glideProgress(scene, timeline, f)))
  const shot = glide(frame)
  if (scene.camera.start) return shot
  const extra = pullOut(scene, aspect, timeline, glide)[clamp(Math.round(frame), 0, timeline.totalFrames - 1)]!
  return extra > 0 ? { ...shot, zoom: Math.max(MIN_ZOOM, shot.zoom - extra) } : shot
}

/**
 * Layout px of `at` on the map view `shot`: the Mercator offset from the shot centre at `TILE_SIZE · 2^zoom` px per
 * world, rotated so the bearing points up, around the layout centre. Pitch is ignored. `at` is unwrapped against the
 * shot centre.
 */
export function projectToLayout(shot: Shot, aspect: Aspect, at: LngLat): [number, number] {
  const { width, height } = layoutSize(aspect)
  const world = TILE_SIZE * 2 ** shot.zoom
  const c = toXY(shot.center)
  const p = toXY([unwrapLng(shot.center[0], at[0]), at[1]])
  const dx = (p[0] - c[0]) * world
  const dy = (p[1] - c[1]) * world
  const b = (shot.bearing * Math.PI) / 180
  return [width / 2 + dx * Math.cos(b) + dy * Math.sin(b), height / 2 - dx * Math.sin(b) + dy * Math.cos(b)]
}
