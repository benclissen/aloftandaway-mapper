import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, stat, utimes } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createTileProxy } from '../../src/server/tiles.js'
import { startServer, type MapperServer } from '../../src/server/server.js'

const TILE = Buffer.from([0x1a, 0x02, 0x08, 0x01, 0xff, 0x00, 0x7f])
const TILE_PATH = 'planet/20260101_001001_pt/5/16/10.pbf'

interface Fake {
  origin: string
  /** Request paths seen, in order. */
  hits: string[]
  inFlight: number
  maxInFlight: number
  /** Status for the next requests, consumed one per request; then `status`. */
  failures: Array<number | 'drop'>
  status: number
  delayMs: number
  close(): Promise<void>
}

async function fakeUpstream(): Promise<Fake> {
  const fake: Fake = {
    origin: '',
    hits: [],
    inFlight: 0,
    maxInFlight: 0,
    failures: [],
    status: 200,
    delayMs: 0,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
  const server = http.createServer((req, res) => {
    fake.hits.push(req.url ?? '')
    fake.inFlight++
    fake.maxInFlight = Math.max(fake.maxInFlight, fake.inFlight)
    setTimeout(() => {
      fake.inFlight--
      const status = fake.failures.shift() ?? fake.status
      if (status === 'drop') return void req.socket.destroy()
      if (status !== 200) {
        res.writeHead(status)
        return void res.end()
      }
      if (req.url === '/planet') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return void res.end(
          JSON.stringify({
            tilejson: '3.0.0',
            tiles: [`${fake.origin}/planet/20260101_001001_pt/{z}/{x}/{y}.pbf`, 'https://elsewhere.example/{z}/{x}/{y}.pbf'],
            minzoom: 0,
            maxzoom: 14,
          }),
        )
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      res.end(TILE)
    }, fake.delayMs)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  fake.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return fake
}

interface Reply {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

/** Sends the path as given: a URL object would resolve `..` and `%2e%2e` before the request left. */
function get(url: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const { host, port } = new URL(url)
    const rawPath = url.slice(url.indexOf('/', url.indexOf('//') + 2))
    http
      .get({ host: host.split(':')[0], port, path: rawPath }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
      })
      .on('error', reject)
  })
}

let tmp: string
let cacheDir: string
let fake: Fake
let harness: http.Server
let harnessOrigin: string

const PUBLIC_BASE = 'http://127.0.0.1:9999/tok/tiles/'

/** The proxy behind a bare node:http server; the URL path after `/` is the encoded subpath. */
async function startHarness(opts: { maxConcurrent?: number; retryDelaysMs?: number[] } = {}): Promise<void> {
  const proxy = createTileProxy({
    cacheDir,
    upstream: fake.origin,
    publicBase: () => PUBLIC_BASE,
    retryDelaysMs: [1, 1, 1],
    ...opts,
  })
  harness = http.createServer((req, res) => {
    void proxy((req.url ?? '/').slice(1), res)
  })
  await new Promise<void>((resolve) => harness.listen(0, '127.0.0.1', resolve))
  harnessOrigin = `http://127.0.0.1:${(harness.address() as AddressInfo).port}`
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'mapper-tiles-'))
  cacheDir = path.join(tmp, 'cache')
  fake = await fakeUpstream()
})

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!harness) return resolve()
    harness.close(() => resolve())
    harness.closeAllConnections()
  })
  await fake.close()
  await rm(tmp, { recursive: true, force: true })
})

describe('tile proxy', () => {
  test('second request is served from disk', async () => {
    await startHarness()
    const first = await get(`${harnessOrigin}/${TILE_PATH}`)
    const second = await get(`${harnessOrigin}/${TILE_PATH}`)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(first.body.equals(TILE)).toBe(true)
    expect(second.body.equals(first.body)).toBe(true)
    expect(second.headers['content-type']).toBe('application/x-protobuf')
    expect(fake.hits).toEqual([`/${TILE_PATH}`])
    expect((await readFile(path.join(cacheDir, 'tiles', TILE_PATH))).equals(TILE)).toBe(true)
  })

  test('serves fonts, encoding the font stack for the upstream and keeping it on disk', async () => {
    await startHarness()
    const stack = 'Noto%20Sans%20Regular'
    const reply = await get(`${harnessOrigin}/fonts/${stack}/0-255.pbf`)
    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toBe('application/x-protobuf')
    expect(fake.hits).toEqual([`/fonts/${stack}/0-255.pbf`])
    expect(existsSync(path.join(cacheDir, 'tiles', 'fonts', 'Noto Sans Regular', '0-255.pbf'))).toBe(true)
    await get(`${harnessOrigin}/fonts/${stack}/0-255.pbf`)
    expect(fake.hits).toHaveLength(1)
  })

  test('rewrites TileJSON tile URLs to the local base', async () => {
    await startHarness()
    const reply = await get(`${harnessOrigin}/planet`)
    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toBe('application/json')
    expect(reply.headers['content-encoding']).toBeUndefined()
    const json = JSON.parse(reply.body.toString('utf8'))
    expect(json.tiles).toEqual([
      `${PUBLIC_BASE}planet/20260101_001001_pt/{z}/{x}/{y}.pbf`,
      'https://elsewhere.example/{z}/{x}/{y}.pbf',
    ])
    expect(json.maxzoom).toBe(14)
    // The cache keeps the upstream bytes, so a new server base still rewrites correctly.
    const cached = JSON.parse(await readFile(path.join(cacheDir, 'tiles', 'planet.tilejson'), 'utf8'))
    expect(cached.tiles[0]).toBe(`${fake.origin}/planet/20260101_001001_pt/{z}/{x}/{y}.pbf`)
  })

  test('caches the TileJSON for 24 hours', async () => {
    await startHarness()
    await get(`${harnessOrigin}/planet`)
    await get(`${harnessOrigin}/planet`)
    expect(fake.hits).toEqual(['/planet'])

    const file = path.join(cacheDir, 'tiles', 'planet.tilejson')
    const almostADay = new Date(Date.now() - 23 * 3600 * 1000)
    await utimes(file, almostADay, almostADay)
    await get(`${harnessOrigin}/planet`)
    expect(fake.hits).toHaveLength(1)

    const moreThanADay = new Date(Date.now() - 25 * 3600 * 1000)
    await utimes(file, moreThanADay, moreThanADay)
    await get(`${harnessOrigin}/planet`)
    expect(fake.hits).toHaveLength(2)
    expect(Date.now() - (await stat(file)).mtimeMs).toBeLessThan(60_000)
  })

  test('keeps tiles under the TileJSON path, since planet is also a directory', async () => {
    await startHarness()
    await get(`${harnessOrigin}/planet`)
    const reply = await get(`${harnessOrigin}/${TILE_PATH}`)
    expect(reply.status).toBe(200)
    expect(existsSync(path.join(cacheDir, 'tiles', 'planet.tilejson'))).toBe(true)
    expect(existsSync(path.join(cacheDir, 'tiles', TILE_PATH))).toBe(true)
  })

  describe('rejects paths it does not serve, without touching the upstream', () => {
    const bad = [
      '..%2F..%2Fetc%2Fpasswd',
      '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      'planet/../0/0/0.pbf',
      'planet/%2e%2e/0/0/0.pbf',
      'planet/v1/0/0/..%2F..%2F0.pbf',
      'fonts/../0-255.pbf',
      'fonts/%2E%2E/0-255.pbf',
      'fonts/.%2F/0-255.pbf',
      'fonts/Noto%2F..%2F..%2Fx/0-255.pbf',
      'fonts/a%5Cb/0-255.pbf',
      'fonts/a%00b/0-255.pbf',
      'fonts/Noto/0-255.png',
      'fonts/Noto/0-255.pbf/extra',
      'planet/v1/1/2/3.png',
      'planet/v1/1/2/3.pbf/',
      'planet/v1/-1/2/3.pbf',
      'planet/v1/1/2',
      'planet%0A',
      'planet/',
      'tiles',
      'other',
      '',
      'https%3A%2F%2Fevil.example%2Fplanet',
      '%2F%2Fevil.example%2Fplanet',
      '%E0%A4%A',
    ]
    test.each(bad)('400 for %j', async (subpath) => {
      await startHarness()
      const reply = await get(`${harnessOrigin}/${subpath}`)
      expect(reply.status).toBe(400)
      expect(fake.hits).toEqual([])
      expect(existsSync(path.join(cacheDir))).toBe(false)
    })
  })

  test('retries 5xx three times then answers 502', async () => {
    fake.status = 503
    await startHarness()
    const reply = await get(`${harnessOrigin}/${TILE_PATH}`)
    expect(reply.status).toBe(502)
    expect(fake.hits).toHaveLength(4)
    expect(existsSync(path.join(cacheDir, 'tiles', TILE_PATH))).toBe(false)
  })

  test('recovers when a retry succeeds', async () => {
    fake.failures = [500, 'drop']
    await startHarness()
    const reply = await get(`${harnessOrigin}/${TILE_PATH}`)
    expect(reply.status).toBe(200)
    expect(reply.body.equals(TILE)).toBe(true)
    expect(fake.hits).toHaveLength(3)
  })

  test('retries network errors then answers 502', async () => {
    fake.failures = ['drop', 'drop', 'drop', 'drop']
    await startHarness()
    const reply = await get(`${harnessOrigin}/${TILE_PATH}`)
    expect(reply.status).toBe(502)
    expect(fake.hits).toHaveLength(4)
  })

  test('waits between retries by the configured delays', async () => {
    fake.status = 503
    await startHarness({ retryDelaysMs: [60, 60] })
    const started = Date.now()
    const reply = await get(`${harnessOrigin}/${TILE_PATH}`)
    expect(reply.status).toBe(502)
    expect(fake.hits).toHaveLength(3)
    expect(Date.now() - started).toBeGreaterThanOrEqual(110)
  })

  test('does not cache 404, and passes it through without retrying', async () => {
    fake.status = 404
    await startHarness()
    const first = await get(`${harnessOrigin}/${TILE_PATH}`)
    expect(first.status).toBe(404)
    expect(fake.hits).toHaveLength(1)
    expect(existsSync(path.join(cacheDir, 'tiles', TILE_PATH))).toBe(false)

    fake.status = 200
    const second = await get(`${harnessOrigin}/${TILE_PATH}`)
    expect(second.status).toBe(200)
    expect(fake.hits).toHaveLength(2)
  })

  test('passes 204 through without caching it', async () => {
    fake.status = 204
    await startHarness()
    const reply = await get(`${harnessOrigin}/${TILE_PATH}`)
    expect(reply.status).toBe(204)
    expect(reply.body).toHaveLength(0)
    expect(existsSync(path.join(cacheDir, 'tiles', TILE_PATH))).toBe(false)
  })

  test('does not follow upstream redirects', async () => {
    fake.status = 302
    await startHarness()
    const reply = await get(`${harnessOrigin}/${TILE_PATH}`)
    expect(reply.status).toBe(502)
    expect(fake.hits).toHaveLength(1)
  })

  test('caps concurrency', async () => {
    fake.delayMs = 40
    await startHarness()
    const replies = await Promise.all(
      Array.from({ length: 20 }, (_, i) => get(`${harnessOrigin}/planet/v1/5/${i}/10.pbf`)),
    )
    expect(replies.map((r) => r.status)).toEqual(Array(20).fill(200))
    expect(fake.hits).toHaveLength(20)
    expect(fake.maxInFlight).toBe(6)
  })

  test('honours a custom concurrency cap', async () => {
    fake.delayMs = 30
    await startHarness({ maxConcurrent: 2 })
    await Promise.all(Array.from({ length: 8 }, (_, i) => get(`${harnessOrigin}/planet/v1/5/${i}/10.pbf`)))
    expect(fake.maxInFlight).toBe(2)
  })

  test('coalesces concurrent misses for one tile into one upstream fetch', async () => {
    fake.delayMs = 40
    await startHarness()
    const replies = await Promise.all(Array.from({ length: 10 }, () => get(`${harnessOrigin}/${TILE_PATH}`)))
    expect(replies.every((r) => r.status === 200 && r.body.equals(TILE))).toBe(true)
    expect(fake.hits).toHaveLength(1)
  })

  test('leaves no temporary files behind', async () => {
    await startHarness()
    await Promise.all([get(`${harnessOrigin}/${TILE_PATH}`), get(`${harnessOrigin}/planet`)])
    const entries = await readdir(path.join(cacheDir, 'tiles'), { recursive: true })
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([])
  })
})

describe('mounted in the server', () => {
  let server: MapperServer

  afterEach(async () => {
    await server?.close()
  })

  test('serves tiles under the token and points the TileJSON back at itself', async () => {
    server = await startServer({ studioDir: tmp, cacheDir, tileUpstream: fake.origin })

    const json = await get(`${server.base}tiles/planet`)
    expect(json.status).toBe(200)
    expect(JSON.parse(json.body.toString('utf8')).tiles[0]).toBe(
      `${server.base}tiles/planet/20260101_001001_pt/{z}/{x}/{y}.pbf`,
    )

    const url = `${server.base}tiles/${TILE_PATH}`
    const first = await get(url)
    const second = await get(url)
    expect(first.status).toBe(200)
    expect(second.body.equals(TILE)).toBe(true)
    expect(fake.hits).toEqual(['/planet', `/${TILE_PATH}`])

    const traversal = await get(`${server.base}tiles/..%2F..%2Fetc%2Fpasswd`)
    expect(traversal.status).toBe(400)
    expect(fake.hits).toHaveLength(2)
  })

  test('still needs the token', async () => {
    server = await startServer({ studioDir: tmp, cacheDir, tileUpstream: fake.origin })
    const reply = await get(`http://127.0.0.1:${server.port}/wrong/tiles/${TILE_PATH}`)
    expect(reply.status).toBe(404)
    expect(fake.hits).toEqual([])
  })
})
