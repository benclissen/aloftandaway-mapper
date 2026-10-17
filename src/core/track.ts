import { haversineKm, toXY, unwrapLng, type XY } from './geo.js'
import { parseIsoTime, simplify, type GpxLine } from './gpx.js'
import { MAX_LAT, type LngLat } from './schema.js'

/** A recorded GPS or AIS track, as read from a file. */
export interface RecordedTrack {
  name?: string
  points: LngLat[]
  /** Milliseconds since 1970 for each point, present only when every point has one. */
  times?: number[]
}

export class TrackError extends Error {
  readonly fix: string
  constructor(message: string, fix: string) {
    super(message)
    this.name = 'TrackError'
    this.fix = fix
  }
}

/** The most points a track keeps after thinning. */
export const MAX_TRACK_POINTS = 10_000
/** A stay is a run of points all within this distance of the run's first point. */
export const STAY_RADIUS_KM = 1
/** How close a track must come to a stop for a leg to be cut there. */
export const TRACK_NEAR_KM = 2

/** A stop takes the name of a waypoint this close to it, as in gpx.ts. */
const NAME_KM = 1
/** Douglas-Peucker starts at this tolerance. */
const THIN_KM = 0.01
/** Once round the equator, in the same units as `haversineKm`. */
const WORLD_KM = 2 * haversineKm([0, 0], [180, 0])
const NO_TIMES_FIX = "Pass stops: 'ends', or use a file with a time for every point."

// CSV

const LNG_NAMES = ['lng', 'lon', 'longitude']
const LAT_NAMES = ['lat', 'latitude']
const TIME_NAMES = ['time', 'timestamp']

/** The cells of one CSV line. Double quotes may wrap a cell, and `""` inside them is one quote. */
function cells(line: string): string[] {
  const out: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      out.push(cell.trim())
      cell = ''
    } else cell += c
  }
  out.push(cell.trim())
  return out
}

function numberOf(cell: string | undefined): number | undefined {
  // Number('') is 0, so a blank coordinate would land on the equator or the prime meridian.
  if (cell === undefined || cell === '') return undefined
  const n = Number(cell)
  return Number.isFinite(n) ? n : undefined
}

/** Unix seconds, or milliseconds above 1e11, or ISO 8601 with `Z` or an offset. */
function timeOf(cell: string | undefined): number | undefined {
  if (cell === undefined || cell === '') return undefined
  if (/^[+-]?\d+(\.\d+)?$/.test(cell)) {
    const n = Number(cell)
    const ms = Math.round(n > 1e11 ? n : n * 1000)
    // Beyond the range a Date holds, toISOString would throw.
    return Number.isNaN(new Date(ms).getTime()) ? undefined : ms
  }
  return parseIsoTime(cell)
}

/**
 * A CSV track. The first row names the columns, in any order and any case: `lng`, `lon` or `longitude`; `lat` or
 * `latitude`; and optionally `time` or `timestamp`. Rows with a missing or out-of-range coordinate are skipped and
 * counted. Times are kept only when every kept row has a readable one.
 */
export function parseTrackCsv(text: string): RecordedTrack & { skippedRows: number } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)
  const first = lines.findIndex((l) => l.trim() !== '')
  const header = first < 0 ? [] : cells(lines[first]!).map((c) => c.toLowerCase())
  const column = (names: string[]): number => header.findIndex((c) => names.includes(c))
  const lngAt = column(LNG_NAMES)
  const latAt = column(LAT_NAMES)
  const timeAt = column(TIME_NAMES)
  if (lngAt < 0 || latAt < 0) {
    throw new TrackError('This CSV has no lng and lat columns.', 'The first row must name the columns: lng, lat and optionally time.')
  }

  const points: LngLat[] = []
  const times: number[] = []
  let allTimed = timeAt >= 0
  let skippedRows = 0
  for (const line of lines.slice(first + 1)) {
    if (line.trim() === '') continue
    const row = cells(line)
    const lng = numberOf(row[lngAt])
    const lat = numberOf(row[latAt])
    if (lng === undefined || lat === undefined || Math.abs(lat) > MAX_LAT || Math.abs(lng) > 180) {
      skippedRows++
      continue
    }
    points.push([lng, lat])
    if (!allTimed) continue
    const time = timeOf(row[timeAt])
    if (time === undefined) allTimed = false
    else times.push(time)
  }
  return allTimed ? { points, times, skippedRows } : { points, skippedRows }
}

export function recordedFromGpx(line: GpxLine): RecordedTrack {
  const track: RecordedTrack = { points: line.points }
  if (line.name !== undefined) track.name = line.name
  if (line.times !== undefined) track.times = line.times
  return track
}

/** `track` with its points in time order. The sort is stable, so points logged at the same time keep their order. */
function byTime(track: RecordedTrack): RecordedTrack {
  const { times } = track
  if (!times || times.every((t, i) => i === 0 || times[i - 1]! <= t)) return track
  const order = times.map((_, i) => i).sort((a, b) => times[a]! - times[b]!)
  const sorted: RecordedTrack = { points: order.map((i) => track.points[i]!), times: order.map((i) => times[i]!) }
  if (track.name !== undefined) sorted.name = track.name
  return sorted
}

// Stays

export interface Stay {
  /** Index of the run's first point, in time order. */
  start: number
  /** Index of the run's last point, inclusive. */
  end: number
  /** The centre of the run's points. */
  at: LngLat
  arrive: number
  depart: number
}

/** `lng` brought back into [-180, 180). */
const wrapLng = (lng: number): number => ((((lng + 180) % 360) + 360) % 360) - 180

/** Mean of `points`, taking the short way round 180°. */
function centroid(points: LngLat[]): LngLat {
  const ref = points[0]![0]
  let lng = 0
  let lat = 0
  for (const p of points) {
    lng += unwrapLng(ref, p[0])
    lat += p[1]
  }
  return [wrapLng(lng / points.length), lat / points.length]
}

/** The centre of `a`'s `na` points and `b`'s `nb` points together. */
function joinCentres(a: LngLat, na: number, b: LngLat, nb: number): LngLat {
  const lng = (a[0] * na + unwrapLng(a[0], b[0]) * nb) / (na + nb)
  return [wrapLng(lng), (a[1] * na + b[1] * nb) / (na + nb)]
}

/**
 * Where the track stood still: each maximal run of consecutive points, in time order, all within `STAY_RADIUS_KM` of
 * the run's first point and spanning at least `minStayMs`. Greedy from the left: a run that's long enough is a stay and
 * the search goes on after it; one that isn't moves the start on one point. `start` and `end` index the time-sorted
 * points.
 *
 * A run can start on a point still coming in, near the edge of the circle, and then end early when a point on the far
 * side of the stay leaves it. The rest of the stay is then a second run straight after. So a stay that follows another
 * with no point between and has its centre within `STAY_RADIUS_KM` of the other's joins it.
 *
 * Speed: a stay's points are scanned once and consumed. A start that fails is scanned only until a point leaves the
 * radius, so the cost is n times the points logged while crossing 1 km, about a dozen for a ship logging every 10 s.
 * Each distance test is a flat-earth sum of squares on typed arrays, exact to well under 1% at 1 km; only a pair within
 * 2% of the radius falls back to `haversineKm`.
 */
export function findStays(track: RecordedTrack, minStayMs: number): Stay[] {
  const { points, times } = byTime(track)
  if (!times) throw new TrackError("Stays need a time on every point, and this track doesn't have one on each.", NO_TIMES_FIX)
  const n = points.length
  const rad = Math.PI / 180
  const lng = new Float64Array(n)
  const lat = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    lng[i] = points[i]![0] * rad
    lat[i] = points[i]![1] * rad
  }
  const r2 = (STAY_RADIUS_KM / (WORLD_KM / (2 * Math.PI))) ** 2
  const near = (i: number, j: number, cosI: number): boolean => {
    let dl = lng[j]! - lng[i]!
    if (dl > Math.PI) dl -= 2 * Math.PI
    else if (dl < -Math.PI) dl += 2 * Math.PI
    const dx = dl * cosI
    const dy = lat[j]! - lat[i]!
    const d2 = dx * dx + dy * dy
    if (d2 < 0.98 * r2) return true
    if (d2 > 1.02 * r2) return false
    return haversineKm(points[i]!, points[j]!) <= STAY_RADIUS_KM
  }

  const stays: Stay[] = []
  let i = 0
  while (i < n) {
    const cosI = Math.cos(lat[i]!)
    let j = i
    while (j + 1 < n && near(i, j + 1, cosI)) j++
    if (j > i && times[j]! - times[i]! >= minStayMs) {
      const at = centroid(points.slice(i, j + 1))
      const prev = stays[stays.length - 1]
      if (prev && prev.end === i - 1 && haversineKm(prev.at, at) <= STAY_RADIUS_KM) {
        prev.at = joinCentres(prev.at, i - prev.start, at, j + 1 - i)
        prev.end = j
        prev.depart = times[j]!
      } else stays.push({ start: i, end: j, at, arrive: times[i]!, depart: times[j]! })
      i = j + 1
    } else i++
  }
  return stays
}

// Thinning

/**
 * `points` thinned by Douglas-Peucker in Mercator, with every index in `keep`, the first and the last always kept. The
 * tolerance starts at 10 m on the ground at the mean latitude and doubles until at most `max` points remain, or only
 * the kept ones do. Longitudes are unwrapped first, so a track across 180° thins as one line.
 */
export function thinTrack(points: LngLat[], keep: ReadonlySet<number>, max: number = MAX_TRACK_POINTS): LngLat[] {
  const n = points.length
  if (n <= 2) return points.slice()
  const anchors = [...new Set([0, n - 1, ...[...keep].filter((i) => Number.isInteger(i) && i >= 0 && i < n)])].sort((a, b) => a - b)
  const xy: XY[] = []
  let prev = points[0]![0]
  let latSum = 0
  for (const p of points) {
    prev = unwrapLng(prev, p[0])
    xy.push(toXY([prev, p[1]]))
    latSum += p[1]
  }
  // One Mercator world unit is WORLD_KM × cos(latitude) on the ground.
  let tolerance = THIN_KM / (WORLD_KM * Math.cos(((latSum / n) * Math.PI) / 180))
  for (;;) {
    const kept: number[] = [0]
    for (let a = 0; a < anchors.length - 1; a++) {
      const lo = anchors[a]!
      const part = simplify(xy.slice(lo, anchors[a + 1]! + 1), tolerance)
      for (let k = 1; k < part.length; k++) kept.push(lo + part[k]!)
    }
    if (kept.length <= max || kept.length === anchors.length) return kept.map((i) => points[i]!)
    tolerance *= 2
  }
}

// Stops

export interface TrackImport {
  stops: { name: string; at: LngLat; arrive?: string; depart?: string }[]
  /** The thinned points, each stay collapsed to its centre. */
  points: LngLat[]
  /** How many points were read. */
  recorded: number
  /** How many stays were found, 0 in `ends` mode. */
  stays: number
}

type TrackStop = TrackImport['stops'][number]

/**
 * Stops and a thinned line from a recorded track. `stays` puts a stop at each stay of `minStayMinutes` or more, plus
 * the first and last points when no stay covers them; `ends` uses only the first and last points. A stop near one of
 * `waypoints` takes its name. Points are put in time order first when every one has a time.
 */
export function trackToStops(
  track: RecordedTrack,
  opts: { stops: 'stays' | 'ends'; minStayMinutes: number; waypoints?: { name: string; at: LngLat }[] },
): TrackImport {
  const recorded = track.points.length
  if (recorded < 2) {
    throw new TrackError(
      `This track has ${recorded} point${recorded === 1 ? '' : 's'} with a valid position, and a route needs at least 2.`,
      'Choose a file with at least two points that have a longitude and latitude.',
    )
  }
  const sorted = byTime(track)
  const { points, times } = sorted
  const n = points.length
  const nameNear = (at: LngLat): string | undefined => {
    let best: { name: string; km: number } | undefined
    for (const w of opts.waypoints ?? []) {
      const km = haversineKm(w.at, at)
      if (km <= NAME_KM && (!best || km < best.km)) best = { name: w.name, km }
    }
    return best?.name
  }

  if (opts.stops === 'ends') {
    const label = track.name ?? 'Track'
    const first = points[0]!
    const last = points[n - 1]!
    return {
      stops: [
        { name: nameNear(first) ?? `${label} start`, at: first, ...(times ? { depart: new Date(times[0]!).toISOString() } : {}) },
        { name: nameNear(last) ?? `${label} end`, at: last, ...(times ? { arrive: new Date(times[n - 1]!).toISOString() } : {}) },
      ],
      points: thinTrack(points, new Set([0, n - 1])),
      recorded,
      stays: 0,
    }
  }

  if (!times) throw new TrackError("Stays need a time on every point, and this track doesn't have one on each.", NO_TIMES_FIX)
  const stays = findStays(sorted, opts.minStayMinutes * 60_000)
  // Collapse each stay to its centre, noting where each centre lands in the shorter list.
  const collapsed: LngLat[] = []
  const keep = new Set<number>()
  const iso = (ms: number): string => new Date(ms).toISOString()
  const found: Omit<TrackStop, 'name'>[] = []
  if (stays[0]?.start !== 0) found.push({ at: points[0]!, depart: iso(times[0]!) })
  let i = 0
  for (const s of stays) {
    while (i < s.start) collapsed.push(points[i++]!)
    keep.add(collapsed.length)
    collapsed.push(s.at)
    found.push({ at: s.at, arrive: iso(s.arrive), depart: iso(s.depart) })
    i = s.end + 1
  }
  while (i < n) collapsed.push(points[i++]!)
  if (stays[stays.length - 1]?.end !== n - 1) found.push({ at: points[n - 1]!, arrive: iso(times[n - 1]!) })
  if (found.length < 2) {
    throw new TrackError(
      'The whole track is one stay, so it gives only one stop.',
      "Pass stops: 'ends' to use the first and last points.",
    )
  }

  const stops = found.map((f, k): TrackStop => ({ name: nameNear(f.at) ?? `Stop ${k + 1}`, ...f }))
  return { stops, points: thinTrack(collapsed, keep), recorded, stays: stays.length }
}
