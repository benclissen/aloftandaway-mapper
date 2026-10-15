import { toLngLat, type XY } from './geo.js'
import type { LandSource } from './land.js'

/** A Mercator box. x may be unwrapped (outside 0 to 1). */
export interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Square cells over a box, row-major from the box's min corner. */
export interface WaterGrid {
  x0: number
  y0: number
  cell: number
  cols: number
  rows: number
  /** 1 for land, 0 for water. A water cell has no land in it. */
  land: Uint8Array
  /** Step multiplier: 3, 2 or 1.5 within 1, 2 or 3 cells of land, 1 on open water, Infinity on land. */
  cost: Float32Array
}

const KM_PER_WORLD = 40075.017

/** One Sutherland–Hodgman pass against `v >= bound` (or `<=`), on axis 0 (x) or 1 (y). Returns the point count. */
function clipSide(src: Float64Array, n: number, dst: Float64Array, axis: 0 | 1, bound: number, above: boolean): number {
  let m = 0
  let px = src[(n - 1) * 2]!
  let py = src[(n - 1) * 2 + 1]!
  let pv = axis === 0 ? px : py
  let pin = above ? pv >= bound : pv <= bound
  for (let i = 0; i < n; i++) {
    const cx = src[i * 2]!
    const cy = src[i * 2 + 1]!
    const cv = axis === 0 ? cx : cy
    const cin = above ? cv >= bound : cv <= bound
    if (cin !== pin) {
      const t = (bound - pv) / (cv - pv)
      dst[m * 2] = px + t * (cx - px)
      dst[m * 2 + 1] = py + t * (cy - py)
      m++
    }
    if (cin) {
      dst[m * 2] = cx
      dst[m * 2 + 1] = cy
      m++
    }
    px = cx
    py = cy
    pv = cv
    pin = cin
  }
  return m
}

/** The ring clipped to the box, or undefined if nothing is left. */
function clipRing(ring: Float64Array, box: Box): Float64Array | undefined {
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
  if (maxX < box.minX || minX > box.maxX || maxY < box.minY || minY > box.maxY) return undefined
  if (minX >= box.minX && maxX <= box.maxX && minY >= box.minY && maxY <= box.maxY) return ring
  let n = ring.length / 2
  let src = ring
  // Each pass at most doubles the point count.
  const sides: [0 | 1, number, boolean][] = [
    [0, box.minX, true],
    [0, box.maxX, false],
    [1, box.minY, true],
    [1, box.maxY, false],
  ]
  for (const [axis, bound, above] of sides) {
    if (n < 3) return undefined
    const dst = new Float64Array(n * 4)
    n = clipSide(src, n, dst, axis, bound, above)
    src = dst
  }
  return n < 3 ? undefined : src.subarray(0, n * 2)
}

/**
 * Rasterise land over `box` into square cells, `longSide` across the box's longer side.
 * A cell is land if its centre is inside land or a land edge passes through it.
 */
export function waterGrid(land: LandSource, box: Box, longSide = 1024): WaterGrid {
  const width = box.maxX - box.minX
  const height = box.maxY - box.minY
  const cell = Math.max(width, height) / longSide
  if (!(cell > 0) || !Number.isFinite(cell)) throw new Error('waterGrid needs a box with a positive size')
  const cols = Math.max(1, Math.ceil(width / cell - 1e-9))
  const rows = Math.max(1, Math.ceil(height / cell - 1e-9))
  const x0 = box.minX
  const y0 = box.minY
  const total = cols * rows
  const landMask = new Uint8Array(total)

  // Clip a cell beyond the grid, so the edges clipping adds along the clip box fall outside it.
  const clip: Box = { minX: x0 - cell, minY: y0 - cell, maxX: x0 + (cols + 1) * cell, maxY: y0 + (rows + 1) * cell }
  const rings: Float64Array[] = []
  for (const ring of land.ringsIn(clip.minX, clip.minY, clip.maxX, clip.maxY)) {
    const clipped = clipRing(ring, clip)
    if (clipped) rings.push(clipped)
  }

  // Ring coordinates in cell units from (x0, y0).
  const scaled = rings.map((ring) => {
    const out = new Float64Array(ring.length)
    for (let i = 0; i < ring.length; i += 2) {
      out[i] = (ring[i]! - x0) / cell
      out[i + 1] = (ring[i + 1]! - y0) / cell
    }
    return out
  })

  // Even-odd fill at cell-centre rows. Row r's centre is at v = r + 0.5.
  const rowRange = (va: number, vb: number): [number, number] => {
    const lo = Math.min(va, vb)
    const hi = Math.max(va, vb)
    // Rows with lo <= r + 0.5 < hi.
    return [Math.max(0, Math.ceil(lo - 0.5)), Math.min(rows - 1, Math.ceil(hi - 0.5) - 1)]
  }
  const counts = new Int32Array(rows + 1)
  for (const ring of scaled) {
    const m = ring.length / 2
    for (let i = 0; i < m; i++) {
      const j = i + 1 === m ? 0 : i + 1
      const [r0, r1] = rowRange(ring[i * 2 + 1]!, ring[j * 2 + 1]!)
      for (let r = r0; r <= r1; r++) counts[r + 1]!++
    }
  }
  for (let r = 0; r < rows; r++) counts[r + 1]! += counts[r]!
  const xs = new Float64Array(counts[rows]!)
  const next = counts.slice(0, rows)
  for (const ring of scaled) {
    const m = ring.length / 2
    for (let i = 0; i < m; i++) {
      const j = i + 1 === m ? 0 : i + 1
      const ua = ring[i * 2]!
      const va = ring[i * 2 + 1]!
      const ub = ring[j * 2]!
      const vb = ring[j * 2 + 1]!
      const [r0, r1] = rowRange(va, vb)
      for (let r = r0; r <= r1; r++) xs[next[r]!++] = ua + ((r + 0.5 - va) * (ub - ua)) / (vb - va)
    }
  }
  for (let r = 0; r < rows; r++) {
    const row = xs.subarray(counts[r]!, counts[r + 1]!).sort()
    for (let k = 0; k + 1 < row.length; k += 2) {
      // Columns with row[k] < c + 0.5 < row[k + 1].
      const c0 = Math.max(0, Math.floor(row[k]! - 0.5) + 1)
      const c1 = Math.min(cols - 1, Math.ceil(row[k + 1]! - 0.5) - 1)
      if (c1 >= c0) landMask.fill(1, r * cols + c0, r * cols + c1 + 1)
    }
  }

  // Every cell an edge passes through (grid traversal).
  for (const ring of scaled) {
    const m = ring.length / 2
    for (let i = 0; i < m; i++) {
      const j = i + 1 === m ? 0 : i + 1
      walkEdge(ring[i * 2]!, ring[i * 2 + 1]!, ring[j * 2]!, ring[j * 2 + 1]!, cols, rows, landMask)
    }
  }

  return { x0, y0, cell, cols, rows, land: landMask, cost: coastCost(landMask, cols, rows) }
}

/** Mark the cells the segment (in cell units) passes through. */
function walkEdge(ua: number, va: number, ub: number, vb: number, cols: number, rows: number, mask: Uint8Array): void {
  if ((ua < 0 && ub < 0) || (va < 0 && vb < 0) || (ua >= cols && ub >= cols) || (va >= rows && vb >= rows)) return
  let c = Math.floor(ua)
  let r = Math.floor(va)
  const du = ub - ua
  const dv = vb - va
  const sc = du > 0 ? 1 : -1
  const sr = dv > 0 ? 1 : -1
  const tdu = du !== 0 ? Math.abs(1 / du) : Infinity
  const tdv = dv !== 0 ? Math.abs(1 / dv) : Infinity
  let tu = du > 0 ? (c + 1 - ua) * tdu : du < 0 ? (ua - c) * tdu : Infinity
  let tv = dv > 0 ? (r + 1 - va) * tdv : dv < 0 ? (va - r) * tdv : Infinity
  const steps = Math.abs(Math.floor(ub) - c) + Math.abs(Math.floor(vb) - r)
  const mark = (): void => {
    if (c >= 0 && c < cols && r >= 0 && r < rows) mask[r * cols + c] = 1
  }
  mark()
  for (let s = 0; s < steps; s++) {
    if (tu < tv) {
      c += sc
      tu += tdu
    } else {
      r += sr
      tv += tdv
    }
    mark()
  }
}

/** Step costs from a 3-4 chamfer distance to land (3 per cell straight, 4 diagonal). */
function coastCost(land: Uint8Array, cols: number, rows: number): Float32Array {
  const far = 1 << 30
  const d = new Int32Array(land.length)
  for (let i = 0; i < land.length; i++) d[i] = land[i] ? 0 : far
  const relax = (i: number, j: number, w: number): void => {
    const v = d[j]! + w
    if (v < d[i]!) d[i] = v
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      if (c > 0) relax(i, i - 1, 3)
      if (r > 0) {
        relax(i, i - cols, 3)
        if (c > 0) relax(i, i - cols - 1, 4)
        if (c < cols - 1) relax(i, i - cols + 1, 4)
      }
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c
      if (c < cols - 1) relax(i, i + 1, 3)
      if (r < rows - 1) {
        relax(i, i + cols, 3)
        if (c < cols - 1) relax(i, i + cols + 1, 4)
        if (c > 0) relax(i, i + cols - 1, 4)
      }
    }
  }
  const cost = new Float32Array(land.length)
  for (let i = 0; i < land.length; i++) {
    const v = d[i]!
    cost[i] = v === 0 ? Infinity : v <= 3 ? 3 : v <= 6 ? 2 : v <= 9 ? 1.5 : 1
  }
  return cost
}

/** The index of the cell containing `xy`, or undefined outside the grid. */
export function cellAt(grid: WaterGrid, [x, y]: XY): number | undefined {
  const c = Math.floor((x - grid.x0) / grid.cell)
  const r = Math.floor((y - grid.y0) / grid.cell)
  if (!(c >= 0 && c < grid.cols && r >= 0 && r < grid.rows)) return undefined
  return r * grid.cols + c
}

export function cellCentre(grid: WaterGrid, index: number): XY {
  const c = index % grid.cols
  const r = Math.floor(index / grid.cols)
  return [grid.x0 + (c + 0.5) * grid.cell, grid.y0 + (r + 0.5) * grid.cell]
}

/**
 * The water cell nearest `xy` by centre distance, within `maxKm`, or undefined if there is none.
 * A point already in a water cell gets that cell.
 */
export function snapToWater(grid: WaterGrid, xy: XY, maxKm: number): number | undefined {
  const own = cellAt(grid, xy)
  if (own !== undefined && grid.land[own] === 0) return own
  const lat = toLngLat(xy)[1]
  const radius = maxKm / (KM_PER_WORLD * Math.cos((lat * Math.PI) / 180))
  if (!(radius >= 0)) return undefined
  const { x0, y0, cell, cols, rows } = grid
  const c0 = Math.max(0, Math.floor((xy[0] - radius - x0) / cell))
  const c1 = Math.min(cols - 1, Math.floor((xy[0] + radius - x0) / cell))
  const r0 = Math.max(0, Math.floor((xy[1] - radius - y0) / cell))
  const r1 = Math.min(rows - 1, Math.floor((xy[1] + radius - y0) / cell))
  let best: number | undefined
  let bestD = radius * radius
  for (let r = r0; r <= r1; r++) {
    const dy = y0 + (r + 0.5) * cell - xy[1]
    for (let c = c0; c <= c1; c++) {
      const i = r * cols + c
      if (grid.land[i] !== 0) continue
      const dx = x0 + (c + 0.5) * cell - xy[0]
      const d = dx * dx + dy * dy
      if (d < bestD || (d === bestD && best === undefined)) {
        best = i
        bestD = d
      }
    }
  }
  return best
}

/** The first point, sampling every quarter cell from `a` to `b`, that lies in a land cell. */
export function firstLandOnSegment(grid: WaterGrid, a: XY, b: XY): XY | undefined {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (grid.cell / 4)))
  for (let k = 0; k <= n; k++) {
    const p: XY = [a[0] + (dx * k) / n, a[1] + (dy * k) / n]
    const i = cellAt(grid, p)
    if (i !== undefined && grid.land[i] === 1) return p
  }
  return undefined
}
