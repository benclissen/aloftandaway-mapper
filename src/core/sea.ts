import { curveThrough } from './curve.js'
import { haversineKm, toLngLat, toXY, unwrapLng, type XY } from './geo.js'
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

/**
 * Bump whenever the routing code or its parameters change (cell sizes, rounds, the tile buffer, the coast filter), or
 * the way water is read from tiles changes (zoom, pixels, the feature filter). A new planet build is not a reason.
 * The version is in every leg's cache key, so bumping it routes every cached leg again.
 */
export const ROUTER_VERSION = 3
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
  /**
   * Set by the server, never by the router, when the leg was routed without all the tiles it needed: no network,
   * the download budget used up, or the rounds ran out before the route settled.
   */
  unverified?: 'offline' | 'budget' | 'unsettled'
  /**
   * The straight distance, in km, from the start stop and from the end stop to the water point the route starts or
   * ends at. 0 for a stop in water.
   */
  stopGapKm?: [number, number]
}

export type SeaPaths = Record<string, SeaPath>

/**
 * Why a path is unverified, as a clause. Validation, renders and the studio end "checked against Natural Earth only,
 * because …" with it for `offline` and `budget`, and "only partly checked, because …" for `unsettled`, which did use
 * the tiles it loaded. A leg that fell back says `STRAIGHT_LINE` instead.
 */
export const UNVERIFIED_CAUSE: Record<NonNullable<SeaPath['unverified']>, string> = {
  offline: "OpenFreeMap couldn't be reached",
  budget: 'the project needed more map tiles at once than Mapper fetches in one go',
  unsettled: 'it kept finding new islands',
}

/**
 * What a sea leg that fell back says it was drawn as. Validation, renders and the studio all end their fallback
 * wording with it, whatever the reason the leg went unverified.
 */
export const STRAIGHT_LINE = 'drawn as a straight line, which may cross land'

/** A stop farther than this many km from the water its sea route starts or ends in has a line across land to reach it. */
export const STOP_FAR_KM = 2

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

/** An inclusive rectangle of a grid's cells: first and last column, first and last row. */
interface Rect {
  c0: number
  c1: number
  r0: number
  r1: number
}

const cellRect = (frame: GridFrame, i: number): Rect => {
  const c = i % frame.cols
  const r = (i - c) / frame.cols
  return { c0: c, c1: c, r0: r, r1: r }
}

/**
 * A* over the 8-neighbours of cells that aren't `blocked`, with each step costing its length times the mean of
 * the two cells' `cost`. Returns the cell path from `start` to the first open cell reached in `goal`, or undefined.
 */
function search(
  frame: GridFrame,
  blocked: Uint8Array,
  cost: Float32Array,
  start: number,
  goal: Rect,
): number[] | undefined {
  const { cols, rows, cell } = frame
  const total = cols * rows
  const g = new Float64Array(total).fill(Infinity)
  const parent = new Int32Array(total).fill(-1)
  const closed = new Uint8Array(total)
  const diag = Math.SQRT2 - 1
  const h = (i: number): number => {
    const c = i % cols
    const r = (i - c) / cols
    const dx = Math.max(0, goal.c0 - c, c - goal.c1)
    const dy = Math.max(0, goal.r0 - r, r - goal.r1)
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
    const ic = i % cols
    const ir = (i - ic) / cols
    if (ic >= goal.c0 && ic <= goal.c1 && ir >= goal.r0 && ir <= goal.r1) {
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
/** The largest fine cell, in km. Narrow sounds between skerries stay open at this size. */
const FINE_KM = 0.05
/** The most cells along either side of a fine grid. A stretch too long for one is cut into pieces. */
const MAX_FINE_SIDE = 2048
/**
 * The most coarse cells a fine stretch reaches past its tight cells into open water, so it joins the open stretches
 * there, and the route cells consecutive pieces share. Fewer when FINE_ROOM_KM takes fewer, or a piece wouldn't fit.
 */
const FINE_MARGIN = 4
/** How far, in km, a fine stretch reaches past its tight cells, and a fine grid past the route cells it covers. */
const FINE_ROOM_KM = 3
/**
 * The largest coarse cell, in km where the box comes nearest the equator. Three coarse cells of FINE_KM cells and
 * their margin then fit in one fine grid, so fine cells stay at FINE_KM on legs that span half the world.
 */
const MAX_COARSE_KM = 25
/** Stretches needing a fine grid that are this many open coarse cells apart or fewer share one. */
const MERGE_GAP = 2 * FINE_MARGIN
/** How many times a coarse route may be rejected by its fine grids before the leg falls back. */
const MAX_ROUNDS = 8

/**
 * The cells to start and end on: for each end, the nearest open cell within its limit, both in one region, choosing
 * the region where the two snaps add up shortest. `past` says, for each end, how much further its snap is than its
 * nearest open cell in any region. `snap` names an end with no open cell in reach; undefined means no region reaches
 * both.
 */
function snapPair(
  frame: GridFrame,
  blocked: Uint8Array,
  labels: Int32Array,
  a: XY,
  b: XY,
  kmA: number,
  kmB: number,
): { start: number; goal: number; past: [number, number] } | { snap: 0 | 1 } | undefined {
  const near = nearestByRegion(frame, blocked, labels, a, kmA)
  if (near.size === 0) return { snap: 0 }
  const far = nearestByRegion(frame, blocked, labels, b, kmB)
  if (far.size === 0) return { snap: 1 }
  let best: { start: number; goal: number; da: number; db: number } | undefined
  for (const [id, s] of near) {
    const g = far.get(id)
    if (g && (!best || s.d + g.d < best.da + best.db)) best = { start: s.cell, goal: g.cell, da: s.d, db: g.d }
  }
  if (!best) return undefined
  const least = (m: Map<number, { d: number }>): number => Math.min(...[...m.values()].map((v) => v.d))
  return { start: best.start, goal: best.goal, past: [best.da - least(near), best.db - least(far)] }
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
  const wide = Math.max(box.maxX - box.minX, box.maxY - box.minY) * kmPerUnit(Math.min(Math.max(0.5, box.minY), box.maxY))
  const coarse = waterGrid(land, box, Math.max(1024, Math.ceil(wide / MAX_COARSE_KM)))
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
    const cells = search(coarse, blocked, cost, ends.start, cellRect(coarse, ends.goal))
    if (!cells) return { search: true }
    const out = refine(land, coarse, coarseMask, blocked, cells, a, b)
    if (!('shut' in out)) return out
    if (out.shut === 0) return { search: true }
  }
  return { search: true }
}

/**
 * Turns a coarse cell route into water points: open stretches as coarse cell centres, and each stretch that
 * touches land (or starts or ends off the controls) through fine grids. Every piece is string-pulled again as one
 * line, against the fine grids where there are some and the coarse grid elsewhere, so the joins between pieces
 * don't bend. When a fine grid finds the stretch blocked, shuts the coarse cells it couldn't reach and says how many.
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

  const raw: XY[] = []
  const grids: WaterGrid[] = []
  const add = (pts: XY[]): void => {
    for (const p of pts) {
      const prev = raw[raw.length - 1]
      if (!prev || !same(prev, p)) raw.push(p)
    }
  }
  const open = (lo: number, hi: number): void => {
    const run: XY[] = []
    for (let i = lo; i <= hi; i++) run.push(i === 0 ? a : i === last ? b : cellCentre(coarse, cells[i]!))
    if (last === 0) run.push(b)
    add(pull(coarseMask, run))
  }
  // Each fine stretch starts and ends on the open cells it reaches out to, which the open stretches share.
  let at = 0
  for (const [i, j] of runs) {
    const piece = fineRun(land, coarse, coarseMask, blocked, cells, i, j, a, b)
    if (!('points' in piece)) return piece
    if (piece.u > at) open(at, piece.u)
    add(piece.points)
    grids.push(...piece.grids)
    at = piece.w
  }
  if (runs.length === 0 || at < last) open(at, last)
  const mask = grids.reduce<Mask>((outside, grid) => gridMask(grid, outside), coarseMask)
  const points = pull(mask, raw)
  return { points, masks: points.slice(1).map(() => mask), base: mask }
}

/**
 * A box of fine cells on the lattice with `k` fine cells to a coarse cell, counted from the coarse grid's corner:
 * first and last column, first and last row.
 */
type FineBox = [number, number, number, number]

/** How fine grids cover one tight stretch: the coarse route cells each piece covers, and its box. */
interface Cut {
  /** Fine cells per coarse cell side. */
  k: number
  /** The first and last coarse route cells of the whole stretch. */
  u: number
  w: number
  pieces: { s: number; e: number; box: FineBox }[]
}

/**
 * Cuts coarse route cells `i` to `j`, grown by `m` cells each way, into pieces whose fine grids are at most
 * MAX_FINE_SIDE cells across with `k` fine cells to a coarse cell. Each piece covers its route cells and a margin
 * round them of `m` coarse cells or FINE_ROOM_KM's worth of FINE_KM cells, whichever is less. A stop's piece also
 * covers the stop and, with `room`, as far round it as a stop may snap, so the fine route has room to find its own
 * way out; without, as far round it as its coarse cell's centre, which takes in any water nearer the stop than that
 * cell. Consecutive pieces share `m` route cells. Undefined if even the smallest piece doesn't fit.
 */
function cut(
  coarse: WaterGrid,
  cells: number[],
  i: number,
  j: number,
  a: XY,
  b: XY,
  k: number,
  m: number,
  room: boolean,
): Cut | undefined {
  const last = cells.length - 1
  const { cols, rows } = coarse
  const fineCell = coarse.cell / k
  const u = Math.max(0, i - m)
  const w = Math.min(last, j + m)
  const fineCol = (x: number): number => Math.floor((x - coarse.x0) / fineCell)
  const fineRow = (y: number): number => Math.floor((y - coarse.y0) / fineCell)
  const margin = Math.min(m * k, Math.ceil(FINE_ROOM_KM / FINE_KM))
  const around = (stop: XY, t: number): FineBox => {
    const [cx, cy] = cellCentre(coarse, cells[t]!)
    const reach = room ? MAX_SNAP_KM / kmPerUnit(stop[1]) : Math.hypot(cx - stop[0], cy - stop[1])
    return [fineCol(stop[0] - reach), fineCol(stop[0] + reach), fineRow(stop[1] - reach), fineRow(stop[1] + reach)]
  }
  const startBox = u === 0 ? around(a, 0) : undefined
  const endBox = w === last ? around(b, last) : undefined
  const join = (x: FineBox, y: FineBox): FineBox => [
    Math.min(x[0], y[0]),
    Math.max(x[1], y[1]),
    Math.min(x[2], y[2]),
    Math.max(x[3], y[3]),
  ]
  const cellBox = (t: number): FineBox => {
    const c = cells[t]! % cols
    const r = (cells[t]! - c) / cols
    return [c * k, c * k + k - 1, r * k, r * k + k - 1]
  }
  // The box grown by the margin and kept on the coarse grid, and whether it fits.
  const grown = (x: FineBox): FineBox => [
    Math.max(0, x[0] - margin),
    Math.min(cols * k - 1, x[1] + margin),
    Math.max(0, x[2] - margin),
    Math.min(rows * k - 1, x[3] + margin),
  ]
  const fits = (x: FineBox): boolean => Math.max(x[1] - x[0] + 1, x[3] - x[2] + 1) <= MAX_FINE_SIDE

  const pieces: Cut['pieces'] = []
  for (let s = u; ; ) {
    let box: FineBox = s === u && startBox ? join(startBox, cellBox(s)) : cellBox(s)
    if (!fits(grown(box))) return undefined
    let e = s
    while (e < w) {
      let next = join(box, cellBox(e + 1))
      if (e + 1 === w && endBox) next = join(next, endBox)
      if (!fits(grown(next))) break
      box = next
      e++
    }
    if (e === w) {
      pieces.push({ s, e, box: grown(box) })
      return { k, u, w, pieces }
    }
    if (e < s + m + 1) return undefined
    pieces.push({ s, e, box: grown(box) })
    s = e - m
  }
}

/**
 * The water points for the tight coarse route cells `i` to `j`, and the open cells the stretch reaches out to each
 * way, on fine grids: from the cell at its start (or `a`) to the cell at its end (or `b`). Each piece but the last
 * routes to the first fine water in its last route cell, and the next piece starts there.
 */
function fineRun(
  land: LandSource,
  coarse: WaterGrid,
  coarseMask: Mask,
  blocked: Uint8Array,
  cells: number[],
  i: number,
  j: number,
  a: XY,
  b: XY,
): FineRun | { snap: 0 | 1 } | { shut: number } {
  const last = cells.length - 1

  // One lattice for every piece, so they share cell centres, with fine cells no bigger than FINE_KM where the
  // stretch comes nearest the equator. MAX_COARSE_KM keeps the smallest piece in reach; only a stop box too big for
  // it makes fine cells grow.
  let yLo = Infinity
  let yHi = -Infinity
  for (let t = Math.max(0, i - FINE_MARGIN); t <= Math.min(last, j + FINE_MARGIN); t++) {
    const r = Math.floor(cells[t]! / coarse.cols)
    yLo = Math.min(yLo, coarse.y0 + r * coarse.cell)
    yHi = Math.max(yHi, coarse.y0 + (r + 1) * coarse.cell)
  }
  const kmMost = kmPerUnit(Math.min(Math.max(0.5, yLo), yHi))
  let k = Math.max(1, Math.ceil((coarse.cell * kmMost) / FINE_KM))
  // Reach FINE_ROOM_KM past the tight cells in whole coarse cells, up to FINE_MARGIN of them, or as many as fit;
  // failing even one, use bigger fine cells. At k = 1 one piece always fits.
  const most = Math.min(FINE_MARGIN, Math.max(1, Math.ceil(FINE_ROOM_KM / (coarse.cell * kmMost))))
  const plan = (room: boolean): Cut | undefined => {
    for (let m = most; m >= 1; m--) {
      const out = cut(coarse, cells, i, j, a, b, k, m, room)
      if (out) return out
    }
    return undefined
  }
  let tight = plan(false)
  while (!tight) {
    k = k > 2 ? Math.max(2, Math.floor(k * 0.9)) : 1
    tight = plan(false)
  }
  // A stop whose nearest water doesn't lead on within its piece gets room round it to find its own way out, if
  // that still fits.
  const out = walk(land, coarse, coarseMask, blocked, cells, i, j, a, b, tight, true)
  if (out !== 'room') return out
  const again = walk(land, coarse, coarseMask, blocked, cells, i, j, a, b, plan(true) ?? tight, false)
  return again === 'room' ? { shut: 0 } : again
}

interface FineRun {
  /** The first and last coarse route cells the fine stretch covers. */
  u: number
  w: number
  points: XY[]
  grids: WaterGrid[]
}

/**
 * Routes the pieces of `plan` in turn. With `retry`, says 'room' instead of failing or snapping a stop past nearer
 * water, before anything is shut.
 */
function walk(
  land: LandSource,
  coarse: WaterGrid,
  coarseMask: Mask,
  blocked: Uint8Array,
  cells: number[],
  i: number,
  j: number,
  a: XY,
  b: XY,
  plan: Cut,
  retry: boolean,
): FineRun | { snap: 0 | 1 } | { shut: number } | 'room' {
  const last = cells.length - 1
  const { cols } = coarse
  const { k, u, w, pieces } = plan
  const fineCell = coarse.cell / k
  const pStop = u === 0
  const qStop = w === last
  const q = qStop ? b : cellCentre(coarse, cells[w]!)
  // A stop snapped more than two fine cells past its nearest water.
  const slack = 2 * fineCell

  /** Shuts the tight cells of route cells t0 to t1 that region `id` of the fine grid doesn't reach. */
  const shutUnreached = (
    grid: WaterGrid,
    labels: Int32Array,
    id: number | undefined,
    box: FineBox,
    t0: number,
    t1: number,
  ): number => {
    const reached = new Set<number>()
    if (id !== undefined) {
      for (let f = 0; f < labels.length; f++) {
        if (labels[f] !== id) continue
        const fc = f % grid.cols
        const fr = (f - fc) / grid.cols
        reached.add(Math.floor((box[2] + fr) / k) * cols + Math.floor((box[0] + fc) / k))
      }
    }
    let shut = 0
    for (let t = Math.max(t0, i); t <= Math.min(t1, j); t++) {
      const c = cells[t]!
      if (!reached.has(c) && !blocked[c]) {
        blocked[c] = 1
        shut++
      }
    }
    return shut
  }

  const points: XY[] = []
  const grids: WaterGrid[] = []
  let from = pStop ? a : cellCentre(coarse, cells[u]!)
  for (let n = 0; n < pieces.length; n++) {
    const { s, e, box } = pieces[n]!
    const final = n === pieces.length - 1
    const grid = waterGridAt(land, {
      x0: coarse.x0 + box[0] * fineCell,
      y0: coarse.y0 + box[2] * fineCell,
      cell: fineCell,
      cols: box[1] - box[0] + 1,
      rows: box[3] - box[2] + 1,
    })
    const labels = labelWater(grid, grid.land)
    const fineKm = grid.cell * kmPerUnit(grid.y0 + (grid.rows * grid.cell) / 2)
    const startStop = n === 0 && pStop
    const endStop = final && qStop
    const stopHere = startStop || endStop
    // An open cell's centre and a shared point (a cell centre on this lattice, well inside this box) start from their
    // own cell. Starting anywhere else would join them across whatever lies between; if their own water doesn't
    // lead on, the stretch is shut and routed again instead.
    const kmFrom = startStop ? snapKm(fineKm) : 0
    let start: number
    let goal: number | undefined
    let route: number[] | undefined
    if (final) {
      const kmQ = qStop ? snapKm(fineKm) : 0
      const ends = snapPair(grid, grid.land, labels, from, q, kmFrom, kmQ)
      // An open cell's centre is always in water, so only a control can fail to snap.
      const stopFails = ends !== undefined && 'snap' in ends && (ends.snap === 0 ? startStop : endStop)
      const snappedPast =
        ends !== undefined && 'past' in ends && ends.past.some((d, end) => (end === 0 ? startStop : endStop) && d > slack)
      if (retry && stopHere && (!ends || stopFails || snappedPast)) return 'room'
      if (ends && 'snap' in ends) return stopFails ? { snap: ends.snap } : { shut: 0 }
      if (!ends) {
        // The coarse route went through a gap the fine grid doesn't have. Shut the stretch's coarse cells that the
        // water at its open end (or nearest its start) doesn't reach.
        const regions = [...nearestByRegion(grid, grid.land, labels, qStop ? from : q, qStop ? kmFrom : 0)]
        regions.sort((x, y) => x[1].d - y[1].d)
        return { shut: shutUnreached(grid, labels, regions[0]?.[0], box, s, e) }
      }
      start = ends.start
      goal = ends.goal
      route = search(grid, grid.land, grid.cost, start, cellRect(grid, goal))
    } else {
      // The goal is any fine water in the piece's last route cell that the start reaches.
      const ec = cells[e]! % cols
      const er = (cells[e]! - ec) / cols
      const c0 = ec * k - box[0]
      const r0 = er * k - box[2]
      const rect: Rect = { c0, c1: c0 + k - 1, r0, r1: r0 + k - 1 }
      const inGoal = new Set<number>()
      for (let r = rect.r0; r <= rect.r1; r++) {
        for (let c = rect.c0; c <= rect.c1; c++) {
          const id = labels[r * grid.cols + c]!
          if (id >= 0) inGoal.add(id)
        }
      }
      const near = [...nearestByRegion(grid, grid.land, labels, from, kmFrom)].sort((x, y) => x[1].d - y[1].d)
      const pick = near.find(([id]) => inGoal.has(id))
      if (retry && startStop && (!pick || pick[1].d - near[0]![1].d > slack)) return 'room'
      if (near.length === 0) return startStop ? { snap: 0 } : { shut: 0 }
      if (!pick) return { shut: shutUnreached(grid, labels, near[0]![0], box, s, e) }
      start = pick[1].cell
      route = search(grid, grid.land, grid.cost, start, rect)
    }
    if (!route) return { shut: 0 }

    // A control or shared point in water starts from itself: the step to its own cell's centre stays in that cell.
    const raw: XY[] = []
    const add = (pt: XY): void => {
      const prev = raw[raw.length - 1]
      if (!prev || !same(prev, pt)) raw.push(pt)
    }
    add(cellAt(grid, from) === start ? from : cellCentre(grid, start))
    for (const c of route) add(cellCentre(grid, c))
    if (goal !== undefined) add(cellAt(grid, q) === goal ? q : cellCentre(grid, goal))
    for (const pt of pull(gridMask(grid, coarseMask), raw)) {
      const prev = points[points.length - 1]
      if (!prev || !same(prev, pt)) points.push(pt)
    }
    grids.push(grid)
    from = raw[raw.length - 1]!
  }
  return { u, w, points, grids }
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
  // How far each stop is from the water its route starts or ends at.
  const stopGapKm: [number, number] = [0, 0]
  const gap = (i: number, water: XY): number =>
    same(water, xy[i]!) ? 0 : haversineKm(controls[i]!.at, toLngLat(water))
  let routed = false
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
    // Controls before this leg coincide with its start, and those after the last leg with its end.
    if (!routed) stopGapKm[0] = gap(0, water[0]!)
    stopGapKm[1] = gap(last, water[water.length - 1]!)
    routed = true
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
  const out: SeaPath = { status: 'ok', path, knots, stopGapKm }
  if (crossesLand) out.crossesLand = crossesLand
  return out
}
