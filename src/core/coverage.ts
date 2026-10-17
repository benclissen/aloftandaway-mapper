import { toXY, unwrapLng } from './geo.js'
import type { LandSource } from './land.js'
import type { LngLat } from './schema.js'
import { kmPerUnit, waterGridAt } from './water.js'

/** Km per Mercator unit at its largest between Mercator y0 and y1, which is nearest the equator. */
function kmPerUnitMost(y0: number, y1: number): number {
  return kmPerUnit(Math.min(Math.max(0.5, y0), y1))
}

/** Km per Mercator unit at its smallest between Mercator y0 and y1, which is furthest from the equator. */
function kmPerUnitLeast(y0: number, y1: number): number {
  return kmPerUnit(Math.abs(y0 - 0.5) > Math.abs(y1 - 0.5) ? y0 : y1)
}

/** Tiles per side of the blocks the coast filter rasterises land in. */
const BLOCK = 32

/**
 * The keys `"x/y"` of the tiles at `zoom` that lie within `bufferKm` of `path`, x wrapped, sorted as strings.
 * Consecutive points are joined the short way round, by a straight line in Mercator. The line is sampled at no more
 * than `bufferKm / 2` apart, and each sample takes the tiles within `bufferKm` of it (plus half the spacing, so
 * nothing between samples is missed), converted at its own latitude.
 *
 * With `coast`, only tiles whose square, grown by `coastKm`, meets `coast`'s land are kept. That's worked out on
 * whole tiles, so a tile up to one tile further out may be kept too.
 */
export function tilesNear(
  path: LngLat[],
  opts: { zoom: number; bufferKm: number; coast?: LandSource; coastKm?: number },
): string[] {
  const { zoom, bufferKm, coast, coastKm = 0 } = opts
  if (!(bufferKm > 0)) throw new Error('tilesNear needs a positive bufferKm')
  const span = 2 ** zoom
  const spacing = bufferKm / 2
  // Tiles found, by unwrapped column and row.
  const found = new Map<string, [number, number]>()
  const take = (x: number, y: number): void => {
    const reach = (bufferKm + spacing / 2) / kmPerUnit(y)
    const tx0 = Math.floor((x - reach) * span)
    const tx1 = Math.floor((x + reach) * span)
    const ty0 = Math.max(0, Math.floor((y - reach) * span))
    const ty1 = Math.min(span - 1, Math.floor((y + reach) * span))
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) found.set(`${tx}/${ty}`, [tx, ty])
  }

  let prevLng = path[0]?.[0] ?? 0
  const xy = path.map(([lng, lat]) => {
    prevLng = unwrapLng(prevLng, lng)
    return toXY([prevLng, lat])
  })
  if (xy.length > 0) take(...xy[0]!)
  for (let i = 1; i < xy.length; i++) {
    const [ax, ay] = xy[i - 1]!
    const [bx, by] = xy[i]!
    // Spacing is checked where the scale is largest, so it holds along the whole segment.
    const km = Math.hypot(bx - ax, by - ay) * kmPerUnitMost(Math.min(ay, by), Math.max(ay, by))
    const n = Math.max(1, Math.ceil(km / spacing))
    for (let k = 1; k <= n; k++) take(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n)
  }

  let tiles = [...found.values()]
  if (coast) {
    // Group by block, rasterise the land in each block grown by the coast reach, and keep a tile when a land cell
    // lies within that reach of it. A cell is land when any land touches it.
    const blocks = new Map<string, [number, number][]>()
    for (const t of tiles) {
      const key = `${Math.floor(t[0] / BLOCK)}/${Math.floor(t[1] / BLOCK)}`
      const list = blocks.get(key)
      if (list) list.push(t)
      else blocks.set(key, [t])
    }
    // Tiles of reach from a tile in row ty, at the row's edge furthest from the equator.
    const reachOf = (ty: number): number => Math.ceil((coastKm * span) / kmPerUnitLeast(ty / span, (ty + 1) / span))
    const kept: [number, number][] = []
    for (const list of blocks.values()) {
      const bx = Math.floor(list[0]![0] / BLOCK) * BLOCK
      const by = Math.floor(list[0]![1] / BLOCK) * BLOCK
      let reach = 0
      for (const [, ty] of list) reach = Math.max(reach, reachOf(ty))
      const cols = BLOCK + 2 * reach
      const frame = { x0: (bx - reach) / span, y0: (by - reach) / span, cell: 1 / span, cols, rows: cols }
      const grid = waterGridAt(coast, frame)
      for (const t of list) {
        const r = reachOf(t[1])
        const c = t[0] - bx + reach
        const w = t[1] - by + reach
        let near = false
        for (let rr = w - r; rr <= w + r && !near; rr++) {
          for (let cc = c - r; cc <= c + r && !near; cc++) near = grid.land[rr * cols + cc] === 1
        }
        if (near) kept.push(t)
      }
    }
    tiles = kept
  }

  const keys = new Set(tiles.map(([tx, ty]) => `${((tx % span) + span) % span}/${ty}`))
  return [...keys].sort()
}
