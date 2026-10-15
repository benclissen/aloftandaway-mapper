import { describe, expect, test } from 'vitest'
import { SYMBOLS, SYMBOL_ICON } from '../../src/core/index.js'
import { ICONS } from '../../src/studio/stage/icons.js'

/** Argument counts of the SVG path commands. */
const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }

/** A minimal path tokeniser: every command is known and has a whole number of argument groups. */
function parsePath(d: string): void {
  const token = /\s*,?\s*(?:([a-zA-Z])|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?))/y
  let cmd = ''
  let count = 0
  const flush = () => {
    if (!cmd) return
    const need = ARGS[cmd.toUpperCase()]
    if (need === undefined) throw new Error(`unknown command ${cmd}`)
    if (need === 0 ? count !== 0 : count === 0 || count % need !== 0) throw new Error(`${cmd} has ${count} numbers`)
  }
  let pos = 0
  while (pos < d.length) {
    // Arc flags are single digits and may run into the next number, as in `a2 2 0 00-2-2`.
    const flag = cmd.toUpperCase() === 'A' && (count % 7 === 3 || count % 7 === 4)
    const re = flag ? /\s*,?\s*()([01])/y : token
    re.lastIndex = pos
    const m = re.exec(d)
    if (!m) throw new Error(`bad token at ${pos}`)
    pos = re.lastIndex
    if (m[1]) {
      flush()
      cmd = m[1]
      count = 0
    } else count++
  }
  flush()
}

describe('icons', () => {
  test('every SymbolKind except none and dot has an icon', () => {
    for (const kind of SYMBOLS) {
      if (kind === 'none' || kind === 'dot') {
        expect(kind in SYMBOL_ICON).toBe(false)
        continue
      }
      const name = SYMBOL_ICON[kind]
      expect(name, kind).toBeDefined()
      expect(ICONS[name], `${kind} -> ${name}`).toBeDefined()
    }
  })

  test('every icon path parses', () => {
    for (const [name, icon] of Object.entries(ICONS)) {
      expect(icon.paths.length, name).toBeGreaterThan(0)
      for (const d of icon.paths) {
        expect(d, name).toMatch(/^[Mm]/)
        expect(() => parsePath(d), `${name}: ${d}`).not.toThrow()
      }
      expect(['right', 'front', 'north-east', 'up']).toContain(icon.facing)
    }
  })

  test('the six hand-drawn icons exist', () => {
    for (const name of ['campervan', 'coach', 'ferry', 'speedboat', 'balloon', 'arrow']) expect(ICONS).toHaveProperty(name)
  })
})
