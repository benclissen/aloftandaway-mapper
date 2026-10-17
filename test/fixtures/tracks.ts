import type { LngLat } from '../../src/core/index.js'

/**
 * Synthetic recorded tracks for tests. Everything here is made up and deterministic: a seeded LCG drives the noise, so
 * the same seed always gives the same text. No real AIS or GPS log is committed.
 */

const START_MS = Date.UTC(2026, 5, 1, 6, 0, 0)
const MINUTE = 60_000
const M_PER_DEG = 111_320

/** Numerical Recipes LCG, giving floats in [0, 1). */
export function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

/** `p` moved by up to `metres` east and north, each uniform in ±`metres`. */
function jitter(rand: () => number, p: LngLat, metres: number): LngLat {
  const dLat = ((rand() * 2 - 1) * metres) / M_PER_DEG
  const dLng = ((rand() * 2 - 1) * metres) / (M_PER_DEG * Math.cos((p[1] * Math.PI) / 180))
  return [p[0] + dLng, p[1] + dLat]
}

/** `samples` points spread evenly by distance along `line`, the last one on its end. Planar in degrees, which is fine here. */
function along(line: LngLat[], samples: number): LngLat[] {
  const seg = line.slice(1).map((b, i) => Math.hypot(b[0] - line[i]![0], b[1] - line[i]![1]))
  const total = seg.reduce((a, b) => a + b, 0)
  const out: LngLat[] = []
  for (let k = 1; k <= samples; k++) {
    let d = (total * k) / samples
    let i = 0
    while (i < seg.length - 1 && d > seg[i]!) d -= seg[i++]!
    const a = line[i]!
    const b = line[i + 1]!
    const t = seg[i] === 0 ? 0 : Math.min(1, d / seg[i]!)
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
  }
  return out
}

const PORT_A: LngLat = [23.62, 37.94]
const PORT_B: LngLat = [25.33, 37.45]
const PORT_C: LngLat = [25.43, 36.42]
/** Open water south of Paros, where the 30-minute stop is. */
const SHORT_STOP: LngLat = [25.3, 36.88]
/** B to C through open water: down the Paros-Naxos strait, west of Ios, and into the caldera from the north-west. */
const B_TO_STOP: LngLat[] = [PORT_B, [25.3, 37.3], [25.31, 37.05], SHORT_STOP]
const STOP_TO_C: LngLat[] = [SHORT_STOP, [25.22, 36.72], [25.26, 36.58], [25.36, 36.47], PORT_C]

/**
 * A cruise logged once a minute: 3 h in port at A, 10 h sailing to B, 8 h at B, then 4 h sailing, a 30-minute stop at
 * sea, 4 h more sailing, and 3 h at C, where the log ends. Stays jitter by ±200 m and sailing by ±100 m.
 *
 * C lasts 3 h rather than 2 h: at one sample a minute, 2 h of samples span only 119 minutes, which is under the default
 * 120-minute stay.
 */
export function syntheticCruise(opts: { seed?: number } = {}): {
  csv: string
  gpx: string
  ports: LngLat[]
  /** The first and last sample time at each port, in milliseconds. */
  calls: { arrive: number; depart: number }[]
} {
  const rand = lcg(opts.seed ?? 1)
  const points: LngLat[] = []
  const calls: { arrive: number; depart: number }[] = []
  const stay = (at: LngLat, minutes: number, call = true): void => {
    if (call) calls.push({ arrive: START_MS + points.length * MINUTE, depart: START_MS + (points.length + minutes - 1) * MINUTE })
    for (let i = 0; i < minutes; i++) points.push(jitter(rand, at, 200))
  }
  const sail = (line: LngLat[], minutes: number): void => {
    for (const p of along(line, minutes)) points.push(jitter(rand, p, 100))
  }
  stay(PORT_A, 180)
  sail([PORT_A, PORT_B], 600)
  stay(PORT_B, 480)
  sail(B_TO_STOP, 240)
  stay(SHORT_STOP, 30, false)
  sail(STOP_TO_C, 240)
  stay(PORT_C, 180)

  const times = points.map((_, i) => new Date(START_MS + i * MINUTE).toISOString())
  const f = (n: number): string => n.toFixed(6)
  const csv = ['lng,lat,time', ...points.map((p, i) => `${f(p[0])},${f(p[1])},${times[i]}`)].join('\n') + '\n'
  const trkpts = points.map((p, i) => `<trkpt lat="${f(p[1])}" lon="${f(p[0])}"><time>${times[i]}</time></trkpt>`)
  const gpx =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx version="1.1" creator="mapper-tests" xmlns="http://www.topografix.com/GPX/1/1">' +
    `<trk><name>Synthetic cruise</name><trkseg>${trkpts.join('')}</trkseg></trk></gpx>\n`
  return { csv, gpx, ports: [PORT_A, PORT_B, PORT_C], calls }
}

/** Where the day loop starts and ends: a made-up hotel on Naxos. */
const HOME: LngLat = [25.4, 37.05]
const KM_PER_DEG = M_PER_DEG / 1000

/**
 * A day loop logged once a minute: `stayMinutes` at home (default 180), a drive once round a 40 km circle that starts
 * and ends at home, in `samples` steps (default 200), then `stayMinutes` at home again. The drive gives `samples + 1`
 * points, the first and last at home; with `stayMinutes: 0` there are no stays. Stays jitter by ±50 m and the drive by
 * ±20 m.
 */
export function syntheticLoop(opts: { seed?: number; stayMinutes?: number; samples?: number } = {}): {
  csv: string
  points: LngLat[]
  home: LngLat
  /** The length of the circle the drive follows. */
  lengthKm: number
} {
  const rand = lcg(opts.seed ?? 1)
  const stayMinutes = opts.stayMinutes ?? 180
  const samples = opts.samples ?? 200
  const lengthKm = 40
  const r = lengthKm / (2 * Math.PI)
  const cos = Math.cos((HOME[1] * Math.PI) / 180)
  const points: LngLat[] = []
  for (let i = 0; i < stayMinutes; i++) points.push(jitter(rand, HOME, 50))
  // The circle's centre is r km north of home, so home is on it, and the drive goes round it clockwise from the south.
  for (let k = 0; k <= samples; k++) {
    const a = (2 * Math.PI * k) / samples
    const east = -r * Math.sin(a)
    const north = r - r * Math.cos(a)
    points.push(jitter(rand, [HOME[0] + east / (KM_PER_DEG * cos), HOME[1] + north / KM_PER_DEG], 20))
  }
  for (let i = 0; i < stayMinutes; i++) points.push(jitter(rand, HOME, 50))

  const f = (n: number): string => n.toFixed(6)
  const rows = points.map((p, i) => `${f(p[0])},${f(p[1])},${new Date(START_MS + i * MINUTE).toISOString()}`)
  return { csv: ['lng,lat,time', ...rows].join('\n') + '\n', points, home: HOME, lengthKm }
}
