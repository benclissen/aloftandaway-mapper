import { describe, expect, test } from 'vitest'
import { signBox, signLift, SIGN_TAG, SYMBOL_SIZES, vehicleRadius, type SymbolKind, type SymbolStyle } from '../../src/core/index.js'
import { sceneOf, stopsAt } from '../fixtures/projects.js'

function scene(symbol: SymbolKind, opts: { style?: SymbolStyle; legSymbols?: Array<SymbolKind | undefined> } = {}) {
  const s = structuredClone(sceneOf(stopsAt([[0, 0], [1, 0], [2, 0]])))
  s.look.symbol = symbol
  if (opts.style) s.look.symbolStyle = opts.style
  opts.legSymbols?.forEach((leg, i) => {
    s.legs[i] = leg ? { ...s.legs[i]!, symbol: leg } : s.legs[i]!
  })
  return s
}

describe('vehicleRadius', () => {
  test('a dot or nothing is the dot radius, a badge its radius plus ring, an icon half its size plus half its halo', () => {
    expect(vehicleRadius('dot', 'badge')).toBe(SYMBOL_SIZES.dotRadius)
    expect(vehicleRadius('none', 'badge')).toBe(6)
    expect(vehicleRadius('car', 'badge')).toBe(25)
    expect(vehicleRadius('car', 'badge-line')).toBe(25)
    expect(vehicleRadius('car', 'icon')).toBe(16)
  })
})

describe('signLift', () => {
  test('a badge scene lifts signs to 41 px', () => {
    expect(signLift(scene('car'))).toBe(41)
    expect(signLift(scene('car', { style: 'badge-line' }))).toBe(41)
  })

  test('an icon scene lifts signs to 32 px', () => {
    expect(signLift(scene('plane', { style: 'icon' }))).toBe(32)
  })

  test('a dot scene keeps 16 px', () => {
    expect(signLift(scene('dot'))).toBe(SIGN_TAG.lift)
    expect(signLift(scene('none'))).toBe(16)
  })

  test('a scene with a dot look and a ferry leg uses 41 px', () => {
    expect(signLift(scene('dot', { legSymbols: [undefined, 'ferry'] }))).toBe(41)
  })

  test('a badge look that every leg overrides with a dot keeps 16 px', () => {
    expect(signLift(scene('car', { legSymbols: ['dot', 'dot'] }))).toBe(16)
  })

  test('a look symbol that no leg draws does not lift signs, but one a leg inherits does', () => {
    expect(signLift(scene('car', { legSymbols: ['dot', 'none'] }))).toBe(16)
    expect(signLift(scene('car', { legSymbols: ['dot', undefined] }))).toBe(41)
  })

  test('a scene with no legs uses its look symbol', () => {
    const s = scene('car')
    s.legs = []
    expect(signLift(s)).toBe(41)
  })
})

describe('signBox', () => {
  test('sits the box a given lift above the dot, the default lift when none is given', () => {
    expect(signBox([100, 200], 'Hi').bottom).toBe(200 - SIGN_TAG.lift)
    expect(signBox([100, 200], 'Hi', 41).bottom).toBe(159)
    expect(signBox([100, 200], 'Hi', 41).top).toBe(159 - (SIGN_TAG.lineHeight + 2 * SIGN_TAG.padY))
  })
})
