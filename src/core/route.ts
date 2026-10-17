import { airPath } from './air.js'
import { dist, lerp, sampleChain, type Control } from './curve.js'
import { toLngLat, toXY, unwrapLng, headingDeg, type XY } from './geo.js'
import type { LegMode, LngLat, Scene, SymbolKind } from './schema.js'
import { seaLegKey, type SeaPath, type SeaPaths } from './sea.js'
import { cutTrack, trackKey } from './track.js'

export interface RouteLeg {
  mode: LegMode
  /**
   * `sea` follows a routed sea path, `air` is a flight arc, `track` follows a recorded track, and `line` is a plain
   * curve through the controls.
   */
  drawnAs: 'line' | 'sea' | 'air' | 'track'
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
  /**
   * On every sea leg. `pending` until its sea path has been routed; `fallback` when routing failed, with the
   * reason. Both are drawn as lines. `crossesLand` is where an `ok` path first crosses land; `unverified` and
   * `stopGapKm` are the path's own (see `SeaPath`).
   */
  sea?: {
    status: 'ok' | 'fallback' | 'pending'
    reason?: string
    crossesLand?: LngLat
    unverified?: SeaPath['unverified']
    stopGapKm?: SeaPath['stopGapKm']
  }
  /**
   * On every track leg. `missing` when `seaPaths` has no points for its track, and then it's drawn as a straight
   * line. `stopGapKm` is how far the start and end stops are from the track points the leg is cut at.
   */
  track?: {
    status: 'ok' | 'missing'
    id: string
    stopGapKm?: [number, number]
  }
}

export interface Route {
  legs: RouteLeg[]
  length: number
  /** South-west and north-east corners of every path point, longitudes unwrapped. */
  bounds: [LngLat, LngLat]
}

/** Whether a leg's line may curve through its end stops into neighbouring legs. */
const curves = (mode: LegMode) => mode === 'line' || mode === 'land'

function finishLeg(mode: LegMode, drawnAs: RouteLeg['drawnAs'], path: LngLat[], xy: XY[], knots: number[]): RouteLeg {
  const cum = [0]
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1]! + dist(xy[i - 1]!, xy[i]!))
  return { mode, drawnAs, path, xy, cum, length: cum[cum.length - 1]!, knots }
}

function makeLeg(mode: LegMode, xy: XY[], controls: Control[], knots: number[]): RouteLeg {
  const path = xy.map(toLngLat)
  // Stops and via points sit exactly on their own coordinates.
  knots.forEach((k, i) => (path[k] = controls[i]!.at))
  return finishLeg(mode, 'line', path, xy, knots)
}

/** `lng` shifted by whole turns to lie nearest `near`. */
const nearestTurn = (lng: number, near: number): number => lng + Math.round((near - lng) / 360) * 360

/**
 * The routed line of a scene. Line and land legs curve through their stops and via points. A sea leg follows its
 * path in `seaPaths`, keyed by `seaLegKey`, and is drawn as a line until it has one. An air leg is a flight arc. A
 * track leg follows its recorded track's points in `seaPaths`, keyed by `trackKey`, between the cuts `cutTrack`
 * finds, and is drawn as a straight line when they're missing.
 */
export function buildRoute(scene: Scene, seaPaths?: SeaPaths): Route {
  const { stops } = scene
  if (stops.length < 2) {
    const at = stops[0]?.at ?? [0, 0]
    return { legs: [], length: 0, bounds: [[...at], [...at]] }
  }

  // Unwrap every point in travel order so the whole route is continuous in longitude. Each chain
  // starts from where the previous leg actually ended.
  let prevLng = stops[0]!.at[0]
  const unwrap = (p: LngLat): LngLat => {
    prevLng = unwrapLng(prevLng, p[0])
    return [prevLng, p[1]]
  }
  const specs = stops.slice(1).map((_, i) => scene.legs[i] ?? { mode: 'line' as const, via: [] })
  let start: LngLat = unwrap(stops[0]!.at)

  // Where the last track leg ended on its track, so the next leg on the same track starts there.
  let cut: { leg: number; id: string; end: number } | undefined

  // One curve runs through each chain of `line` and `land` legs. A sharp stop ends a
  // chain, and a sea, air or track leg is a chain on its own.
  const legs: RouteLeg[] = []
  for (let first = 0; first < specs.length; ) {
    const spec = specs[first]!
    const leg =
      spec.mode === 'sea' ? seaLeg(first) : spec.mode === 'air' ? airLeg(first) : spec.mode === 'track' ? trackLeg(first) : undefined
    if (leg) {
      legs.push(leg)
      start = leg.path[leg.path.length - 1]!
      prevLng = start[0]
      first++
      continue
    }
    let last = first
    while (
      curves(specs[last]!.mode) &&
      last + 1 < specs.length &&
      curves(specs[last + 1]!.mode) &&
      stops[last + 1]!.sharp !== true
    )
      last++
    legs.push(...lineChain(first, last))
    start = legs[legs.length - 1]!.path.at(-1)!
    first = last + 1
  }

  /** Legs `first` to `last` as one curve from `start`. */
  function lineChain(first: number, last: number): RouteLeg[] {
    const controls: Control[] = [{ at: start, sharp: false }]
    const stopControl = [0]
    for (let i = first; i <= last; i++) {
      controls.push(...specs[i]!.via.map((v) => ({ at: unwrap(v.at), sharp: v.sharp === true })))
      controls.push({ at: unwrap(stops[i + 1]!.at), sharp: false })
      stopControl.push(controls.length - 1)
    }
    const chain = sampleChain(controls)
    const out: RouteLeg[] = []
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
        out.push(makeLeg(specs[i]!.mode, [p, p], legControls, knots))
      } else {
        const knots = chain.at.slice(from, to + 1).map((k) => k - lo)
        out.push(makeLeg(specs[i]!.mode, chain.xy.slice(lo, hi + 1), legControls, knots))
      }
    }
    return out
  }

  /** Leg `i` by sea: its cached path, or a line while it has none. */
  function seaLeg(i: number): RouteLeg {
    const { via } = specs[i]!
    const from = stops[i]!.at
    const to = stops[i + 1]!.at
    const cached = seaPaths?.[seaLegKey(from, to, via)]
    if (cached?.status !== 'ok') {
      const leg = lineChain(i, i)[0]!
      leg.sea = cached
        ? {
            status: 'fallback',
            ...(cached.reason !== undefined && { reason: cached.reason }),
            ...(cached.unverified && { unverified: cached.unverified }),
          }
        : { status: 'pending' }
      return leg
    }
    // Shift by whole turns onto the unwrapped start, then put each control exactly on its own coordinates.
    const shift = Math.round((start[0] - cached.path[0]![0]) / 360) * 360
    const path: LngLat[] = cached.path.map(([lng, lat]) => [lng + shift, lat])
    const controls = [from, ...via.map((v) => v.at), to]
    cached.knots.forEach((k, j) => {
      const c = controls[j]!
      path[k] = j === 0 ? start : [nearestTurn(c[0], path[k]![0]), c[1]]
    })
    const leg = finishLeg('sea', 'sea', path, path.map(toXY), [...cached.knots])
    leg.sea = {
      status: 'ok',
      ...(cached.crossesLand && { crossesLand: cached.crossesLand }),
      ...(cached.unverified && { unverified: cached.unverified }),
      ...(cached.stopGapKm && { stopGapKm: cached.stopGapKm }),
    }
    return leg
  }

  /** Leg `i` by air: an arc through its unwrapped controls. */
  function airLeg(i: number): RouteLeg {
    const controls = [start, ...specs[i]!.via.map((v) => unwrap(v.at)), unwrap(stops[i + 1]!.at)]
    const { path, knots } = airPath(controls)
    return finishLeg('air', 'air', path, path.map(toXY), knots)
  }

  /**
   * Leg `i` on its recorded track: the stops at its ends, and the points between its cuts, each unwrapped from the one
   * before. A straight line when the track's points are missing.
   */
  function trackLeg(i: number): RouteLeg {
    const id = specs[i]!.track ?? ''
    const entry = seaPaths?.[trackKey(id)]
    if (entry?.status !== 'ok' || entry.path.length === 0) {
      const leg = lineChain(i, i)[0]!
      leg.track = { status: 'missing', id }
      return leg
    }
    const points = entry.path
    const shared = cut && cut.leg === i - 1 && cut.id === id ? cut.end : undefined
    const { start: s, end: e, gapKm } = cutTrack(points, stops[i]!.at, stops[i + 1]!.at, shared)
    cut = { leg: i, id, end: e }
    const path: LngLat[] = [start]
    for (let k = s + 1; k < e; k++) path.push(unwrap(points[k]!))
    path.push(unwrap(stops[i + 1]!.at))
    const leg = finishLeg('track', 'track', path, path.map(toXY), [0, path.length - 1])
    leg.track = { status: 'ok', id, stopGapKm: gapKm }
    return leg
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
