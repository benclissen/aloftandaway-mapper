import { describe, expect, test } from 'vitest'
import { LegModeSchema, NO_ROAD_ROUTE, ROAD_OFFLINE, SYMBOLS, THEMES, type Route, type Scene } from '../../src/core/index.js'
import { fallbackNote, legModeChanges, legModeOptions, MODE_LABELS, SYMBOL_LABELS, THEME_NAMES, roadNote, trackNote, unverifiedNote } from '../../src/studio/edit/labels.js'
import { canAddVia, canSharpen, isSharp, viaHandleAt } from '../../src/studio/edit/RouteEditor.js'
import { greekIslands } from '../fixtures/projects.js'

test('every symbol, mode and theme has a label', () => {
  for (const s of SYMBOLS) expect(SYMBOL_LABELS[s]).toBeTruthy()
  for (const m of LegModeSchema.options) expect(MODE_LABELS[m]).toBeTruthy()
  for (const t of THEMES) expect(THEME_NAMES[t]).toBeTruthy()
  expect(Object.keys(SYMBOL_LABELS)).toHaveLength(SYMBOLS.length)
})

test('an unverified sea route has a leg note for each reason', () => {
  expect(unverifiedNote('offline', 'ok')).toBe("Checked against Natural Earth only: OpenFreeMap couldn't be reached. Mapper checks it again by itself.")
  expect(unverifiedNote('budget', 'ok')).toBe(
    'Checked against Natural Earth only: the project needed more map tiles at once than Mapper fetches in one go. Mapper checks it again by itself.',
  )
  expect(unverifiedNote('unsettled', 'ok')).toBe('Only partly checked: it kept finding new islands. It may cross small islands near the ones it found.')
})

test('an unverified sea route drawn as a straight line says it may cross land', () => {
  expect(unverifiedNote('offline', 'fallback')).toBe(
    "No route found: OpenFreeMap couldn't be reached. Drawn as a straight line, which may cross land. Mapper checks it again by itself.",
  )
  expect(unverifiedNote('budget', 'fallback')).toBe(
    'No route found: the project needed more map tiles at once than Mapper fetches in one go. Drawn as a straight line, which may cross land. Mapper checks it again by itself.',
  )
  expect(unverifiedNote('unsettled', 'fallback')).toBe('No route found: it kept finding new islands. Drawn as a straight line, which may cross land.')
})

test('a fallback leg has one note, the unverified one when it is unverified', () => {
  expect(fallbackNote({ status: 'fallback', reason: 'The start stop is more than 30 km from the sea' })).toBe(
    'No sea route found: The start stop is more than 30 km from the sea. Drawn as a line.',
  )
  expect(fallbackNote({ status: 'fallback' })).toBe('No sea route found. Drawn as a line.')
  // The unverified note says it's drawn as a straight line, and why.
  for (const why of ['offline', 'budget', 'unsettled'] as const) {
    expect(fallbackNote({ status: 'fallback', reason: 'No sea route found', unverified: why })).toBeUndefined()
  }
  expect(fallbackNote({ status: 'ok' })).toBeUndefined()
  expect(fallbackNote({ status: 'pending' })).toBeUndefined()
  expect(fallbackNote(undefined)).toBeUndefined()
})

describe('recorded-track legs', () => {
  const ID = 'abcdef012345'

  test('Recorded track is offered only on a leg with a track', () => {
    expect(legModeOptions({ mode: 'sea' })).toEqual(['line', 'land', 'sea', 'air'])
    expect(legModeOptions({ mode: 'sea', track: ID })).toEqual(['line', 'land', 'sea', 'air', 'track'])
    expect(legModeOptions({ mode: 'track', track: ID })).toContain('track')
  })

  test('choosing Recorded track sends mode and an empty via', () => {
    expect(legModeChanges('track')).toEqual({ mode: 'track', via: [] })
  })

  test('leaving a track leg keeps its track', () => {
    expect(legModeChanges('line')).toEqual({ mode: 'line' })
    expect(legModeChanges('sea')).toEqual({ mode: 'sea' })
  })

  test('a track leg shows no via handles and a click adds none', () => {
    expect(canAddVia({ mode: 'track' })).toBe(false)
    expect(canAddVia({ mode: 'sea' })).toBe(true)
    // No via point, so the point menu has nothing to act on.
    const scene = structuredClone(greekIslands().scenes[0]!)
    scene.legs[0] = { ...scene.legs[0]!, mode: 'track', track: ID, via: [] }
    expect(isSharp(scene, { kind: 'via', leg: 0, index: 0 })).toBeUndefined()
  })

  test('a missing track shows a note', () => {
    expect(trackNote({ status: 'missing', id: ID })).toBe("Its recorded track file is missing, so it's drawn as a straight line.")
  })

  test('a far stop shows a note', () => {
    expect(trackNote({ status: 'ok', id: ID, stopGapKm: [0.4, 7.26] })).toBe('A stop is 7.3 km from the recorded track.')
    expect(trackNote({ status: 'ok', id: ID, stopGapKm: [3.04, 1] })).toBe('A stop is 3.0 km from the recorded track.')
  })

  test('a track within 2 km, or none, has no note', () => {
    expect(trackNote({ status: 'ok', id: ID, stopGapKm: [0.4, 2] })).toBeUndefined()
    expect(trackNote({ status: 'ok', id: ID })).toBeUndefined()
    expect(trackNote(undefined)).toBeUndefined()
  })
})

describe('roadNote', () => {
  test('says why a car leg is drawn as a curve', () => {
    expect(roadNote({ status: 'fallback', profile: 'car', reason: ROAD_OFFLINE, unverified: 'offline' })).toBe(
      "Couldn't reach the road router, so it's drawn as a curve. Mapper tries again by itself.",
    )
    expect(roadNote({ status: 'fallback', profile: 'car', reason: NO_ROAD_ROUTE })).toBe(
      "No road route between these stops, so it's drawn as a curve.",
    )
  })

  test('names a stop that is far from the road, and is silent otherwise', () => {
    expect(roadNote({ status: 'ok', profile: 'car', stopGapKm: [0.2, 1.2] })).toBe('A stop is 1.2 km from the nearest road.')
    expect(roadNote({ status: 'ok', profile: 'car', stopGapKm: [0.2, 0.5] })).toBeUndefined()
    expect(roadNote({ status: 'ok', profile: 'car' })).toBeUndefined()
    expect(roadNote({ status: 'pending', profile: 'car' })).toBeUndefined()
    expect(roadNote(undefined)).toBeUndefined()
  })
})

describe('viaHandleAt', () => {
  const scene = {
    legs: [{ mode: 'land', via: [{ at: [24, 37.5] }] }, { mode: 'line', via: [{ at: [26, 36.5] }] }],
  } as unknown as Scene
  const leg = (road?: { status: 'ok' | 'pending' | 'fallback' }) =>
    ({ knots: [0, 1, 2], path: [[23, 37], [24.001, 37.502], [25, 36]], road: road && { profile: 'car', ...road } }) as unknown as Route['legs'][number]

  test('stays where the via was placed on a leg that follows the road', () => {
    expect(viaHandleAt(scene, { legs: [leg({ status: 'ok' })] } as Route, 0, 0)).toEqual([24, 37.5])
  })

  test('sits on the drawn path on any other leg', () => {
    expect(viaHandleAt(scene, { legs: [leg({ status: 'fallback' })] } as Route, 0, 0)).toEqual([24.001, 37.502])
    expect(viaHandleAt(scene, { legs: [leg({ status: 'pending' })] } as Route, 0, 0)).toEqual([24.001, 37.502])
    expect(viaHandleAt(scene, { legs: [leg()] } as Route, 0, 0)).toEqual([24.001, 37.502])
    expect(viaHandleAt(scene, { legs: [leg()] } as Route, 0, 5)).toBeUndefined()
  })
})

describe('canSharpen', () => {
  const scene = (symbol: 'car' | 'train', mode: 'land' | 'line'): Scene => {
    const s = structuredClone(greekIslands().scenes[0]!)
    s.look.symbol = symbol
    s.legs[0] = { ...s.legs[0]!, mode, via: [{ at: [25, 37] }] }
    return s
  }
  const via = { kind: 'via', leg: 0, index: 0 } as const

  test('is false for a via point on a car land leg, which follows a road', () => {
    expect(canSharpen(scene('car', 'land'), via)).toBe(false)
  })

  test('is true for a via point on a train land leg, a line leg, or a stop', () => {
    expect(canSharpen(scene('train', 'land'), via)).toBe(true)
    expect(canSharpen(scene('car', 'line'), via)).toBe(true)
    const s = scene('car', 'land')
    expect(canSharpen(s, { kind: 'stop', id: s.stops[0]!.id })).toBe(true)
  })

  test('is true for a via point whose leg is gone', () => {
    expect(canSharpen(scene('car', 'land'), { kind: 'via', leg: 99, index: 0 })).toBe(true)
  })
})
