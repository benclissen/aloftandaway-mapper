import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import type { Project, ServerMessage } from '../../src/core/index.js'
import { PROJECT_FILE, createProject, loadProject, mutateProject, saveProject } from '../../src/server/store.js'
import { getServer, startServer, type MapperServer } from '../../src/server/server.js'

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
  server = await startServer({ studioDir, cacheDir: path.join(tmp, 'cache') })
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

  test('does not rebroadcast an unchanged updatedAt', async () => {
    const { ws, next, messages } = await connect()
    await next()
    await writeFile(path.join(folder, 'notes.txt'), 'unrelated')
    const before = await loadProject(folder)
    await writeFile(path.join(folder, PROJECT_FILE), `${JSON.stringify(before, null, 2)}\n`)
    await new Promise((r) => setTimeout(r, 250))
    expect(messages).toHaveLength(0)
    ws.close()
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
