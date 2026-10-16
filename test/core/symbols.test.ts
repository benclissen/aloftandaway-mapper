import { describe, expect, test } from 'vitest'
import { buildRoute, legFlipped, screenAngle, SYMBOLS, SYMBOL_FACING, symbolStyleOf, turnPose, type LngLat } from '../../src/core/index.js'
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

describe('screenAngle', () => {
  test('screen angle of a step east is 90', () => {
    // Degrees clockwise from screen-up, with y growing downwards.
    expect(screenAngle([10, 10], [14, 10])).toBeCloseTo(90)
    expect(screenAngle([10, 10], [10, 6])).toBeCloseTo(0)
    expect(screenAngle([10, 10], [10, 14])).toBeCloseTo(180)
    expect(screenAngle([10, 10], [6, 10])).toBeCloseTo(270)
    expect(screenAngle([10, 10], [9, 9])).toBeCloseTo(315)
  })

  test('a zero-length screen step has no angle', () => {
    expect(screenAngle([10, 10], [10, 10])).toBeUndefined()
    expect(screenAngle([10, 10], [10.005, 10.005])).toBeUndefined()
    expect(screenAngle([10, 10], [10.02, 10])).toBeCloseTo(90)
  })
})

describe('turnPose', () => {
  test('a westbound helicopter is mirrored, not upside down', () => {
    expect(turnPose(270, 'right', false)).toEqual({ rotate: 180, mirrorY: true })
    expect(turnPose(225, 'right', false)).toEqual({ rotate: 135, mirrorY: true })
  })

  test('an eastbound helicopter is not mirrored', () => {
    // Even on a leg that ends west of where it starts: the line on screen points east.
    expect(turnPose(90, 'right', true)).toEqual({ rotate: 0, mirrorY: false })
    expect(turnPose(45, 'right', true)).toEqual({ rotate: -45, mirrorY: false })
  })

  test("a nearly vertical line takes the leg's facing", () => {
    for (const angle of [0, 10, 170, 180, 194, 350]) {
      expect(turnPose(angle, 'right', true), `angle ${angle}`).toEqual({ rotate: angle - 90, mirrorY: true })
      expect(turnPose(angle, 'right', false), `angle ${angle}`).toEqual({ rotate: angle - 90, mirrorY: false })
    }
    // Past 15 degrees from vertical, the screen decides.
    expect(turnPose(16, 'right', true).mirrorY).toBe(false)
    expect(turnPose(344, 'right', false).mirrorY).toBe(true)
  })

  test('planes and arrows are never mirrored', () => {
    for (let angle = 0; angle < 360; angle += 15) {
      for (const flipped of [false, true]) {
        expect(turnPose(angle, 'north-east', flipped)).toEqual({ rotate: angle - 45, mirrorY: false })
        expect(turnPose(angle, 'up', flipped)).toEqual({ rotate: angle, mirrorY: false })
      }
    }
  })
})
