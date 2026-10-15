import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeLand, encodeLand, landIndex, toLngLat, toXY, type LngLat } from '../../src/core/index.js'

const shipped = () => readFileSync(new URL('../../data/land-10m.bin', import.meta.url))

describe('land data', () => {
  it('round-trips rings within 1e-4°', () => {
    const a: LngLat[] = [[10.12345, 50.54321], [11.1, 50.5], [10.9, 51.7], [10.12345, 50.54321]]
    const b: LngLat[] = [[-179.99, -84.5], [179.99, -80], [0, -70]]
    const out = decodeLand(encodeLand('test-1', [a, b]))
    expect(out.version).toBe('test-1')
    expect(out.rings).toHaveLength(2)
    for (const [i, ring] of [a.slice(0, 3), b].entries()) {
      const r = out.rings[i]!
      expect(r.length).toBe(ring.length * 2)
      ring.forEach(([lng, lat], j) => {
        const [dl, dt] = toLngLat([r[j * 2]!, r[j * 2 + 1]!])
        expect(Math.abs(dl - lng)).toBeLessThan(0.6e-4)
        expect(Math.abs(dt - lat)).toBeLessThan(0.6e-4)
      })
    }
  })

  it('rejects bytes without the MLND header', () => {
    expect(() => decodeLand(new Uint8Array([1, 2, 3, 4, 5, 6]))).toThrow(/not a Mapper land file/)
  })

  it('reads the shipped file', () => {
    const bytes = shipped()
    const data = decodeLand(new Uint8Array(bytes))
    expect(data.version).toBe('ne-10m-5.1.2')
    expect(data.rings.length).toBeGreaterThan(9000)
    expect(bytes.length).toBeLessThan(2.5 * 1024 * 1024)
  })

  it('knows land from sea', () => {
    const land = landIndex(decodeLand(new Uint8Array(shipped())))
    expect(land.isLand([23.7275, 37.9838])).toBe(true)
    expect(land.isLand([25.3289, 37.4467])).toBe(true)
    expect(land.isLand([7.4474, 46.948])).toBe(true)
    expect(land.isLand([6.6, 46.45])).toBe(true)
    expect(land.isLand([23.6, 37.93])).toBe(false)
    expect(land.isLand([25.0, 37.0])).toBe(false)
    expect(land.isLand([51, 42])).toBe(false)
  })

  it('finds rings across the antimeridian', () => {
    const land = landIndex(decodeLand(new Uint8Array(shipped())))
    const [x0, y0] = toXY([177, 5])
    const [x1, y1] = toXY([182, -25])
    const rings = land.ringsIn(x0, Math.min(y0, y1), x1, Math.max(y0, y1))
    expect(rings.some((r) => r.some((v, i) => i % 2 === 0 && v > 1))).toBe(true)
  })
})
