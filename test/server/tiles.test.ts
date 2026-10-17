import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createTileProxy, createTileStore, tileStore, USER_AGENT } from '../../src/server/tiles.js'
import { startServer, type MapperServer } from '../../src/server/server.js'
import { startFakeTiles } from '../helpers/fake-tiles.js'

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

  test('proxies and caches satellite tiles with y/x swapped upstream', async () => {
    await startHarness()
    const reply = await get(`${harnessOrigin}/satellite/5/16/10.jpg`)
    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toBe('image/jpeg')
    expect(reply.body.equals(TILE)).toBe(true)
    // EOx's WMTS wants zoom/row/column, so y comes before x.
    expect(fake.hits).toEqual(['/satellite/5/10/16.jpg'])
    expect(existsSync(path.join(cacheDir, 'tiles', 'satellite/5/16/10.jpg'))).toBe(true)

    const again = await get(`${harnessOrigin}/satellite/5/16/10.jpg`)
    expect(again.body.equals(TILE)).toBe(true)
    expect(fake.hits).toHaveLength(1)
  })

  test('proxies and caches terrain tiles', async () => {
    await startHarness()
    const reply = await get(`${harnessOrigin}/terrain/5/16/10.png`)
    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toBe('image/png')
    expect(reply.body.equals(TILE)).toBe(true)
    expect(fake.hits).toEqual(['/terrain/5/16/10.png'])
    expect(existsSync(path.join(cacheDir, 'tiles', 'terrain/5/16/10.png'))).toBe(true)

    await get(`${harnessOrigin}/terrain/5/16/10.png`)
    expect(fake.hits).toHaveLength(1)
  })

  test('a satellite or terrain tile that fails after its retries answers like a basemap tile does', async () => {
    fake.status = 503
    await startHarness()
    const basemap = await get(`${harnessOrigin}/${TILE_PATH}`)
    const satellite = await get(`${harnessOrigin}/satellite/5/16/10.jpg`)
    const terrain = await get(`${harnessOrigin}/terrain/5/16/10.png`)
    // Three retries after the first attempt, for each of the three tiles.
    expect(fake.hits).toHaveLength(12)
    for (const reply of [satellite, terrain]) {
      expect(reply.status).toBe(basemap.status)
      expect(reply.status).toBe(502)
      expect(reply.headers['content-type']).toBe(basemap.headers['content-type'])
      const body = JSON.parse(reply.body.toString('utf8')) as { error: { message: string } }
      expect(Object.keys(body)).toEqual(['error'])
      expect(body.error.message).toBe(
        (JSON.parse(basemap.body.toString('utf8')) as { error: { message: string } }).error.message,
      )
    }
    expect(existsSync(path.join(cacheDir, 'tiles', 'satellite/5/16/10.jpg'))).toBe(false)
    expect(existsSync(path.join(cacheDir, 'tiles', 'terrain/5/16/10.png'))).toBe(false)
  })

  describe('rejects other satellite or terrain paths', () => {
    const bad = [
      'satellite',
      'satellite/5/16/10.png',
      'satellite/5/16/10.pbf',
      'satellite/5/16/10',
      'satellite/5/16',
      'satellite/v1/5/16/10.jpg',
      'satellite/5/16/-10.jpg',
      'satellite/5/16/10.jpg/',
      'satellite/%2e%2e/16/10.jpg',
      'satellite/5/16/..%2F..%2F10.jpg',
      'terrain',
      'terrain/5/16/10.jpg',
      'terrain/5/16/10.pbf',
      'terrain/5/16',
      'terrain/v1/5/16/10.png',
      'terrain/5/16/10.png/extra',
      'terrain/5/%2e%2e/10.png',
      'terrain/5/16/a.png',
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

describe('tile store', () => {
  const BUILD = '20261011_080001_pt'
  let fixtures: string
  let tiles: Awaited<ReturnType<typeof startFakeTiles>>

  beforeEach(async () => {
    fixtures = path.join(tmp, 'fixtures')
    await mkdir(path.join(fixtures, BUILD, '12', '2200'), { recursive: true })
    for (let y = 0; y < 12; y++) await writeFile(path.join(fixtures, BUILD, '12', '2200', `${1000 + y}.pbf`), TILE)
    tiles = await startFakeTiles(fixtures)
  })

  afterEach(async () => {
    await tiles.close()
  })

  const tilePath = (y: number): string => `planet/${BUILD}/12/2200/${1000 + y}.pbf`

  test('every upstream request sends the Mapper User-Agent', async () => {
    expect(USER_AGENT).toMatch(/^aloftandaway-mapper\/\d+\.\d+\.\d+/)
    const store = createTileStore({ cacheDir, upstream: tiles.url, retryDelaysMs: [] })
    expect((await store.get(tilePath(0), { use: 'view' })).status).toBe(200)
    expect((await store.get(tilePath(1), { use: 'download' })).status).toBe(200)
    expect((await store.get('planet')).status).toBe(200)
    expect(tiles.requests).toHaveLength(3)
    expect(tiles.userAgents).toEqual([USER_AGENT, USER_AGENT, USER_AGENT])
  })

  test('the proxy sends the Mapper User-Agent too', async () => {
    const proxy = createTileProxy({ cacheDir, upstream: tiles.url, publicBase: () => PUBLIC_BASE, retryDelaysMs: [] })
    harness = http.createServer((req, res) => void proxy((req.url ?? '/').slice(1), res))
    await new Promise<void>((resolve) => harness.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(harness.address() as AddressInfo).port}`
    expect((await get(`${origin}/${tilePath(0)}`)).status).toBe(200)
    expect(tiles.userAgents).toEqual([USER_AGENT])
  })

  test('download use opens at most 4 requests at once', async () => {
    tiles.delayMs = 40
    const store = createTileStore({ cacheDir, upstream: tiles.url, retryDelaysMs: [] })
    const replies = await Promise.all(Array.from({ length: 12 }, (_, y) => store.get(tilePath(y), { use: 'download' })))
    expect(replies.map((r) => r.status)).toEqual(Array(12).fill(200))
    expect(tiles.requests).toHaveLength(12)
    expect(tiles.inFlightMax).toBe(4)
  })

  test('view and download share the disk cache and one in-flight fetch', async () => {
    tiles.delayMs = 40
    const store = createTileStore({ cacheDir, upstream: tiles.url, retryDelaysMs: [] })
    const [view, download] = await Promise.all([
      store.get(tilePath(0), { use: 'view' }),
      store.get(tilePath(0), { use: 'download' }),
    ])
    expect(view.body.equals(TILE)).toBe(true)
    expect(download.body.equals(TILE)).toBe(true)
    expect(tiles.requests).toEqual([`/${tilePath(0)}`])
    // Later, from disk: either use, and a second store over the same cache.
    await store.get(tilePath(0), { use: 'download' })
    await createTileStore({ cacheDir, upstream: tiles.url }).get(tilePath(0), { use: 'view' })
    expect(tiles.requests).toHaveLength(1)
  })

  test('tileStore gives one store per cache and upstream', async () => {
    const a = tileStore({ cacheDir, upstream: tiles.url })
    expect(tileStore({ cacheDir: path.join(cacheDir, '..', 'cache'), upstream: `${tiles.url}/` })).toBe(a)
    expect(tileStore({ cacheDir: path.join(tmp, 'other'), upstream: tiles.url })).not.toBe(a)
    expect(tileStore({ cacheDir, upstream: fake.origin })).not.toBe(a)
  })

  test('planetBuild reads the build from the TileJSON', async () => {
    const store = createTileStore({ cacheDir, upstream: tiles.url, retryDelaysMs: [] })
    expect(await store.planetBuild()).toBe(BUILD)
    expect(await store.planetBuild()).toBe(BUILD)
    // The second answer came from the cached TileJSON.
    expect(tiles.requests).toEqual(['/planet'])
  })

  test('planetBuild fails when the TileJSON is not there', async () => {
    fake.status = 404
    const store = createTileStore({ cacheDir, upstream: fake.origin, retryDelaysMs: [] })
    await expect(store.planetBuild()).rejects.toThrow(/TileJSON/)
  })

  test('a path the proxy would not serve answers 400 without going upstream', async () => {
    const store = createTileStore({ cacheDir, upstream: tiles.url })
    expect((await store.get('planet/../x')).status).toBe(400)
    expect(tiles.requests).toEqual([])
  })
})
