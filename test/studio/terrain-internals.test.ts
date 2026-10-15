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
