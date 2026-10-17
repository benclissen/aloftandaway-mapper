import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

export interface FakeTiles {
  /** The server's origin, such as `http://127.0.0.1:41234`. Use it as the tile upstream. */
  url: string
  /** The planet build the TileJSON names. */
  build: string
  /** Request paths seen, in order. */
  requests: string[]
  /** The User-Agent of each request, in the same order. */
  userAgents: Array<string | undefined>
  /** The most requests it had open at once. */
  inFlightMax: number
  /** How long each answer waits, in ms. Change it between requests to make the fake slow. */
  delayMs: number
  close(): Promise<void>
}

const DEFAULT_BUILD = '20260101_000000_pt'

/**
 * A stand-in for OpenFreeMap that serves fixture tiles from `dir/<build>/<z>/<x>/<y>.pbf`. `planet` is a TileJSON whose
 * tile URL is `<url>/planet/<build>/{z}/{x}/{y}.pbf`, with `<build>` the last folder in `dir` (or a default when there
 * is none). A tile that isn't there answers 204, as the real server does for an empty one.
 */
export async function startFakeTiles(dir: string): Promise<FakeTiles> {
  const builds = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  const fake: FakeTiles = {
    url: '',
    build: builds.at(-1) ?? DEFAULT_BUILD,
    requests: [],
    userAgents: [],
    inFlightMax: 0,
    delayMs: 0,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
  let inFlight = 0
  const server = http.createServer((req, res) => {
    const url = req.url ?? ''
    fake.requests.push(url)
    fake.userAgents.push(req.headers['user-agent'])
    inFlight++
    fake.inFlightMax = Math.max(fake.inFlightMax, inFlight)
    const answer = async (): Promise<void> => {
      if (url === '/planet') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            tilejson: '3.0.0',
            tiles: [`${fake.url}/planet/${fake.build}/{z}/{x}/{y}.pbf`],
            minzoom: 0,
            maxzoom: 14,
          }),
        )
        return
      }
      const match = /^\/planet\/([\w.-]+)\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(url)
      const body = match
        ? await readFile(path.join(dir, match[1]!, match[2]!, match[3]!, `${match[4]}.pbf`)).catch(() => undefined)
        : undefined
      if (!body) {
        res.writeHead(204)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/x-protobuf', 'Content-Length': body.length })
      res.end(body)
    }
    setTimeout(() => {
      void answer().finally(() => {
        inFlight--
      })
    }, fake.delayMs)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return fake
}
