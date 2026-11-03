import { haversineKm, toXY, unwrapLng } from './geo.js'
import { simplify } from './gpx.js'
import type { LegMode, LngLat, Project, SymbolKind, ViaPoint } from './schema.js'
import { fnv1a64, type SeaPath } from './sea.js'
import { kmPerUnit } from './water.js'

/** How a road leg travels, as the road router's profile names it. */
export type RoadProfile = 'car' | 'bike' | 'foot'

/**
 * Bump whenever building a path from the router's answer, or its parameters, change. The version is in every road
 * leg's cache key, so bumping it routes every road leg again.
 */
export const ROAD_VERSION = 1
/** Road detail smaller than this many metres is simplified away. */
export const ROAD_SIMPLIFY_M = 3
/** A stop farther than this many km from the road its route starts or ends on has a long straight join to reach it. */
export const ROAD_STOP_FAR_KM = 0.5
/** Why a road leg fell back when the router couldn't be asked. */
export const ROAD_OFFLINE = "the road router couldn't be reached"
/** Why a road leg fell back when the router found no way between its stops. */
export const NO_ROAD_ROUTE = 'there is no road route between its stops'

/** Symbols that travel on rails or cables, which no road profile fits. */
const OFF_ROAD: ReadonlySet<SymbolKind> = new Set(['train', 'tram', 'cable-car'])

/** The road profile a symbol travels by: on foot, by bike, by car, or none for rail and cable. */
export function roadProfile(symbol: SymbolKind): RoadProfile | undefined {
  if (symbol === 'walk') return 'foot'
  if (symbol === 'bike') return 'bike'
  return OFF_ROAD.has(symbol) ? undefined : 'car'
}

/** The road profile of a leg: only `land` legs follow roads, by the leg's own symbol or else the look's. */
export function legProfile(
  leg: { mode: LegMode; symbol?: SymbolKind },
  look: { symbol: SymbolKind },
): RoadProfile | undefined {
  return leg.mode === 'land' ? roadProfile(leg.symbol ?? look.symbol) : undefined
}

/**
 * A cache key for one road leg: `road:` and 16 hex characters of FNV-1a 64 over its inputs. `sharp` is left out,
 * because it does nothing on a road leg.
 */
export function roadLegKey(profile: RoadProfile, from: LngLat, to: LngLat, via: ViaPoint[]): string {
  return `road:${fnv1a64(JSON.stringify([ROAD_VERSION, profile, from, to, via.map((v) => v.at)]))}`
}

/** What the road router is asked for one road leg. */
export interface RoadLeg {
  profile: RoadProfile
  from: LngLat
  to: LngLat
  via: LngLat[]
}

/** Every road leg in the project's scenes and their contexts, keyed by `roadLegKey`. Context legs use the scene's look. */
export function roadLegsOf(project: Project): Map<string, RoadLeg> {
  const legs = new Map<string, RoadLeg>()
  const add = (
    stops: { at: LngLat }[],
    list: { mode: LegMode; symbol?: SymbolKind; via: ViaPoint[] }[],
    look: { symbol: SymbolKind },
  ): void => {
    list.forEach((leg, i) => {
      const from = stops[i]
      const to = stops[i + 1]
      const profile = legProfile(leg, look)
      if (!profile || !from || !to) return
      legs.set(roadLegKey(profile, from.at, to.at, leg.via), {
        profile,
        from: from.at,
        to: to.at,
        via: leg.via.map((v) => v.at),
      })
    })
  }
  for (const scene of project.scenes) {
    add(scene.stops, scene.legs, scene.look)
    if (scene.context) add(scene.context.stops, scene.context.legs, scene.look)
  }
  return legs
}

/** The parts of an OSRM `route` answer that Mapper reads. */
export interface OsrmAnswer {
  code: string
  routes?: { geometry: { coordinates: LngLat[] } }[]
  /** Where the router matched each requested point, in request order: the start, each via, the end. */
  waypoints?: { location: LngLat }[]
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6

/**
 * The path of a road leg from the router's answer. It runs straight from `from` to the start of the road, along
 * the road, and straight from its end to `to`, unwrapped from `from`'s longitude. `knots` index `from`, the road
 * point matched to each via point, and `to`. The road is simplified at `ROAD_SIMPLIFY_M` between knots and joins,
 * which all stay. Points other than knots are rounded to 1e-6°.
 */
export function roadPath(answer: OsrmAnswer, from: LngLat, to: LngLat, via: LngLat[]): SeaPath {
  const line = answer.routes?.[0]?.geometry.coordinates ?? []

  // 1. The stops and the road in one unwrapped list, without repeated points.
  let prevLng = from[0]
  const points: LngLat[] = [from]
  const add = ([lng, lat]: LngLat): void => {
    prevLng = unwrapLng(prevLng, lng)
    const last = points[points.length - 1]!
    if (last[0] !== prevLng || last[1] !== lat) points.push([prevLng, lat])
  }
  // The joins: where the road starts and ends in `points`. A road point on a stop is the stop itself.
  const joins = [0, 0]
  line.forEach((p, i) => {
    add(p)
    if (i === 0) joins[0] = points.length - 1
  })
  joins[1] = points.length - 1
  add(to)
  // A leg that goes nowhere still has a start and an end.
  if (points.length === 1) points.push([prevLng, to[1]])
  const last = points.length - 1

  // 2. Each via's knot: the nearest point after the knot before it, leaving room for the vias after it. A path too
  // short to give each via its own point gives it the knot before it.
  const targets =
    answer.waypoints?.length === via.length + 2 ? answer.waypoints.slice(1, -1).map((w) => w.location) : via
  const knots = [0]
  targets.forEach((target, j) => {
    const prev = knots[knots.length - 1]!
    const hi = last - 1 - (targets.length - 1 - j)
    let best = prev
    let bestKm = Infinity
    for (let i = prev + 1; i <= hi; i++) {
      const km = haversineKm(points[i]!, target)
      if (km < bestKm) {
        bestKm = km
        best = i
      }
    }
    knots.push(best)
  })
  knots.push(last)

  // 3. Simplify each stretch between knots and joins on its own, so they all stay.
  const xy = points.map(toXY)
  const tolerance = ROAD_SIMPLIFY_M / (kmPerUnit(xy[0]![1]) * 1000)
  const breaks = [...new Set([...knots, ...joins])].sort((a, b) => a - b)
  const keep = new Set(breaks)
  for (let b = 1; b < breaks.length; b++) {
    const lo = breaks[b - 1]!
    const hi = breaks[b]!
    if (hi - lo < 2) continue
    for (const i of simplify(xy.slice(lo, hi + 1), tolerance)) keep.add(lo + i)
  }

  // 4. The kept points, knots exact and the rest rounded.
  const isKnot = new Set(knots)
  const index = new Map<number, number>()
  const path: LngLat[] = []
  for (let i = 0; i <= last; i++) {
    if (!keep.has(i)) continue
    index.set(i, path.length)
    const p = points[i]!
    path.push(isKnot.has(i) ? p : [round6(p[0]), round6(p[1])])
  }

  const stopGapKm: [number, number] =
    line.length > 0 ? [haversineKm(from, line[0]!), haversineKm(to, line[line.length - 1]!)] : [0, 0]
  return { status: 'ok', path, knots: knots.map((k) => index.get(k)!), stopGapKm }
}
