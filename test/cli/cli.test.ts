import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'vitest'

// These tests spawn the compiled CLI. beforeAll compiles it (tsc only, under a second), so `npm test` needs no
// separate build step. Only the cancelled-render test starts Chrome.
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
  expect(JSON.parse(set.stdout).project.scenes[0].stops).toHaveLength(3)

  const validated = await mapper('validate-project', '--json', JSON.stringify({ folder }))
  expect(validated.code, validated.stderr).toBe(0)
  expect(JSON.parse(validated.stdout).errors).toEqual([])
})

test('mapper import-gpx --json works', async () => {
  const folder = path.join(tmp, 'gpx-project')
  const created = await mapper('create-project', '--json', JSON.stringify({ folder, name: 'Walk' }))
  expect(created.code, created.stderr).toBe(0)
  const file = path.join(ROOT, 'test', 'fixtures', 'gpx', 'track.gpx')
  const imported = await mapper('import-gpx', '--json', JSON.stringify({ folder, path: file }))
  expect(imported.code, imported.stderr).toBe(0)
  const out = JSON.parse(imported.stdout)
  expect(out.import.stops).toBe(2)
  expect(out.project.scenes[0].stops).toHaveLength(2)
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
  expect(JSON.parse(got.stdout).project.scenes[0].stops).toHaveLength(500)
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
  ['render with an empty --scenes entry', ['render', '/tmp/x', '--scenes', '1,,2']],
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

test('mapper set-stops --json with scene 2', async () => {
  const folder = path.join(tmp, 'scenes')
  await mapper('create-project', '--json', JSON.stringify({ folder, name: 'Scenes' }))
  const added = await mapper('update-project', '--json', JSON.stringify({ folder, ops: [{ op: 'add_scene', name: 'Sail' }] }))
  expect(added.code, added.stderr).toBe(0)
  const set = await mapper('set-stops', '--json', JSON.stringify({ ...STOPS, folder, scene: 2 }))
  expect(set.code, set.stderr).toBe(0)
  const result = JSON.parse(set.stdout)
  expect(result.project.scenes[0].stops).toHaveLength(0)
  expect(result.project.scenes[1].stops).toHaveLength(3)
  expect(result.scene).toEqual({ id: result.project.scenes[1].id, position: 2 })
  expect(set.stderr).toContain('Changed Scene 2 of 2 · Sail.')

  const unknown = await mapper('set-stops', '--json', JSON.stringify({ ...STOPS, folder, scene: 9 }))
  expect(unknown.code).toBe(1)
  expect(unknown.stderr).toContain('no scene 9')
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

test('render --help says H.264 MP4 is the default', async () => {
  const { stdout } = await mapper('render', '--help')
  expect(stdout).toMatch(/default[^\n]*H\.264 MP4/i)
  expect(stdout).toContain('--codec prores')
})

test('a failed render prints the error and what it left behind once, with no cancellation', async () => {
  const folder = path.join(tmp, 'failed')
  await mapper('create-project', '--json', JSON.stringify({ folder, name: 'Failed' }))
  const { code, stdout, stderr } = await mapper('render', folder)
  expect(code).toBe(1)
  expect(stdout).toBe('')
  expect(stderr).not.toContain('Cancelled.')
  expect(stderr.match(/Error: /g)).toHaveLength(1)
  expect(stderr.match(/No outputs were finished\./g)).toHaveLength(1)
})

test('a cancelled render reports its folder and the map credit on stderr and exits 130', async () => {
  const folder = path.join(tmp, 'cancelled')
  await mapper('create-project', '--json', JSON.stringify({ folder, name: 'Cancelled' }))
  await mapper('set-stops', '--json', JSON.stringify({ ...STOPS, folder }))
  const child = spawn(process.execPath, [MAIN, 'render', folder], {
    env: { ...(process.env as Record<string, string>), MAPPER_CACHE_DIR: path.join(tmp, 'cache') },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d: Buffer) => (stdout += d))
  child.stderr.on('data', (d: Buffer) => (stderr += d))
  const closed = new Promise<number | null>((resolve) => child.on('close', resolve))
  // The render folder appears before Chrome starts, so a signal now cancels a render that has a folder.
  const renders = path.join(folder, 'renders')
  for (let i = 0; i < 300 && !(existsSync(renders) && readdirSync(renders).length > 0); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  child.kill('SIGINT')
  const code = await closed
  expect(code).toBe(130)
  expect(stdout).toBe('')
  expect(stderr.match(/Cancelled\./g)).toHaveLength(1)
  expect(stderr.match(/No outputs were finished\./g)).toHaveLength(1)
  expect(stderr).toContain('No outputs were finished.')
  expect(stderr).toContain(`Folder: ${path.join(renders, readdirSync(renders)[0]!)}`)
  expect(stderr).toContain('Credit required: ')
}, 60_000)

/** Writes a preload that swaps the modules `main.js` imports by these specifiers for the given URLs. */
async function swapImports(dir: string, swaps: Record<string, string>): Promise<string> {
  const preload = path.join(dir, 'preload.mjs')
  await writeFile(
    preload,
    `import { registerHooks } from 'node:module'
const swaps = ${JSON.stringify(swaps)}
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === ${JSON.stringify(pathToFileURL(MAIN).href)} && specifier in swaps) {
      return { url: swaps[specifier], shortCircuit: true }
    }
    return next(specifier, context)
  },
})
`,
  )
  return preload
}

test('mapper render --scenes 1,s_x --each parses positions and ids', async () => {
  // A fake render returns the scenes and join it was given.
  const dir = path.join(tmp, 'scenes-each')
  await mkdir(dir, { recursive: true })
  const fakeRender = path.join(dir, 'fake-render.mjs')
  await writeFile(
    fakeRender,
    `export function addOutput(outputs, output) {
  outputs.push(output)
}
export async function renderProject(args) {
  return { dir: ${JSON.stringify(dir)}, manifest: ${JSON.stringify(path.join(dir, 'manifest.json'))}, frames: 1, renderFps: 1, fps: { num: 25, den: 1 }, projectHash: 'fake', outputs: [], scenes: [], sceneStarts: [], args: { scenes: args.scenes, join: args.join } }
}
`,
  )
  const preload = await swapImports(dir, { '../render/render.js': pathToFileURL(fakeRender).href })
  const run = (...args: string[]) => new Promise<Run>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, MAIN, 'render', dir, ...args])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d))
    child.stderr.on('data', (d: Buffer) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
  const each = await run('--scenes', '1, s_x,12', '--each')
  expect(each.code, each.stderr).toBe(0)
  expect(JSON.parse(each.stdout).args).toEqual({ scenes: [1, 's_x', 12], join: false })
  const all = await run()
  expect(all.code, all.stderr).toBe(0)
  expect(JSON.parse(all.stdout).args).toEqual({})
})

test('render --help documents --scenes and --each', async () => {
  const { stdout } = await mapper('render', '--help')
  expect(stdout).toContain('--scenes <ids or positions>')
  expect(stdout).toContain('--each')
})

test('a signal after the render finishes is not reported as a cancel', async () => {
  // A preload swaps in a render that succeeds at once, and a summary that waits for SIGINT before it prints. The
  // signal so always lands while the result is printing, and the shutdown handler has run by the time it goes on.
  const dir = path.join(tmp, 'signal-after-done')
  await mkdir(dir, { recursive: true })
  const fakeRender = path.join(dir, 'fake-render.mjs')
  await writeFile(
    fakeRender,
    `export function addOutput(outputs, output) {
  outputs.push(output)
}
export async function renderProject(args) {
  args.onStart?.({ dir: ${JSON.stringify(dir)} })
  return { dir: ${JSON.stringify(dir)}, manifest: ${JSON.stringify(path.join(dir, 'manifest.json'))}, frames: 1, renderFps: 1, fps: { num: 25, den: 1 }, projectHash: 'fake', outputs: [], scenes: [], sceneStarts: [] }
}
`,
  )
  const realTools = pathToFileURL(path.join(ROOT, 'dist', 'mcp', 'tools.js')).href
  const slowTools = path.join(dir, 'slow-tools.mjs')
  await writeFile(
    slowTools,
    `export * from ${JSON.stringify(realTools)}
import { doneSummary as realDoneSummary } from ${JSON.stringify(realTools)}
export async function doneSummary(result) {
  // A signal listener alone doesn't keep Node running.
  const alive = setInterval(() => undefined, 1000)
  await new Promise((resolve) => process.once('SIGINT', resolve))
  clearInterval(alive)
  await new Promise((resolve) => setImmediate(resolve))
  return realDoneSummary(result)
}
`,
  )
  const preload = await swapImports(dir, {
    '../render/render.js': pathToFileURL(fakeRender).href,
    '../mcp/tools.js': pathToFileURL(slowTools).href,
  })
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, MAIN, 'render', dir], {
    env: { ...(process.env as Record<string, string>), MAPPER_CACHE_DIR: path.join(tmp, 'cache') },
  })
  try {
    let stdout = ''
    let stderr = ''
    const printed = new Promise<void>((resolve) => {
      child.stdout.on('data', (d: Buffer) => {
        stdout += d
        if (stdout.trimEnd().endsWith('}')) resolve()
      })
    })
    child.stderr.on('data', (d: Buffer) => (stderr += d))
    const closed = new Promise<number | null>((resolve) => child.on('close', resolve))
    await printed
    expect(JSON.parse(stdout).dir).toBe(dir)
    child.kill('SIGINT')
    expect(await closed).toBe(130)
    expect(stderr).not.toContain('Cancelled.')
  } finally {
    child.kill('SIGKILL')
  }
}, 30_000)
