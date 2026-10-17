import { readFileSync } from 'node:fs'
import { describe, expect, test, vi } from 'vitest'
import { dropElevationTiles, redrawTerrain } from '../../src/studio/stage/terrain-internals.js'

describe('terrain internals', () => {
  test('call through to MapLibre when present', () => {
    const clearTiles = vi.fn()
    const releaseAllRTT = vi.fn()
    const map = { style: { tileManagers: { terrain: { clearTiles } } }, terrain: { tileManager: { releaseAllRTT } } }
    dropElevationTiles(map, 'terrain')
    redrawTerrain(map)
    expect(clearTiles).toHaveBeenCalledOnce()
    expect(releaseAllRTT).toHaveBeenCalledOnce()
  })

  test('a moved tile manager or clearTiles fails loudly', () => {
    const message = /can't render terrain deterministically.*map\.style\.tileManagers\['terrain'\]\.clearTiles is missing/
    expect(() => dropElevationTiles({}, 'terrain')).toThrow(message)
    expect(() => dropElevationTiles({ style: { tileManagers: {} } }, 'terrain')).toThrow(message)
    expect(() => dropElevationTiles({ style: { tileManagers: { terrain: {} } } }, 'terrain')).toThrow(message)
  })

  test('a moved terrain tile manager or releaseAllRTT fails loudly', () => {
    const message = /can't render terrain deterministically.*map\.terrain\.tileManager\.releaseAllRTT is missing/
    expect(() => redrawTerrain({})).toThrow(message)
    expect(() => redrawTerrain({ terrain: null })).toThrow(message)
    expect(() => redrawTerrain({ terrain: { tileManager: {} } })).toThrow(message)
  })
})

describe('MapLibre version', () => {
  // The terrain code reaches into MapLibre's internals, so a new minor version could break it without warning.
  test('maplibre-gl is pinned exactly', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> }
    expect(pkg.dependencies['maplibre-gl']).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
