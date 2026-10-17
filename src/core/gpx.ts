import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { haversineKm, toXY, type XY } from './geo.js'
import { setStops } from './patch.js'
import { resolveScene, type SceneRef } from './scenes.js'
import { MAX_LAT, parseProject, type InputLegMode, type LngLat, type Project, type SymbolKind, type ViaPoint } from './schema.js'

export interface GpxLine {
  kind: 'track' | 'route'
  name?: string
  points: LngLat[]
}

export interface Gpx {
  lines: GpxLine[]
  waypoints: { name: string; at: LngLat }[]
}

export class GpxError extends Error {
  readonly fix: string
  constructor(message: string, fix: string) {
    super(message)
    this.name = 'GpxError'
    this.fix = fix
  }
}

const MAX_VIA = 100
const KEEP_KM = 2
const NAME_KM = 1

// Parsing

type Node = Record<string, unknown>

const parser = new XMLParser({
  // Entity handling stays off (no DTD or custom entities); textOf decodes the predefined and numeric references.
  processEntities: false,
  cdataPropName: '#cdata',
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => ['trk', 'trkseg', 'trkpt', 'rte', 'rtept', 'wpt'].includes(name),
})

const asNodes = (v: unknown): Node[] => (Array.isArray(v) ? v.filter((x): x is Node => typeof x === 'object' && x !== null) : [])

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

/** `text` with XML's predefined entities and numeric character references decoded. Others are left as written. */
function decodeRefs(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/g, (ref, name: string) => {
    if (!name.startsWith('#')) return NAMED[name]!
    const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
    const valid = code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
    return valid ? String.fromCodePoint(code) : ref
  })
}

function textOf(v: unknown): string | undefined {
  let raw: string
  if (typeof v === 'string') raw = decodeRefs(v)
  else if (typeof v === 'object' && v !== null) {
    const node = v as Node
    const text = node['#text']
    const cdata = node['#cdata']
    const parts = (x: unknown): string[] => (Array.isArray(x) ? x : x === undefined ? [] : [x]).map(String)
    raw = parts(text).map(decodeRefs).join('') + parts(cdata).join('')
  } else return undefined
  const t = raw.trim()
  return t === '' ? undefined : t
}

function pointOf(node: Node): LngLat | undefined {
  const rawLat = node['@_lat']
  const rawLon = node['@_lon']
  // Number('') is 0, so a blank coordinate would land on the equator or the prime meridian.
  if (typeof rawLat !== 'string' || typeof rawLon !== 'string' || rawLat.trim() === '' || rawLon.trim() === '') return undefined
  const lat = Number(rawLat)
  const lon = Number(rawLon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > MAX_LAT || Math.abs(lon) > 180) return undefined
  return [lon, lat]
}

function pointsOf(nodes: Node[]): LngLat[] {
  return nodes.map(pointOf).filter((p): p is LngLat => p !== undefined)
}

export function parseGpx(text: string): Gpx {
  const notGpx = new GpxError("This isn't a GPX file.", 'Choose a .gpx file exported from a GPS app or route planner.')
  if (XMLValidator.validate(text) !== true) throw notGpx
  let doc: Node
  try {
    doc = parser.parse(text) as Node
  } catch {
    throw notGpx
  }
  const root = doc['gpx']
  if (typeof root !== 'object' || root === null) throw notGpx
  const gpx = root as Node

  const lines: GpxLine[] = []
  for (const trk of asNodes(gpx['trk'])) {
    const points = asNodes(trk['trkseg']).flatMap((seg) => pointsOf(asNodes(seg['trkpt'])))
    if (points.length >= 2) lines.push({ kind: 'track', name: textOf(trk['name']), points })
  }
  for (const rte of asNodes(gpx['rte'])) {
    const points = pointsOf(asNodes(rte['rtept']))
    if (points.length >= 2) lines.push({ kind: 'route', name: textOf(rte['name']), points })
  }
  const waypoints: Gpx['waypoints'] = []
  for (const wpt of asNodes(gpx['wpt'])) {
    const name = textOf(wpt['name'])
    const at = pointOf(wpt)
    if (name && at) waypoints.push({ name, at })
  }
  return { lines: lines.map((l) => (l.name === undefined ? { kind: l.kind, points: l.points } : l)), waypoints }
}

// Geometry

/** Nearest point on the polyline to `p`: km away, km along the line, and the segment it falls on. */
function project(points: LngLat[], cum: number[], p: LngLat): { km: number; along: number; seg: number } {
  const [px, py] = toXY(p)
  let best = { d2: Infinity, seg: 0, t: 0 }
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, ay] = toXY(points[i]!)
    const [bx, by] = toXY(points[i + 1]!)
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2))
    const d2 = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2
    if (d2 < best.d2) best = { d2, seg: i, t }
  }
  const a = points[best.seg]!
  const b = points[best.seg + 1]!
  const foot: LngLat = [a[0] + (b[0] - a[0]) * best.t, a[1] + (b[1] - a[1]) * best.t]
  return {
    km: haversineKm(p, foot),
    along: cum[best.seg]! + haversineKm(a, b) * best.t,
    seg: best.seg,
  }
}

function distToSegment(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

/** Douglas-Peucker. Returns the indices kept, ends included. */
function simplify(xy: XY[], tolerance: number): number[] {
  const keep = new Uint8Array(xy.length)
  keep[0] = 1
  keep[xy.length - 1] = 1
  const stack: [number, number][] = [[0, xy.length - 1]]
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!
    let far = -1
    let farD = tolerance
    for (let i = lo + 1; i < hi; i++) {
      const d = distToSegment(xy[i]!, xy[lo]!, xy[hi]!)
      if (d > farD) {
        farD = d
        far = i
      }
    }
    if (far >= 0) {
      keep[far] = 1
      stack.push([lo, far], [far, hi])
    }
  }
  return xy.flatMap((_, i) => (keep[i] ? [i] : []))
}

/** Via points for the stretch `stretch`, ends excluded, at most `MAX_VIA`. */
function viaFor(stretch: LngLat[]): ViaPoint[] {
  if (stretch.length <= 2) return []
  const xy = stretch.map(toXY)
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const [x, y] of xy) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const size = Math.max(maxX - minX, maxY - minY, 1e-12)
  let tolerance = 0.002 * size
  for (;;) {
    const kept = simplify(xy, tolerance)
    if (kept.length - 2 <= MAX_VIA) return kept.slice(1, -1).map((i) => ({ at: stretch[i]! }))
    tolerance *= 2
  }
}

// Conversion

export interface GpxImport {
  stops: { name: string; at: LngLat }[]
  via: ViaPoint[][]
  line?: { kind: 'track' | 'route'; name?: string }
  skipped: { name: string; km: number }[]
}

function chooseLine(gpx: Gpx, track: number | string | undefined): GpxLine | undefined {
  if (gpx.lines.length === 0) return undefined
  if (track === undefined) return gpx.lines[0]
  const found = typeof track === 'number' ? gpx.lines[track - 1] : (gpx.lines.find((l) => l.name === track) ?? gpx.lines.find((l) => l.name?.toLowerCase() === track.toLowerCase()))
  if (found) return found
  const names = gpx.lines.map((l, i) => `${i + 1}. ${l.name ?? `(unnamed ${l.kind})`}`).join(', ')
  const count = gpx.lines.length
  throw new GpxError(
    `No track '${track}' in this GPX file. It has ${count} ${count === 1 ? 'track or route' : 'tracks and routes'}: ${names}.`,
    `Pass a number from 1 to ${count}, or one of the names.`,
  )
}

export function gpxToStops(gpx: Gpx, opts: { track?: number | string; stops?: 'waypoints' | 'ends' }): GpxImport {
  const line = chooseLine(gpx, opts.track)
  const mode = opts.stops ?? 'ends'

  if (!line) {
    if (mode === 'ends') throw new GpxError('This GPX file has no track or route.', "Pass stops: 'waypoints', or choose a file with a track.")
    return waypointsOnly(gpx)
  }

  const info = line.name === undefined ? { kind: line.kind } : { kind: line.kind, name: line.name }
  const points = line.points
  const cum = [0]
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1]! + haversineKm(points[i - 1]!, points[i]!))

  if (mode === 'ends') {
    const first = points[0]!
    const last = points[points.length - 1]!
    const label = line.name ?? 'Track'
    const near = (p: LngLat): string | undefined =>
      gpx.waypoints.map((w) => ({ w, d: haversineKm(w.at, p) })).filter((x) => x.d <= NAME_KM).sort((a, b) => a.d - b.d)[0]?.w.name
    return {
      stops: [
        { name: near(first) ?? `${label} start`, at: first },
        { name: near(last) ?? `${label} end`, at: last },
      ],
      via: [viaFor(points)],
      line: info,
      skipped: [],
    }
  }

  const kept: { name: string; at: LngLat; along: number; seg: number }[] = []
  const skipped: GpxImport['skipped'] = []
  for (const w of gpx.waypoints) {
    const hit = project(points, cum, w.at)
    if (hit.km <= KEEP_KM) kept.push({ name: w.name, at: w.at, along: hit.along, seg: hit.seg })
    else skipped.push({ name: w.name, km: Math.round(hit.km * 10) / 10 })
  }
  if (kept.length < 2) {
    throw new GpxError(
      `Only ${kept.length} named waypoint${kept.length === 1 ? '' : 's'} lie within ${KEEP_KM} km of the track, and a route needs at least 2.`,
      "Use stops: 'ends', or add named waypoints along the track.",
    )
  }
  kept.sort((a, b) => a.along - b.along)
  const via = kept.slice(1).map((next, i) => {
    const prev = kept[i]!
    return viaFor([prev.at, ...points.slice(prev.seg + 1, next.seg + 1), next.at])
  })
  return { stops: kept.map((k) => ({ name: k.name, at: k.at })), via, line: info, skipped }
}

function waypointsOnly(gpx: Gpx): GpxImport {
  if (gpx.waypoints.length < 2) {
    throw new GpxError(
      `This GPX file has ${gpx.waypoints.length} named waypoint${gpx.waypoints.length === 1 ? '' : 's'} and no track, and a route needs at least 2.`,
      'Choose a file with a track or with at least two named waypoints.',
    )
  }
  const stops = gpx.waypoints.map((w) => ({ name: w.name, at: w.at }))
  return { stops, via: stops.slice(1).map(() => []), skipped: [] }
}

/**
 * Replaces the chosen scene's stops (the first by default) with the imported ones and puts the simplified line on each
 * leg as via points. The other scenes are untouched.
 */
export function importGpx(
  project: Project,
  imported: GpxImport,
  opts: { scene?: SceneRef; legMode?: InputLegMode; symbol?: SymbolKind },
): Project {
  const legMode = opts.legMode ?? 'line'
  const last = imported.stops.length - 1
  const next = setStops(project, {
    scene: opts.scene,
    stops: imported.stops.map((s, i) => (i < last ? { ...s, legMode, ...(opts.symbol ? { symbol: opts.symbol } : {}) } : { ...s })),
    legMode,
    replace: true,
  })
  const { scene, index } = resolveScene(next, opts.scene)
  const legs = scene.legs.map((leg, i) => ({ ...leg, via: imported.via[i] ?? [] }))
  return parseProject({ ...next, scenes: next.scenes.map((s, i) => (i === index ? { ...scene, legs } : s)) })
}
