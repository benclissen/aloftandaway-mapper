import { describe, expect, it } from 'vitest'
import { createRoadRouter, ROAD_USER_AGENT } from '../../src/server/roads.js'

const OK = { code: 'Ok', routes: [{ geometry: { coordinates: [[25.4, 36.3], [25.5, 36.4]] } }], waypoints: [] }
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status })

function rig(responder: (url: string, n: number) => Response | Promise<Response>, opts: { minIntervalMs?: number } = {}) {
  let clock = 0
  const calls: { url: string; at: number; headers: Record<string, string> }[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), at: clock, headers: (init?.headers ?? {}) as Record<string, string> })
    return responder(String(input), calls.length)
  }) as typeof fetch
  const router = createRoadRouter({
    fetch: fetchFn,
    now: () => clock,
    sleep: async (ms) => { clock += ms },
    ...opts,
  })
  return { router, calls, advance: (ms: number) => { clock += ms } }
}

const A: [number, number] = [25.4325, 36.348]
const B: [number, number] = [25.3756, 36.4614]

describe('road router', () => {
  it('builds the request', async () => {
    const { router, calls } = rig(() => json(200, OK))
    await router.route('foot', [A, B])
    expect(calls[0]!.url).toBe(
      'https://routing.openstreetmap.de/routed-foot/route/v1/driving/25.4325,36.348;25.3756,36.4614?overview=full&geometries=geojson&steps=false',
    )
    expect(calls[0]!.headers['User-Agent']).toBe(ROAD_USER_AGENT)
    expect(ROAD_USER_AGENT).toContain('+https://github.com/benclissen/aloftandaway-mapper')
    await router.route('car', [[190, 10], [-190, 11]])
    expect(calls[1]!.url).toContain('/-170,10;170,11?')
  })

  it('reads Ok, NoRoute and NoSegment', async () => {
    expect((await rig(() => json(200, OK)).router.route('car', [A, B])).kind).toBe('ok')
    expect((await rig(() => json(400, { code: 'NoRoute' })).router.route('car', [A, B])).kind).toBe('no-route')
    expect((await rig(() => json(400, { code: 'NoSegment' })).router.route('car', [A, B])).kind).toBe('no-route')
    expect((await rig(() => json(200, { code: 'Ok', routes: [] })).router.route('car', [A, B])).kind).toBe('offline')
  })

  it('treats 429, 5xx, bad JSON, a thrown fetch and a timeout as offline', async () => {
    expect((await rig(() => json(429, {})).router.route('car', [A, B])).kind).toBe('offline')
    expect((await rig(() => json(503, {})).router.route('car', [A, B])).kind).toBe('offline')
    expect((await rig(() => new Response('<html>', { status: 200 })).router.route('car', [A, B])).kind).toBe('offline')
    expect((await rig(() => { throw new Error('down') }).router.route('car', [A, B])).kind).toBe('offline')
    const hang = createRoadRouter({
      timeoutMs: 5,
      fetch: ((_u: unknown, init?: RequestInit) =>
        new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as typeof fetch,
      sleep: async () => {},
    })
    expect((await hang.route('car', [A, B])).kind).toBe('offline')
  })

  it('stays offline for offlineMs', async () => {
    let fail = true
    const { router, calls, advance } = rig(() => (fail ? json(503, {}) : json(200, OK)))
    expect((await router.route('car', [A, B])).kind).toBe('offline')
    fail = false
    advance(59_000)
    expect((await router.route('car', [A, B])).kind).toBe('offline')
    expect(calls).toHaveLength(1)
    advance(1_001)
    expect((await router.route('car', [A, B])).kind).toBe('ok')
    expect(calls).toHaveLength(2)
  })

  it('spaces requests at least minIntervalMs apart', async () => {
    const { router, calls } = rig((url, n) => json(200, { ...OK, routes: [{ geometry: { coordinates: [[n, n]] } }] }), { minIntervalMs: 1000 })
    const replies = await Promise.all([router.route('car', [A, B]), router.route('car', [A, B]), router.route('car', [A, B])])
    const starts = calls.map((c) => c.at)
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1000)
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(1000)
    replies.forEach((r, i) => {
      expect(r.kind === 'ok' && r.answer.routes![0]!.geometry.coordinates[0]).toEqual([i + 1, i + 1])
    })
  })
})
