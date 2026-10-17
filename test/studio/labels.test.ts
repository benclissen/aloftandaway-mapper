import { expect, test } from 'vitest'
import { SYMBOLS, THEMES, LegModeSchema } from '../../src/core/index.js'
import { fallbackNote, MODE_LABELS, SYMBOL_LABELS, THEME_NAMES, unverifiedNote } from '../../src/studio/edit/labels.js'

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
