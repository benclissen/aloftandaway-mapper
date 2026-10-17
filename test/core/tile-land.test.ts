import { describe, expect, it } from 'vitest'
import {
  allLand,
  allWater,
  decodeLand,
  encodeLand,
  landIndex,
  rasteriseTile,
  tileLand,
  TILE_PIXELS,
  toLngLat,
  WATER_ZOOM,
  waterGridAt,
  withTiles,
  type GridFrame,
  type LandTile,
  type LngLat,
  type TileFeature,
  type TileLand,
} from '../../src/core/index.js'

type Pt = { x: number; y: number }

const EXTENT = 4096
const SPAN = 2 ** WATER_ZOOM
const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
]
const isLandPx = (t: LandTile, c: number, r: number): boolean => t.landIn(c, r, c, r) === 1
const square = (w: number, s: number, e: number, n: number): LngLat[] => [[w, s], [e, s], [e, n], [w, n]]
const source = (rings: LngLat[][]) => landIndex(decodeLand(encodeLand('t', rings)))

/** A mulberry32 generator: the same numbers every run. */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Even-odd point in ring. */
function inRing(ring: Pt[], x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!
    const b = ring[j]!
    if (a.y > y !== b.y > y && x < a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y)) inside = !inside
  }
  return inside
}

/** A TileLand over keyed tiles that records every tile asked for, and wraps nothing itself. */
function recording(tiles: Map<string, LandTile>): TileLand & { asked: [number, number][] } {
  const asked: [number, number][] = []
  return {
    zoom: WATER_ZOOM,
    pixels: TILE_PIXELS,
    asked,
    tile(x, y) {
      asked.push([x, y])
      return tiles.get(`${x}/${y}`)
    },
  }
}

/** The world-pixel square of a grid cell, in pixels of zoom-12 tiles. */
const cellPixels = (f: GridFrame, i: number): [number, number, number, number] => {
  const P = SPAN * TILE_PIXELS
  const c = i % f.cols
  const r = Math.floor(i / f.cols)
  return [(f.x0 + c * f.cell) * P, (f.y0 + r * f.cell) * P, (f.x0 + (c + 1) * f.cell) * P, (f.y0 + (r + 1) * f.cell) * P]
}

describe('tile rasterising', () => {
  // 16 pixels a side: one pixel is 256 tile units.
  it('a pixel is water when its centre is in a water feature', () => {
    const t = rasteriseTile([{ rings: [rect(300, 10, 700, 250)] }], EXTENT, 16)
    // Row 0's centres at y 128; columns 1 and 2 have centres 384 and 640, inside the feature.
    expect(isLandPx(t, 1, 0)).toBe(false)
    expect(isLandPx(t, 2, 0)).toBe(false)
    // Column 0 (centre 128) and column 3 (centre 896) are touched but their centres are outside.
    expect(isLandPx(t, 0, 0)).toBe(true)
    expect(isLandPx(t, 3, 0)).toBe(true)
    expect(isLandPx(t, 1, 1)).toBe(true)
    expect(t.landIn(0, 0, 15, 15)).toBe(256 - 2)
    // Clamped to the tile.
    expect(t.landIn(-5, -5, 40, 40)).toBe(256 - 2)
    expect(t.landIn(3, 0, 2, 0)).toBe(0)
  })

  it('a hole in a water feature is land', () => {
    // The hole runs the same way round as the outer ring: orientation doesn't matter.
    const t = rasteriseTile([{ rings: [rect(0, 0, 4096, 4096), rect(5 * 256 + 10, 5 * 256 + 10, 6 * 256 - 10, 6 * 256 - 10)] }], EXTENT, 16)
    expect(isLandPx(t, 5, 5)).toBe(true)
    expect(t.landIn(0, 0, 15, 15)).toBe(1)
    expect(isLandPx(t, 4, 5)).toBe(false)
    expect(isLandPx(t, 5, 6)).toBe(false)
  })

  it('overlapping water features are still water', () => {
    const a: TileFeature = { rings: [rect(0, 0, 2048, 2048)] }
    const b: TileFeature = { rings: [rect(1024, 1024, 3072, 3072)] }
    const t = rasteriseTile([a, b], EXTENT, 16)
    // Pixels 4–7 in both directions are in both features.
    expect(isLandPx(t, 5, 5)).toBe(false)
    expect(t.landIn(4, 4, 7, 7)).toBe(0)
    expect(isLandPx(t, 2, 2)).toBe(false)
    expect(isLandPx(t, 10, 10)).toBe(false)
    expect(isLandPx(t, 13, 2)).toBe(true)
    // Within one feature the same two rings are even-odd: the overlap is a hole.
    const one = rasteriseTile([{ rings: [...a.rings, ...b.rings] }], EXTENT, 16)
    expect(one.landIn(4, 4, 7, 7)).toBe(16)
    expect(isLandPx(one, 2, 2)).toBe(false)
  })

  it('geometry in the tile buffer is ignored', () => {
    // Wholly in the buffer, on every side: no pixel changes.
    const outside = rasteriseTile(
      [
        { rings: [rect(-200, 0, -10, 4096)] },
        { rings: [rect(4100, 0, 4300, 4096)] },
        { rings: [rect(0, -300, 4096, -1)] },
        { rings: [rect(0, 4097, 4096, 4400)] },
      ],
      EXTENT,
      16,
    )
    expect(outside.landIn(0, 0, 15, 15)).toBe(256)
    // Reaching into the buffer from inside: only the pixels whose centres are covered.
    const across = rasteriseTile([{ rings: [rect(-300, -300, 300, 4400)] }], EXTENT, 16)
    expect(across.landIn(0, 0, 0, 15)).toBe(0)
    expect(across.landIn(1, 0, 15, 15)).toBe(15 * 16)
    // Bigger than the tile: all water.
    expect(rasteriseTile([{ rings: [rect(-500, -500, 4600, 4600)] }], EXTENT, 16).landIn(0, 0, 15, 15)).toBe(0)
  })

  it('landIn counts match a brute-force count', () => {
    const rnd = random(12)
    for (const pixels of [TILE_PIXELS, 100]) {
      const features: TileFeature[] = []
      const coord = () => -200 + rnd() * (EXTENT + 400)
      for (let k = 0; k < 120; k++) {
        const x = coord()
        const y = coord()
        const w = rnd() * 600
        const h = rnd() * 600
        const rings = [rect(x, y, x + w, y + h)]
        // Some features get a second ring, some a triangle.
        if (rnd() < 0.3) rings.push([{ x: coord(), y: coord() }, { x: coord(), y: coord() }, { x: coord(), y: coord() }])
        features.push({ rings })
      }
      const t = rasteriseTile(features, EXTENT, pixels)
      const unit = EXTENT / pixels
      const land = new Uint8Array(pixels * pixels)
      for (let r = 0; r < pixels; r++) {
        for (let c = 0; c < pixels; c++) {
          const x = (c + 0.5) * unit
          const y = (r + 0.5) * unit
          const wet = features.some((f) => f.rings.filter((ring) => inRing(ring, x, y)).length % 2 === 1)
          land[r * pixels + c] = wet ? 0 : 1
        }
      }
      let some = 0
      for (let k = 0; k < 200; k++) {
        const a = Math.floor(rnd() * (pixels + 20)) - 10
        const b = Math.floor(rnd() * (pixels + 20)) - 10
        const c = Math.floor(rnd() * (pixels + 20)) - 10
        const d = Math.floor(rnd() * (pixels + 20)) - 10
        // Mostly ordered corners; some the wrong way round, which hold nothing.
        const [c0, c1] = k % 10 === 0 ? [a, b] : [Math.min(a, b), Math.max(a, b)]
        const [r0, r1] = k % 10 === 0 ? [c, d] : [Math.min(c, d), Math.max(c, d)]
        let want = 0
        for (let r = Math.max(0, r0); r <= Math.min(pixels - 1, r1); r++) {
          for (let cc = Math.max(0, c0); cc <= Math.min(pixels - 1, c1); cc++) want += land[r * pixels + cc]!
        }
        expect(t.landIn(c0, r0, c1, r1), `${pixels}px [${c0}, ${r0}, ${c1}, ${r1}]`).toBe(want)
        if (want > 0) some++
      }
      expect(some).toBeGreaterThan(100)
    }
  })

  it('has constant tiles for no water and all water', () => {
    expect(allLand().landIn(0, 0, TILE_PIXELS - 1, TILE_PIXELS - 1)).toBe(TILE_PIXELS * TILE_PIXELS)
    expect(allLand(16).landIn(-3, 2, 20, 2)).toBe(16)
    expect(allWater().landIn(0, 0, 9, 9)).toBe(0)
    expect(rasteriseTile([], EXTENT).landIn(0, 0, 511, 511)).toBe(TILE_PIXELS * TILE_PIXELS)
  })
})

describe('tile land in the water grid', () => {
  // A zoom-12 tile in the Baltic, and its corner in world units.
  const TX = 2250
  const TY = 1150
  const PX = 1 / (SPAN * TILE_PIXELS)
  const tileWest = TX / SPAN
  const tileNorth = TY / SPAN
  const lngLatOf = (x: number, y: number): LngLat => toLngLat([x, y])

  it('an island one pixel wide closes the cell it is in', () => {
    // All water but pixel (200, 300), which is 8 tile units a side.
    const island = rasteriseTile([{ rings: [rect(-64, -64, 4160, 4160), rect(1601, 2401, 1607, 2407)] }], EXTENT)
    expect(island.landIn(0, 0, 511, 511)).toBe(1)
    // Natural Earth says land over the whole tile and beyond; inside the tile only the tile counts.
    const [w, n] = lngLatOf(tileWest - 0.1 / SPAN, tileNorth - 0.1 / SPAN)
    const [e, s] = lngLatOf(tileWest + 1.1 / SPAN, tileNorth + 1.1 / SPAN)
    const land = withTiles(source([square(w, s, e, n)]), tileLand(new Map([[`${TX}/${TY}`, island]])), 't+tiles')
    // Cells 3.3 pixels wide, so cell edges fall inside pixels.
    const frame: GridFrame = { x0: tileWest + 190.2 * PX, y0: tileNorth + 290.7 * PX, cell: 3.3 * PX, cols: 8, rows: 8 }
    const g = waterGridAt(land, frame)
    let closed = 0
    for (let i = 0; i < g.land.length; i++) {
      // In the tile's own pixels.
      const [a, b, c, d] = cellPixels(frame, i).map((v, k) => v - (k % 2 === 0 ? TX : TY) * TILE_PIXELS) as [number, number, number, number]
      const overlaps = Math.min(c, 201) - Math.max(a, 200) > 1e-6 && Math.min(d, 301) - Math.max(b, 300) > 1e-6
      expect(g.land[i], `cell ${i}`).toBe(overlaps ? 1 : 0)
      expect(g.solid[i], `cell ${i}`).toBe(0)
      if (overlaps) {
        expect(g.cost[i]).toBe(Infinity)
        closed++
      }
    }
    expect(closed).toBe(4)
    // Cells 4 pixels wide on pixel edges: only the cell holding the pixel closes; those touching it stay open.
    const aligned = waterGridAt(land, { x0: tileWest + 196 * PX, y0: tileNorth + 296 * PX, cell: 4 * PX, cols: 3, rows: 3 })
    expect([...aligned.land]).toEqual([0, 0, 0, 0, 1, 0, 0, 0, 0])
  })

  it('a cell across the coverage edge keeps the ring land', () => {
    // Tile x 3072 starts at 90° E exactly. Ring land 0.05° either side of it, well past the grid.
    const tx = 3072
    const west = tx / SPAN
    const [, n] = lngLatOf(west, tileNorth - 0.5 / SPAN)
    const [, s] = lngLatOf(west, tileNorth + 1.5 / SPAN)
    const rings = source([square(89.95, s, 90.05, n)])
    const cell = 1 / SPAN / 40
    // Column 3 is half west of the tile, half on it.
    const frame: GridFrame = { x0: west - 3.5 * cell, y0: tileNorth + 10 * cell, cell, cols: 8, rows: 4 }
    const wet = waterGridAt(withTiles(rings, tileLand(new Map([[`${tx}/${TY}`, allWater()]])), 'w'), frame)
    for (let r = 0; r < frame.rows; r++) {
      const at = (c: number) => r * frame.cols + c
      for (const c of [0, 1, 2]) {
        expect(wet.land[at(c)], `uncovered ${c}`).toBe(1)
        expect(wet.solid[at(c)], `uncovered ${c}`).toBe(1)
      }
      expect(wet.land[at(3)]).toBe(1)
      expect(wet.solid[at(3)]).toBe(0)
      for (const c of [4, 5, 6, 7]) expect(wet.land[at(c)], `covered ${c}`).toBe(0)
    }
    // The other way round: ring water off the tile, tile land on it. The cell is land, and not solid.
    const dry = waterGridAt(withTiles(source([]), tileLand(new Map([[`${tx}/${TY}`, allLand()]])), 'd'), frame)
    for (let r = 0; r < frame.rows; r++) {
      const at = (c: number) => r * frame.cols + c
      expect(dry.land[at(2)]).toBe(0)
      expect(dry.land[at(3)]).toBe(1)
      expect(dry.solid[at(3)]).toBe(0)
      expect(dry.solid[at(4)]).toBe(1)
    }
  })

  it('tile x wraps across 180°', () => {
    const tiles = recording(new Map([[`4095/${TY}`, allLand()], [`0/${TY}`, allWater()]]))
    // 255 columns, so no cell edge falls on x = 1 and column 127 straddles it.
    const cell = 0.002 / 255
    const frame: GridFrame = { x0: 0.999, y0: tileNorth + 0.25 / SPAN, cell, cols: 255, rows: 4 }
    const g = waterGridAt(withTiles(source([]), tiles, 'w'), frame)
    const xs = new Set(tiles.asked.map(([x]) => x))
    expect(xs.has(4095)).toBe(true)
    expect(xs.has(0)).toBe(true)
    for (const x of xs) expect(x >= 0 && x < SPAN, `asked x ${x}`).toBe(true)
    // Land wherever a cell overlaps tile 4095; tile 0 is water and the tiles beyond are not loaded.
    for (let c = 0; c < frame.cols; c++) {
      const xa = frame.x0 + c * cell
      const want = Math.min(xa + cell, 1) - Math.max(xa, 4095 / SPAN) > 0 ? 1 : 0
      expect(g.land[c], `column ${c}`).toBe(want)
    }
    expect(g.land[126]).toBe(1)
    expect(g.land[127]).toBe(1)
    expect(g.land[128]).toBe(0)
    // tileLand wraps x itself.
    const keyed = tileLand(new Map([[`4095/${TY}`, allLand()], [`0/${TY}`, allWater()]]))
    expect(keyed.tile(-1, TY)).toBe(keyed.tile(4095, TY))
    expect(keyed.tile(SPAN, TY)).toBe(keyed.tile(0, TY))
    expect(keyed.tile(0, TY)).toBeDefined()
  })

  it('rows above and below the Mercator square have no tiles', () => {
    // A TileLand that would hand out land anywhere, even off the square.
    const asked: [number, number][] = []
    const everywhere: TileLand = {
      zoom: WATER_ZOOM,
      pixels: TILE_PIXELS,
      tile(x, y) {
        asked.push([x, y])
        return allLand()
      },
    }
    const cell = 1 / SPAN / 8
    for (const y0 of [-2.5 * cell, 1 - 2.5 * cell]) {
      asked.length = 0
      const frame: GridFrame = { x0: 0.5, y0, cell, cols: 2, rows: 5 }
      const g = waterGridAt(withTiles(source([]), everywhere, 'e'), frame)
      for (const [, y] of asked) expect(y >= 0 && y < SPAN, `asked y ${y}`).toBe(true)
      const rowLand = [0, 1, 2, 3, 4].map((r) => g.land[r * 2])
      const rowSolid = [0, 1, 2, 3, 4].map((r) => g.solid[r * 2])
      // Row 2 straddles the edge: tile land makes it land, but it isn't solid.
      if (y0 < 0) {
        expect(rowLand).toEqual([0, 0, 1, 1, 1])
        expect(rowSolid).toEqual([0, 0, 0, 1, 1])
      } else {
        expect(rowLand).toEqual([1, 1, 1, 0, 0])
        expect(rowSolid).toEqual([1, 1, 0, 0, 0])
      }
    }
    const keyed = tileLand(new Map([[`0/0`, allLand()], [`0/${SPAN - 1}`, allLand()]]))
    expect(keyed.tile(0, -1)).toBeUndefined()
    expect(keyed.tile(0, SPAN)).toBeUndefined()
    expect(keyed.tile(0, 0)).toBeDefined()
  })

  it('isLand reads a loaded tile and falls back to the rings', () => {
    const island = rasteriseTile([{ rings: [rect(-64, -64, 4160, 4160), rect(1601, 2401, 1607, 2407)] }], EXTENT)
    const [w, n] = lngLatOf(tileWest - 0.1 / SPAN, tileNorth - 0.1 / SPAN)
    const [e, s] = lngLatOf(tileWest + 1.1 / SPAN, tileNorth + 1.1 / SPAN)
    const base = source([square(w, s, e, n)])
    const land = withTiles(base, tileLand(new Map([[`${TX}/${TY}`, island]])), 'v2')
    expect(land.version).toBe('v2')
    expect(land.tiles?.zoom).toBe(WATER_ZOOM)
    expect(land.ringsIn(0, 0, 1, 1)).toEqual(base.ringsIn(0, 0, 1, 1))
    const centre = (c: number, r: number) => lngLatOf(tileWest + (c + 0.5) * PX, tileNorth + (r + 0.5) * PX)
    expect(land.isLand(centre(200, 300))).toBe(true)
    expect(land.isLand(centre(201, 300))).toBe(false)
    const [lng, lat] = centre(201, 300)
    expect(land.isLand([lng + 360, lat])).toBe(false)
    // Off the tile, on ring land.
    expect(land.isLand(lngLatOf(tileWest - 0.05 / SPAN, tileNorth + 0.5 / SPAN))).toBe(true)
    expect(base.isLand(centre(201, 300))).toBe(true)
  })
})
