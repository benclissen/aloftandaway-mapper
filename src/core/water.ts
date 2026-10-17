import { toLngLat, type XY } from './geo.js'
import type { LandSource, LandTile, TileLand } from './land.js'

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
  /** 1 for a cell that is all land: its centre is in land and no land edge passes through it. */
  solid: Uint8Array
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

/** Where a grid's cells lie: the min corner, the cell size and the cell counts. */
export interface GridFrame {
  x0: number
  y0: number
  cell: number
  cols: number
  rows: number
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
  return waterGridAt(land, { x0: box.minX, y0: box.minY, cell, cols, rows })
}

/** Rasterise land into the cells of `frame`, the same way as `waterGrid`. */
export function waterGridAt(land: LandSource, frame: GridFrame): WaterGrid {
  const { x0, y0, cell, cols, rows } = frame
  if (!(cell > 0) || !Number.isFinite(cell)) throw new Error('waterGrid needs a positive cell size')
  const total = cols * rows
  const fillMask = new Uint8Array(total)
  const edgeMask = new Uint8Array(total)

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
      if (c1 >= c0) fillMask.fill(1, r * cols + c0, r * cols + c1 + 1)
    }
  }

  // Every cell an edge passes through (grid traversal).
  for (const ring of scaled) {
    const m = ring.length / 2
    for (let i = 0; i < m; i++) {
      const j = i + 1 === m ? 0 : i + 1
      walkEdge(ring[i * 2]!, ring[i * 2 + 1]!, ring[j * 2]!, ring[j * 2 + 1]!, cols, rows, edgeMask)
    }
  }

  const landMask = new Uint8Array(total)
  const solid = new Uint8Array(total)
  for (let i = 0; i < total; i++) {
    landMask[i] = fillMask[i]! | edgeMask[i]!
    solid[i] = fillMask[i]! & (edgeMask[i]! ^ 1)
  }
  if (land.tiles) overlayTiles(land.tiles, frame, landMask, solid)
  return { x0, y0, cell, cols, rows, land: landMask, solid, cost: coastCost(landMask, cols, rows) }
}

/**
 * Read loaded tiles over the ring result. A pixel counts for a cell when their squares overlap with positive area.
 * A cell wholly on loaded tiles is land when any of its pixels is land, and solid when all are. A cell partly on
 * them keeps its ring land and adds the tiles' land, and stays solid only if the rings and every pixel say so.
 */
function overlayTiles(tiles: TileLand, frame: GridFrame, land: Uint8Array, solid: Uint8Array): void {
  const { x0, y0, cell, cols, rows } = frame
  const n = tiles.pixels
  const span = 2 ** tiles.zoom
  const world = span * n
  // Each column's pixels in world pixel units (x unwrapped), and its tiles.
  const pc0 = new Float64Array(cols)
  const pc1 = new Float64Array(cols)
  for (let c = 0; c < cols; c++) {
    pc0[c] = Math.floor((x0 + c * cell) * world)
    pc1[c] = Math.ceil((x0 + (c + 1) * cell) * world) - 1
  }
  const txFirst = Math.floor(pc0[0]! / n)
  const txLast = Math.floor(pc1[cols - 1]! / n)
  // Loaded tiles along a tile row, from txFirst, or null if it has none. Rows only move down the grid.
  const tileRows = new Map<number, (LandTile | undefined)[] | null>()
  const tileRow = (ty: number): (LandTile | undefined)[] | null => {
    let row = tileRows.get(ty)
    if (row === undefined) {
      row = null
      if (ty >= 0 && ty < span) {
        const found: (LandTile | undefined)[] = []
        for (let tx = txFirst; tx <= txLast; tx++) found.push(tiles.tile(((tx % span) + span) % span, ty))
        if (found.some((t) => t)) row = found
      }
      tileRows.set(ty, row)
    }
    return row
  }

  for (let r = 0; r < rows; r++) {
    const pr0 = Math.floor((y0 + r * cell) * world)
    const pr1 = Math.ceil((y0 + (r + 1) * cell) * world) - 1
    const ty0 = Math.floor(pr0 / n)
    const ty1 = Math.floor(pr1 / n)
    for (const ty of tileRows.keys()) if (ty < ty0) tileRows.delete(ty)
    let loaded = false
    for (let ty = ty0; ty <= ty1; ty++) if (tileRow(ty)) loaded = true
    if (!loaded) continue
    for (let c = 0; c < cols; c++) {
      const tx0 = Math.floor(pc0[c]! / n)
      const tx1 = Math.floor(pc1[c]! / n)
      let covered = true
      let some = false
      let any = false
      let all = true
      for (let ty = ty0; ty <= ty1; ty++) {
        const row = tileRow(ty)
        const lr0 = Math.max(pr0, ty * n) - ty * n
        const lr1 = Math.min(pr1, ty * n + n - 1) - ty * n
        for (let tx = tx0; tx <= tx1; tx++) {
          const tile = row?.[tx - txFirst]
          if (!tile) {
            covered = false
            continue
          }
          some = true
          const lc0 = Math.max(pc0[c]!, tx * n) - tx * n
          const lc1 = Math.min(pc1[c]!, tx * n + n - 1) - tx * n
          const count = tile.landIn(lc0, lr0, lc1, lr1)
          if (count > 0) any = true
          if (count < (lc1 - lc0 + 1) * (lr1 - lr0 + 1)) all = false
        }
      }
      if (!some) continue
      const i = r * cols + c
      if (covered) {
        land[i] = any ? 1 : 0
        solid[i] = all ? 1 : 0
      } else {
        land[i] = any ? 1 : land[i]!
        solid[i] = all ? solid[i]! : 0
      }
    }
  }
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

/**
 * The part of the segment from `a` to `b`, as a range of t from 0 at `a` to 1 at `b`, that lies within `tMin` to
 * `tMax` and inside the grid. Undefined if none of it does.
 */
export function segmentInGrid(grid: GridFrame, a: XY, b: XY, tMin = 0, tMax = 1): [number, number] | undefined {
  let t0 = tMin
  let t1 = tMax
  const ends: [number, number, number][] = [
    [a[0] - grid.x0, b[0] - a[0], grid.cols * grid.cell],
    [a[1] - grid.y0, b[1] - a[1], grid.rows * grid.cell],
  ]
  for (const [p, d, size] of ends) {
    if (d === 0) {
      if (p < 0 || p > size) return undefined
      continue
    }
    const ta = -p / d
    const tb = (size - p) / d
    t0 = Math.max(t0, Math.min(ta, tb))
    t1 = Math.min(t1, Math.max(ta, tb))
  }
  return t0 <= t1 ? [t0, t1] : undefined
}

/**
 * The first t, from `tMin` to `tMax` along the segment from `a` (t = 0) to `b` (t = 1), at which the segment is in
 * a land cell. Walks every cell the segment passes through, so it can't step over a corner of land. Outside the
 * grid counts as water.
 */
export function landAlong(grid: WaterGrid, a: XY, b: XY, tMin = 0, tMax = 1): number | undefined {
  const range = segmentInGrid(grid, a, b, tMin, tMax)
  if (!range) return undefined
  const [t0, t1] = range
  const { cols, rows, cell, land } = grid
  const ua = (a[0] - grid.x0) / cell
  const va = (a[1] - grid.y0) / cell
  const du = (b[0] - a[0]) / cell
  const dv = (b[1] - a[1]) / cell
  const startU = ua + du * t0
  const startV = va + dv * t0
  // A start on a cell edge, heading down, is in the cell below the edge.
  let c = Math.min(cols - 1, Math.max(0, du < 0 ? Math.ceil(startU) - 1 : Math.floor(startU)))
  let r = Math.min(rows - 1, Math.max(0, dv < 0 ? Math.ceil(startV) - 1 : Math.floor(startV)))
  const sc = du > 0 ? 1 : -1
  const sr = dv > 0 ? 1 : -1
  const stepU = du !== 0 ? Math.abs(1 / du) : Infinity
  const stepV = dv !== 0 ? Math.abs(1 / dv) : Infinity
  let nextU = du > 0 ? (c + 1 - ua) / du : du < 0 ? (c - ua) / du : Infinity
  let nextV = dv > 0 ? (r + 1 - va) / dv : dv < 0 ? (r - va) / dv : Infinity
  const inGrid = (cc: number, rr: number): boolean => cc >= 0 && cc < cols && rr >= 0 && rr < rows
  // Steps closer than this, in t, count as one step through a corner.
  const tie = 1e-7 * Math.min(stepU, stepV)
  let t = t0
  for (;;) {
    if (land[r * cols + c] === 1) return t
    if (Math.abs(nextU - nextV) <= tie) {
      // Through a corner: both cells beside it count, so a segment that grazes a corner of land meets it.
      t = Math.min(nextU, nextV)
      if (t > t1) return undefined
      if (inGrid(c + sc, r) && land[r * cols + c + sc] === 1) return t
      if (inGrid(c, r + sr) && land[(r + sr) * cols + c] === 1) return t
      c += sc
      r += sr
      nextU += stepU
      nextV += stepV
    } else if (nextU < nextV) {
      if (nextU > t1) return undefined
      t = nextU
      c += sc
      nextU += stepU
    } else {
      if (nextV > t1) return undefined
      t = nextV
      r += sr
      nextV += stepV
    }
    if (!inGrid(c, r)) return undefined
  }
}

/** The first point on the segment from `a` to `b` that lies in a land cell. Outside the grid counts as water. */
export function firstLandOnSegment(grid: WaterGrid, a: XY, b: XY): XY | undefined {
  const t = landAlong(grid, a, b)
  return t === undefined ? undefined : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

/**
 * Connected regions of open cells (`blocked[i] === 0`), joined the way the sea router moves: to the 8 neighbours,
 * but diagonally only when both cells beside the step are open. Blocked cells get -1.
 */
export function labelWater(frame: Pick<GridFrame, 'cols' | 'rows'>, blocked: Uint8Array): Int32Array {
  const { cols, rows } = frame
  const labels = new Int32Array(cols * rows).fill(-1)
  const queue = new Int32Array(cols * rows)
  let next = 0
  for (let seed = 0; seed < labels.length; seed++) {
    if (blocked[seed] || labels[seed] !== -1) continue
    const id = next++
    labels[seed] = id
    let head = 0
    let tail = 0
    queue[tail++] = seed
    while (head < tail) {
      const i = queue[head++]!
      const c = i % cols
      const r = (i - c) / cols
      for (let dr = -1; dr <= 1; dr++) {
        const nr = r + dr
        if (nr < 0 || nr >= rows) continue
        for (let dc = -1; dc <= 1; dc++) {
          const nc = c + dc
          if ((dr === 0 && dc === 0) || nc < 0 || nc >= cols) continue
          const j = nr * cols + nc
          if (blocked[j] || labels[j] !== -1) continue
          if (dr !== 0 && dc !== 0 && (blocked[r * cols + nc] || blocked[nr * cols + c])) continue
          labels[j] = id
          queue[tail++] = j
        }
      }
    }
  }
  return labels
}

/** Km per Mercator unit at Mercator `y`. */
export function kmPerUnit(y: number): number {
  return KM_PER_WORLD * Math.cos((toLngLat([0, y])[1] * Math.PI) / 180)
}

/**
 * For each region that has an open cell within `maxKm` of `xy` (by cell centre), the nearest such cell and its
 * distance in Mercator units. A point in an open cell gets that cell at distance 0 for its region.
 */
export function nearestByRegion(
  frame: GridFrame,
  blocked: Uint8Array,
  labels: Int32Array,
  xy: XY,
  maxKm: number,
): Map<number, { cell: number; d: number }> {
  const out = new Map<number, { cell: number; d: number }>()
  const { x0, y0, cell, cols, rows } = frame
  const c = Math.floor((xy[0] - x0) / cell)
  const r = Math.floor((xy[1] - y0) / cell)
  if (c >= 0 && c < cols && r >= 0 && r < rows && !blocked[r * cols + c]) out.set(labels[r * cols + c]!, { cell: r * cols + c, d: 0 })
  const radius = maxKm / kmPerUnit(xy[1])
  if (!(radius > 0)) return out
  const c0 = Math.max(0, Math.floor((xy[0] - radius - x0) / cell))
  const c1 = Math.min(cols - 1, Math.floor((xy[0] + radius - x0) / cell))
  const r0 = Math.max(0, Math.floor((xy[1] - radius - y0) / cell))
  const r1 = Math.min(rows - 1, Math.floor((xy[1] + radius - y0) / cell))
  const limit = radius * radius
  for (let rr = r0; rr <= r1; rr++) {
    const dy = y0 + (rr + 0.5) * cell - xy[1]
    for (let cc = c0; cc <= c1; cc++) {
      const i = rr * cols + cc
      if (blocked[i]) continue
      const dx = x0 + (cc + 0.5) * cell - xy[0]
      const d2 = dx * dx + dy * dy
      if (d2 >= limit) continue
      const d = Math.sqrt(d2)
      const best = out.get(labels[i]!)
      if (!best || d < best.d) out.set(labels[i]!, { cell: i, d })
    }
  }
  return out
}
