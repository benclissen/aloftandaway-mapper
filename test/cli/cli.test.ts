import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'vitest'

// These tests spawn the compiled CLI. beforeAll compiles it (tsc only, under a second), so `npm test` needs no
// separate build step. None of them start Chrome.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const MAIN = path.join(ROOT, 'dist', 'cli', 'main.js')

let tmp: string

beforeAll(async () => {
  await promisify(execFile)('npx', ['tsc', '-p', 'tsconfig.node.json'], { cwd: ROOT })
  tmp = await mkdtemp(path.join(os.tmpdir(), 'mapper-cli-'))
}, 120_000)

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

interface Run {
  code: number | null
  stdout: string
  stderr: string
}

function mapper(...args: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args], {
      env: { ...(process.env as Record<string, string>), MAPPER_CACHE_DIR: path.join(tmp, 'cache') },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d))
    child.stderr.on('data', (d: Buffer) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

const STOPS = {
  folder: '',
  stops: [
    { name: 'Piraeus', at: [23.6466, 37.942] },
    { name: 'Mykonos', at: [25.3289, 37.4467] },
    { name: 'Santorini', at: [25.4317, 36.4166] },
  ],
}

test('create, set stops and validate through the tool commands', async () => {
  const folder = path.join(tmp, 'trip')

  const created = await mapper('create-project', '--json', JSON.stringify({ folder, name: 'Greek isles' }))
  expect(created.code, created.stderr).toBe(0)
  expect(JSON.parse(created.stdout).project.name).toBe('Greek isles')
  expect(created.stderr).toContain('Greek isles')

  const file = path.join(tmp, 'stops.json')
  await writeFile(file, JSON.stringify({ ...STOPS, folder }))
  const set = await mapper('set-stops', '--json-file', file)
  expect(set.code, set.stderr).toBe(0)
  expect(JSON.parse(set.stdout).project.stops).toHaveLength(3)

  const validated = await mapper('validate-project', '--json', JSON.stringify({ folder }))
  expect(validated.code, validated.stderr).toBe(0)
  expect(JSON.parse(validated.stdout).errors).toEqual([])
})

test.each(['render-job', 'render-status', 'cancel-render', 'open-studio'])('%s is not a command', async (name) => {
  const { code, stderr } = await mapper(name)
  expect(code).toBe(2)
  expect(stderr).toContain(`Unknown command '${name}'`)
})

test('large output reaches a pipe whole', async () => {
  const folder = path.join(tmp, 'big')
  const stops = Array.from({ length: 500 }, (_, i) => ({ name: `Stop ${i}`, at: [i * 0.1, 10 + (i % 7)] }))
  const created = await mapper('create-project', '--json', JSON.stringify({ folder, name: 'Big' }))
  expect(created.code, created.stderr).toBe(0)
  const file = path.join(tmp, 'big-stops.json')
  await writeFile(file, JSON.stringify({ folder, stops }))
  const set = await mapper('set-stops', '--json-file', file)
  expect(set.code, set.stderr).toBe(0)

  const got = await mapper('get-project', '--json', JSON.stringify({ folder }))
  expect(got.code, got.stderr).toBe(0)
  expect(got.stdout.length).toBeGreaterThan(200_000)
  expect(JSON.parse(got.stdout).project.stops).toHaveLength(500)
})

test('--help lists every command', async () => {
  const { code, stdout } = await mapper('--help')
  expect(code).toBe(0)
  for (const name of ['mcp', 'studio', 'render', 'doctor', 'create-project', 'get-project', 'set-stops', 'update-project']) {
    expect(stdout).toContain(name)
  }
  for (const name of ['validate-project', 'preview-frame', 'preview-contact-sheet']) {
    expect(stdout).toContain(name)
  }
  for (const name of ['open-studio', 'render-job', 'render-status', 'cancel-render']) {
    expect(stdout).not.toMatch(new RegExp(`^  ${name}\\b`, 'm'))
  }
})

test('an unknown command exits 2 with usage on stderr', async () => {
  const { code, stdout, stderr } = await mapper('frobnicate')
  expect(code).toBe(2)
  expect(stdout).toBe('')
  expect(stderr).toContain("Unknown command 'frobnicate'")
  expect(stderr).toContain('Usage: mapper')
})

test('a relative folder exits 1 with a fix', async () => {
  const { code, stderr } = await mapper('get-project', '--json', JSON.stringify({ folder: 'relative/path' }))
  expect(code).toBe(1)
  expect(stderr).toContain('Error:')
  expect(stderr).toContain('Fix:')
})

test('invalid tool input exits 1 and names the field', async () => {
  const { code, stderr } = await mapper('get-project', '--json', '{}')
  expect(code).toBe(1)
  expect(stderr).toContain('folder')
  expect(stderr).toContain('Fix:')
})

test.each([
  ['an unknown flag', ['get-project', '--bogus']],
  ['invalid JSON', ['get-project', '--json', '{nope']],
  ['both --json and --json-file', ['get-project', '--json', '{}', '--json-file', '/x']],
  ['a missing --json-file', ['get-project', '--json-file', '/no/such/file.json']],
  ['render without a folder', ['render']],
  ['render with a bad codec', ['render', '/tmp/x', '--codec', 'gif']],
  ['render with --from alone', ['render', '/tmp/x', '--from', '2']],
  ['render with an empty layer entry', ['render', '/tmp/x', '--layers', 'map,,route']],
  ['render with an empty --layers', ['render', '/tmp/x', '--layers', '']],
  ['render with an unknown layer', ['render', '/tmp/x', '--layers', 'map,depth']],
  ['render with a duplicate layer', ['render', '/tmp/x', '--layers', 'map, map']],
  ['render with a non-number --to', ['render', '/tmp/x', '--from', '1', '--to', 'soon']],
  ['studio without a folder', ['studio']],
  ['doctor with a stray argument', ['doctor', 'extra']],
])('%s exits 2', async (_name, args) => {
  const { code, stdout, stderr } = await mapper(...args)
  expect(code).toBe(2)
  expect(stdout).toBe('')
  expect(stderr).toMatch(/Error: .+/)
})

test('a command takes --help', async () => {
  const { code, stdout } = await mapper('set-stops', '--help')
  expect(code).toBe(0)
  expect(stdout).toContain('mapper set-stops')
  expect(stdout).toContain('--json-file')
})

test('render --layers all,preview fails before any render folder exists', async () => {
  const folder = path.join(tmp, 'combo')
  await mapper('create-project', '--json', JSON.stringify({ folder, name: 'Combo' }))
  await mapper('set-stops', '--json', JSON.stringify({ ...STOPS, folder }))
  const { code, stdout, stderr } = await mapper('render', folder, '--layers', ' all , preview ')
  expect(code).toBe(1)
  expect(stdout).toBe('')
  expect(stderr).toContain('Do not combine all and preview')
  expect(existsSync(path.join(folder, 'renders'))).toBe(false)
})

test('render --help documents --layers', async () => {
  const { stdout } = await mapper('render', '--help')
  expect(stdout).toContain('--layers map,route,signs[,preview]')
})
