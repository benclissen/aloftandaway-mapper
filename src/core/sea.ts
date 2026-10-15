import { curveThrough } from './curve.js'
import { toLngLat, toXY, unwrapLng, type XY } from './geo.js'
import type { LandSource } from './land.js'
import type { LngLat, ViaPoint } from './schema.js'
import {
  cellAt,
  cellCentre,
  kmPerUnit,
  labelWater,
  landAlong,
  nearestByRegion,
  segmentInGrid,
  waterGrid,
  waterGridAt,
  type Box,
  type GridFrame,
  type WaterGrid,
} from './water.js'

/** Bump when routing changes, so cached paths are recomputed. */
export const ROUTER_VERSION = 2
/** The fallback reason when there is no land data to route with. */
export const NO_LAND_DATA = "Mapper's land data could not be loaded"
/** How far a stop or via point may be from the nearest water cell. */
export const MAX_SNAP_KM = 30

export interface SeaPath {
  status: 'ok' | 'fallback'
  /** Why the leg fell back, for the user. */
  reason?: string
  /**
   * Unwrapped from `from`'s longitude. `path[0]` is exactly `from`, `path[knots[i + 1]]` is exactly
   * via `i`, and the last point is exactly `to`. Empty on fallback.
   */
  path: LngLat[]
  /** Indices into `path` of `from`, each via point in order, and `to`. Empty on fallback. */
  knots: number[]
  /** The first point where the path crosses land outside the stop connectors, wrapped to ±180. */
  crossesLand?: LngLat
}

export type SeaPaths = Record<string, SeaPath>

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK_64 = 0xffffffffffffffffn

/** A cache key for one sea leg: 16 hex characters of FNV-1a 64 over its inputs. */
export function seaLegKey(from: LngLat, to: LngLat, via: ViaPoint[]): string {
  const text = JSON.stringify([ROUTER_VERSION, from, to, via.map((v) => [v.at, v.sharp === true])])
  let hash = FNV_OFFSET
  for (const byte of new TextEncoder().encode(text)) hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK_64
  return hash.toString(16).padStart(16, '0')
}

/** `lng` shifted by whole turns into [-180, 180). */
const wrapLng = (lng: number): number => ((((lng + 180) % 360) + 360) % 360) - 180

const same = (a: XY, b: XY): boolean => a[0] === b[0] && a[1] === b[1]

/** Finds where a segment first meets land. */
interface Mask {
  /** The first t, from 0 at `a` to 1 at `b`, at which the segment from `a` to `b` is on land, within `tMin` to `tMax`. */
  landAlong(a: XY, b: XY, tMin?: number, tMax?: number): number | undefined
}

/** Land by `grid`'s cells; outside the grid, land by `outside` (or water when there is none). */
const gridMask = (grid: WaterGrid, outside?: Mask): Mask => ({
  landAlong(a, b, tMin = 0, tMax = 1) {
    const inside = segmentInGrid(grid, a, b, tMin, tMax)
    if (!outside) return inside && landAlong(grid, a, b, ...inside)
    if (!inside) return outside.landAlong(a, b, tMin, tMax)
    return (
      (inside[0] > tMin ? outside.landAlong(a, b, tMin, inside[0]) : undefined) ??
      landAlong(grid, a, b, ...inside) ??
      (inside[1] < tMax ? outside.landAlong(a, b, inside[1], tMax) : undefined)
    )
  },
})

/** The first point on the segment from `a` to `b` that `mask` says is land. */
function firstLand(mask: Mask, a: XY, b: XY): XY | undefined {
  const t = mask.landAlong(a, b)
  return t === undefined ? undefined : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

/** A stretch of the sea between two controls: its water points, end to end, and the land mask for each span. */
interface Passage {
  /** First and last are the controls themselves when they lie in water, else their snapped cell centres. */
  points: XY[]
  /** `masks[i]` checks the span from `points[i]` to `points[i + 1]`. */
  masks: Mask[]
  /** For connectors when there are no spans. */
  base: Mask
}

type Failure = { snap: number } | { search: true }

/**
 * A* over the 8-neighbours of cells that aren't `blocked`, with each step costing its length times the mean of
 * the two cells' `cost`. Returns the cell path from `start` to `goal`, or undefined.
 */
function search(
  frame: GridFrame,
  blocked: Uint8Array,
  cost: Float32Array,
  start: number,
  goal: number,
): number[] | undefined {
  const { cols, rows, cell } = frame
  const total = cols * rows
  const g = new Float64Array(total).fill(Infinity)
  const parent = new Int32Array(total).fill(-1)
  const closed = new Uint8Array(total)
  const gc = goal % cols
  const gr = Math.floor(goal / cols)
  const diag = Math.SQRT2 - 1
  const h = (i: number): number => {
    const dx = Math.abs((i % cols) - gc)
    const dy = Math.abs(Math.floor(i / cols) - gr)
    return cell * (Math.max(dx, dy) + diag * Math.min(dx, dy))
  }

  // Binary min-heap of (f, cell), with stale entries skipped on pop.
  let heapF = new Float64Array(1024)
  let heapI = new Int32Array(1024)
  let size = 0
  const push = (f: number, i: number): void => {
    if (size === heapF.length) {
      const nf = new Float64Array(size * 2)
      nf.set(heapF)
      heapF = nf
      const ni = new Int32Array(size * 2)
      ni.set(heapI)
      heapI = ni
    }
    let k = size++
    while (k > 0) {
      const p = (k - 1) >> 1
      if (heapF[p]! <= f) break
      heapF[k] = heapF[p]!
      heapI[k] = heapI[p]!
      k = p
    }
    heapF[k] = f
    heapI[k] = i
  }
  const pop = (): number => {
    const top = heapI[0]!
    const f = heapF[--size]!
    const i = heapI[size]!
    let k = 0
    for (;;) {
      let c = 2 * k + 1
      if (c >= size) break
      if (c + 1 < size && heapF[c + 1]! < heapF[c]!) c++
      if (heapF[c]! >= f) break
      heapF[k] = heapF[c]!
      heapI[k] = heapI[c]!
      k = c
    }
    heapF[k] = f
    heapI[k] = i
    return top
  }

  g[start] = 0
  push(h(start), start)
  const straight = cell
  const diagonal = cell * Math.SQRT2
  while (size > 0) {
    const i = pop()
    if (closed[i]) continue
    if (i === goal) {
      const out = [i]
      for (let k = parent[i]!; k !== -1; k = parent[k]!) out.push(k)
      return out.reverse()
    }
    closed[i] = 1
    const c = i % cols
    const r = Math.floor(i / cols)
    const gi = g[i]!
    const ci = cost[i]!
    for (let dr = -1; dr <= 1; dr++) {
      const nr = r + dr
      if (nr < 0 || nr >= rows) continue
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue
        const nc = c + dc
        if (nc < 0 || nc >= cols) continue
        const j = nr * cols + nc
        if (blocked[j] || closed[j]) continue
        // No corner cutting: a diagonal step needs both cells beside it in water.
        if (dr !== 0 && dc !== 0 && (blocked[r * cols + nc] || blocked[nr * cols + c])) continue
        const step = (dr !== 0 && dc !== 0 ? diagonal : straight) * ((ci + cost[j]!) / 2)
        const gj = gi + step
        if (gj < g[j]!) {
          g[j] = gj
          parent[j] = i
          push(gj + h(j), j)
        }
      }
    }
  }
  return undefined
}

/**
 * String pulling: from each kept point, keep the furthest later point the grid says is reachable.
 * Scanning stops after a run of unreachable points, so a far point behind a headland isn't tested.
 */
function pull(mask: Mask, points: XY[]): XY[] {
  const out = [points[0]!]
  let i = 0
  while (i < points.length - 1) {
    let best = i + 1
    let misses = 0
    for (let j = i + 2; j < points.length && misses < 16; j++) {
      if (firstLand(mask, points[i]!, points[j]!) === undefined) {
        best = j
        misses = 0
      } else misses++
    }
    out.push(points[best]!)
    i = best
  }
  return out
}

/** Step cost on a coarse cell that has some land and some water in it. */
const MIXED_COST = 4
/** The cell size, in km, that fine grids aim for. */
const FINE_KM = 0.2
/** The most cells along either side of a fine grid. */
const MAX_FINE_SIDE = 2048
/** Coarse cells of open water a fine grid reaches beyond the stretch it refines. */
const FINE_MARGIN = 4
/** Stretches needing a fine grid that are this many open coarse cells apart or fewer share one. */
const MERGE_GAP = 2 * FINE_MARGIN
/** How many times a coarse route may be rejected by its fine grids before the leg falls back. */
const MAX_ROUNDS = 8

/**
 * The cells to start and end on: for each end, the nearest open cell within its limit, both in one region, choosing
 * the region where the two snaps add up shortest. `snap` names an end with no open cell in reach; undefined means
 * no region reaches both.
 */
function snapPair(
  frame: GridFrame,
  blocked: Uint8Array,
  labels: Int32Array,
  a: XY,
  b: XY,
  kmA: number,
  kmB: number,
): { start: number; goal: number } | { snap: 0 | 1 } | undefined {
  const near = nearestByRegion(frame, blocked, labels, a, kmA)
  if (near.size === 0) return { snap: 0 }
  const far = nearestByRegion(frame, blocked, labels, b, kmB)
  if (far.size === 0) return { snap: 1 }
  let best: { start: number; goal: number; d: number } | undefined
  for (const [id, s] of near) {
    const g = far.get(id)
    if (g && (!best || s.d + g.d < best.d)) best = { start: s.cell, goal: g.cell, d: s.d + g.d }
  }
  return best && { start: best.start, goal: best.goal }
}

/** How far a stop may snap on a grid with cells `cellKm` across. */
const snapKm = (cellKm: number): number => Math.max(MAX_SNAP_KM, 1.5 * cellKm)

/**
 * The water points from `a` to `b`. A coarse grid over their box, grown by `grow` times the usual margin, finds the
 * way: it lets the route through cells with any water in them, so narrow straits and harbours stay open. Where the
 * coarse route touches land, a fine grid over that stretch finds the actual water. If a fine grid shows the coarse
 * route was blocked, those coarse cells are shut and the coarse route is found again.
 */
function passage(land: LandSource, a: XY, b: XY, grow: number): Passage | Failure {
  const minX = Math.min(a[0], b[0])
  const maxX = Math.max(a[0], b[0])
  const minY = Math.min(a[1], b[1])
  const maxY = Math.max(a[1], b[1])
  const margin = grow * Math.max(0.5 * Math.max(maxX - minX, maxY - minY), 0.5 / 360)
  const box: Box = {
    minX: minX - margin,
    minY: Math.max(0, minY - margin),
    maxX: maxX + margin,
    maxY: Math.min(1, maxY + margin),
  }
  const coarse = waterGrid(land, box)
  const coarseMask = gridMask(coarse)
  // Only cells that are all land are shut to the coarse route, plus any its fine grids shut.
  const blocked = coarse.solid.slice()
  const cost = new Float32Array(blocked.length)
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const labels = labelWater(coarse, blocked)
    const kmA = snapKm(coarse.cell * kmPerUnit(a[1]))
    const kmB = snapKm(coarse.cell * kmPerUnit(b[1]))
    const ends = snapPair(coarse, blocked, labels, a, b, kmA, kmB)
    if (!ends) return { search: true }
    if ('snap' in ends) return round === 0 ? ends : { search: true }
    for (let i = 0; i < cost.length; i++) cost[i] = blocked[i] ? Infinity : coarse.land[i] ? MIXED_COST : coarse.cost[i]!
    const cells = search(coarse, blocked, cost, ends.start, ends.goal)
    if (!cells) return { search: true }
    const out = refine(land, coarse, coarseMask, blocked, cells, a, b)
    if (!('shut' in out)) return out
    if (out.shut === 0) return { search: true }
  }
  return { search: true }
}

/**
 * Turns a coarse cell route into water points: open stretches as coarse cell centres, and each stretch that
 * touches land (or starts or ends off the controls) through a fine grid. When a fine grid finds the stretch
 * blocked, shuts the coarse cells it couldn't reach and says how many.
 */
function refine(
  land: LandSource,
  coarse: WaterGrid,
  coarseMask: Mask,
  blocked: Uint8Array,
  cells: number[],
  a: XY,
  b: XY,
): Passage | { snap: 0 | 1 } | { shut: number } {
  const last = cells.length - 1
  const tight = cells.map((c) => coarse.land[c] !== 0)
  // A diagonal step between open cells past the corner of a cell with land in it needs the fine grid too.
  for (let t = 1; t <= last; t++) {
    const u = cells[t - 1]!
    const v = cells[t]!
    const uc = u % coarse.cols
    const vc = v % coarse.cols
    if (uc === vc || (u - uc) / coarse.cols === (v - vc) / coarse.cols) continue
    if (coarse.land[u - uc + vc] || coarse.land[v - vc + uc]) tight[t - 1] = tight[t] = true
  }
  if (tight[0] === false && cellAt(coarse, a) !== cells[0]) tight[0] = true
  if (tight[last] === false && cellAt(coarse, b) !== cells[last]) tight[last] = true
  const runs: [number, number][] = []
  for (let i = 0; i <= last; i++) {
    if (!tight[i]) continue
    let j = i
    while (j < last && tight[j + 1]) j++
    const prev = runs[runs.length - 1]
    if (prev && i - prev[1] - 1 <= MERGE_GAP) prev[1] = j
    else runs.push([i, j])
    i = j
  }

  const points: XY[] = []
  const masks: Mask[] = []
  const add = (p: XY, mask: Mask): void => {
    const prev = points[points.length - 1]
    if (prev && same(prev, p)) return
    if (prev) masks.push(mask)
    points.push(p)
  }
  const centre = (i: number): XY => cellCentre(coarse, cells[i]!)
  const open = (lo: number, hi: number): void => {
    const run: XY[] = []
    for (let i = lo; i <= hi; i++) run.push(i === 0 ? a : i === last ? b : centre(i))
    if (last === 0) run.push(b)
    for (const p of pull(coarseMask, run)) add(p, coarseMask)
  }
  let at = 0
  for (const [i, j] of runs) {
    if (i > at) open(at, i - 1)
    const piece = fine(land, coarse, coarseMask, blocked, cells, i, j, a, b)
    if (!('points' in piece)) return piece
    for (const p of piece.points) add(p, piece.mask)
    at = j + 1
  }
  if (at <= last) open(at, last)
  return { points, masks, base: coarseMask }
}

/**
 * The water points for coarse route cells `i` to `j` on a fine grid, from the open cell before them (or `a`) to
 * the open cell after them (or `b`).
 */
function fine(
  land: LandSource,
  coarse: WaterGrid,
  coarseMask: Mask,
  blocked: Uint8Array,
  cells: number[],
  i: number,
  j: number,
  a: XY,
  b: XY,
): { points: XY[]; mask: Mask } | { snap: 0 | 1 } | { shut: number } {
  const last = cells.length - 1
  const pStop = i === 0
  const qStop = j === last
  const p = pStop ? a : cellCentre(coarse, cells[i - 1]!)
  const q = qStop ? b : cellCentre(coarse, cells[j + 1]!)

  // The coarse cells to cover: the stretch, its ends, and as far as a stop may snap.
  let c0 = Infinity
  let c1 = -Infinity
  let r0 = Infinity
  let r1 = -Infinity
  const cover = (x: number, y: number): void => {
    const c = Math.floor((x - coarse.x0) / coarse.cell)
    const r = Math.floor((y - coarse.y0) / coarse.cell)
    c0 = Math.min(c0, c)
    c1 = Math.max(c1, c)
    r0 = Math.min(r0, r)
    r1 = Math.max(r1, r)
  }
  for (let t = Math.max(0, i - 1); t <= Math.min(last, j + 1); t++) {
    const [x, y] = cellCentre(coarse, cells[t]!)
    cover(x, y)
  }
  for (const [end, stop] of [
    [p, pStop],
    [q, qStop],
  ] as const) {
    const reach = stop ? MAX_SNAP_KM / kmPerUnit(end[1]) : 0
    cover(end[0] - reach, end[1] - reach)
    cover(end[0] + reach, end[1] + reach)
  }
  c0 = Math.max(0, c0 - FINE_MARGIN)
  r0 = Math.max(0, r0 - FINE_MARGIN)
  c1 = Math.min(coarse.cols - 1, c1 + FINE_MARGIN)
  r1 = Math.min(coarse.rows - 1, r1 + FINE_MARGIN)
  const midY = coarse.y0 + ((r0 + r1 + 1) / 2) * coarse.cell
  const side = Math.max(c1 - c0 + 1, r1 - r0 + 1)
  const k = Math.max(1, Math.min(Math.ceil((coarse.cell * kmPerUnit(midY)) / FINE_KM), Math.floor(MAX_FINE_SIDE / side)))
  const grid = waterGridAt(land, {
    x0: coarse.x0 + c0 * coarse.cell,
    y0: coarse.y0 + r0 * coarse.cell,
    cell: coarse.cell / k,
    cols: (c1 - c0 + 1) * k,
    rows: (r1 - r0 + 1) * k,
  })
  const labels = labelWater(grid, grid.land)
  const fineKm = grid.cell * kmPerUnit(midY)
  const kmP = pStop ? snapKm(fineKm) : 0
  const kmQ = qStop ? snapKm(fineKm) : 0
  const ends = snapPair(grid, grid.land, labels, p, q, kmP, kmQ)
  if (ends && 'snap' in ends) return { snap: ends.snap }
  if (!ends) {
    // The coarse route went through a gap the fine grid doesn't have. Shut the stretch's coarse cells that the
    // water at its open end (or nearest its start) doesn't reach.
    const ref = qStop ? p : q
    const regions = [...nearestByRegion(grid, grid.land, labels, ref, qStop ? kmP : 0)]
    regions.sort((x, y) => x[1].d - y[1].d)
    const reached = new Set<number>()
    const id = regions[0]?.[0]
    if (id !== undefined) {
      for (let f = 0; f < labels.length; f++) {
        if (labels[f] !== id) continue
        const fc = f % grid.cols
        const fr = (f - fc) / grid.cols
        reached.add((r0 + Math.floor(fr / k)) * coarse.cols + c0 + Math.floor(fc / k))
      }
    }
    let shut = 0
    for (let t = i; t <= j; t++) {
      const c = cells[t]!
      if (!reached.has(c) && !blocked[c]) {
        blocked[c] = 1
        shut++
      }
    }
    return { shut }
  }
  const route = search(grid, grid.land, grid.cost, ends.start, ends.goal)
  if (!route) return { shut: 0 }

  // A control in water starts from itself: the step to its own cell's centre stays in that cell.
  const raw: XY[] = []
  const add = (pt: XY): void => {
    const prev = raw[raw.length - 1]
    if (!prev || !same(prev, pt)) raw.push(pt)
  }
  add(cellAt(grid, p) === ends.start ? p : cellCentre(grid, ends.start))
  for (const c of route) add(cellCentre(grid, c))
  add(cellAt(grid, q) === ends.goal ? q : cellCentre(grid, ends.goal))
  const mask = gridMask(grid, coarseMask)
  return { points: pull(mask, raw), mask }
}

type SpanKind = 'water' | 'stop' | 'via'

/**
 * Samples per span. Sea spans are long and a via can bend the curve hard near it, so they are sampled
 * more densely than land routes' SAMPLES_PER_SPAN.
 */
const SEA_SAMPLES_PER_SPAN = 64

/** How many times a curved span that meets land may be halved before it goes straight. */
const MAX_SPLITS = 4

/**
 * Curves through `points`, one run between each pair of `breaks`. Every span becomes SEA_SAMPLES_PER_SPAN
 * steps, so point p is sample p × SEA_SAMPLES_PER_SPAN. `bad[p]` marks a water span whose curve meets land;
 * connector spans are always straight.
 */
function smooth(points: XY[], kind: SpanKind[], mask: Mask[], breaks: number[]): { samples: XY[]; bad: boolean[] } {
  const S = SEA_SAMPLES_PER_SPAN
  const samples: XY[] = [points[0]!]
  const bad: boolean[] = []
  for (let r = 0; r + 1 < breaks.length; r++) {
    const lo = breaks[r]!
    const hi = breaks[r + 1]!
    if (hi === lo) continue
    const curve = curveThrough(points.slice(lo, hi + 1), S)
    for (let p = lo; p < hi; p++) {
      const a = points[p]!
      const b = points[p + 1]!
      // Connectors, and a run of one span (which curveThrough doesn't sample), are straight.
      if (kind[p] !== 'water' || hi - lo === 1) {
        for (let s = 1; s <= S; s++) samples.push([a[0] + ((b[0] - a[0]) * s) / S, a[1] + ((b[1] - a[1]) * s) / S])
        bad.push(false)
        continue
      }
      // curveThrough puts points[p] at sample (p - lo) × S, so the span is the next S samples.
      const span = curve.slice((p - lo) * S + 1, (p - lo + 1) * S + 1)
      let clear = true
      for (let s = 0; clear && s < S; s++) {
        clear = firstLand(mask[p]!, s === 0 ? a : span[s - 1]!, span[s]!) === undefined
      }
      samples.push(...span)
      bad.push(!clear)
    }
  }
  return { samples, bad }
}

/**
 * A path at sea from `from` to `to` through each via point in order. Falls back, with a reason,
 * when a stop is too far from the sea or no sea route joins two controls.
 */
export function routeSea(from: LngLat, to: LngLat, via: ViaPoint[], land: LandSource): SeaPath {
  // 1. Unwrap the controls in travel order.
  let prevLng = from[0]
  const controls: { at: LngLat; sharp: boolean }[] = [from, ...via.map((v) => v.at), to].map((at, i) => {
    prevLng = unwrapLng(prevLng, at[0])
    return { at: [prevLng, at[1]] as LngLat, sharp: i > 0 && i <= via.length && via[i - 1]!.sharp === true }
  })
  const last = controls.length - 1
  const xy = controls.map((c) => toXY(c.at))
  const name = (i: number): string => (i === 0 ? 'the start stop' : i === last ? 'the end stop' : `via point ${i}`)
  const capital = (s: string): string => s[0]!.toUpperCase() + s.slice(1)
  const fallback = (reason: string): SeaPath => ({ status: 'fallback', reason, path: [], knots: [] })

  // 10. Everything in one place.
  if (xy.every((p) => same(p, xy[0]!))) {
    return { status: 'ok', path: [from, controls[last]!.at], knots: controls.map((_, i) => (i === last ? 1 : 0)) }
  }

  // 2–7. Route each pair of controls and join them into one point list.
  let points: XY[] = [xy[0]!]
  let spanKind: SpanKind[] = []
  let spanGrid: Mask[] = []
  let knotPoint: number[] = [0]
  const runBreaks = (): number[] => [
    0,
    ...knotPoint.filter((_, i) => i > 0 && i < last && controls[i]!.sharp),
    points.length - 1,
  ]
  const append = (p: XY, kind: SpanKind, grid: Mask): void => {
    if (same(points[points.length - 1]!, p)) return
    points.push(p)
    spanKind.push(kind)
    spanGrid.push(grid)
  }
  for (let k = 0; k < last; k++) {
    const a = xy[k]!
    const b = xy[k + 1]!
    if (same(a, b)) {
      knotPoint.push(points.length - 1)
      continue
    }
    let found = passage(land, a, b, 1)
    if ('snap' in found) return fallback(`${capital(name(k + found.snap))} is more than ${MAX_SNAP_KM} km from the sea`)
    // Retry once with a wider box. A snap that fails only on its coarser grid still means no route.
    if ('search' in found) found = passage(land, a, b, 3)
    if (!('points' in found)) return fallback(`No sea route found between ${name(k)} and ${name(k + 1)}`)
    const { points: water, masks, base } = found
    const connector = (i: number): SpanKind => (i === 0 || i === last ? 'stop' : 'via')
    append(water[0]!, connector(k), masks[0] ?? base)
    for (let i = 1; i < water.length; i++) append(water[i]!, 'water', masks[i - 1]!)
    append(b, connector(k + 1), masks[masks.length - 1] ?? base)
    knotPoint.push(points.length - 1)
  }

  // 8. Smooth each run between sharp vias. A curved span that meets land is split at its midpoint, which
  // lies on the checked straight segment, so the curve hugs that segment and stays smooth through vias.
  // A span still on land after a few splits goes straight.
  const S = SEA_SAMPLES_PER_SPAN
  let smoothed = smooth(points, spanKind, spanGrid, runBreaks())
  for (let round = 0; round < MAX_SPLITS && smoothed.bad.some(Boolean); round++) {
    const at: number[] = []
    const nextPoints: XY[] = []
    const nextKind: SpanKind[] = []
    const nextGrid: Mask[] = []
    for (let p = 0; p < points.length; p++) {
      at.push(nextPoints.length)
      nextPoints.push(points[p]!)
      if (p === spanKind.length) break
      const a = points[p]!
      const b = points[p + 1]!
      const halves = smoothed.bad[p] ? 2 : 1
      if (halves === 2) nextPoints.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])
      for (let h = 0; h < halves; h++) {
        nextKind.push(spanKind[p]!)
        nextGrid.push(spanGrid[p]!)
      }
    }
    points = nextPoints
    spanKind = nextKind
    spanGrid = nextGrid
    knotPoint = knotPoint.map((p) => at[p]!)
    smoothed = smooth(points, spanKind, spanGrid, runBreaks())
  }
  const samples = smoothed.samples
  smoothed.bad.forEach((bad, p) => {
    if (!bad) return
    const a = points[p]!
    const b = points[p + 1]!
    for (let s = 1; s <= S; s++) samples[p * S + s] = [a[0] + ((b[0] - a[0]) * s) / S, a[1] + ((b[1] - a[1]) * s) / S]
  })

  // 9. The first land the path crosses outside the stop connectors.
  let crossesLand: LngLat | undefined
  for (let p = 0; p < spanKind.length && !crossesLand; p++) {
    if (spanKind[p] === 'stop') continue
    for (let s = 0; s < S; s++) {
      const hit = firstLand(spanGrid[p]!, samples[p * S + s]!, samples[p * S + s + 1]!)
      if (hit) {
        const [lng, lat] = toLngLat(hit)
        crossesLand = [wrapLng(lng), lat]
        break
      }
    }
  }

  const path = samples.map(toLngLat)
  const knots = knotPoint.map((p) => p * S)
  knots.forEach((k, i) => (path[k] = controls[i]!.at))
  const out: SeaPath = { status: 'ok', path, knots }
  if (crossesLand) out.crossesLand = crossesLand
  return out
}
