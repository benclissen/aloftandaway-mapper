import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { LngLat } from '../../src/core/index.js'

export interface FakeOsrm {
  /** The router URL template for `MAPPER_ROAD_ROUTER`: it contains `{profile}`. */
  url: string
  /** Request paths seen, in order. */
  requests: string[]
  close(): Promise<void>
}

/**
 * A stand-in for the OSRM road service. It reads the profile and the points from the request path
 * (`/<profile>/<lng>,<lat>;<lng>,<lat>...`) and sends back whatever `answer` returns.
 */
export async function startFakeOsrm(
  answer: (profile: string, points: LngLat[]) => { status: number; body: unknown },
): Promise<FakeOsrm> {
  const requests: string[] = []
  const server = http.createServer((req, res) => {
    const url = req.url ?? ''
    requests.push(url)
    const [, profile = '', coords = ''] = /^\/([^/]+)\/([^?]*)/.exec(url) ?? []
    const points = coords.split(';').map((pair) => pair.split(',').map(Number) as LngLat)
    const reply = answer(profile, points)
    res.writeHead(reply.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(reply.body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/{profile}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
