import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import { decodeLand, encodeLand, landIndex, NO_LAND_DATA, PATHS_ORIGIN, routeSea, seaLegKey, STALE_BASE_MESSAGE, validateProject, type LandSource, type LngLat, type Project, type ServerMessage, type ViaPoint } from '../../src/core/index.js'
import { PROJECT_FILE, createProject, loadProject, mutateProject, saveProject } from '../../src/server/store.js'
import type { SeaWater } from '../../src/server/sea-water.js'
import { getServer, startServer, WATCH_DEBOUNCE_MS, type MapperServer, type ServerOptions } from '../../src/server/server.js'

let tmp: string
let studioDir: string
let folder: string
let server: MapperServer
let key: string
let project: Project

interface Reply {
  status: number
  body: string
  headers: http.IncomingHttpHeaders
  json: () => any
}

/** node:http, because fetch won't let a test set the Host header. */
function call(
  url: string,
  init: { method?: string; host?: string; body?: string | Buffer; headers?: Record<string, string> } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: init.method ?? 'GET',
        headers: { ...init.headers, ...(init.host ? { Host: init.host } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers, json: () => JSON.parse(body) })
        })
      },
    )
    req.on('error', reject)
    req.end(init.body)
  })
}

function projectUrl(suffix = '', projectKey = key): string {
  return `${server.base}api/projects/${projectKey}${suffix}`
}

function patchProject(body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return call(projectUrl('/patch'), { method: 'POST', body: JSON.stringify(body), headers })
}

function wsUrl(projectKey = key): string {
  return server.base.replace('http:', 'ws:') + `ws/projects/${projectKey}`
}

/** Opens a socket and collects its messages. */
async function connect(url = wsUrl()): Promise<{ ws: WebSocket; messages: ServerMessage[]; next: (ms?: number) => Promise<ServerMessage> }> {
  const ws = new WebSocket(url)
  const messages: ServerMessage[] = []
  const waiting: Array<(m: ServerMessage) => void> = []
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString()) as ServerMessage
    const waiter = waiting.shift()
    if (waiter) waiter(message)
    else messages.push(message)
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  const next = (ms = 1000): Promise<ServerMessage> => {
    const queued = messages.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), ms)
      waiting.push((m) => {
        clearTimeout(timer)
        resolve(m)
      })
    })
  }
  return { ws, messages, next }
}

function rejection(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers })
    ws.once('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0)
      res.resume()
    })
    ws.once('open', () => reject(new Error('the upgrade should have been refused')))
    ws.once('error', () => undefined)
  })
}

/**
 * A sea router on the land alone, which says each leg was checked, or that it couldn't be while offline (or, with
 * `why`, for that reason).
 */
function fakeWater(state: { online: boolean; why?: 'offline' | 'unsettled' } = { online: true }): SeaWater & { calls: number } {
  const fake = {
    calls: 0,
    async route(from: LngLat, to: LngLat, via: ViaPoint[], base: LandSource) {
      fake.calls++
      const routed = routeSea(from, to, via, base)
      const why = state.why ?? 'offline'
      // Offline, the path is a little different, as a Natural Earth route would be.
      return state.online
        ? { ...routed, water: { build: 'b1', tiles: 1, rounds: 1 } }
        : { ...routed, path: [...routed.path], stopGapKm: [1, 1] as [number, number], unverified: why, water: { unverified: why } }
    },
  }
  return fake
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'mapper-server-'))
  studioDir = path.join(tmp, 'studio')
  await mkdir(path.join(studioDir, 'assets'), { recursive: true })
  await writeFile(path.join(studioDir, 'index.html'), '<!doctype html><title>studio</title>')
  await writeFile(path.join(studioDir, 'assets', 'app.js'), 'console.log(1)')
  await writeFile(path.join(tmp, 'secret.txt'), 'secret')
  folder = path.join(tmp, 'trip')
  project = await createProject(folder, 'Trip')
  // Give it a stop to edit.
  const saved = await saveProject(folder, {
    ...project,
    scenes: [
      {
        ...project.scenes[0]!,
        stops: [
          { id: 'a', name: 'Piraeus', at: [23.6466, 37.942], pause: 0, sign: 'always' },
          { id: 'b', name: 'Mykonos', at: [25.3289, 37.4467], pause: 0, sign: 'always' },
        ],
        legs: [{ mode: 'line', via: [] }],
      },
    ],
  })
  project = saved
  // Never the real tile store: offline, its retries would hold up every sea route for the folder.
  server = await startServer({ studioDir, cacheDir: path.join(tmp, 'cache'), water: fakeWater() })
  key = await server.registerProject(folder)
})

afterEach(async () => {
  await server.close()
  await rm(tmp, { recursive: true, force: true })
})

describe('security', () => {
  test('binds 127.0.0.1 with a 64-character hex token', () => {
    expect(server.token).toMatch(/^[0-9a-f]{64}$/)
    expect(server.base).toBe(`http://127.0.0.1:${server.port}/${server.token}/`)
  })

  test('rejects a foreign Host header', async () => {
    const evil = await call(projectUrl(), { host: `evil.example:${server.port}` })
    expect(evil.status).toBe(403)
    const rebinding = await call(projectUrl(), { host: 'evil.example' })
    expect(rebinding.status).toBe(403)
    const wrongPort = await call(projectUrl(), { host: `127.0.0.1:${server.port + 1}` })
    expect(wrongPort.status).toBe(403)
    const local = await call(projectUrl(), { host: `localhost:${server.port}` })
    expect(local.status).toBe(200)
  })

  test('rejects a wrong token', async () => {
    const other = 'f'.repeat(64)
    const reply = await call(`http://127.0.0.1:${server.port}/${other}/api/projects/${key}`)
    expect(reply.status).toBe(404)
    const short = await call(`http://127.0.0.1:${server.port}/abc/api/projects/${key}`)
    expect(short.status).toBe(404)
    const none = await call(`http://127.0.0.1:${server.port}/api/projects/${key}`)
    expect(none.status).toBe(404)
  })

  test('a wrong Host is refused before the token is checked', async () => {
    const reply = await call(`http://127.0.0.1:${server.port}/nope/studio/`, { host: 'evil.example' })
    expect(reply.status).toBe(403)
  })

  test('unregistered project keys are 404', async () => {
    expect((await call(projectUrl('', project.id))).status).toBe(404)
    expect((await call(projectUrl('', 'not-registered'))).status).toBe(404)
    expect((await call(projectUrl('', '%2e%2e%2ftrip'))).status).toBe(404)
    expect((await call(projectUrl('', '%E0%A4%A'))).status).toBe(404)
    const patch = await call(projectUrl('/patch', 'not-registered'), { method: 'POST', body: '{}' })
    expect(patch.status).toBe(404)
  })

  test('websocket upgrades check Host, token and key', async () => {
    expect(await rejection(wsUrl(), { Host: 'evil.example' })).toBe(403)
    expect(await rejection(wsUrl().replace(server.token, 'f'.repeat(64)))).toBe(404)
    expect(await rejection(wsUrl('not-registered'))).toBe(404)
  })

  test('sets no-referrer so the token stays out of Referer headers', async () => {
    const reply = await call(projectUrl())
    expect(reply.headers['referrer-policy']).toBe('no-referrer')
  })
})

describe('studio files', () => {
  test('serves assets with a content type', async () => {
    const reply = await call(`${server.base}studio/assets/app.js`)
    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toContain('text/javascript')
    expect(reply.body).toBe('console.log(1)')
  })

  test('serves .mjs as JavaScript, so module workers load', async () => {
    await writeFile(path.join(studioDir, 'assets', 'worker.mjs'), 'export {}')
    const reply = await call(`${server.base}studio/assets/worker.mjs`)
    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toContain('text/javascript')
  })

  test('falls back to index.html', async () => {
    for (const url of [`${server.base}studio/`, `${server.base}studio/?project=${key}`, `${server.base}studio/some/route`]) {
      const reply = await call(url)
      expect(reply.status).toBe(200)
      expect(reply.headers['content-type']).toContain('text/html')
      expect(reply.body).toContain('<title>studio</title>')
    }
  })

  test('rejects path traversal', async () => {
    for (const tail of ['..%2fsecret.txt', '%2e%2e/secret.txt', '%2e%2e%2f%2e%2e%2fsecret.txt', '%00']) {
      const reply = await call(`${server.base}studio/${tail}`)
      expect(reply.status, tail).toBe(404)
      expect(reply.body).not.toContain('secret')
    }
  })

  test('a backslash is just a file name on this platform, so it serves the fallback and leaks nothing', async () => {
    const reply = await call(`${server.base}studio/..%5csecret.txt`)
    expect(reply.body).not.toContain('secret')
  })

  test('studioUrl carries the project key and extra query', () => {
    expect(server.studioUrl(key)).toBe(`${server.base}studio/?project=${key}`)
    expect(server.studioUrl(key, { mode: 'edit', layer: 'map' })).toBe(`${server.base}studio/?project=${key}&mode=edit&layer=map`)
  })
})

describe('project api', () => {
  test('GET returns the project', async () => {
    const reply = await call(projectUrl())
    expect(reply.status).toBe(200)
    expect(reply.json().project.id).toBe(project.id)
    expect(reply.json().project.scenes[0]!.stops).toHaveLength(2)
  })

  test('patch applies and persists', async () => {
    const reply = await patchProject({ ops: [{ op: 'update_stop', id: 'a', changes: { name: 'Pireas' } }] })
    expect(reply.status).toBe(200)
    expect(reply.json().project.scenes[0]!.stops[0].name).toBe('Pireas')
    expect((await loadProject(folder)).scenes[0]!.stops[0]?.name).toBe('Pireas')
  })

  test('sceneSet patches reach the scene', async () => {
    const reply = await patchProject({ sceneSet: { camera: { mode: 'fixed' } } })
    expect(reply.status).toBe(200)
    expect(reply.json().project.scenes[0].camera.mode).toBe('fixed')
    expect((await loadProject(folder)).scenes[0]!.camera.mode).toBe('fixed')
  })

  test('bad patch is 400 with a path and leaves the file unchanged', async () => {
    const before = await loadProject(folder)
    const reply = await patchProject({ ops: [{ op: 'update_stop', id: 'nope', changes: { name: 'x' } }] })
    expect(reply.status).toBe(400)
    const { error } = reply.json()
    expect(error.message).toEqual(expect.any(String))
    expect(error.path).toEqual(expect.any(Array))
    expect(error.path.length).toBeGreaterThan(0)
    expect(error.issues[0].path).toEqual(error.path)
    expect(await loadProject(folder)).toEqual(before)

    const unknown = await patchProject({ bogus: true })
    expect(unknown.status).toBe(400)
    expect(unknown.json().error.path).toEqual(['bogus'])
    expect(await loadProject(folder)).toEqual(before)
  })

  test('malformed JSON and non-object bodies are 400', async () => {
    const before = await loadProject(folder)
    const bad = await call(projectUrl('/patch'), { method: 'POST', body: '{"ops":' })
    expect(bad.status).toBe(400)
    expect(bad.json().error.message).toContain('JSON')
    const array = await call(projectUrl('/patch'), { method: 'POST', body: '[]' })
    expect(array.status).toBe(400)
    expect(await loadProject(folder)).toEqual(before)
  })

  test('bodies over 1 MB are 413', async () => {
    const before = await loadProject(folder)
    const big = JSON.stringify({ set: { description: 'x'.repeat(1024 * 1024 + 10) } })
    const reply = await call(projectUrl('/patch'), { method: 'POST', body: big }).catch((e: NodeJS.ErrnoException) => e)
    // The server may close the socket as soon as it answers; either way nothing is written.
    if (reply instanceof Error) expect(['ECONNRESET', 'EPIPE']).toContain(reply.code)
    else expect(reply.status).toBe(413)
    expect(await loadProject(folder)).toEqual(before)
  })

  test('a project file that no longer parses is a 400 with a fix', async () => {
    await writeFile(path.join(folder, PROJECT_FILE), '{nope')
    const reply = await call(projectUrl())
    expect(reply.status).toBe(400)
    expect(reply.json().error.fix).toEqual(expect.any(String))
  })
})

describe('registerProject', () => {
  test('returns the same opaque key for the same folder and rejects relative paths', async () => {
    expect(key).toMatch(/^[0-9a-f]{32}$/)
    expect(key).not.toBe(project.id)
    expect(await server.registerProject(folder)).toBe(key)
    expect(await server.registerProject(`${folder}/`)).toBe(key)
    await expect(server.registerProject('relative/trip')).rejects.toThrow('absolute')
    await expect(server.registerProject(path.join(tmp, 'missing'))).rejects.toThrow('No project found')
  })

  test('serves several projects', async () => {
    const second = path.join(tmp, 'second')
    await createProject(second, 'Second')
    const secondKey = await server.registerProject(second)
    expect(secondKey).not.toBe(key)
    expect((await call(projectUrl('', secondKey))).json().project.name).toBe('Second')
    expect((await call(projectUrl())).json().project.name).toBe('Trip')
  })

  test('a copied folder keeps the same project id but gets its own key, so edits stay in their folder', async () => {
    const copy = path.join(tmp, 'copy')
    await cp(folder, copy, { recursive: true })
    expect((await loadProject(copy)).id).toBe(project.id)
    const { ws, next } = await connect()
    await next()

    const copyKey = await server.registerProject(copy)
    expect(copyKey).not.toBe(key)
    const reply = await patchProject({ ops: [{ op: 'update_stop', id: 'a', changes: { name: 'Original' } }] })
    expect(reply.status).toBe(200)
    expect((await loadProject(folder)).scenes[0]!.stops[0]?.name).toBe('Original')
    expect((await loadProject(copy)).scenes[0]!.stops[0]?.name).toBe('Piraeus')
    // The original's socket still hears about the original.
    expect((await next(1000)).project.scenes[0]!.stops[0]?.name).toBe('Original')

    await call(projectUrl('/patch', copyKey), {
      method: 'POST',
      body: JSON.stringify({ ops: [{ op: 'update_stop', id: 'a', changes: { name: 'Copy' } }] }),
    })
    expect((await loadProject(copy)).scenes[0]!.stops[0]?.name).toBe('Copy')
    expect((await loadProject(folder)).scenes[0]!.stops[0]?.name).toBe('Original')
    ws.close()
  })

  test("re-registering a folder whose project id changed keeps its key and its clients", async () => {
    const { ws, next } = await connect()
    await next()
    await saveProject(folder, { ...(await loadProject(folder)), id: randomUUID() })
    await next(1000)
    expect(await server.registerProject(folder)).toBe(key)

    await patchProject({ ops: [{ op: 'update_stop', id: 'b', changes: { name: 'Still here' } }] })
    expect((await next(1000)).project.scenes[0]!.stops[1]?.name).toBe('Still here')

    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()))
    await server.close()
    await closed
  })
})

describe('websocket sync', () => {
  test('sends the project on connect', async () => {
    const { ws, next } = await connect()
    const message = await next()
    expect(message.type).toBe('project')
    expect(message.project.id).toBe(project.id)
    ws.close()
  })

  test('pushes external edits over WebSocket', async () => {
    const { ws, next } = await connect()
    await next()
    const current = await loadProject(folder)
    await saveProject(folder, { ...current, name: 'Renamed' })
    const message = await next(1000)
    expect(message.project.name).toBe('Renamed')
    ws.close()
  })

  test('pushes edits made through the patch endpoint', async () => {
    const { ws, next } = await connect()
    await next()
    await patchProject({ ops: [{ op: 'update_stop', id: 'b', changes: { name: 'Mykonos Town' } }] })
    expect((await next(1000)).project.scenes[0]!.stops[1]?.name).toBe('Mykonos Town')
    ws.close()
  })

  test('patch responds with previousUpdatedAt', async () => {
    const before = await loadProject(folder)
    const reply = await patchProject({ set: { name: 'Renamed' } })
    expect(reply.status).toBe(200)
    const body = reply.json()
    expect(body.previousUpdatedAt).toBe(before.updatedAt)
    expect(body.project.name).toBe('Renamed')
    expect(Date.parse(body.project.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt))
  })

  test('patch with a stale base is rejected with 409 and the file is unchanged', async () => {
    const stale = (await loadProject(folder)).updatedAt
    await mutateProject(folder, (p) => ({ ...p, name: 'From the agent' }))
    const file = path.join(folder, PROJECT_FILE)
    const before = await readFile(file, 'utf8')
    const reply = await patchProject({ set: { name: 'From the studio' } }, { 'X-Mapper-Base': stale })
    expect(reply.status).toBe(409)
    expect(reply.json().error.message).toBe('The project changed since the studio last saw it.')
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  test.each([
    ['update_leg', { op: 'update_leg', index: 0, changes: { symbol: 'ferry' } }, (p: Project) => p.scenes[0]!.legs[0]!.symbol],
    ['insert_via', { op: 'insert_via', leg: 0, index: 0, point: { at: [24.5, 37.7] } }, (p: Project) => p.scenes[0]!.legs[0]!.via.length],
  ])('a stale %s is refused with 409 and nothing changes', async (_, op, observe) => {
    const stale = (await loadProject(folder)).updatedAt
    await mutateProject(folder, (p) => ({ ...p, name: 'From the agent' }))
    const file = path.join(folder, PROJECT_FILE)
    const before = await readFile(file, 'utf8')
    const reply = await patchProject({ ops: [op] }, { 'X-Mapper-Base': stale })
    expect(reply.status).toBe(409)
    expect(reply.json().error.message).toBe(STALE_BASE_MESSAGE)
    expect(await readFile(file, 'utf8')).toBe(before)
    // The same op is fine against the current version, so the refusal was the base and nothing else.
    const unchanged = observe(await loadProject(folder))
    const current = (await loadProject(folder)).updatedAt
    const applied = await patchProject({ ops: [op] }, { 'X-Mapper-Base': current })
    expect(applied.status).toBe(200)
    expect(observe(await loadProject(folder))).not.toEqual(unchanged)
  })

  test('patch with the current base applies', async () => {
    const current = (await loadProject(folder)).updatedAt
    const reply = await patchProject({ set: { name: 'From the studio' } }, { 'X-Mapper-Base': current })
    expect(reply.status).toBe(200)
    expect(reply.json().previousUpdatedAt).toBe(current)
    expect((await loadProject(folder)).name).toBe('From the studio')
  })

  test("broadcast carries the patching client's origin", async () => {
    const { ws, next } = await connect()
    expect((await next()).origin).toBeUndefined()
    const reply = await patchProject({ set: { name: 'From the studio' } }, { 'X-Mapper-Client': 'abc' })
    expect(reply.status).toBe(200)
    const message = await next(1000)
    expect(message.project.name).toBe('From the studio')
    expect(message.origin).toBe('abc')
    ws.close()
  })

  test("a client can't claim the paths origin", async () => {
    const { ws, next } = await connect()
    try {
      await next()
      await patchProject({ set: { name: 'Claimed' } }, { 'X-Mapper-Client': PATHS_ORIGIN })
      const message = await next(1000)
      expect(message.project.name).toBe('Claimed')
      expect('origin' in message).toBe(false)
    } finally {
      ws.close()
    }
  })

  test('outside writes broadcast with no origin', async () => {
    const { ws, next } = await connect()
    await next()
    await patchProject({ set: { name: 'From the studio' } }, { 'X-Mapper-Client': 'abc' })
    expect((await next(1000)).origin).toBe('abc')
    await mutateProject(folder, (p) => ({ ...p, name: 'From the agent' }))
    const message = await next(1000)
    expect(message.project.name).toBe('From the agent')
    expect('origin' in message).toBe(false)
    ws.close()
  })

  test('an invalid client id is ignored', async () => {
    const { ws, next } = await connect()
    await next()
    const reply = await patchProject({ set: { name: 'Odd client' } }, { 'X-Mapper-Client': 'not valid!' })
    expect(reply.status).toBe(200)
    const message = await next(1000)
    expect(message.project.name).toBe('Odd client')
    expect('origin' in message).toBe(false)
    const long = await patchProject({ set: { name: 'Long client' } }, { 'X-Mapper-Client': 'a'.repeat(65) })
    expect(long.status).toBe(200)
    const second = await next(1000)
    expect(second.project.name).toBe('Long client')
    expect('origin' in second).toBe(false)
    ws.close()
  })

  test('ignores a half-written file and tries again on the next change', async () => {
    const { ws, next, messages } = await connect()
    await next()
    await writeFile(path.join(folder, PROJECT_FILE), '{"half":')
    await new Promise((r) => setTimeout(r, 250))
    expect(messages).toHaveLength(0)
    const current = { ...project, name: 'Recovered' }
    await saveProject(folder, current)
    expect((await next(1000)).project.name).toBe('Recovered')
    ws.close()
  })

  test('a hand edit that keeps updatedAt reaches the studio', async () => {
    const { ws, next } = await connect()
    try {
      await next()
      const before = await loadProject(folder)
      await writeFile(path.join(folder, PROJECT_FILE), `${JSON.stringify({ ...before, name: 'By hand' }, null, 2)}\n`)
      const message = await next(2000)
      expect(message.project.name).toBe('By hand')
      expect(Date.parse(message.project.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt))
      expect('origin' in message).toBe(false)
      expect((await loadProject(folder)).updatedAt).toBe(message.project.updatedAt)
    } finally {
      ws.close()
    }
  })

  test('a restored older file reaches the studio', async () => {
    const { ws, next } = await connect()
    try {
      await next()
      const file = path.join(folder, PROJECT_FILE)
      const v1 = await saveProject(folder, { ...(await loadProject(folder)), name: 'Version 1' })
      const v1Bytes = await readFile(file)
      const v2 = await saveProject(folder, { ...v1, name: 'Version 2' })
      // Two quick saves can reach the studio as one.
      let shown = await next(2000)
      while (shown.project.name !== 'Version 2') shown = await next(2000)
      await writeFile(file, v1Bytes)
      const message = await next(2000)
      expect(message.project.name).toBe('Version 1')
      expect({ ...message.project, updatedAt: v1.updatedAt }).toEqual(v1)
      expect(Date.parse(message.project.updatedAt)).toBeGreaterThan(Date.parse(v2.updatedAt))
      expect('origin' in message).toBe(false)
    } finally {
      ws.close()
    }
  })

  test('a save that changes only updatedAt is still broadcast', async () => {
    const { ws, next } = await connect()
    try {
      const shown = await next()
      const saved = await mutateProject(folder, (p) => p)
      const message = await next(2000)
      expect(message.project.updatedAt).toBe(saved.updatedAt)
      expect(Date.parse(message.project.updatedAt)).toBeGreaterThan(Date.parse(shown.project.updatedAt))
    } finally {
      ws.close()
    }
  })

  test('an identical older file restored is restamped', async () => {
    const { ws, next } = await connect()
    try {
      await next()
      const file = path.join(folder, PROJECT_FILE)
      await saveProject(folder, await loadProject(folder))
      const v1Bytes = await readFile(file)
      const v2 = await mutateProject(folder, (p) => p)
      // Two quick saves can reach the studio as one.
      let shown = await next(2000)
      while (shown.project.updatedAt !== v2.updatedAt) shown = await next(2000)
      await writeFile(file, v1Bytes)
      const message = await next(2000)
      expect(Date.parse(message.project.updatedAt)).toBeGreaterThan(Date.parse(v2.updatedAt))
      expect('origin' in message).toBe(false)
      expect((await loadProject(folder)).updatedAt).toBe(message.project.updatedAt)
    } finally {
      ws.close()
    }
  })

  test('an identical rewrite sends nothing and leaves the file alone', async () => {
    const { ws, next, messages } = await connect()
    try {
      await next()
      await writeFile(path.join(folder, 'notes.txt'), 'unrelated')
      const before = await loadProject(folder)
      await writeFile(path.join(folder, PROJECT_FILE), `${JSON.stringify(before, null, 2)}\n`)
      await new Promise((r) => setTimeout(r, 4 * WATCH_DEBOUNCE_MS))
      expect(messages).toHaveLength(0)
      expect((await loadProject(folder)).updatedAt).toBe(before.updatedAt)
    } finally {
      ws.close()
    }
  })

  test('reformatting the file sends nothing and leaves it alone', async () => {
    const { ws, next, messages } = await connect()
    try {
      await next()
      const file = path.join(folder, PROJECT_FILE)
      const before = await loadProject(folder)
      const reordered = Object.fromEntries(Object.entries(before).reverse())
      await writeFile(file, `${JSON.stringify(reordered, null, 4)}\n`)
      const written = await readFile(file, 'utf8')
      await new Promise((r) => setTimeout(r, 4 * WATCH_DEBOUNCE_MS))
      expect(messages).toHaveLength(0)
      expect(await readFile(file, 'utf8')).toBe(written)
    } finally {
      ws.close()
    }
  })

  test('a schema-invalid hand edit is never rewritten', async () => {
    const { ws, next, messages } = await connect()
    try {
      await next()
      const file = path.join(folder, PROJECT_FILE)
      const before = await loadProject(folder)
      const invalid = { ...before, output: { ...before.output, fps: { num: 7, den: 1 } } }
      await writeFile(file, `${JSON.stringify(invalid, null, 2)}\n`)
      const written = await readFile(file, 'utf8')
      await new Promise((r) => setTimeout(r, 4 * WATCH_DEBOUNCE_MS))
      expect(messages).toHaveLength(0)
      expect(await readFile(file, 'utf8')).toBe(written)
      await saveProject(folder, { ...before, name: 'Valid again' })
      expect((await next(2000)).project.name).toBe('Valid again')
    } finally {
      ws.close()
    }
  })

  test('close shuts down clients and the listener', async () => {
    const { ws } = await connect()
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()))
    await server.close()
    await closed
    await expect(call(projectUrl())).rejects.toThrow()
  })
})

describe('getServer', () => {
  test('concurrent callers share one server', async () => {
    const cache = process.env.MAPPER_CACHE_DIR
    process.env.MAPPER_CACHE_DIR = path.join(tmp, 'cache')
    try {
      const [a, b] = await Promise.all([getServer(), getServer()])
      expect(a).toBe(b)
      expect(await getServer()).toBe(a)
      await a.close()
      const c = await getServer()
      expect(c).not.toBe(a)
      await c.close()
    } finally {
      if (cache === undefined) delete process.env.MAPPER_CACHE_DIR
      else process.env.MAPPER_CACHE_DIR = cache
    }
  })
})

describe('sea paths', () => {
  const A: LngLat = [9, 50]
  const B: LngLat = [11, 50]
  const island = (): LandSource =>
    landIndex(decodeLand(encodeLand('test-land', [[[9.8, 49.5], [10.2, 49.5], [10.2, 50.5], [9.8, 50.5]]])))
  let sea: MapperServer
  let seaKey: string
  let seaUrl: (suffix?: string) => string

  async function seaServer(land: () => Promise<LandSource>, extra: Partial<ServerOptions> = {}): Promise<void> {
    sea = await startServer({ studioDir, cacheDir: path.join(tmp, 'cache2'), land, water: fakeWater(), ...extra })
    seaKey = await sea.registerProject(folder)
    seaUrl = (suffix = '') => `${sea.base}api/projects/${seaKey}${suffix}`
  }
  const withSeaLeg = (p: Project): Project => ({
    ...p,
    scenes: [
      {
        ...p.scenes[0]!,
        stops: [
          { id: 'a', name: 'A', at: A, pause: 0, sign: 'always' },
          { id: 'b', name: 'B', at: B, pause: 0, sign: 'always' },
        ],
        legs: [{ mode: 'sea', via: [] }],
      },
    ],
  })
  const legKey = seaLegKey(A, B, [])

  afterEach(async () => {
    await sea?.close()
  })

  test('GET answers with seaPaths', async () => {
    await saveProject(folder, withSeaLeg(await loadProject(folder)))
    await seaServer(async () => island())
    const body = (await call(seaUrl())).json()
    expect(body.project.id).toBe(project.id)
    expect(body.seaPaths[legKey].status).toBe('ok')
  })

  test('a patch answer carries seaPaths for a new sea leg', async () => {
    await seaServer(async () => island())
    const before = (await call(seaUrl())).json()
    expect(before.seaPaths).toEqual({})
    const reply = await call(seaUrl('/patch'), {
      method: 'POST',
      body: JSON.stringify({ ops: [{ op: 'update_leg', index: 0, changes: { mode: 'sea' } }] }),
    })
    // The fixture's stops are in Greece; the leg's key comes from the answer's own project.
    const answer = reply.json()
    const [s0, s1] = answer.project.scenes[0].stops
    expect(answer.seaPaths[seaLegKey(s0.at, s1.at, [])]).toBeDefined()
  })

  test('broadcasts seaPaths for a sea leg added from outside', async () => {
    await seaServer(async () => island())
    const url = sea.base.replace('http:', 'ws:') + `ws/projects/${seaKey}`
    const { ws, next } = await connect(url)
    try {
      expect(((await next()) as any).seaPaths).toEqual({})
      await mutateProject(folder, withSeaLeg)
      // The leg is routed before the message goes out, which can take over a second while the whole suite runs.
      const message = (await next(5000)) as any
      expect(message.seaPaths[legKey].status).toBe('ok')
    } finally {
      ws.close()
    }
  })

  test('an open studio gets the upgraded path', async () => {
    // Only the sea server watches the folder, so no other server rewrites its path cache.
    await server.close()
    await saveProject(folder, withSeaLeg(await loadProject(folder)))
    const state = { online: false }
    const water = fakeWater(state)
    let clock = 0
    await seaServer(async () => island(), { water, retryMs: 40, now: () => clock })
    const url = sea.base.replace('http:', 'ws:') + `ws/projects/${seaKey}`
    const { ws, next, messages } = await connect(url)
    try {
      const first = (await next()) as any
      expect(first.seaPaths[legKey].unverified).toBe('offline')
      // Within the minute the cache keeps the unverified path, and nothing changes, so nothing is sent.
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(water.calls).toBe(1)
      expect(messages).toEqual([])
      // Back online, and the minute is up: the next retry routes it again and pushes the new path.
      state.online = true
      clock = 61_000
      const upgraded = (await next(2000)) as any
      expect(upgraded.type).toBe('project')
      expect(upgraded.project.updatedAt).toBe(first.project.updatedAt)
      expect(upgraded.seaPaths[legKey].unverified).toBeUndefined()
      expect(upgraded.seaPaths[legKey].status).toBe('ok')
      // A paths-only update names itself, so the studio keeps its undo history.
      expect(upgraded.origin).toBe(PATHS_ORIGIN)
      expect(water.calls).toBe(2)
      // Verified now, so the retries stop.
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(water.calls).toBe(2)
      expect(messages).toEqual([])
    } finally {
      ws.close()
    }
  })

  test('the retry timer stops when the studio closes', async () => {
    // Only the sea server watches the folder, so no other server rewrites its path cache.
    await server.close()
    await saveProject(folder, withSeaLeg(await loadProject(folder)))
    const water = fakeWater({ online: false })
    // Each call is a minute after the last, so every retry routes the leg again.
    let clock = 0
    await seaServer(async () => island(), { water, retryMs: 20, now: () => (clock += 61_000) })
    const url = sea.base.replace('http:', 'ws:') + `ws/projects/${seaKey}`
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    const first = await connect(url)
    await first.next()
    await wait(200)
    expect(water.calls).toBeGreaterThan(2)
    // Offline each time, with the same path, so nothing new was sent.
    expect(first.messages).toEqual([])
    await new Promise<void>((resolve) => {
      first.ws.once('close', () => resolve())
      first.ws.close()
    })
    await wait(60)
    const settled = water.calls
    await wait(200)
    expect(water.calls).toBe(settled)

    // A new studio starts it again, and closing the server stops it.
    const second = await connect(url)
    await second.next()
    await wait(100)
    expect(water.calls).toBeGreaterThan(settled + 1)
    await sea.close()
    const closed = water.calls
    await wait(200)
    expect(water.calls).toBe(closed)
  })

  test("an open studio showing only unsettled routes doesn't keep retrying", async () => {
    // Only the sea server watches the folder, so no other server rewrites its path cache.
    await server.close()
    await saveProject(folder, withSeaLeg(await loadProject(folder)))
    const water = fakeWater({ online: false, why: 'unsettled' })
    // Each call is more than a day after the last, so any retry would route the leg again.
    let clock = 0
    await seaServer(async () => island(), { water, retryMs: 20, now: () => (clock += 25 * 60 * 60 * 1000) })
    const url = sea.base.replace('http:', 'ws:') + `ws/projects/${seaKey}`
    const { ws, next, messages } = await connect(url)
    try {
      expect(((await next()) as any).seaPaths[legKey].unverified).toBe('unsettled')
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(water.calls).toBe(1)
      expect(messages).toEqual([])
    } finally {
      ws.close()
    }
  })

  test('a paths-only update goes only to studios still showing the old path', async () => {
    // Only the sea server watches the folder, so no other server rewrites its path cache.
    await server.close()
    await saveProject(folder, withSeaLeg(await loadProject(folder)))
    const state = { online: false }
    let clock = 0
    await seaServer(async () => island(), { water: fakeWater(state), retryMs: 40, now: () => clock })
    const url = sea.base.replace('http:', 'ws:') + `ws/projects/${seaKey}`
    const old = await connect(url)
    try {
      expect(((await old.next()) as any).seaPaths[legKey].unverified).toBe('offline')
      state.online = true
      clock = 61_000
      // A studio opened now gets the new path straight away, and doesn't hear it again.
      const fresh = await connect(url)
      try {
        expect(((await fresh.next()) as any).seaPaths[legKey].unverified).toBeUndefined()
        expect(((await old.next(2000)) as any).seaPaths[legKey].unverified).toBeUndefined()
        await new Promise((resolve) => setTimeout(resolve, 200))
        expect(fresh.messages).toEqual([])
      } finally {
        fresh.ws.close()
      }
    } finally {
      old.ws.close()
    }
  })

  test("falls back on every sea leg when the land data can't load", async () => {
    await saveProject(folder, withSeaLeg(await loadProject(folder)))
    const error = console.error
    let logged = 0
    console.error = () => {
      logged++
    }
    try {
      await seaServer(async () => {
        throw new Error('no land')
      })
      const body = (await call(seaUrl())).json()
      expect(body.project.id).toBe(project.id)
      const fallback = { status: 'fallback', reason: NO_LAND_DATA, path: [], knots: [] }
      expect(body.seaPaths).toEqual({ [legKey]: fallback })
      expect((await call(seaUrl())).json().seaPaths).toEqual({ [legKey]: fallback })
      expect(logged).toBe(1)
      // Validation says why, so the studio and agents don't wait on a route that won't come.
      const { warnings } = validateProject(body.project, { seaPaths: body.seaPaths })
      expect(warnings.find((w) => w.code === 'sea-fallback')?.message).toContain(NO_LAND_DATA)
    } finally {
      console.error = error
    }
  })
})
