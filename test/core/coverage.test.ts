import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeLand, haversineKm, landIndex, tilesNear, toLngLat, toXY, type LngLat } from '../../src/core/index.js'

const land = landIndex(decodeLand(readFileSync(new URL('../../data/land-10m.bin', import.meta.url))))

const Z = 12
const SPAN = 2 ** Z

/** Points every `stepKm` or closer along the polyline, straight in Mercator between its points. */
function dense(path: LngLat[], stepKm: number): LngLat[] {
  const out: LngLat[] = [path[0]!]
  for (let i = 1; i < path.length; i++) {
    const a = toXY(path[i - 1]!)
    const b = toXY(path[i]!)
    const n = Math.max(1, Math.ceil(haversineKm(path[i - 1]!, path[i]!) / stepKm))
    for (let k = 1; k <= n; k++) out.push(toLngLat([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]))
  }
  return out
}

/** The distance, in km, from `p` to tile (x, y): to the nearest point of the tile's square, x unwrapped. */
function kmToTile(p: LngLat, x: number, y: number): number {
  const [px, py] = toXY(p)
  const nx = Math.min(Math.max(px, x / SPAN), (x + 1) / SPAN)
  const ny = Math.min(Math.max(py, y / SPAN), (y + 1) / SPAN)
  return haversineKm(p, toLngLat([nx, ny]))
}

describe('tilesNear', () => {
  it('covers every tile within the buffer', () => {
    // A bent line through the Stockholm archipelago, long enough to cross many tiles.
    const path: LngLat[] = [
      [18.3, 59.35],
      [18.42, 59.41],
      [18.5, 59.3],
    ]
    const bufferKm = 2
    const keys = tilesNear(path, { zoom: Z, bufferKm })
    expect(keys).toEqual([...new Set(keys)].sort())
    for (const k of keys) expect(k).toMatch(/^\d+\/\d+$/)

    const fine = dense(path, 0.01)
    const xs = fine.map((p) => toXY(p)[0] * SPAN)
    const ys = fine.map((p) => toXY(p)[1] * SPAN)
    const within = new Set<string>()
    const loose = new Set<string>()
    for (let x = Math.floor(Math.min(...xs)) - 4; x <= Math.floor(Math.max(...xs)) + 4; x++) {
      for (let y = Math.floor(Math.min(...ys)) - 4; y <= Math.floor(Math.max(...ys)) + 4; y++) {
        const d = Math.min(...fine.map((p) => kmToTile(p, x, y)))
        if (d <= bufferKm) within.add(`${x}/${y}`)
        if (d <= 2 * bufferKm) loose.add(`${x}/${y}`)
      }
    }
    expect(within.size).toBeGreaterThan(10)
    // Every tile within the buffer, and nothing far beyond it.
    expect([...within].filter((k) => !keys.includes(k))).toEqual([])
    expect(keys.filter((k) => !loose.has(k))).toEqual([])
  })

  it('wraps x at 180°', () => {
    // Unwrapped across the antimeridian, as routeSea returns it.
    const keys = tilesNear(
      [
        [179.95, -17],
        [180.05, -17],
      ],
      { zoom: Z, bufferKm: 1 },
    )
    const xs = keys.map((k) => Number(k.split('/')[0]))
    expect(xs.every((x) => x >= 0 && x < SPAN)).toBe(true)
    expect(xs).toContain(SPAN - 1)
    expect(xs).toContain(0)
    // The same tiles from the wrapped longitudes.
    expect(
      tilesNear(
        [
          [179.95, -17],
          [-179.95, -17],
        ],
        { zoom: Z, bufferKm: 1 },
      ),
    ).toEqual(keys)
  })

  it('the coast filter drops open-ocean tiles', () => {
    const opts = { zoom: Z, bufferKm: 2, coast: land, coastKm: 20 }
    const midAtlantic: LngLat[] = [
      [-35, 40],
      [-34, 40.2],
    ]
    expect(tilesNear(midAtlantic, { zoom: Z, bufferKm: 2 }).length).toBeGreaterThan(10)
    expect(tilesNear(midAtlantic, opts)).toEqual([])

    // Off Southampton: the Solent and Spithead, with the Isle of Wight and the mainland close by.
    const solent: LngLat[] = [
      [-1.4, 50.8],
      [-1.1, 50.75],
    ]
    const all = tilesNear(solent, { zoom: Z, bufferKm: 2 })
    const kept = tilesNear(solent, opts)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept).toEqual(all)

    // A line from the Channel out into the Atlantic keeps its coastal end only.
    const outward: LngLat[] = [
      [-5.5, 49.9],
      [-12, 48],
    ]
    const near = tilesNear(outward, opts)
    const every = tilesNear(outward, { zoom: Z, bufferKm: 2 })
    expect(near.length).toBeGreaterThan(0)
    expect(near.length).toBeLessThan(every.length / 2)
    expect(near.every((k) => every.includes(k))).toBe(true)
  })
})
