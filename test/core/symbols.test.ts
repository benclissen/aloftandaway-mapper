import { describe, expect, test } from 'vitest'
import { buildRoute, legFlipped, SYMBOLS, SYMBOL_FACING, symbolStyleOf, type LngLat } from '../../src/core/index.js'
import { sceneOf, stopsAt } from '../fixtures/projects.js'

const routeOf = (points: LngLat[]) => buildRoute(sceneOf(stopsAt(points)))

describe('legFlipped', () => {
  test('flips per leg, not per frame', () => {
    // East, then north, then back west.
    const route = routeOf([
      [0, 50],
      [2, 50],
      [2, 52],
      [0, 52],
    ])
    expect(route.legs).toHaveLength(3)
    expect(legFlipped(route, 0)).toBe(false)
    expect(legFlipped(route, 1)).toBe(false)
    expect(legFlipped(route, 2)).toBe(true)
  })

  test('a leg across the antimeridian is judged by its direction of travel', () => {
    expect(legFlipped(routeOf([[179, 10], [-179, 10]]), 0)).toBe(false)
    expect(legFlipped(routeOf([[-179, 10], [179, 10]]), 0)).toBe(true)
  })

  test('a leg that runs due south is not flipped', () => {
    expect(legFlipped(routeOf([[5, 50], [5, 40]]), 0)).toBe(false)
  })
})

describe('symbols', () => {
  test('symbolStyleOf defaults to badge', () => {
    expect(symbolStyleOf({} as never)).toBe('badge')
    expect(symbolStyleOf({ symbolStyle: 'icon' } as never)).toBe('icon')
    expect(symbolStyleOf({ symbolStyle: 'badge-line' } as never)).toBe('badge-line')
  })

  test('every SymbolKind has a facing rule', () => {
    for (const s of SYMBOLS) expect(SYMBOL_FACING[s]).toBeDefined()
    expect(SYMBOL_FACING.none).toBe('none')
    expect(SYMBOL_FACING.plane).toBe('turn')
    expect(SYMBOL_FACING.arrow).toBe('turn')
    expect(SYMBOL_FACING.car).toBe('side')
    expect(SYMBOL_FACING.walk).toBe('upright')
    expect(SYMBOL_FACING.dot).toBe('upright')
  })
})
