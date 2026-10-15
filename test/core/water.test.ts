import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  cellAt,
  cellCentre,
  decodeLand,
  encodeLand,
  firstLandOnSegment,
  landIndex,
  snapToWater,
  toXY,
  waterGrid,
  type Box,
  type LngLat,
  type WaterGrid,
  type XY,
} from '../../src/core/index.js'

const square = (w: number, s: number, e: number, n: number): LngLat[] => [[w, s], [e, s], [e, n], [w, n]]
const source = (rings: LngLat[][]) => landIndex(decodeLand(encodeLand('t', rings)))
const boxOf = (w: number, s: number, e: number, n: number): Box => {
  const [minX, maxY] = toXY([w, s])
  const [maxX, minY] = toXY([e, n])
  return { minX, minY, maxX, maxY }
}

// A 1°×1° island in a 4°×4° box.
const island = boxOf(20, 30, 21, 31)
const islandGrid = () => waterGrid(source([square(20, 30, 21, 31)]), boxOf(18.5, 28.5, 22.5, 32.5), 256)

/** Cell rectangle in Mercator. */
const cellBox = (g: WaterGrid, i: number): Box => {
  const c = i % g.cols
  const r = Math.floor(i / g.cols)
  return { minX: g.x0 + c * g.cell, minY: g.y0 + r * g.cell, maxX: g.x0 + (c + 1) * g.cell, maxY: g.y0 + (r + 1) * g.cell }
}
/** Gap between two boxes along the wider axis (0 if they overlap or touch). */
const gap = (a: Box, b: Box): number =>
  Math.max(0, a.minX - b.maxX, b.minX - a.maxX, a.minY - b.maxY, b.minY - a.maxY)

describe('water grid', () => {
  it('marks a square island and its edge cells as land', () => {
    const g = islandGrid()
    expect(Math.max(g.cols, g.rows)).toBe(256)
    expect(g.land.length).toBe(g.cols * g.rows)
    let landCount = 0
    for (let i = 0; i < g.land.length; i++) {
      const b = cellBox(g, i)
      const [cx, cy] = cellCentre(g, i)
      const centreInside = cx > island.minX && cx < island.maxX && cy > island.minY && cy < island.maxY
      const overlaps = b.maxX > island.minX && b.minX < island.maxX && b.maxY > island.minY && b.minY < island.maxY
      const crossesOutline = overlaps && !(b.minX > island.minX && b.maxX < island.maxX && b.minY > island.minY && b.maxY < island.maxY)
      if (centreInside || crossesOutline) expect(g.land[i], `cell ${i}`).toBe(1)
      if (gap(b, island) >= 2 * g.cell - 1e-12) expect(g.land[i], `cell ${i}`).toBe(0)
      landCount += g.land[i]!
    }
    expect(landCount).toBeGreaterThan(3000)
  })

  it('fills a ring with a hole as land around water', () => {
    const g = waterGrid(source([square(19, 29, 23, 33), square(20, 30, 22, 32)]), boxOf(18, 28, 24, 34), 256)
    expect(g.land[cellAt(g, toXY([21, 31]))!]).toBe(0)
    expect(g.land[cellAt(g, toXY([19.5, 31]))!]).toBe(1)
    expect(g.land[cellAt(g, toXY([18.5, 31]))!]).toBe(0)
  })

  it('costs more next to the coast', () => {
    const g = islandGrid()
    const [, y] = toXY([20.5, 30.5])
    // The first water cell east of the island, along the island's middle row.
    let i = cellAt(g, [island.maxX, y])!
    while (g.land[i] === 1) i++
    expect(g.land[i - 1]).toBe(1)
    expect(g.cost[i]).toBe(3)
    expect(g.cost[i + 1]).toBe(2)
    expect(g.cost[i + 2]).toBe(1.5)
    expect(g.cost[i + 10]).toBe(1)
    expect(g.cost[i - 1]).toBe(Infinity)
  })

  it('snaps an inland point to the nearest water within the limit', () => {
    const g = islandGrid()
    const p = toXY([20.9, 30.5])
    const i = snapToWater(g, p, 50)
    expect(i).toBeDefined()
    expect(g.land[i!]).toBe(0)
    const [cx, cy] = cellCentre(g, i!)
    expect(cx).toBeGreaterThan(island.maxX)
    expect(cx - island.maxX).toBeLessThan(2 * g.cell)
    expect(Math.abs(cy - p[1])).toBeLessThan(g.cell)
    expect(snapToWater(g, p, 1)).toBeUndefined()
    // A point already in water snaps to its own cell.
    const sea = toXY([19, 29])
    expect(snapToWater(g, sea, 1)).toBe(cellAt(g, sea))
  })

  it('finds land on a segment', () => {
    const g = islandGrid()
    const hit = firstLandOnSegment(g, toXY([19, 30.5]), toXY([22, 30.5]))
    expect(hit).toBeDefined()
    expect(g.land[cellAt(g, hit!)!]).toBe(1)
    expect(hit![0]).toBeGreaterThan(island.minX - g.cell)
    expect(hit![0]).toBeLessThan(island.minX + g.cell)
    expect(firstLandOnSegment(g, toXY([19, 29]), toXY([22, 29.5]))).toBeUndefined()
  })

  it('maps points to cells and back', () => {
    const g = islandGrid()
    expect(cellAt(g, [g.x0 - g.cell, g.y0])).toBeUndefined()
    expect(cellAt(g, [g.x0, g.y0 + g.rows * g.cell + g.cell])).toBeUndefined()
    const i = 5 * g.cols + 7
    expect(cellAt(g, cellCentre(g, i))).toBe(i)
  })

  it('works on unwrapped boxes', () => {
    const land = landIndex(decodeLand(readFileSync(new URL('../../data/land-10m.bin', import.meta.url))))
    const [, minY] = toXY([0, -15])
    const [, maxY] = toXY([0, -20])
    const g = waterGrid(land, { minX: 0.99, minY, maxX: 1.02, maxY }, 512)
    const vitiLevu = toXY([178.0, -17.8])
    expect(g.land[cellAt(g, vitiLevu)!]).toBe(1)
    // An island east of 180°, at its unwrapped x beyond 1.
    const east: XY = [toXY([-179.85, -16.8])[0] + 1, toXY([-179.85, -16.8])[1]]
    expect(g.land[cellAt(g, east)!]).toBe(1)
    expect(g.land[cellAt(g, toXY([179.0, -19.5]))!]).toBe(0)
  })
})
