import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const coreDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/core')
const FORBIDDEN = new Set(['fs', 'path', 'http', 'maplibre-gl', 'react', 'ws'])

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : []
  })
}

function specifiers(source: string): string[] {
  const found: string[] = []
  const patterns = [
    /\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const re of patterns) for (const m of source.matchAll(re)) found.push(m[1]!)
  return found
}

test('src/core only imports from src/core and avoids platform modules', () => {
  const files = sourceFiles(coreDir)
  expect(files.length).toBeGreaterThan(0)
  const violations: string[] = []
  for (const file of files) {
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      const where = `${relative(coreDir, file)} imports '${spec}'`
      if (spec.startsWith('node:') || FORBIDDEN.has(spec) || [...FORBIDDEN].some((f) => spec.startsWith(`${f}/`))) {
        violations.push(where)
      } else if (spec.startsWith('.') && relative(coreDir, resolve(dirname(file), spec)).startsWith('..')) {
        violations.push(`${where} (outside src/core)`)
      }
    }
  }
  expect(violations).toEqual([])
})

test('the import scanner finds the specifiers it should', () => {
  const src = `import a from 'node:fs'\nimport { b } from "../x.js"\nexport * from 'ws'\nimport 'react'\nconst c = await import('path')`
  expect(specifiers(src).sort()).toEqual(['../x.js', 'node:fs', 'path', 'react', 'ws'])
})
