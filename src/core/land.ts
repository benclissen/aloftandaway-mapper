import { clampLat, toXY } from './geo.js'
import { MAX_LAT, type LngLat } from './schema.js'

export const LAND_FORMAT = 1

const SCALE = 1e4
const MAGIC = [0x4d, 0x4c, 0x4e, 0x44] // "MLND"

export interface LandData {
  version: string
  /** Flat Mercator `[x0, y0, x1, y1, …]` per ring, implicitly closed. */
  rings: Float64Array[]
}

export interface LandSource {
  version: string
  /** Rings whose bounding box meets the Mercator box (x may be unwrapped), shifted by whole worlds to overlap it. */
  ringsIn(minX: number, minY: number, maxX: number, maxY: number): Float64Array[]
  /** Even-odd point-in-polygon over all rings; any longitude. */
  isLand(at: LngLat): boolean
}

function pushVarint(out: number[], value: number): void {
  let v = value
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80)
    v = Math.floor(v / 0x80)
  }
  out.push(v)
}

const zigzag = (d: number): number => (d >= 0 ? d * 2 : -d * 2 - 1)
const unzigzag = (z: number): number => (z % 2 === 0 ? z / 2 : -(z + 1) / 2)

export function encodeLand(version: string, rings: LngLat[][]): Uint8Array {
  const v = new TextEncoder().encode(version)
  if (v.length > 255) throw new Error('land version string too long')
  const out: number[] = [...MAGIC, LAND_FORMAT, v.length, ...v]
  pushVarint(out, rings.length)
  for (const ring of rings) {
    let pts = ring
    const first = ring[0]
    const last = ring[ring.length - 1]
    if (ring.length > 1 && first && last && first[0] === last[0] && first[1] === last[1]) pts = ring.slice(0, -1)
    pushVarint(out, pts.length)
    let px = 0
    let py = 0
    for (const [lng, lat] of pts) {
      const x = Math.round(lng * SCALE)
      const y = Math.round(lat * SCALE)
      pushVarint(out, zigzag(x - px))
      pushVarint(out, zigzag(y - py))
      px = x
      py = y
    }
  }
  return Uint8Array.from(out)
}

export function decodeLand(bytes: Uint8Array): LandData {
  if (bytes.length < 6 || MAGIC.some((m, i) => bytes[i] !== m)) throw new Error('not a Mapper land file')
  if (bytes[4] !== LAND_FORMAT) throw new Error(`unsupported Mapper land format ${bytes[4]}`)
  const n = bytes[5]!
  const version = new TextDecoder().decode(bytes.subarray(6, 6 + n))
  let pos = 6 + n
  const varint = (): number => {
    let result = 0
    let mul = 1
    for (;;) {
      const b = bytes[pos++]
      if (b === undefined) throw new Error('not a Mapper land file (truncated)')
      result += (b & 0x7f) * mul
      if (b < 0x80) return result
      mul *= 0x80
    }
  }
  const count = varint()
  const rings: Float64Array[] = []
  for (let r = 0; r < count; r++) {
    const m = varint()
    const ring = new Float64Array(m * 2)
    let x = 0
    let y = 0
    for (let i = 0; i < m; i++) {
      x += unzigzag(varint())
      y += unzigzag(varint())
      const [mx, my] = toXY([x / SCALE, clampLat(y / SCALE)])
      ring[i * 2] = mx
      ring[i * 2 + 1] = my
    }
    rings.push(ring)
  }
  return { version, rings }
}

const BANDS = 2048

export function landIndex(data: LandData): LandSource {
  const { rings } = data
  const n = rings.length
  // Bounding boxes: minX, minY, maxX, maxY per ring.
  const bbox = new Float64Array(n * 4)
  rings.forEach((ring, r) => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let i = 0; i < ring.length; i += 2) {
      const x = ring[i]!
      const y = ring[i + 1]!
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    bbox.set([minX, minY, maxX, maxY], r * 4)
  })

  // Edges bucketed by latitude band (counting sort). An edge is (ring, start point).
  const band = (y: number): number => Math.min(BANDS - 1, Math.max(0, Math.floor(y * BANDS)))
  const counts = new Int32Array(BANDS + 1)
  const eachEdge = (fn: (r: number, i: number, b0: number, b1: number) => void): void => {
    for (let r = 0; r < n; r++) {
      const ring = rings[r]!
      const m = ring.length / 2
      for (let i = 0; i < m; i++) {
        const j = i + 1 === m ? 0 : i + 1
        const ya = ring[i * 2 + 1]!
        const yb = ring[j * 2 + 1]!
        fn(r, i, band(Math.min(ya, yb)), band(Math.max(ya, yb)))
      }
    }
  }
  eachEdge((_r, _i, b0, b1) => {
    for (let b = b0; b <= b1; b++) counts[b + 1]!++
  })
  for (let b = 0; b < BANDS; b++) counts[b + 1]! += counts[b]!
  const total = counts[BANDS]!
  const edgeRing = new Int32Array(total)
  const edgePt = new Int32Array(total)
  const fill = counts.slice(0, BANDS)
  eachEdge((r, i, b0, b1) => {
    for (let b = b0; b <= b1; b++) {
      const k = fill[b]!++
      edgeRing[k] = r
      edgePt[k] = i
    }
  })

  return {
    version: data.version,
    ringsIn(minX, minY, maxX, maxY) {
      const out: Float64Array[] = []
      const sMin = Math.ceil(minX - 1)
      const sMax = Math.floor(maxX)
      for (let r = 0; r < n; r++) {
        const o = r * 4
        if (bbox[o + 3]! < minY || bbox[o + 1]! > maxY) continue
        for (let s = sMin; s <= sMax; s++) {
          if (bbox[o]! + s > maxX || bbox[o + 2]! + s < minX) continue
          if (s === 0) out.push(rings[r]!)
          else {
            const src = rings[r]!
            const shifted = new Float64Array(src.length)
            for (let i = 0; i < src.length; i += 2) {
              shifted[i] = src[i]! + s
              shifted[i + 1] = src[i + 1]!
            }
            out.push(shifted)
          }
        }
      }
      return out
    },
    isLand(at) {
      const [wx, y] = toXY([at[0], Math.min(Math.max(at[1], -MAX_LAT), MAX_LAT)])
      const x = wx - Math.floor(wx)
      const b = band(y)
      let inside = false
      for (let k = counts[b]!; k < counts[b + 1]!; k++) {
        const ring = rings[edgeRing[k]!]!
        const m = ring.length / 2
        const i = edgePt[k]!
        const j = i + 1 === m ? 0 : i + 1
        const ya = ring[i * 2 + 1]!
        const yb = ring[j * 2 + 1]!
        if (ya > y === yb > y) continue
        const xa = ring[i * 2]!
        const xi = xa + ((y - ya) * (ring[j * 2]! - xa)) / (yb - ya)
        if (xi > x) inside = !inside
      }
      return inside
    },
  }
}
