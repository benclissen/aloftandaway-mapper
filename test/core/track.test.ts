import { describe, expect, it } from 'vitest'
import {
  MAX_TRACK_POINTS,
  STAY_RADIUS_KM,
  TRACK_NEAR_KM,
  TrackError,
  findStays,
  haversineKm,
  parseGpx,
  parseTrackCsv,
  recordedFromGpx,
  thinTrack,
  trackToStops,
  type LngLat,
  type RecordedTrack,
  unwrapLng,
} from '../../src/core/index.js'
import { lcg, syntheticCruise } from '../fixtures/tracks.js'

const HOUR = 3_600_000
const MIN = 60_000

const caught = (f: () => unknown): unknown => {
  try {
    f()
  } catch (e) {
    return e
  }
  throw new Error('expected a throw')
}

/** `p` moved `km` north. */
const north = (p: LngLat, km: number): LngLat => [p[0], p[1] + km / 111.195]

describe('track constants', () => {
  it('match the stage decisions', () => {
    expect(MAX_TRACK_POINTS).toBe(10_000)
    expect(STAY_RADIUS_KM).toBe(1)
    expect(TRACK_NEAR_KM).toBe(2)
  })
})

describe('parseTrackCsv', () => {
  it('parses lng,lat,time CSV in any column order', () => {
    const a = parseTrackCsv('lng,lat,time\n10,50,2026-06-01T06:00:00Z\n10.1,50.1,2026-06-01T06:01:00Z\n')
    const b = parseTrackCsv('Time,Latitude,Longitude\r\n2026-06-01T06:00:00Z,50,10\r\n2026-06-01T06:01:00Z,50.1,10.1\r\n')
    const c = parseTrackCsv('timestamp,LON,LAT\n2026-06-01T06:00:00Z,10,50\n2026-06-01T06:01:00Z,10.1,50.1')
    for (const t of [a, b, c]) {
      expect(t.points).toEqual([
        [10, 50],
        [10.1, 50.1],
      ])
      expect(t.times).toEqual([Date.UTC(2026, 5, 1, 6, 0), Date.UTC(2026, 5, 1, 6, 1)])
      expect(t.skippedRows).toBe(0)
      expect(t.badTimes).toBe(0)
    }
    const noTime = parseTrackCsv('lat,lng\n50,10\n51,11\n')
    expect(noTime.points).toEqual([
      [10, 50],
      [11, 51],
    ])
    expect(noTime.times).toBeUndefined()
  })

  it('skips bad rows and counts them', () => {
    const t = parseTrackCsv(
      ['lng,lat,time', '10,50,1780293600', ',50,1780293660', '10,91,1780293720', 'abc,50,1780293780', '11,51,1780293840', ''].join('\n'),
    )
    expect(t.skippedRows).toBe(3)
    expect(t.points).toEqual([
      [10, 50],
      [11, 51],
    ])
    expect(t.times).toEqual([1780293600_000, 1780293840_000])
    expect(parseTrackCsv('lng,lat\n181,0\n0,85.06\n0,85.05\n').skippedRows).toBe(2)
  })

  it('drops times when any row lacks one', () => {
    const blank = parseTrackCsv('lng,lat,time\n10,50,2026-06-01T06:00:00Z\n10.1,50.1,\n10.2,50.2,2026-06-01T06:02:00Z\n')
    expect(blank.points).toHaveLength(3)
    expect(blank.times).toBeUndefined()
    const bad = parseTrackCsv('lng,lat,time\n10,50,2026-06-01T06:00:00Z\n10.1,50.1,yesterday\n')
    expect(bad.times).toBeUndefined()
    // A time with no zone is ambiguous, so it counts as a bad one.
    const local = parseTrackCsv('lng,lat,time\n10,50,2026-06-01T06:00:00Z\n10.1,50.1,2026-06-01T06:01:00\n')
    expect(local.times).toBeUndefined()
    // A bad coordinate row with a time doesn't count against the times of the rows kept.
    const kept = parseTrackCsv('lng,lat,time\n10,50,2026-06-01T06:00:00Z\nx,50.1,\n10.2,50.2,2026-06-01T06:02:00Z\n')
    expect(kept.times).toHaveLength(2)
  })

  it('reads Unix seconds and ISO times alike', () => {
    const at = Date.UTC(2026, 5, 1, 6, 0, 0)
    const rows = [
      `${at / 1000}`,
      `${at}`,
      `${at / 1000}.5`,
      '2026-06-01T06:00:00Z',
      '2026-06-01T06:00:00.000Z',
      '2026-06-01T08:00:00+02:00',
      '2026-06-01T08:00:00+0200',
      '2026-06-01T01:30:00-04:30',
      '2026-06-01 06:00:00Z',
    ]
    const t = parseTrackCsv(['lng,lat,time', ...rows.map((r) => `10,50,${r}`)].join('\n'))
    expect(t.times).toEqual([at, at, at + 500, at, at, at, at, at, at])
    expect(parseTrackCsv('lng,lat,time\n10,50,2026-02-30T00:00:00Z\n').times).toBeUndefined()
    expect(parseTrackCsv('lng,lat,time\n10,50,1e30\n').times).toBeUndefined()
  })

  it('reads quoted cells and ignores extra columns', () => {
    const t = parseTrackCsv('\uFEFF"name","lat","lng","speed"\n"Ship, A",50,10,12\n"B",51,11,9\n')
    expect(t.points).toEqual([
      [10, 50],
      [11, 51],
    ])
  })

  it('a CSV without lng and lat columns is refused', () => {
    for (const text of ['', 'time,lat\n2026-06-01T06:00:00Z,50\n', '10,50\n11,51\n']) {
      const e = caught(() => parseTrackCsv(text))
      expect(e).toBeInstanceOf(TrackError)
      expect((e as TrackError).fix).toBe('The first row must name the columns: lng, lat and optionally time.')
    }
  })
})

describe('findStays', () => {
  const cruise = syntheticCruise()
  const track = parseTrackCsv(cruise.csv)

  it('finds the stays in a synthetic cruise', () => {
    expect(track.skippedRows).toBe(0)
    expect(track.times).toHaveLength(track.points.length)
    const stays = findStays(track, 120 * MIN)
    expect(stays).toHaveLength(3)
    stays.forEach((s, i) => {
      expect(haversineKm(s.at, cruise.ports[i]!)).toBeLessThan(0.3)
      expect(s.depart - s.arrive).toBeGreaterThanOrEqual(120 * MIN)
      expect(s.arrive).toBe(track.times![s.start])
      expect(s.depart).toBe(track.times![s.end])
    })
    expect(stays[0]!.start).toBe(0)
    expect(stays[2]!.end).toBe(track.points.length - 1)

    const short = findStays(track, 20 * MIN)
    expect(short).toHaveLength(4)
    expect(short[2]!.depart - short[2]!.arrive).toBeLessThan(120 * MIN)
    expect(short[2]!.depart - short[2]!.arrive).toBeGreaterThanOrEqual(20 * MIN)
    expect(haversineKm(short[3]!.at, cruise.ports[2]!)).toBeLessThan(0.3)
  })

  it('reads the same cruise from GPX and CSV text', () => {
    const fromGpx = recordedFromGpx(parseGpx(cruise.gpx).lines[0]!)
    expect(fromGpx.name).toBe('Synthetic cruise')
    expect(fromGpx.points).toEqual(track.points)
    expect(fromGpx.times).toEqual(track.times)
  })

  it('each port call is one stay from arrival to departure, whatever the seed', { timeout: 60_000 }, () => {
    const seeds = [...Array.from({ length: 200 }, (_, i) => i + 1), 80, 84, 116]
    for (const seed of seeds) {
      const c = syntheticCruise({ seed })
      const r = trackToStops(parseTrackCsv(c.csv), { stops: 'stays', minStayMinutes: 120 })
      expect(r.stops, `seed ${seed}`).toHaveLength(3)
      r.stops.forEach((s, k) => {
        const call = c.calls[k]!
        expect(haversineKm(s.at, c.ports[k]!), `seed ${seed} stop ${k + 1}`).toBeLessThan(0.3)
        expect(Math.abs(Date.parse(s.arrive!) - call.arrive), `seed ${seed} stop ${k + 1} arrive`).toBeLessThanOrEqual(15 * MIN)
        expect(Math.abs(Date.parse(s.depart!) - call.depart), `seed ${seed} stop ${k + 1} depart`).toBeLessThanOrEqual(15 * MIN)
      })
    }
  })

  it('a stay keeps going past a run that ends early, even when the rest is short', () => {
    // The run from the first point (0.9 km out) ends at the point 0.3 km south of the port after 2.5 h. The 1.5 h after
    // it is too short to be a stay alone, but it's still the same port call.
    const p: LngLat = [24, 37]
    const points: LngLat[] = [north(p, 0.9), p, p, p, north(p, -0.3), p, p, north(p, 5)]
    const times = [0, 1, 2, 2.5, 3, 3.5, 4, 5].map((h) => h * HOUR)
    const stays = findStays({ points, times }, 120 * MIN)
    expect(stays.map((s) => [s.start, s.end, s.arrive, s.depart])).toEqual([[0, 6, 0, 4 * HOUR]])
    expect(haversineKm(stays[0]!.at, north(p, (0.9 - 0.3) / 7))).toBeLessThan(0.001)
  })

  it('unsorted times find the same stays', () => {
    const [header, ...rows] = cruise.csv.trim().split('\n')
    const rand = lcg(7)
    for (let i = rows.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[rows[i], rows[j]] = [rows[j]!, rows[i]!]
    }
    const shuffled = parseTrackCsv([header, ...rows].join('\n'))
    expect(shuffled.points).not.toEqual(track.points)
    expect(findStays(shuffled, 120 * MIN)).toEqual(findStays(track, 120 * MIN))
  })

  it('a gap in the log at one place is a stay', () => {
    const p: LngLat = [24, 37]
    const t: RecordedTrack = { points: [p, north(p, 0.05)], times: [0, 3 * HOUR] }
    const stays = findStays(t, 120 * MIN)
    expect(stays).toHaveLength(1)
    expect(stays[0]).toMatchObject({ start: 0, end: 1, arrive: 0, depart: 3 * HOUR })
    expect(haversineKm(stays[0]!.at, north(p, 0.025))).toBeLessThan(0.001)
  })

  it('a slow drift is cut into stays a little over 1 km long', () => {
    // Drifting 0.45 km an hour. The run from point 0 ends at point 3 (1.35 km from it); as a stay it then takes points
    // within 1 km of its centre: point 3 (0.9 km) but not point 4 (1.125 km). The next stays start from there.
    const p: LngLat = [24, 37]
    const points = Array.from({ length: 11 }, (_, i) => north(p, 0.45 * i))
    const times = points.map((_, i) => i * HOUR)
    expect(findStays({ points, times }, 120 * MIN).map((s) => [s.start, s.end])).toEqual([
      [0, 3],
      [4, 7],
      [8, 10],
    ])
  })

  it('a stay split by a run that starts on the way in joins up', () => {
    // The run from the first point (0.9 km out) ends when the point 0.3 km south of the port leaves its circle, and
    // the rest of the stay is a second run straight after.
    const p: LngLat = [24, 37]
    const points: LngLat[] = [north(p, 0.9), p, p, p, north(p, -0.3), p, p, p]
    const times = [0, 1, 2, 2.5, 3, 4, 5, 6].map((h) => h * HOUR)
    const stays = findStays({ points, times }, 120 * MIN)
    expect(stays.map((s) => [s.start, s.end, s.arrive, s.depart])).toEqual([[0, 7, 0, 6 * HOUR]])
    expect(haversineKm(stays[0]!.at, north(p, (0.9 - 0.3) / 8))).toBeLessThan(0.001)
  })

  it('stays more than 1 km apart stay apart, even with no point between', () => {
    const p: LngLat = [24, 37]
    const q = north(p, 1.5)
    const stays = findStays({ points: [p, p, p, q, q, q], times: [0, 1, 3, 4, 5, 7].map((h) => h * HOUR) }, 120 * MIN)
    expect(stays.map((s) => [s.start, s.end])).toEqual([
      [0, 2],
      [3, 5],
    ])
  })

  it('a stay across 180° has its centre on the right side', () => {
    const points: LngLat[] = [
      [179.999, -17],
      [-179.999, -17],
      [179.999, -17],
      [-179.999, -17],
    ]
    const stays = findStays({ points, times: [0, HOUR, 2 * HOUR, 3 * HOUR] }, 120 * MIN)
    expect(stays).toHaveLength(1)
    expect(Math.abs(Math.abs(stays[0]!.at[0]) - 180)).toBeLessThan(0.001)
  })

  it('needs times', () => {
    const e = caught(() => findStays({ points: [[0, 0], [1, 1]] }, 120 * MIN))
    expect(e).toBeInstanceOf(TrackError)
  })

  it('finds stays in 200,000 points within 3 s', { timeout: 60_000 }, () => {
    // An AIS-like log every 10 s: 12 h sailing at 28 km/h, then 6 h in port, repeated.
    const rand = lcg(3)
    const points: LngLat[] = []
    const times: number[] = []
    let at: LngLat = [-20, 40]
    let ports = 0
    while (points.length < 200_000) {
      for (let i = 0; i < 6 * 360 && points.length < 200_000; i++) {
        points.push([at[0] + (rand() - 0.5) * 0.004, at[1] + (rand() - 0.5) * 0.004])
        times.push(points.length * 10_000)
      }
      if (points.length < 200_000) ports++
      for (let i = 0; i < 12 * 360 && points.length < 200_000; i++) {
        at = [at[0] + 0.00095, at[1] + 0.0002 * Math.sin(points.length / 5000)]
        points.push([at[0] + (rand() - 0.5) * 0.002, at[1] + (rand() - 0.5) * 0.002])
        times.push(points.length * 10_000)
      }
    }
    const t0 = performance.now()
    const stays = findStays({ points, times }, 120 * MIN)
    const ms = performance.now() - t0
    expect(stays).toHaveLength(ports)
    expect(ms).toBeLessThan(3000)
  })
})

describe('trackToStops', () => {
  const cruise = syntheticCruise()
  const track = parseTrackCsv(cruise.csv)

  it('stays become stops', () => {
    const r = trackToStops(track, { stops: 'stays', minStayMinutes: 120 })
    expect(r.stops.map((s) => s.name)).toEqual(['Stop 1', 'Stop 2', 'Stop 3'])
    expect(r.stays).toBe(3)
    expect(r.recorded).toBe(track.points.length)
    r.stops.forEach((s, i) => {
      expect(haversineKm(s.at, cruise.ports[i]!)).toBeLessThan(0.3)
      expect(s.arrive).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(s.depart).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(Date.parse(s.depart!) - Date.parse(s.arrive!)).toBeGreaterThanOrEqual(120 * MIN)
    })
    expect(r.stops[0]!.arrive).toBe('2026-06-01T06:00:00.000Z')
    // The thinned line starts and ends on the first and last stop, and passes through the middle one.
    expect(r.points[0]).toEqual(r.stops[0]!.at)
    expect(r.points[r.points.length - 1]).toEqual(r.stops[2]!.at)
    expect(r.points).toContainEqual(r.stops[1]!.at)
    expect(r.points.length).toBeLessThan(track.points.length)
    expect(r.points.length).toBeGreaterThan(10)
  })

  it('adds the ends when no stay covers them', () => {
    const p: LngLat = [24, 37]
    const points: LngLat[] = [p, north(p, 5), north(p, 10), north(p, 10.01), north(p, 10.02), north(p, 15)]
    const times = [0, HOUR, 2 * HOUR, 3 * HOUR, 5 * HOUR, 6 * HOUR]
    const r = trackToStops({ points, times }, { stops: 'stays', minStayMinutes: 120 })
    expect(r.stays).toBe(1)
    expect(r.stops.map((s) => s.name)).toEqual(['Stop 1', 'Stop 2', 'Stop 3'])
    expect(r.stops[0]).toEqual({ name: 'Stop 1', at: p, depart: new Date(0).toISOString() })
    expect(r.stops[1]).toMatchObject({ arrive: new Date(2 * HOUR).toISOString(), depart: new Date(5 * HOUR).toISOString() })
    expect(r.stops[2]).toEqual({ name: 'Stop 3', at: north(p, 15), arrive: new Date(6 * HOUR).toISOString() })
  })

  it('a waypoint names a stop', () => {
    const waypoints = [
      { name: 'Mykonos', at: north(cruise.ports[1]!, 0.5) },
      { name: 'Too far', at: north(cruise.ports[2]!, 1.6) },
    ]
    const r = trackToStops(track, { stops: 'stays', minStayMinutes: 120, waypoints })
    expect(r.stops.map((s) => s.name)).toEqual(['Stop 1', 'Mykonos', 'Stop 3'])
  })

  it('ends mode', () => {
    const r = trackToStops(track, { stops: 'ends', minStayMinutes: 120 })
    expect(r.stops.map((s) => s.name)).toEqual(['Track start', 'Track end'])
    expect(r.stays).toBe(0)
    expect(r.stops[0]!.at).toEqual(track.points[0])
    expect(r.stops[1]!.at).toEqual(track.points[track.points.length - 1])
    expect(r.points[0]).toEqual(track.points[0])
    expect(r.points[r.points.length - 1]).toEqual(track.points[track.points.length - 1])
    const named = trackToStops({ name: 'Aegean', points: track.points }, { stops: 'ends', minStayMinutes: 120 })
    expect(named.stops.map((s) => s.name)).toEqual(['Aegean start', 'Aegean end'])
    expect(named.stops[0]!.depart).toBeUndefined()
    const wp = trackToStops(track, { stops: 'ends', minStayMinutes: 120, waypoints: [{ name: 'Piraeus', at: cruise.ports[0]! }] })
    expect(wp.stops.map((s) => s.name)).toEqual(['Piraeus', 'Track end'])
  })

  it('stays without times is refused', () => {
    const e = caught(() => trackToStops({ points: track.points }, { stops: 'stays', minStayMinutes: 120 }))
    expect(e).toBeInstanceOf(TrackError)
    expect((e as TrackError).fix).toBe("Pass stops: 'ends', or use a file with a time for every point.")
    const blank = parseTrackCsv('lng,lat,time\n10,50,2026-06-01T06:00:00Z\n10.1,50.1,\n')
    expect(blank.badTimes).toBe(0)
    const e2 = caught(() => trackToStops(blank, { stops: 'stays', minStayMinutes: 120 }))
    expect((e2 as TrackError).fix).toBe("Pass stops: 'ends', or use a file with a time for every point.")
  })

  it('times with no zone are refused with a fix that says so', () => {
    const local = parseTrackCsv('lng,lat,time\n10,50,2026-06-01T06:00:00\n10.1,50.1,2026-06-01T09:00:00\n10.2,50.2,2026-06-01T10:00:00Z\n')
    expect(local.times).toBeUndefined()
    expect(local.badTimes).toBe(2)
    for (const f of [() => trackToStops(local, { stops: 'stays', minStayMinutes: 120 }), () => findStays(local, 120 * MIN)]) {
      const e = caught(f)
      expect(e).toBeInstanceOf(TrackError)
      expect((e as TrackError).message).toBe("2 of the track's times can't be read, so stays can't be found.")
      expect((e as TrackError).fix).toBe(
        "Write every time in ISO 8601 with a Z or an offset, such as 2026-06-01T06:00:00Z, or as Unix seconds. Or pass stops: 'ends'.",
      )
    }
    // Ends mode doesn't need times, so it still works.
    expect(trackToStops(local, { stops: 'ends', minStayMinutes: 120 }).stops).toHaveLength(2)
  })

  it('a track with fewer than 2 points is refused', () => {
    expect(caught(() => trackToStops({ points: [[0, 0]] }, { stops: 'ends', minStayMinutes: 120 }))).toBeInstanceOf(TrackError)
  })

  it('a track that is one stay throughout is refused', () => {
    const p: LngLat = [24, 37]
    const e = caught(() => trackToStops({ points: [p, north(p, 0.05)], times: [0, 3 * HOUR] }, { stops: 'stays', minStayMinutes: 120 }))
    expect(e).toBeInstanceOf(TrackError)
  })
})

describe('thinTrack', () => {
  it('thinning keeps stays and ends and caps the count', () => {
    const rand = lcg(11)
    const points: LngLat[] = Array.from({ length: 50_000 }, (_, i) => [10 + i * 0.0001 + (rand() - 0.5) * 0.01, 40 + (rand() - 0.5) * 0.01])
    const keep = new Set([0, 12_345, 25_000, 37_777, 49_999])
    const out = thinTrack(points, keep)
    expect(out.length).toBeLessThanOrEqual(10_000)
    expect(out.length).toBeGreaterThan(100)
    let from = 0
    for (const k of [...keep].sort((a, b) => a - b)) {
      const at = out.indexOf(points[k]!, from)
      expect(at).toBeGreaterThanOrEqual(from)
      from = at + 1
    }
    expect(out[0]).toBe(points[0])
    expect(out[out.length - 1]).toBe(points[49_999])
    expect(thinTrack(points, new Set(), 500).length).toBeLessThanOrEqual(500)
  })

  it('a straight run collapses', () => {
    const points: LngLat[] = Array.from({ length: 1000 }, (_, i) => [10 + i * 0.001, 40])
    expect(thinTrack(points, new Set())).toEqual([
      [10, 40],
      points[999],
    ])
  })

  it('keeps a 15 m wiggle and drops a 5 m one', () => {
    const wiggle = (m: number): LngLat[] => [
      [10, 40],
      [10.01, 40 + m / 111_195],
      [10.02, 40],
    ]
    expect(thinTrack(wiggle(15), new Set())).toHaveLength(3)
    expect(thinTrack(wiggle(5), new Set())).toHaveLength(2)
  })

  it('thins across 180° without keeping the jump', () => {
    const points: LngLat[] = Array.from({ length: 101 }, (_, i) => {
      const lng = 179.5 + i * 0.01
      return [lng > 180 ? lng - 360 : lng, -17]
    })
    expect(thinTrack(points, new Set())).toHaveLength(2)
  })

  it('a track more than half way round keeps its way round', () => {
    // 200° east along 60° S, from 170° through 180° to 10°. A straight line in Mercator, so Douglas-Peucker alone keeps
    // only the ends, and 170° to 10° unwraps the short way, 160° west.
    const points: LngLat[] = Array.from({ length: 201 }, (_, i) => [((170 + i + 180) % 360) - 180, -60])
    const out = thinTrack(points, new Set())
    expect(out[0]).toBe(points[0])
    expect(out.at(-1)).toBe(points[200])
    let lng = out[0]![0]
    for (const p of out.slice(1)) {
      const next = unwrapLng(lng, p[0])
      expect(next - lng).toBeGreaterThan(0)
      expect(next - lng).toBeLessThan(180)
      lng = next
    }
    expect(lng).toBe(370)
    expect(out.length).toBeLessThan(10)
  })
})
