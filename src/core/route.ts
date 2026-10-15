import { sampleChain } from './curve.js'
import { toLngLat, toXY, unwrapLng, headingDeg, type XY } from './geo.js'
import type { LegMode, LngLat, Scene, SymbolKind } from './schema.js'

export interface RouteLeg {
  mode: LegMode
  drawnAs: 'line'
  /** Unwrapped `[lng, lat]`, sampled from `xy`. The ends are exactly the unwrapped stop coordinates. */
  path: LngLat[]
  xy: XY[]
  /** Distance along this leg at each point: `cum[0] = 0`, `cum.at(-1) = length`. */
  cum: number[]
  length: number
  /**
   * Indices into `path` and `xy` of the start stop, each via point in order, and the end stop.
   * Always `via.length + 2` long; coincident points share an index.
   */
  knots: number[]
  /** The mode has no router yet, so the leg is drawn as a line. */
  notAvailable?: boolean
}

export interface Route {
  legs: RouteLeg[]
  length: number
  /** South-west and north-east corners of every path point, longitudes unwrapped. */
  bounds: [LngLat, LngLat]
}

const dist = (a: XY, b: XY) => Math.hypot(b[0] - a[0], b[1] - a[1])

function lerp(a: XY, b: XY, t: number): XY {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

/** A stop or via point, unwrapped. */
interface Control {
  at: LngLat
  sharp: boolean
}

/** Whether a leg's line may curve through its end stops into neighbouring legs. */
const curves = (mode: LegMode) => mode === 'line' || mode === 'land'

function makeLeg(mode: LegMode, xy: XY[], controls: Control[], knots: number[]): RouteLeg {
  const path = xy.map(toLngLat)
  // Stops and via points sit exactly on their own coordinates.
  knots.forEach((k, i) => (path[k] = controls[i]!.at))
  const cum = [0]
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1]! + dist(xy[i - 1]!, xy[i]!))
  const leg: RouteLeg = { mode, drawnAs: 'line', path, xy, cum, length: cum[cum.length - 1]!, knots }
  if (mode === 'sea' || mode === 'air') leg.notAvailable = true
  return leg
}

export function buildRoute(scene: Scene): Route {
  const { stops } = scene
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
  const specs = stops.slice(1).map((_, i) => scene.legs[i] ?? { mode: 'line' as const, via: [] })
  const stopAt: LngLat[] = [unwrap(stops[0]!.at)]
  const viaAt: Control[][] = []
  specs.forEach((spec, i) => {
    viaAt.push(spec.via.map((v) => ({ at: unwrap(v.at), sharp: v.sharp === true })))
    stopAt.push(unwrap(stops[i + 1]!.at))
  })

  // One curve runs through each chain of `line` and `land` legs. A sharp stop ends a
  // chain, and a sea or air leg is a chain on its own.
  const legs: RouteLeg[] = []
  for (let first = 0; first < specs.length; ) {
    let last = first
    while (
      curves(specs[last]!.mode) &&
      last + 1 < specs.length &&
      curves(specs[last + 1]!.mode) &&
      stops[last + 1]!.sharp !== true
    )
      last++
    const controls: Control[] = [{ at: stopAt[first]!, sharp: false }]
    const stopControl = [0]
    for (let i = first; i <= last; i++) {
      controls.push(...viaAt[i]!, { at: stopAt[i + 1]!, sharp: false })
      stopControl.push(controls.length - 1)
    }
    const chain = sampleChain(controls)
    for (let i = first; i <= last; i++) {
      const from = stopControl[i - first]!
      const to = stopControl[i - first + 1]!
      const legControls = controls.slice(from, to + 1)
      const lo = chain.at[from]!
      const hi = chain.at[to]!
      if (hi === lo) {
        // A zero-length leg still has a start and an end point.
        const p = chain.xy[lo]!
        const knots = legControls.map((_, j) => (j === legControls.length - 1 ? 1 : 0))
        legs.push(makeLeg(specs[i]!.mode, [p, p], legControls, knots))
      } else {
        const knots = chain.at.slice(from, to + 1).map((k) => k - lo)
        legs.push(makeLeg(specs[i]!.mode, chain.xy.slice(lo, hi + 1), legControls, knots))
      }
    }
    first = last + 1
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

/** `lng` shifted by whole turns into [-180, 180). */
function wrapLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180
}

/**
 * The point of leg `legIndex` nearest to `at`, whose longitude may be wrapped or not.
 * The returned `at` is wrapped to ±180. `insertIndex` is the `via` index a new point
 * there should take. `distance` is in Mercator units.
 */
export function nearestOnLeg(
  route: Route,
  legIndex: number,
  at: LngLat,
): { at: LngLat; insertIndex: number; distance: number } {
  const leg = route.legs[legIndex]
  if (!leg) throw new RangeError(`No leg ${legIndex}`)
  const q0 = toXY([unwrapLng(leg.path[0]![0], at[0]), at[1]])
  let best = { distance: Infinity, segment: 0, point: leg.xy[0]! }
  // A long leg can reach more than half a turn from its start, so try the next worlds too.
  for (const shift of [0, -1, 1]) {
    const q: XY = [q0[0] + shift, q0[1]]
    for (let i = 0; i < leg.xy.length - 1; i++) {
      const a = leg.xy[i]!
      const b = leg.xy[i + 1]!
      const dx = b[0] - a[0]
      const dy = b[1] - a[1]
      const len2 = dx * dx + dy * dy
      const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / len2))
      const point: XY = [a[0] + dx * t, a[1] + dy * t]
      const distance = dist(q, point)
      if (distance < best.distance) best = { distance, segment: i, point }
    }
  }
  const insertIndex = leg.knots.slice(1, -1).filter((k) => k <= best.segment).length
  const [lng, lat] = toLngLat(best.point)
  return { at: [wrapLng(lng), lat], insertIndex, distance: best.distance }
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

/** The symbol drawn on leg `legIndex`: its own, else the scene's `look.symbol`. */
export function effectiveSymbol(scene: Scene, legIndex: number): SymbolKind {
  return scene.legs[legIndex]?.symbol ?? scene.look.symbol
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
