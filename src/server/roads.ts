import type { LngLat, OsrmAnswer, RoadProfile } from '../core/index.js'
import { OFFLINE_MS } from './sea-water.js'
import { USER_AGENT } from './tiles.js'

/** The OSM-Germany routing service, one engine per profile. `{profile}` becomes `car`, `bike` or `foot`. */
export const DEFAULT_ROAD_ROUTER = 'https://routing.openstreetmap.de/routed-{profile}/route/v1/driving'
export const ROAD_USER_AGENT = `${USER_AGENT} (+https://github.com/benclissen/aloftandaway-mapper)`

export type RoadReply = { kind: 'ok'; answer: OsrmAnswer } | { kind: 'no-route' } | { kind: 'offline' }

export interface RoadRouter {
  /** One OSRM route through the points in order. Never throws: failures come back as `offline`. */
  route(profile: RoadProfile, points: LngLat[]): Promise<RoadReply>
}

export interface RoadRouterOptions {
  /** The service URL, with an optional `{profile}` placeholder. Default `DEFAULT_ROAD_ROUTER`. */
  url?: string
  fetch?: typeof fetch
  /** Least time between the starts of two requests. Default 1000. */
  minIntervalMs?: number
  /** Default 15000. */
  timeoutMs?: number
  /** How long a failure keeps the router offline. Default `OFFLINE_MS`. */
  offlineMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const wrapLng = (lng: number): number =>
  lng >= -180 && lng < 180 ? lng : ((((lng + 180) % 360) + 360) % 360) - 180

export function createRoadRouter(opts: RoadRouterOptions = {}): RoadRouter {
  const template = (opts.url ?? DEFAULT_ROAD_ROUTER).replace(/\/+$/, '')
  const fetchFn = opts.fetch ?? fetch
  const minInterval = opts.minIntervalMs ?? 1000
  const timeoutMs = opts.timeoutMs ?? 15_000
  const offlineMs = opts.offlineMs ?? OFFLINE_MS
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  let tail: Promise<unknown> = Promise.resolve()
  let lastStart: number | undefined
  let downAt: number | undefined

  async function request(profile: RoadProfile, points: LngLat[]): Promise<RoadReply> {
    if (downAt !== undefined && now() < downAt + offlineMs) return { kind: 'offline' }
    if (lastStart !== undefined) {
      const wait = lastStart + minInterval - now()
      if (wait > 0) await sleep(wait)
    }
    lastStart = now()
    const coords = points.map(([lng, lat]) => `${wrapLng(lng)},${lat}`).join(';')
    const url = `${template.replace('{profile}', profile)}/${coords}?overview=full&geometries=geojson&steps=false`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchFn(url, { headers: { 'User-Agent': ROAD_USER_AGENT }, signal: controller.signal })
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as OsrmAnswer
      if (res.status === 400 && (body.code === 'NoRoute' || body.code === 'NoSegment')) return { kind: 'no-route' }
      if (res.status === 200 && body.code === 'Ok' && (body.routes?.[0]?.geometry.coordinates.length ?? 0) > 0) {
        return { kind: 'ok', answer: body }
      }
      if (res.status === 200 && (body.code === 'NoRoute' || body.code === 'NoSegment')) return { kind: 'no-route' }
      throw new Error('unusable answer')
    } catch {
      downAt = now()
      return { kind: 'offline' }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    route(profile, points) {
      const result = tail.then(() => request(profile, points))
      tail = result.catch(() => undefined)
      return result
    },
  }
}

let singleton: RoadRouter | undefined

/** The process-wide router, so every leg shares one request queue and one offline memory. */
export function roadRouter(): RoadRouter {
  singleton ??= createRoadRouter({ url: process.env.MAPPER_ROAD_ROUTER || DEFAULT_ROAD_ROUTER })
  return singleton
}
