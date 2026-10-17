import { describe, expect, test } from 'vitest'
import { SYMBOLS, THEMES, LegModeSchema } from '../../src/core/index.js'
import { fallbackNote, legModeChanges, legModeOptions, MODE_LABELS, SYMBOL_LABELS, THEME_NAMES, trackNote, unverifiedNote } from '../../src/studio/edit/labels.js'
import { canAddVia, isSharp } from '../../src/studio/edit/RouteEditor.js'
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
