import { expect, test } from 'vitest'
import { SYMBOLS, THEMES, LegModeSchema } from '../../src/core/index.js'
import { MODE_LABELS, SYMBOL_LABELS, THEME_NAMES, unverifiedNote } from '../../src/studio/edit/labels.js'

test('every symbol, mode and theme has a label', () => {
  for (const s of SYMBOLS) expect(SYMBOL_LABELS[s]).toBeTruthy()
  for (const m of LegModeSchema.options) expect(MODE_LABELS[m]).toBeTruthy()
  for (const t of THEMES) expect(THEME_NAMES[t]).toBeTruthy()
  expect(Object.keys(SYMBOL_LABELS)).toHaveLength(SYMBOLS.length)
})

test('an unverified sea route has a leg note for each reason', () => {
  expect(unverifiedNote('offline')).toBe("Checked against Natural Earth only: OpenFreeMap couldn't be reached. Mapper checks it again by itself.")
  expect(unverifiedNote('budget')).toBe(
    'Checked against Natural Earth only: the project needed more map tiles at once than Mapper fetches in one go. Mapper checks it again by itself.',
  )
  expect(unverifiedNote('unsettled')).toBe('Only partly checked: it kept finding new islands. It may cross small islands near the ones it found.')
})
