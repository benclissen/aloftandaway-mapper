import { expect, test } from 'vitest'
import { SYMBOLS, THEMES, LegModeSchema } from '../../src/core/index.js'
import { MODE_LABELS, SYMBOL_LABELS, THEME_NAMES } from '../../src/studio/edit/labels.js'

test('every symbol, mode and theme has a label', () => {
  for (const s of SYMBOLS) expect(SYMBOL_LABELS[s]).toBeTruthy()
  for (const m of LegModeSchema.options) expect(MODE_LABELS[m]).toBeTruthy()
  for (const t of THEMES) expect(THEME_NAMES[t]).toBeTruthy()
  expect(Object.keys(SYMBOL_LABELS)).toHaveLength(SYMBOLS.length)
})
