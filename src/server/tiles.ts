import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_TILE_UPSTREAM = 'https://tiles.openfreemap.org'
/** EOxCloudless 2016 (CC BY 4.0), Web Mercator. Rows come before columns: `{z}/{y}/{x}.jpg`. */
export const SATELLITE_UPSTREAM = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g'
/** AWS Terrain Tiles in Terrarium encoding: `{z}/{x}/{y}.png`. */
export const TERRAIN_UPSTREAM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'

/** Glyph PBFs built by `npm run build:glyphs`, one folder per font face. */
const GLYPHS_DIR = fileURLToPath(new URL('../../data/glyphs', import.meta.url))
/** A font stack whose first font starts with this is Mapper's own and never goes upstream. */
const LOCAL_FONT_PREFIX = 'Plus Jakarta Sans'
/** The faces committed under data/glyphs. Anything else with the prefix answers empty. */
const LOCAL_FACES = new Set(['Plus Jakarta Sans SemiBold', 'Plus Jakarta Sans Bold'])

export interface TileProxyOptions {
  /** The cache root. Tiles live under `<cacheDir>/tiles/`. */
  cacheDir: string
  /**
   * Defaults to https://tiles.openfreemap.org. Tests point it at a local fake, which then also stands in for the
   * satellite and elevation sources, at `<upstream>/satellite/...` and `<upstream>/terrain/...`.
   */
  upstream?: string
  /** `<server base>tiles/`. Read per request, since the base is only known once the server listens. */
  publicBase: () => string
  /** Upstream requests in flight at once. Default 6. */
  maxConcurrent?: number
  /** Waits before each retry of a network error or 5xx. Default [250, 1000, 4000]. */
  retryDelaysMs?: number[]
}

/** Takes the percent-encoded part of the URL path after `tiles/`. */
export type TileProxy = (subpath: string, res: ServerResponse) => Promise<void>

/** What the proxy accepts, after decoding. Nothing else ever reaches the upstream. */
const ALLOWED =
  /^(planet(\/[\w.-]+\/\d+\/\d+\/\d+\.pbf)?|fonts\/[^/]+\/\d+-\d+\.pbf|satellite\/\d+\/\d+\/\d+\.jpg|terrain\/\d+\/\d+\/\d+\.png)$/

const TILEJSON_FILE = 'planet.tilejson'
const TILEJSON_TTL_MS = 24 * 60 * 60 * 1000
const UPSTREAM_TIMEOUT_MS = 30_000

interface Reply {
  status: number
  contentType?: string
  body: Buffer
}

class Semaphore {
  private free: number
  private readonly waiting: Array<() => void> = []

  constructor(limit: number) {
    this.free = limit
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--
    else await new Promise<void>((resolve) => this.waiting.push(resolve))
    try {
      return await task()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.free++
    }
  }
}

/** The decoded path segments, or undefined when the request isn't something the proxy serves. */
function parseSubpath(subpath: string): string[] | undefined {
  const segments: string[] = []
  for (const raw of subpath.split('/')) {
    let segment: string
    try {
      segment = decodeURIComponent(raw)
    } catch {
      return undefined
    }
    // A decoded slash would change the path's shape; dot segments climb out of it.
    // Backslashes and control characters have no place in a tile path either.
    if (segment === '.' || segment === '..' || /[/\\\x00-\x1f]/.test(segment)) return undefined
    segments.push(segment)
  }
  return ALLOWED.test(segments.join('/')) ? segments : undefined
}

function contentTypeFor(segments: string[]): string {
  if (segments.length === 1) return 'application/json'
  if (segments[0] === 'satellite') return 'image/jpeg'
  if (segments[0] === 'terrain') return 'image/png'
  return 'application/x-protobuf'
}

/** The first font of a glyph request's stack, and its range, or undefined if it isn't one. */
function localGlyphRequest(segments: string[]): { face: string; range: string } | undefined {
  if (segments.length !== 3 || segments[0] !== 'fonts') return undefined
  const face = segments[1]!.split(',')[0]!.trim()
  return face.startsWith(LOCAL_FONT_PREFIX) ? { face, range: segments[2]!.slice(0, -'.pbf'.length) } : undefined
}

/** A protobuf varint, for lengths under 2^28. */
function varint(n: number): Buffer {
  const bytes: number[] = []
  for (; n >= 0x80; n >>>= 7) bytes.push((n & 0x7f) | 0x80)
  bytes.push(n)
  return Buffer.from(bytes)
}

/** A valid `glyphs` message with one font stack for the range and no glyphs in it. */
function emptyGlyphs(face: string, range: string): Buffer {
  const field = (tag: number, text: string): Buffer => {
    const bytes = Buffer.from(text, 'utf8')
    return Buffer.concat([Buffer.from([tag]), varint(bytes.length), bytes])
  }
  const stack = Buffer.concat([field(0x0a, face), field(0x12, range)])
  return Buffer.concat([Buffer.from([0x0a]), varint(stack.length), stack])
}

function send(res: ServerResponse, status: number, body: Buffer, contentType?: string): void {
  // 204 and 304 must not carry a body.
  if (status === 204 || status === 304) {
    res.writeHead(status)
    res.end()
    return
  }
  res.writeHead(status, {
    ...(contentType ? { 'Content-Type': contentType } : {}),
    'Content-Length': body.length,
  })
  res.end(body)
}

function sendError(res: ServerResponse, status: number, message: string): void {
  send(res, status, Buffer.from(JSON.stringify({ error: { message } })), 'application/json; charset=utf-8')
}

function badGateway(message: string): Reply {
  return { status: 502, body: Buffer.from(JSON.stringify({ error: { message } })), contentType: 'application/json; charset=utf-8' }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createTileProxy(opts: TileProxyOptions): TileProxy {
  const upstream = (opts.upstream ?? DEFAULT_TILE_UPSTREAM).replace(/\/+$/, '')
  const upstreamOrigin = new URL(upstream).origin
  const satelliteUpstream = opts.upstream ? `${upstream}/satellite` : SATELLITE_UPSTREAM
  const terrainUpstream = opts.upstream ? `${upstream}/terrain` : TERRAIN_UPSTREAM
  const tilesRoot = path.resolve(opts.cacheDir, 'tiles')
  const retryDelaysMs = opts.retryDelaysMs ?? [250, 1000, 4000]
  const semaphore = new Semaphore(opts.maxConcurrent ?? 6)
  /** Misses being fetched right now, so concurrent requests for one tile share one upstream fetch. */
  const inFlight = new Map<string, Promise<Reply>>()

  /** Where a subpath lives on disk, or undefined if that would be outside the cache. */
  function cachePath(segments: string[]): string | undefined {
    const file = segments.length === 1 ? path.join(tilesRoot, TILEJSON_FILE) : path.resolve(tilesRoot, ...segments)
    return file.startsWith(tilesRoot + path.sep) ? file : undefined
  }

  async function readCached(segments: string[], file: string): Promise<Buffer | undefined> {
    try {
      if (segments.length === 1) {
        const info = await stat(file)
        if (Date.now() - info.mtimeMs >= TILEJSON_TTL_MS) return undefined
      }
      return await readFile(file)
    } catch {
      return undefined
    }
  }

  async function writeCached(file: string, body: Buffer): Promise<void> {
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
    try {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(temp, body)
      await rename(temp, file)
    } catch (e) {
      await rm(temp, { force: true }).catch(() => undefined)
      // The tile is still good; a full or read-only cache shouldn't fail the render.
      console.error(`Mapper tile cache: could not write ${file}:`, e)
    }
  }

  /** One upstream request, within the concurrency cap. */
  function fetchOnce(url: string): Promise<{ status: number; body: Buffer }> {
    return semaphore.run(async () => {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
      // fetch has already decoded any Content-Encoding.
      return { status: response.status, body: Buffer.from(await response.arrayBuffer()) }
    })
  }

  /** Where a subpath comes from. The segments are already checked, so digits and a fixed extension only. */
  function upstreamUrl(segments: string[]): string {
    const [source, z, x, file] = segments as [string, string, string, string]
    // EOx's WMTS wants zoom/row/column, so y comes before x.
    if (source === 'satellite') return `${satelliteUpstream}/${z}/${file.slice(0, -'.jpg'.length)}/${x}.jpg`
    if (source === 'terrain') return `${terrainUpstream}/${z}/${x}/${file}`
    return `${upstream}/${segments.map(encodeURIComponent).join('/')}`
  }

  /** Fetches with retries. Network errors and 5xx retry; any other status is final. */
  async function fetchUpstream(segments: string[]): Promise<Reply> {
    const url = upstreamUrl(segments)
    for (let attempt = 0; ; attempt++) {
      let failure: string
      try {
        const { status, body } = await fetchOnce(url)
        if (status >= 500) {
          failure = `the tile server answered ${status}`
        } else if (status === 200) {
          return { status, body, contentType: contentTypeFor(segments) }
        } else if (status >= 400 || status === 204) {
          return { status, body: Buffer.alloc(0) }
        } else {
          // Redirects and other oddities: following them could leave the upstream.
          return badGateway(`The tile server answered ${status}, which Mapper doesn't follow.`)
        }
      } catch (e) {
        failure = `the request failed (${e instanceof Error ? e.message : String(e)})`
      }
      const delay = retryDelaysMs[attempt]
      if (delay === undefined) {
        return badGateway(`Could not fetch the tile after ${attempt + 1} attempts: ${failure}.`)
      }
      await sleep(delay)
    }
  }

  /** The upstream bytes for a subpath: from disk when cached, else fetched and cached. */
  async function obtain(segments: string[], file: string): Promise<Reply> {
    const cached = await readCached(segments, file)
    if (cached) return { status: 200, body: cached, contentType: contentTypeFor(segments) }
    const reply = await fetchUpstream(segments)
    if (reply.status === 200) {
      if (segments.length === 1) {
        try {
          JSON.parse(reply.body.toString('utf8'))
        } catch {
          return badGateway("The tile server's TileJSON isn't valid JSON.")
        }
      }
      await writeCached(file, reply.body)
    }
    return reply
  }

  /** Points the TileJSON's tile URLs at this server. Entries from elsewhere are left alone. */
  function rewriteTileJson(body: Buffer): Buffer {
    const json = JSON.parse(body.toString('utf8')) as { tiles?: unknown }
    if (Array.isArray(json.tiles)) {
      const local = opts.publicBase().replace(/\/+$/, '')
      json.tiles = json.tiles.map((entry: unknown) =>
        typeof entry === 'string' && entry.startsWith(upstreamOrigin) ? local + entry.slice(upstreamOrigin.length) : entry,
      )
    }
    return Buffer.from(JSON.stringify(json))
  }

  return async (subpath, res) => {
    const segments = parseSubpath(subpath)
    const file = segments && cachePath(segments)
    if (!segments || !file) return sendError(res, 400, 'Not a tile path Mapper serves.')

    const glyphs = localGlyphRequest(segments)
    if (glyphs) {
      // Only a known face name reaches the disk, so the font name can't point anywhere else.
      // A range that isn't committed answers empty so labels in that script fall back silently.
      const body = LOCAL_FACES.has(glyphs.face)
        ? await readFile(path.join(GLYPHS_DIR, glyphs.face, `${glyphs.range}.pbf`)).catch(() => undefined)
        : undefined
      return send(res, 200, body ?? emptyGlyphs(glyphs.face, glyphs.range), 'application/x-protobuf')
    }

    const key = segments.join('/')
    let pending = inFlight.get(key)
    if (!pending) {
      pending = obtain(segments, file).finally(() => inFlight.delete(key))
      inFlight.set(key, pending)
    }
    const reply = await pending
    if (reply.status === 200 && segments.length === 1) {
      send(res, 200, rewriteTileJson(reply.body), reply.contentType)
    } else {
      send(res, reply.status, reply.body, reply.contentType)
    }
  }
}
