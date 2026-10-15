import { mkdtemp, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createTileProxy } from '../../src/server/tiles.js'

const GLYPHS = path.join(import.meta.dirname, '..', '..', 'data', 'glyphs')

let tmp: string
let upstream: http.Server
let upstreamHits: string[]
let harness: http.Server
let origin: string

interface Reply {
  status: number
  contentType: string | undefined
  body: Buffer
}

function get(rawPath: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    http
      .get(`${origin}${rawPath}`, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, contentType: res.headers['content-type'], body: Buffer.concat(chunks) }),
        )
      })
      .on('error', reject)
  })
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'mapper-glyphs-'))
  upstreamHits = []
  upstream = http.createServer((req, res) => {
    upstreamHits.push(req.url ?? '')
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
    res.end(Buffer.from('NOTO'))
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const proxy = createTileProxy({
    cacheDir: path.join(tmp, 'cache'),
    upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    publicBase: () => 'http://127.0.0.1:9999/tok/tiles/',
    retryDelaysMs: [1],
  })
  harness = http.createServer((req, res) => void proxy((req.url ?? '/').slice(1), res))
  await new Promise<void>((resolve) => harness.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(harness.address() as AddressInfo).port}`
})

afterEach(async () => {
  for (const s of [harness, upstream]) {
    await new Promise<void>((resolve) => {
      s.close(() => resolve())
      s.closeAllConnections()
    })
  }
  await rm(tmp, { recursive: true, force: true })
})

describe('glyphs', () => {
  test('serves a committed Plus Jakarta Sans range from disk without calling upstream', async () => {
    const reply = await get('/fonts/Plus%20Jakarta%20Sans%20SemiBold/0-255.pbf')
    const disk = await readFile(path.join(GLYPHS, 'Plus Jakarta Sans SemiBold', '0-255.pbf'))
    expect(reply.status).toBe(200)
    expect(reply.contentType).toBe('application/x-protobuf')
    expect(reply.body.length).toBeGreaterThan(1000)
    expect(reply.body.equals(disk)).toBe(true)
    // A stack that falls back to Noto still takes the Jakarta face from disk.
    const stack = await get('/fonts/Plus%20Jakarta%20Sans%20Bold%2CNoto%20Sans%20Regular/0-255.pbf')
    expect(stack.body.equals(await readFile(path.join(GLYPHS, 'Plus Jakarta Sans Bold', '0-255.pbf')))).toBe(true)
    expect(upstreamHits).toEqual([])
  })

  test('answers an uncommitted range with an empty glyph set', async () => {
    const reply = await get('/fonts/Plus%20Jakarta%20Sans%20Bold/19968-20223.pbf')
    expect(reply.status).toBe(200)
    expect(reply.contentType).toBe('application/x-protobuf')
    // A glyphs message with one font stack for the range and no glyphs in it.
    expect(reply.body.length).toBeGreaterThan(0)
    expect(reply.body.length).toBeLessThan(100)
    expect(reply.body.toString('latin1')).toContain('19968-20223')
    // An unknown Jakarta face is empty too, never an upstream miss.
    const unknown = await get('/fonts/Plus%20Jakarta%20Sans%20Thin/0-255.pbf')
    expect(unknown.status).toBe(200)
    expect(unknown.body.length).toBeLessThan(100)
    expect(upstreamHits).toEqual([])
  })

  test('still proxies Noto Sans upstream', async () => {
    const reply = await get('/fonts/Noto%20Sans%20Regular/0-255.pbf')
    expect(reply.status).toBe(200)
    expect(reply.body.toString()).toBe('NOTO')
    expect(upstreamHits).toEqual(['/fonts/Noto%20Sans%20Regular/0-255.pbf'])
  })

  test('a font name cannot climb out of the glyph folder', async () => {
    const reply = await get('/fonts/Plus%20Jakarta%20Sans%20SemiBold%2F..%2F..%2Fland-10m/0-255.pbf')
    expect(reply.status).toBe(400)
    expect(upstreamHits).toEqual([])
  })
})
