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
  /** Land pixels from basemap tiles. Wherever a tile is loaded it overrides the rings. */
  tiles?: TileLand
}

/** The zoom and pixels per side at which basemap tiles are read for water. */
export const WATER_ZOOM = 12
export const TILE_PIXELS = 512

/** A decoded tile feature's rings, in tile units (0 to the extent, y down). Ring orientation doesn't matter. */
export interface TileFeature {
  rings: { x: number; y: number }[][]
}

/** One tile's pixels, row 0 at the north edge. */
export interface LandTile {
  /** The number of land pixels in the inclusive pixel rectangle, clamped to the tile. */
  landIn(c0: number, r0: number, c1: number, r1: number): number
}

/** Loaded tiles at one zoom. `x` wraps into 0 to 2^zoom − 1; `y` off the Mercator square has no tile. */
export interface TileLand {
  zoom: number
  pixels: number
  tile(x: number, y: number): LandTile | undefined
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

/** The pixels in the clamped inclusive rectangle, or 0 if it's empty. */
function areaIn(pixels: number, c0: number, r0: number, c1: number, r1: number): number {
  const w = Math.min(pixels - 1, c1) - Math.max(0, c0) + 1
  const h = Math.min(pixels - 1, r1) - Math.max(0, r0) + 1
  return w > 0 && h > 0 ? w * h : 0
}

export function allLand(pixels = TILE_PIXELS): LandTile {
  return { landIn: (c0, r0, c1, r1) => areaIn(pixels, c0, r0, c1, r1) }
}

export function allWater(): LandTile {
  return { landIn: () => 0 }
}

function popcount(v: number): number {
  let n = v - ((v >>> 1) & 0x55555555)
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333)
  return (Math.imul((n + (n >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 0xff
}

const BLOCK = 8

/**
 * A tile's land pixels. A pixel is water when its centre is inside a feature: even-odd over the feature's rings,
 * and water if any feature says so. Geometry outside the tile square only matters as part of a ring around a
 * centre.
 *
 * Water is kept one bit per pixel, and water counts per 8 × 8 block in a summed-area table, so `landIn` reads the
 * blocks wholly inside the rectangle from the table and only the edge rows and columns bit by bit.
 */
export function rasteriseTile(features: TileFeature[], extent: number, pixels = TILE_PIXELS): LandTile {
  const words = Math.ceil(pixels / 32)
  const bits = new Uint32Array(words * pixels)
  const scale = pixels / extent
  const fill = (r: number, c0: number, c1: number): void => {
    const row = r * words
    for (let w = c0 >>> 5; w <= c1 >>> 5; w++) {
      const lo = Math.max(c0, w * 32) - w * 32
      const hi = Math.min(c1, w * 32 + 31) - w * 32
      bits[row + w]! |= hi - lo === 31 ? 0xffffffff : ((1 << (hi - lo + 1)) - 1) << lo
    }
  }

  for (const { rings } of features) {
    // Ring coordinates in pixel units, and the pixel rows whose centre (v = r + 0.5) the feature spans.
    const scaled = rings.map((ring) => ring.flatMap(({ x, y }) => [x * scale, y * scale]))
    let vMin = Infinity
    let vMax = -Infinity
    for (const ring of scaled) {
      for (let i = 1; i < ring.length; i += 2) {
        if (ring[i]! < vMin) vMin = ring[i]!
        if (ring[i]! > vMax) vMax = ring[i]!
      }
    }
    const rTop = Math.max(0, Math.ceil(vMin - 0.5))
    const rEnd = Math.min(pixels - 1, Math.ceil(vMax - 0.5) - 1)
    if (rEnd < rTop) continue
    // Crossings of each row by edge, rows with lo <= r + 0.5 < hi, as in `waterGridAt`.
    const xs: number[][] = Array.from({ length: rEnd - rTop + 1 }, () => [])
    for (const ring of scaled) {
      const m = ring.length / 2
      for (let i = 0; i < m; i++) {
        const j = i + 1 === m ? 0 : i + 1
        const ua = ring[i * 2]!
        const va = ring[i * 2 + 1]!
        const ub = ring[j * 2]!
        const vb = ring[j * 2 + 1]!
        const r0 = Math.max(rTop, Math.ceil(Math.min(va, vb) - 0.5))
        const r1 = Math.min(rEnd, Math.ceil(Math.max(va, vb) - 0.5) - 1)
        for (let r = r0; r <= r1; r++) xs[r - rTop]!.push(ua + ((r + 0.5 - va) * (ub - ua)) / (vb - va))
      }
    }
    xs.forEach((row, k) => {
      row.sort((a, b) => a - b)
      for (let i = 0; i + 1 < row.length; i += 2) {
        // Columns with row[i] < c + 0.5 < row[i + 1].
        const c0 = Math.max(0, Math.floor(row[i]! - 0.5) + 1)
        const c1 = Math.min(pixels - 1, Math.ceil(row[i + 1]! - 0.5) - 1)
        if (c1 >= c0) fill(rTop + k, c0, c1)
      }
    })
  }

  // Water per block, summed: sat[(by * stride) + bx] is the water in blocks above and left of (bx, by).
  const blocks = Math.ceil(pixels / BLOCK)
  const stride = blocks + 1
  const sat = new Int32Array(stride * stride)
  for (let r = 0; r < pixels; r++) {
    const by = (r / BLOCK) | 0
    for (let bx = 0; bx < blocks; bx++) {
      const word = bits[r * words + (bx >>> 2)]!
      sat[(by + 1) * stride + bx + 1]! += popcount((word >>> ((bx & 3) * BLOCK)) & 0xff)
    }
  }
  for (let by = 1; by <= blocks; by++) {
    for (let bx = 1; bx <= blocks; bx++) {
      const i = by * stride + bx
      sat[i]! += sat[i - 1]! + sat[i - stride]! - sat[i - stride - 1]!
    }
  }

  /** Water bit by bit in rows r0 to r1, columns c0 to c1. */
  const waterBits = (r0: number, r1: number, c0: number, c1: number): number => {
    if (r1 < r0 || c1 < c0) return 0
    let n = 0
    const w0 = c0 >>> 5
    const w1 = c1 >>> 5
    const first = (0xffffffff << (c0 & 31)) >>> 0
    const last = (c1 & 31) === 31 ? 0xffffffff : (1 << ((c1 & 31) + 1)) - 1
    for (let r = r0; r <= r1; r++) {
      const row = r * words
      if (w0 === w1) n += popcount(bits[row + w0]! & first & last)
      else {
        n += popcount(bits[row + w0]! & first) + popcount(bits[row + w1]! & last)
        for (let w = w0 + 1; w < w1; w++) n += popcount(bits[row + w]!)
      }
    }
    return n
  }

  return {
    landIn(c0, r0, c1, r1) {
      const area = areaIn(pixels, c0, r0, c1, r1)
      if (area === 0) return 0
      const ca = Math.max(0, c0)
      const ra = Math.max(0, r0)
      const cb = Math.min(pixels - 1, c1)
      const rb = Math.min(pixels - 1, r1)
      // The blocks wholly inside the rectangle.
      const bx0 = Math.ceil(ca / BLOCK)
      const by0 = Math.ceil(ra / BLOCK)
      const bx1 = Math.floor((cb + 1) / BLOCK) - 1
      const by1 = Math.floor((rb + 1) / BLOCK) - 1
      if (bx1 < bx0 || by1 < by0) return area - waterBits(ra, rb, ca, cb)
      const top = by0 * BLOCK
      const bottom = (by1 + 1) * BLOCK - 1
      const water =
        sat[(by1 + 1) * stride + bx1 + 1]! -
        sat[by0 * stride + bx1 + 1]! -
        sat[(by1 + 1) * stride + bx0]! +
        sat[by0 * stride + bx0]! +
        waterBits(ra, top - 1, ca, cb) +
        waterBits(bottom + 1, rb, ca, cb) +
        waterBits(top, bottom, ca, bx0 * BLOCK - 1) +
        waterBits(top, bottom, (bx1 + 1) * BLOCK, cb)
      return area - water
    },
  }
}

/** A TileLand over tiles keyed `"x/y"`. */
export function tileLand(tiles: ReadonlyMap<string, LandTile>, zoom = WATER_ZOOM, pixels = TILE_PIXELS): TileLand {
  const span = 2 ** zoom
  return {
    zoom,
    pixels,
    tile(x, y) {
      if (!(y >= 0 && y < span)) return undefined
      return tiles.get(`${((x % span) + span) % span}/${y}`)
    },
  }
}

/** `base` with `tiles` over it: `isLand` reads a loaded tile's pixel, and the rings elsewhere. */
export function withTiles(base: LandSource, tiles: TileLand, version: string): LandSource {
  const span = 2 ** tiles.zoom
  const n = tiles.pixels
  return {
    version,
    ringsIn: (minX, minY, maxX, maxY) => base.ringsIn(minX, minY, maxX, maxY),
    isLand(at) {
      const [wx, y] = toXY([at[0], clampLat(at[1])])
      const gx = (wx - Math.floor(wx)) * span
      const gy = y * span
      const tx = Math.floor(gx)
      const ty = Math.floor(gy)
      const tile = ty >= 0 && ty < span ? tiles.tile(tx % span, ty) : undefined
      if (!tile) return base.isLand(at)
      const c = Math.min(n - 1, Math.floor((gx - tx) * n))
      const r = Math.min(n - 1, Math.floor((gy - ty) * n))
      return tile.landIn(c, r, c, r) > 0
    },
    tiles,
  }
}
