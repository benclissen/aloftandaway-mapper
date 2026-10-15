import { curveThrough } from './curve.js'
import { toLngLat, toXY, unwrapLng, type XY } from './geo.js'
import type { LandSource } from './land.js'
import type { LngLat, ViaPoint } from './schema.js'
import { cellAt, cellCentre, firstLandOnSegment, snapToWater, waterGrid, type Box, type WaterGrid } from './water.js'

/** Bump when routing changes, so cached paths are recomputed. */
export const ROUTER_VERSION = 1
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

/** A stretch of the sea between two controls: its grid and its water points, end to end. */
interface Passage {
  grid: WaterGrid
  /** First and last are the controls themselves when they lie in water, else their snapped cell centres. */
  points: XY[]
}

type Failure = { snap: number } | { search: true }

/** A* over the grid's 8-neighbours. Returns the cell path from `start` to `goal`, or undefined. */
function search(grid: WaterGrid, start: number, goal: number): number[] | undefined {
  const { cols, rows, cost, land, cell } = grid
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
        if (land[j] || closed[j]) continue
        // No corner cutting: a diagonal step needs both cells beside it in water.
        if (dr !== 0 && dc !== 0 && (land[r * cols + nc] || land[nr * cols + c])) continue
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
function pull(grid: WaterGrid, points: XY[]): XY[] {
  const out = [points[0]!]
  let i = 0
  while (i < points.length - 1) {
    let best = i + 1
    let misses = 0
    for (let j = i + 2; j < points.length && misses < 16; j++) {
      if (firstLandOnSegment(grid, points[i]!, points[j]!) === undefined) {
        best = j
        misses = 0
      } else misses++
    }
    out.push(points[best]!)
    i = best
  }
  return out
}

/** The water points from `a` to `b` on a grid over their box grown by `grow` times the usual margin. */
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
  const grid = waterGrid(land, box)
  const start = snapToWater(grid, a, MAX_SNAP_KM)
  if (start === undefined) return { snap: 0 }
  const goal = snapToWater(grid, b, MAX_SNAP_KM)
  if (goal === undefined) return { snap: 1 }
  const cells = search(grid, start, goal)
  if (!cells) return { search: true }

  // A control in water starts from itself: the step to its own cell's centre stays in that cell.
  const raw: XY[] = []
  const add = (p: XY): void => {
    const prev = raw[raw.length - 1]
    if (!prev || !same(prev, p)) raw.push(p)
  }
  add(cellAt(grid, a) === start ? a : cellCentre(grid, start))
  for (const c of cells) add(cellCentre(grid, c))
  add(cellAt(grid, b) === goal ? b : cellCentre(grid, goal))
  return { grid, points: pull(grid, raw) }
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
function smooth(points: XY[], kind: SpanKind[], grid: WaterGrid[], breaks: number[]): { samples: XY[]; bad: boolean[] } {
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
        clear = firstLandOnSegment(grid[p]!, s === 0 ? a : span[s - 1]!, span[s]!) === undefined
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
  let spanGrid: WaterGrid[] = []
  let knotPoint: number[] = [0]
  const runBreaks = (): number[] => [
    0,
    ...knotPoint.filter((_, i) => i > 0 && i < last && controls[i]!.sharp),
    points.length - 1,
  ]
  const append = (p: XY, kind: SpanKind, grid: WaterGrid): void => {
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
    if (!('grid' in found)) return fallback(`No sea route found between ${name(k)} and ${name(k + 1)}`)
    const { grid, points: water } = found
    const connector = (i: number): SpanKind => (i === 0 || i === last ? 'stop' : 'via')
    append(water[0]!, connector(k), grid)
    for (let i = 1; i < water.length; i++) append(water[i]!, 'water', grid)
    append(b, connector(k + 1), grid)
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
    const nextGrid: WaterGrid[] = []
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
      const hit = firstLandOnSegment(spanGrid[p]!, samples[p * S + s]!, samples[p * S + s + 1]!)
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
