import { haversineKm, toLngLat, toXY, unwrapLng, type XY } from './geo.js'
import { NAME_KM, parseIsoTime, simplify, type GpxLine } from './gpx.js'
import { MAX_LAT, type LngLat } from './schema.js'

/** A recorded GPS or AIS track, as read from a file. */
export interface RecordedTrack {
  name?: string
  points: LngLat[]
  /** Milliseconds since 1970 for each point, present only when every point has one. */
  times?: number[]
  /** How many points had a time that couldn't be read, such as one with no zone. Explains missing `times`. */
  badTimes?: number
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
/**
 * Stops closer than this are at the same place: validation warns about two in a row, unless a recorded track runs
 * between them. A leg that leaves its track this close to its end stop hasn't left yet.
 */
export const SAME_PLACE_KM = 0.5

/** Douglas-Peucker starts at this tolerance. */
const THIN_KM = 0.01
/** Thinning keeps a point at least every this many degrees of longitude, so no stored edge loses its way round. */
const WIND_DEG = 90
/** Once round the equator, in the same units as `haversineKm`. */
const WORLD_KM = 2 * haversineKm([0, 0], [180, 0])

/** Why stays can't be found in `track`: times that are missing, or times that couldn't be read. */
function noTimes(track: RecordedTrack): TrackError {
  const bad = track.badTimes ?? 0
  if (bad > 0) {
    return new TrackError(
      `${bad} of the track's times can't be read, so stays can't be found.`,
      "Write every time in ISO 8601 with a Z or an offset, such as 2026-06-01T06:00:00Z, or as Unix seconds. Or pass stops: 'ends'.",
    )
  }
  return new TrackError(
    "Stays need a time on every point, and this track doesn't have one on each.",
    "Pass stops: 'ends', or use a file with a time for every point.",
  )
}

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
 * counted. Times are kept only when every kept row has a readable one; `badTimes` counts the kept rows whose time is
 * there but can't be read, such as one with no zone.
 */
export function parseTrackCsv(text: string): RecordedTrack & { skippedRows: number; badTimes: number } {
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
  let missingTimes = 0
  let badTimes = 0
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
    if (timeAt < 0) continue
    const cell = row[timeAt]
    const time = timeOf(cell)
    if (time !== undefined) times.push(time)
    else if (cell === undefined || cell === '') missingTimes++
    else badTimes++
  }
  const allTimed = timeAt >= 0 && missingTimes === 0 && badTimes === 0
  return allTimed ? { points, times, skippedRows, badTimes } : { points, skippedRows, badTimes }
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
  return { ...track, points: order.map((i) => track.points[i]!), times: order.map((i) => times[i]!) }
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

/** The centre of `a`'s `na` points and `b`'s `nb` points together. */
function joinCentres(a: LngLat, na: number, b: LngLat, nb: number): LngLat {
  const lng = (a[0] * na + unwrapLng(a[0], b[0]) * nb) / (na + nb)
  return [wrapLng(lng), (a[1] * na + b[1] * nb) / (na + nb)]
}

/**
 * A deque of indices whose values only rise from front to back, for the least value in a sliding window. Give it
 * `value(j)` negated for the greatest.
 */
class WindowMin {
  private readonly at: Int32Array
  private head = 0
  private tail = 0
  constructor(
    size: number,
    private readonly value: (j: number) => number,
  ) {
    this.at = new Int32Array(size)
  }
  push(j: number): void {
    const v = this.value(j)
    while (this.tail > this.head && this.value(this.at[this.tail - 1]!) >= v) this.tail--
    this.at[this.tail++] = j
  }
  /** Drops the indices at or before `i`. */
  dropTo(i: number): void {
    while (this.tail > this.head && this.at[this.head]! <= i) this.head++
  }
  least(): number {
    return this.value(this.at[this.head]!)
  }
}

/**
 * Where the track stood still: each maximal run of consecutive points, in time order, all within `STAY_RADIUS_KM` of
 * the run's first point and spanning at least `minStayMs`. Greedy from the left: a run that's long enough is a stay and
 * the search goes on after it; one that isn't moves the start on one point. `start` and `end` index the time-sorted
 * points.
 *
 * A run can start on a point still coming in, near the edge of the circle, and then end early when a point on the far
 * side of the stay leaves it, before the stay is over. So once a run is a stay, it goes on taking points while each is
 * within `STAY_RADIUS_KM` of the stay's centre so far. And a stay that follows another with no point between, and has
 * its centre within `STAY_RADIUS_KM` of the other's, joins it.
 *
 * Speed: a start is a stay exactly when every point from it up to the first one `minStayMs` later (its window) is
 * within the radius, so only that window is looked at, never the points beyond. The search ends when less than
 * `minStayMs` of log is left. The windows slide forward with the start, and four deques keep the box round each one's
 * points, so each start costs O(1) when its box settles it: inside the circle, it's a stay; reaching beyond the radius
 * north, south, east or west, a point in it is outside. Only a window whose box straddles the circle's edge is checked
 * point by point, and the outside point found is tried first on the next start. A stay's points are scanned once and
 * consumed, and its centre is kept as running sums. So a log costs O(points), a dense stop shorter than `minStayMs`
 * included. Only a window that fills the box but not the circle for most of `minStayMs`, at each of many starts in a
 * row, costs as much as its own points. Each test is a flat-earth sum of squares on typed arrays, exact to well under
 * 1% at 1 km; only a pair within 2% of the radius falls back to `haversineKm`, and the boxes keep that 2% margin, so
 * they decide just as the tests would.
 */
export function findStays(track: RecordedTrack, minStayMs: number): Stay[] {
  const { points, times } = byTime(track)
  if (!times) throw noTimes(track)
  const n = points.length
  const rad = Math.PI / 180
  const lng = new Float64Array(n)
  const lat = new Float64Array(n)
  // Longitudes unwrapped along the track, for the boxes.
  const unwrapped = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    lng[i] = points[i]![0] * rad
    lat[i] = points[i]![1] * rad
    if (i === 0) unwrapped[i] = lng[i]!
    else {
      let dl = lng[i]! - lng[i - 1]!
      if (dl > Math.PI) dl -= 2 * Math.PI
      else if (dl < -Math.PI) dl += 2 * Math.PI
      unwrapped[i] = unwrapped[i - 1]! + dl
    }
  }
  const r2 = (STAY_RADIUS_KM / (WORLD_KM / (2 * Math.PI))) ** 2
  /** Whether point `j` is within the radius of the place at `lngA`, `latA` (radians, `cosA` its cosine). */
  const near = (lngA: number, latA: number, cosA: number, j: number): boolean => {
    let dl = lng[j]! - lngA
    if (dl > Math.PI) dl -= 2 * Math.PI
    else if (dl < -Math.PI) dl += 2 * Math.PI
    const dx = dl * cosA
    const dy = lat[j]! - latA
    const d2 = dx * dx + dy * dy
    if (d2 < 0.98 * r2) return true
    if (d2 > 1.02 * r2) return false
    return haversineKm([(lngA * 180) / Math.PI, (latA * 180) / Math.PI], points[j]!) <= STAY_RADIUS_KM
  }

  // The box round the window: the points after the start up to and including `last`.
  const west = new WindowMin(n, (j) => unwrapped[j]!)
  const east = new WindowMin(n, (j) => -unwrapped[j]!)
  const south = new WindowMin(n, (j) => lat[j]!)
  const north = new WindowMin(n, (j) => -lat[j]!)
  const boxes = [west, east, south, north]
  let last = 0
  // The last point found outside a start's circle.
  let outside = -1

  /** Whether every point in the window of start `i` is within the radius of it. */
  const windowNear = (i: number, cosI: number): boolean => {
    for (const box of boxes) box.dropTo(i)
    const dx = Math.max(unwrapped[i]! - west.least(), -east.least() - unwrapped[i]!) * cosI
    const dy = Math.max(lat[i]! - south.least(), -north.least() - lat[i]!)
    if (Math.max(dx, dy) ** 2 > 1.02 * r2) return false
    if (dx * dx + dy * dy < 0.98 * r2) return true
    if (outside > i && outside <= last && !near(lng[i]!, lat[i]!, cosI, outside)) return false
    for (let k = i + 1; k <= last; k++) {
      if (!near(lng[i]!, lat[i]!, cosI, k)) {
        outside = k
        return false
      }
    }
    return true
  }

  const stays: Stay[] = []
  let i = 0
  // A stay needs a second point, and `minStayMs` of log from its start.
  while (i < n - 1 && times[n - 1]! - times[i]! >= minStayMs) {
    // The window ends at the first point after the start that's `minStayMs` on. The log's last point is one.
    while (last <= i || times[last]! - times[i]! < minStayMs) {
      last++
      for (const box of boxes) box.push(last)
    }
    const cosI = Math.cos(lat[i]!)
    if (!windowNear(i, cosI)) {
      i++
      continue
    }
    let j = last
    while (j + 1 < n && near(lng[i]!, lat[i]!, cosI, j + 1)) j++
    // Running sums for the centre, with longitudes unwrapped around the run's first point.
    const ref = points[i]![0]
    let sumLng = 0
    let sumLat = 0
    for (let k = i; k <= j; k++) {
      sumLng += unwrapLng(ref, points[k]![0])
      sumLat += points[k]![1]
    }
    for (;;) {
      const count = j + 1 - i
      const cLat = sumLat / count
      if (j + 1 >= n || !near((sumLng / count) * rad, cLat * rad, Math.cos(cLat * rad), j + 1)) break
      j++
      sumLng += unwrapLng(ref, points[j]![0])
      sumLat += points[j]![1]
    }
    const count = j + 1 - i
    const at: LngLat = [wrapLng(sumLng / count), sumLat / count]
    const prev = stays[stays.length - 1]
    if (prev && prev.end === i - 1 && haversineKm(prev.at, at) <= STAY_RADIUS_KM) {
      prev.at = joinCentres(prev.at, i - prev.start, at, j + 1 - i)
      prev.end = j
      prev.depart = times[j]!
    } else stays.push({ start: i, end: j, at, arrive: times[i]!, depart: times[j]! })
    i = j + 1
  }
  return stays
}

// Thinning

/**
 * `points` thinned by Douglas-Peucker in Mercator, with every index in `keep`, the first and the last always kept. The
 * tolerance starts at 10 m on the ground at the mean latitude and doubles until at most `max` points remain, or only
 * the kept ones do. Longitudes are unwrapped first, so a track across 180° thins as one line.
 *
 * The points are stored wrapped, and the route unwraps each one to the turn nearest the one before, so an edge of 180°
 * or more would come back the wrong way round. So a point is also kept wherever the track has gone `WIND_DEG` (90°) of
 * longitude from the last such point: every point between two of them is within 90° of the first, so any edge between
 * them spans less than 180°.
 */
export function thinTrack(points: LngLat[], keep: ReadonlySet<number>, max: number = MAX_TRACK_POINTS): LngLat[] {
  const n = points.length
  if (n <= 2) return points.slice()
  const xy: XY[] = []
  const lngs: number[] = []
  let prev = points[0]![0]
  let latSum = 0
  for (const p of points) {
    prev = unwrapLng(prev, p[0])
    lngs.push(prev)
    xy.push(toXY([prev, p[1]]))
    latSum += p[1]
  }
  const winding: number[] = []
  for (let from = 0, k = 1; k < n; k++) {
    if (Math.abs(lngs[k]! - lngs[from]!) < WIND_DEG) continue
    // The last point still within 90°, and this one too when the track went 90° or more in one step.
    if (k - 1 > from) winding.push((from = k - 1))
    if (Math.abs(lngs[k]! - lngs[from]!) >= WIND_DEG) winding.push((from = k))
  }
  const wanted = [0, n - 1, ...winding, ...[...keep].filter((i) => Number.isInteger(i) && i >= 0 && i < n)]
  const anchors = [...new Set(wanted)].sort((a, b) => a - b)
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

  if (!times) throw noTimes(track)
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

// Cutting a track into legs

/** The `seaPaths` key a recorded track's points ride under. Sea keys are hex, so they never start with `track:`. */
export function trackKey(id: string): string {
  return `track:${id}`
}

/**
 * Where a leg meets its track: on the segment from point `index` to the next one, `t` of the way along it in Mercator,
 * with 0 <= t < 1. On a point `t` is 0, and the last point is always `{ index: n - 1, t: 0 }`.
 */
export interface TrackCut {
  index: number
  t: number
}

type Cut = TrackCut & { km: number }

/** A cut this close to a point along the track is taken at the point. */
const SNAP_KM = 0.1

/** Where `cut` lies. A point exactly; between points, its longitude may be off by whole turns. */
export function cutPoint(points: LngLat[], cut: TrackCut): LngLat {
  const a = points[cut.index]!
  if (cut.t === 0) return a
  const b = points[cut.index + 1]!
  const xa = toXY(a)
  const xb = toXY([unwrapLng(a[0], b[0]), b[1]])
  return toLngLat([xa[0] + (xb[0] - xa[0]) * cut.t, xa[1] + (xb[1] - xa[1]) * cut.t])
}

/** The vertex positions `cut` is at or before. A cut on a point is after it, so the point isn't strictly after. */
const before = (a: TrackCut, b: TrackCut): boolean => a.index < b.index || (a.index === b.index && a.t < b.t)

/**
 * Where a leg should end at `at` on `points`, from the cut `lo` on: the nearest place in the first run, a stretch of
 * track inside the circle of `TRACK_NEAR_KM` round `at`, or the nearest place from `lo` on when none comes that
 * close. A run ends where the track leaves the circle, even partway along a segment. With no
 * segment from `lo` on, the last point. Distances are to the segment, so a stop on a long thinned segment is cut
 * there, not at a point kilometres away. `snap` then moves a cut within 100 m of a point onto it.
 *
 * `leaving`, the cut the leg leaves from, is given when searching for a leg's end. The track may then be inside
 * `at`'s circle already at `lo`, because the two ends are close, and the run under way there needs care:
 * - If the leg leaves within `SAME_PLACE_KM` of `at`, the track hasn't left yet, as on a loop that ends where it
 *   began, so the next run is taken. This run is used only when there's no other.
 * - Otherwise it's taken if it gets nearer `at` than half the distance the leg leaves from: the track has made its way
 *   over to `at`. If it doesn't, it competes with the next run, and the nearer of the two wins.
 * The scan stops at the end of the next run, so it costs O(points) at most.
 *
 * Each segment is measured in Mercator, as it's drawn, scaled to kilometres at `at`'s latitude: exact to well under
 * 1% within a few kilometres, which is all the runs need. The distance a cut reports is great-circle.
 */
function cutAt(points: LngLat[], at: LngLat, lo: TrackCut, leaving?: TrackCut): Cut {
  const n = points.length
  const last = (): Cut => ({ index: n - 1, t: 0, km: haversineKm(at, points[n - 1]!) })
  if (lo.index >= n - 1) return last()
  const q = toXY(at)
  const kmPerUnit = WORLD_KM * Math.cos((at[1] * Math.PI) / 180)
  /** Point `k` in Mercator, moved by whole turns to lie nearest `x`. */
  const xyNear = (k: number, x: number): XY => {
    const p = toXY(points[k]!)
    return [p[0] + Math.round(x - p[0]), p[1]]
  }
  let k = lo.index
  let a = xyNear(k, q[0])
  /**
   * The nearest place to `at` on segment `k`, from `lo` on; how far from `at` the segment ends; and its end in
   * Mercator, for the next segment.
   */
  const nearestOn = (): { cut: Cut; endKm: number; b: XY } => {
    const b = xyNear(k + 1, a[0])
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    // `at` moved by whole turns to lie nearest the segment, which spans less than half a turn.
    const qx = q[0] + Math.round(a[0] + dx / 2 - q[0])
    const len2 = dx * dx + dy * dy
    const t0 = k === lo.index ? lo.t : 0
    const t = len2 === 0 ? t0 : Math.min(1, Math.max(t0, ((qx - a[0]) * dx + (q[1] - a[1]) * dy) / len2))
    const km = Math.hypot(a[0] + dx * t - qx, a[1] + dy * t - q[1]) * kmPerUnit
    const endKm = Math.hypot(b[0] - qx, b[1] - q[1]) * kmPerUnit
    return { cut: t >= 1 ? { index: k + 1, t: 0, km } : { index: k, t, km }, endKm, b }
  }

  // A run is a stretch of track inside `at`'s circle. A straight segment enters and leaves a circle at most once, so
  // a run goes on into the next segment only through a point inside the circle: two segments that each dip into it,
  // with the point between them outside, are two runs.
  let nearest: Cut | undefined
  /** The nearest place in the next run from segment `k` on, or undefined when no segment comes that close. */
  const nextRun = (): Cut | undefined => {
    let run: Cut | undefined
    while (k < n - 1) {
      const { cut, endKm, b } = nearestOn()
      a = b
      k++
      if (!nearest || cut.km < nearest.km) nearest = cut
      if (cut.km <= TRACK_NEAR_KM && (!run || cut.km < run.km)) run = cut
      if (run && endKm > TRACK_NEAR_KM) return run
    }
    return run
  }

  // The run under way at `lo`, if the leg leaves from inside the circle, and how far from `at` it leaves.
  let early: Cut | undefined
  let leaveKm = 0
  if (leaving !== undefined) {
    leaveKm = haversineKm(cutPoint(points, leaving), at)
    if (haversineKm(cutPoint(points, lo), at) <= TRACK_NEAR_KM) early = nextRun()
    if (early && leaveKm >= SAME_PLACE_KM && early.km < leaveKm / 2) return snap(points, at, lo, early)
  }
  const run = nextRun()
  if (early && run && leaveKm >= SAME_PLACE_KM) return snap(points, at, lo, early.km <= run.km ? early : run)
  const found = run ?? early ?? nearest
  return found ? snap(points, at, lo, found) : last()
}

/**
 * `cut` moved onto the nearer end of its segment when that point is within `SNAP_KM` of it along the track, so a stop
 * by a logged point is cut there, and no sliver of track is left between the cut and the point. A point further along
 * stays on its side of the cut, however near the stop it is. Only a point from `lo` on is taken. The distance is
 * great-circle.
 */
function snap(points: LngLat[], at: LngLat, lo: TrackCut, cut: Cut): Cut {
  if (cut.t === 0) return { ...cut, km: haversineKm(at, points[cut.index]!) }
  const place = cutPoint(points, cut)
  let best: Cut = { ...cut, km: haversineKm(at, place) }
  let bestAlong = SNAP_KM
  for (const index of [cut.index, cut.index + 1]) {
    if (before({ index, t: 0 }, lo)) continue
    const along = haversineKm(place, points[index]!)
    if (along < bestAlong) {
      best = { index, t: 0, km: haversineKm(at, points[index]!) }
      bestAlong = along
    }
  }
  return best
}

/**
 * Where a leg from `from` to `to` cuts `points`, the wrapped points of a recorded track. A cut can fall between two
 * points (see `TrackCut`), so a stop on a long thinned segment is cut where it is, and the points either side stay in
 * the legs either side. The leg follows every point strictly between its two cuts.
 *
 * `start` is the cut the leg starts at, the previous leg's `end` when both follow this track; without it, `from` is
 * searched for from the first point. `end` is searched for from `start` on: the nearest place in the first run, a
 * stretch of track inside the circle of `TRACK_NEAR_KM` round `to`, or the nearest place when none comes that close. Taking the first run cuts
 * a port called at twice at its first call, and a cruise that ends where it began at its end. When the track is
 * already within `TRACK_NEAR_KM` of `to` where the leg leaves, `cutAt` decides whether the leg ends in that run or a
 * later one, so a loop from a stop back to it isn't cut on the way out. `gapKm` is the great-circle distance from
 * `from` and `to` to the places at `start` and `end`, so two legs that share a cut report the same gap there. Runs
 * are measured in a local Mercator frame, so a track across 180° needs no unwrapping. `points` must hold at least one
 * point, and each stored edge must span less than 180° of longitude, as `thinTrack` leaves them.
 */
export function cutTrack(
  points: LngLat[],
  from: LngLat,
  to: LngLat,
  start?: TrackCut,
): { start: TrackCut; end: TrackCut; gapKm: [number, number] } {
  const first = start ?? cutAt(points, from, { index: 0, t: 0 })
  const fromKm = haversineKm(from, cutPoint(points, first))
  const last = cutAt(points, to, first, first)
  return { start: { index: first.index, t: first.t }, end: { index: last.index, t: last.t }, gapKm: [fromKm, last.km] }
}
