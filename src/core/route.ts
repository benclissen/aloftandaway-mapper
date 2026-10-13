import { toLngLat, toXY, unwrapLng, headingDeg, type XY } from './geo.js'
import type { LegMode, LngLat, Project } from './schema.js'

export interface RouteLeg {
  mode: LegMode
  drawnAs: 'line'
  /** Unwrapped `[lng, lat]`, sampled from `xy`. The ends are exactly the unwrapped stop coordinates. */
  path: LngLat[]
  xy: XY[]
  /** Distance along this leg at each point: `cum[0] = 0`, `cum.at(-1) = length`. */
  cum: number[]
  length: number
  /** The mode has no router yet, so the leg is drawn as a line. */
  notAvailable?: boolean
}

export interface Route {
  legs: RouteLeg[]
  length: number
  /** South-west and north-east corners of every path point, longitudes unwrapped. */
  bounds: [LngLat, LngLat]
}

const SAMPLES_PER_SPAN = 24
const ALPHA = 0.5

const dist = (a: XY, b: XY) => Math.hypot(b[0] - a[0], b[1] - a[1])

function lerp(a: XY, b: XY, t: number): XY {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

/** One point of the centripetal Catmull-Rom span from p1 to p2, by the Barry-Goldman pyramid. `u` is in [0, 1]. */
function catmullRom(p0: XY, p1: XY, p2: XY, p3: XY, u: number): XY {
  const t1 = dist(p0, p1) ** ALPHA
  const t2 = t1 + dist(p1, p2) ** ALPHA
  const t3 = t2 + dist(p2, p3) ** ALPHA
  const t = t1 + (t2 - t1) * u
  const a1 = lerp(p0, p1, (t - 0) / t1)
  const a2 = lerp(p1, p2, (t - t1) / (t2 - t1))
  const a3 = lerp(p2, p3, (t - t2) / (t3 - t2))
  const b1 = lerp(a1, a2, (t - 0) / t2)
  const b2 = lerp(a2, a3, (t - t1) / (t3 - t1))
  return lerp(b1, b2, (t - t1) / (t2 - t1))
}

/** Sample a smooth curve through `points`, which must be distinct from their neighbours. Two points give a straight segment. */
function curveThrough(points: XY[]): XY[] {
  if (points.length < 3) return points
  const first = points[0]!
  const last = points[points.length - 1]!
  const second = points[1]!
  const beforeLast = points[points.length - 2]!
  const ctrl: XY[] = [
    [2 * first[0] - second[0], 2 * first[1] - second[1]],
    ...points,
    [2 * last[0] - beforeLast[0], 2 * last[1] - beforeLast[1]],
  ]
  const out: XY[] = []
  for (let i = 1; i < ctrl.length - 2; i++) {
    out.push(ctrl[i]!) // exact control point
    for (let k = 1; k < SAMPLES_PER_SPAN; k++) {
      out.push(catmullRom(ctrl[i - 1]!, ctrl[i]!, ctrl[i + 1]!, ctrl[i + 2]!, k / SAMPLES_PER_SPAN))
    }
  }
  out.push(last)
  return out
}

function buildLeg(mode: LegMode, points: LngLat[]): RouteLeg {
  const first = points[0]!
  const last = points[points.length - 1]!
  const control: XY[] = []
  for (const p of points) {
    const xy = toXY(p)
    const prev = control[control.length - 1]
    if (!prev || prev[0] !== xy[0] || prev[1] !== xy[1]) control.push(xy)
  }
  // Everything coincides: a zero-length leg that still has both ends.
  const xy = control.length === 1 ? [control[0]!, control[0]!] : curveThrough(control)
  const path = xy.map(toLngLat)
  path[0] = first
  path[path.length - 1] = last
  const cum = [0]
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1]! + dist(xy[i - 1]!, xy[i]!))
  const leg: RouteLeg = { mode, drawnAs: 'line', path, xy, cum, length: cum[cum.length - 1]! }
  if (mode === 'sea' || mode === 'air') leg.notAvailable = true
  return leg
}

export function buildRoute(project: Project): Route {
  const { stops } = project
  if (stops.length < 2) {
    const at = stops[0]?.at ?? [0, 0]
    return { legs: [], length: 0, bounds: [[...at], [...at]] }
  }

  // Unwrap every point in travel order so the whole route is continuous in longitude.
  let prevLng = stops[0]!.at[0]
  const unwrap = (p: LngLat): LngLat => {
    prevLng = unwrapLng(prevLng, p[0])
    return [prevLng, p[1]]
  }
  let from = unwrap(stops[0]!.at)
  const legs: RouteLeg[] = []
  for (let i = 0; i < stops.length - 1; i++) {
    const spec = project.legs[i] ?? { mode: 'line' as const, via: [] }
    const via = spec.via.map(unwrap)
    const to = unwrap(stops[i + 1]!.at)
    legs.push(buildLeg(spec.mode, [from, ...via, to]))
    from = to
  }

  let length = 0
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  for (const leg of legs) {
    length += leg.length
    for (const [lng, lat] of leg.path) {
      west = Math.min(west, lng)
      east = Math.max(east, lng)
      south = Math.min(south, lat)
      north = Math.max(north, lat)
    }
  }
  return { legs, length, bounds: [[west, south], [east, north]] }
}

interface Located {
  legIndex: number
  /** Distance within the leg. */
  local: number
}

function locate(route: Route, distance: number): Located {
  const d = Math.min(Math.max(distance, 0), route.length)
  let start = 0
  for (let i = 0; i < route.legs.length; i++) {
    const end = start + route.legs[i]!.length
    if (d < end) return { legIndex: i, local: d - start }
    start = end
  }
  const legIndex = route.legs.length - 1
  return { legIndex, local: route.legs[legIndex]!.length }
}

/** Index of the segment of `leg` that holds `local`: the later one at a joint, the last one at the end. */
function segmentAt(leg: RouteLeg, local: number): number {
  let i = leg.cum.length - 2
  while (i > 0 && leg.cum[i]! > local) i--
  return i
}

function headingInLeg(leg: RouteLeg, local: number): number {
  const i = segmentAt(leg, local)
  return headingDeg(leg.xy[i]!, leg.xy[i + 1]!)
}

/** Heading of the nearest leg with length, looking back first. 0 when the whole route has none. */
function headingNear(route: Route, legIndex: number): number {
  for (let i = legIndex; i >= 0; i--) {
    const leg = route.legs[i]!
    if (leg.length > 0) return headingInLeg(leg, leg.length)
  }
  return 0
}

/** The head at `distance` along the whole route, clamped to `[0, route.length]`. */
export function pointAt(route: Route, distance: number): { at: LngLat; heading: number; legIndex: number } {
  if (route.legs.length === 0) return { at: [...route.bounds[0]], heading: 0, legIndex: 0 }
  const { legIndex, local } = locate(route, distance)
  const leg = route.legs[legIndex]!
  if (leg.length === 0) return { at: leg.path[0]!, heading: headingNear(route, legIndex), legIndex }
  const heading = headingInLeg(leg, local)
  if (local <= 0) return { at: leg.path[0]!, heading, legIndex }
  if (local >= leg.length) return { at: leg.path[leg.path.length - 1]!, heading, legIndex }
  const i = segmentAt(leg, local)
  const span = leg.cum[i + 1]! - leg.cum[i]!
  const at = toLngLat(lerp(leg.xy[i]!, leg.xy[i + 1]!, (local - leg.cum[i]!) / span))
  return { at, heading, legIndex }
}

/** The line drawn so far: every path point behind the head, then the head. Empty for a route with no legs. */
export function slicePath(route: Route, distance: number): LngLat[] {
  if (route.legs.length === 0) return []
  const { legIndex, local } = locate(route, distance)
  const head = pointAt(route, distance).at
  const out: LngLat[] = []
  const push = (p: LngLat) => {
    const prev = out[out.length - 1]
    if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) out.push(p)
  }
  for (let i = 0; i < legIndex; i++) route.legs[i]!.path.forEach(push)
  const leg = route.legs[legIndex]!
  leg.path.forEach((p, k) => {
    if (leg.cum[k]! < local) push(p)
  })
  push(head)
  return out
}
