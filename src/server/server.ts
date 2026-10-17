import { randomBytes, timingSafeEqual } from 'node:crypto'
import { watch, existsSync, type FSWatcher } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import http from 'node:http'
import type { Duplex } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import {
  applyPatch,
  BASE_HEADER,
  CLIENT_HEADER,
  CLIENT_ID_PATTERN,
  NO_LAND_DATA,
  PATHS_ORIGIN,
  ProjectError,
  STALE_BASE_MESSAGE,
  type PatchRequest,
  type LandSource,
  type Project,
  type SeaPaths,
  type ServerMessage,
} from '../core/index.js'
import { loadLand } from './land.js'
import { RETRY_MS, resolveSeaPaths, retriesSoon, seaLegsOf } from './paths.js'
import { seaWaterOn, type SeaWater } from './sea-water.js'
import { assertAbsolute, loadProject, mutateProject, PROJECT_FILE, projectHash, restampProject, StoreError } from './store.js'
import { createTileProxy, tileStore } from './tiles.js'

export interface MapperServer {
  port: number
  token: string
  /** `http://127.0.0.1:<port>/<token>/` */
  base: string
  /**
   * Registers a project folder and returns its key, an opaque id for the folder's studio URLs. The same folder always
   * gets the same key. Keys aren't project ids, since a copied folder keeps its project's id.
   */
  registerProject(folder: string): Promise<string>
  /** The studio's edit page for the folder with `key`, from `registerProject`. */
  studioUrl(key: string, query?: Record<string, string>): string
  close(): Promise<void>
}

export interface ServerOptions {
  studioDir: string
  cacheDir: string
  /** The tile server for the map and the sea router. Defaults to `MAPPER_TILE_UPSTREAM`, then OpenFreeMap. */
  tileUpstream?: string
  /** Where sea routes get their land data. Defaults to the data that ships with Mapper. */
  land?: () => Promise<LandSource>
  /** Checks sea routes against the basemap's water. Defaults to the router on this server's tile store. */
  water?: SeaWater
  /** How often an open studio's unverified sea routes are worked out again, in ms. Default 60 s. */
  retryMs?: number
  /** The clock the sea route cache's retry times use, in ms. For tests. */
  now?: () => number
}

const MAX_BODY_BYTES = 1024 * 1024
/** How long the watcher waits for a burst of file events to settle before it reads the project, in ms. */
export const WATCH_DEBOUNCE_MS = 50
/** How many saved versions per project remember which studio client patched them. */
const ORIGIN_MEMORY = 32

const CONTENT_TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.pbf': 'application/x-protobuf',
}))

interface Registered {
  /** Resolved folder path. */
  folder: string
  /** The opaque key in the folder's URLs. */
  key: string
  watcher: FSWatcher | undefined
  clients: Set<WebSocket>
  /** `updatedAt` of the last project this entry broadcast or loaded. */
  lastUpdatedAt: string
  /** `projectHash` of that project. */
  lastHash: string
  timer: NodeJS.Timeout | undefined
  /** The client id that patched each recent version, by the version's `updatedAt`. Oldest first. */
  origins: Map<string, string>
  /** Whether a failure to work out sea routes has been logged for this project. */
  seaPathsFailed: boolean
  /** What each open socket was last sent: the version, its sea routes as JSON, and whether any is retried soon. */
  shown: Map<WebSocket, Shown>
  /** The next retry of unverified sea routes, while a socket shows one that's retried within the minute. */
  retry: NodeJS.Timeout | undefined
  /** Whether a retry is running now. */
  retrying: boolean
}

interface Shown {
  updatedAt: string
  paths: string
  /** Whether a route it shows was left unverified by the network or the budget, so is routed again within the minute. */
  retry: boolean
}

interface RouteContext {
  req: http.IncomingMessage
  res: http.ServerResponse
  /** Path segments after the token, still percent-encoded. */
  rest: string[]
  /** Values captured by the route's `match`. */
  params: string[]
}

interface Route {
  method: 'GET' | 'POST'
  /** Returns the captured params when the route applies, or undefined. */
  match(rest: string[]): string[] | undefined
  handle(ctx: RouteContext): Promise<void> | void
}

/** The package root: the nearest directory above this file that holds a package.json. */
export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  while (!existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error('Could not find the Mapper package root (no package.json above the server module).')
    dir = parent
  }
  return dir
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  })
  res.end(text)
}

function sendError(res: http.ServerResponse, status: number, message: string, extra: object = {}): void {
  sendJson(res, status, { error: { message, ...extra } })
}

class BodyTooLarge extends Error {}

/** A conditional patch whose base is no longer the project on disk. */
class StaleBase extends Error {}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new BodyTooLarge()
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge()
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function startServer(opts: ServerOptions): Promise<MapperServer> {
  const studioDir = path.resolve(opts.studioDir)
  const land = opts.land ?? loadLand
  const cacheDir = path.resolve(opts.cacheDir)
  const upstream = opts.tileUpstream ?? (process.env.MAPPER_TILE_UPSTREAM || undefined)
  const water = opts.water ?? seaWaterOn(tileStore({ cacheDir, upstream }))
  const retryMs = opts.retryMs ?? RETRY_MS
  /** Sea route work in flight, which `close` waits for so nothing writes a cache file after it returns. */
  const resolving = new Set<Promise<unknown>>()
  const token = randomBytes(32).toString('hex')
  /** Registered folders by key, and keys by resolved folder. */
  const projects = new Map<string, Registered>()
  const keys = new Map<string, string>()
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  let port = 0
  let closed = false

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((e: unknown) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      console.error('Mapper server error:', e)
      sendError(res, 500, 'Internal server error')
    })
  })

  // Host and token checks

  function hostAllowed(req: http.IncomingMessage): boolean {
    const host = (req.headers.host ?? '').toLowerCase()
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`
  }

  /** The path segments after the token, or undefined when the token is wrong. */
  function routeSegments(req: http.IncomingMessage): string[] | undefined {
    const pathname = (req.url ?? '').split(/[?#]/, 1)[0] ?? ''
    const segments = pathname.split('/')
    if (segments[0] !== '' || segments[1] === undefined || !safeEqual(segments[1], token)) return undefined
    return segments.slice(2)
  }

  const tiles = createTileProxy({
    cacheDir,
    upstream,
    publicBase: () => `${mapper.base}tiles/`,
  })

  // Routes

  const routes: Route[] = [
    {
      method: 'GET',
      match: (rest) => (rest[0] === 'studio' ? [] : undefined),
      handle: serveStudio,
    },
    {
      method: 'GET',
      match: (rest) => (rest.length === 3 && rest[0] === 'api' && rest[1] === 'projects' ? [rest[2]!] : undefined),
      handle: async ({ res, params }) => {
        const entry = lookup(params[0]!)
        if (!entry) return sendError(res, 404, 'Not found')
        await respondWith(res, async () => {
          const project = await loadProject(entry.folder)
          return { project, seaPaths: await seaPathsFor(entry, project) }
        })
      },
    },
    {
      method: 'POST',
      match: (rest) =>
        rest.length === 4 && rest[0] === 'api' && rest[1] === 'projects' && rest[3] === 'patch' ? [rest[2]!] : undefined,
      handle: async ({ req, res, params }) => {
        const entry = lookup(params[0]!)
        if (!entry) return sendError(res, 404, 'Not found')
        let patch: PatchRequest
        try {
          const parsed: unknown = JSON.parse(await readBody(req))
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return sendError(res, 400, 'The request body must be a JSON object.', { path: [] })
          }
          patch = parsed as PatchRequest
        } catch (e) {
          if (e instanceof BodyTooLarge) {
            res.once('finish', () => req.destroy())
            res.setHeader('Connection', 'close')
            return sendError(res, 413, 'The request body is larger than 1 MB.')
          }
          if (e instanceof SyntaxError) return sendError(res, 400, `The request body isn't valid JSON: ${e.message}`, { path: [] })
          throw e
        }
        const client = clientId(req)
        const baseHeader = req.headers[BASE_HEADER.toLowerCase()]
        const base = typeof baseHeader === 'string' ? baseHeader : undefined
        await respondWith(res, async () => {
          let previousUpdatedAt = ''
          const project = await mutateProject(entry.folder, (p) => {
            // Throwing here leaves the file as it is.
            if (base !== undefined && p.updatedAt !== base) throw new StaleBase()
            previousUpdatedAt = p.updatedAt
            return applyPatch(p, patch)
          })
          if (client !== undefined) rememberOrigin(entry, project.updatedAt, client)
          return { project, seaPaths: await seaPathsFor(entry, project), previousUpdatedAt }
        })
      },
    },
    {
      // The proxy validates the path itself; it takes the segments still percent-encoded.
      method: 'GET',
      match: (rest) => (rest[0] === 'tiles' ? [rest.slice(1).join('/')] : undefined),
      handle: ({ res, params }) => tiles(params[0]!, res),
    },
  ]

  /**
   * The sea routes for `project`. When they can't be worked out (the land data is missing, say) every sea leg falls
   * back with the reason, so it draws as a line and the studio and validation say why, and the error is logged the
   * first time for each project.
   */
  async function seaPathsFor(entry: Registered, project: Project): Promise<SeaPaths> {
    if (!project.scenes.some((scene) => scene.legs.some((leg) => leg.mode === 'sea'))) return {}
    const failed = (e: unknown, reason: string): SeaPaths => {
      if (!entry.seaPathsFailed) {
        entry.seaPathsFailed = true
        console.error(`Mapper could not work out sea routes for ${entry.folder}:`, e)
      }
      const paths: SeaPaths = {}
      for (const key of seaLegsOf(project).keys()) paths[key] = { status: 'fallback', reason, path: [], knots: [] }
      return paths
    }
    const work = (async (): Promise<SeaPaths> => {
      let source: LandSource
      try {
        source = await land()
      } catch (e) {
        return failed(e, NO_LAND_DATA)
      }
      try {
        return await resolveSeaPaths(entry.folder, project, { land: source, water, now: opts.now })
      } catch (e) {
        return failed(e, 'Mapper could not work out the sea route')
      }
    })()
    resolving.add(work)
    try {
      return await work
    } finally {
      resolving.delete(work)
    }
  }

  /** Sends what `run` returns, or the error a bad project or patch caused. */
  async function respondWith(res: http.ServerResponse, run: () => Promise<object>): Promise<void> {
    try {
      sendJson(res, 200, await run())
    } catch (e) {
      if (e instanceof StaleBase) {
        sendError(res, 409, STALE_BASE_MESSAGE)
      } else if (e instanceof ProjectError) {
        sendError(res, 400, e.message, { path: e.issues[0]?.path ?? [], issues: e.issues })
      } else if (e instanceof StoreError) {
        sendError(res, 400, e.message, { fix: e.fix })
      } else {
        throw e
      }
    }
  }

  /** The studio's client id from its header, or undefined when it's missing, malformed or the paths origin. */
  function clientId(req: http.IncomingMessage): string | undefined {
    const value = req.headers[CLIENT_HEADER.toLowerCase()]
    return typeof value === 'string' && CLIENT_ID_PATTERN.test(value) && value !== PATHS_ORIGIN ? value : undefined
  }

  function rememberOrigin(entry: Registered, updatedAt: string, client: string): void {
    entry.origins.delete(updatedAt)
    entry.origins.set(updatedAt, client)
    while (entry.origins.size > ORIGIN_MEMORY) entry.origins.delete(entry.origins.keys().next().value!)
  }

  function lookup(encodedKey: string): Registered | undefined {
    const key = decode(encodedKey)
    return key === undefined ? undefined : projects.get(key)
  }

  async function serveStudio({ res, rest }: RouteContext): Promise<void> {
    const relative = rest.slice(1).map(decode)
    if (relative.some((s) => s === undefined || s.includes('\0'))) return sendError(res, 404, 'Not found')
    const wanted = path.resolve(studioDir, relative.join('/'))
    if (wanted !== studioDir && !wanted.startsWith(studioDir + path.sep)) return sendError(res, 404, 'Not found')
    let file = wanted
    const info = await stat(file).catch(() => undefined)
    if (!info?.isFile()) file = path.join(studioDir, 'index.html')
    let body: Buffer
    try {
      body = await readFile(file)
    } catch {
      return sendError(res, 404, 'Not found')
    }
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    })
    res.end(body)
  }

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // The token is in the URL, so keep it out of Referer headers.
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (!hostAllowed(req)) return sendError(res, 403, 'Forbidden')
    const rest = routeSegments(req)
    if (!rest) return sendError(res, 404, 'Not found')
    for (const route of routes) {
      if (route.method !== req.method) continue
      const params = route.match(rest)
      if (params) return route.handle({ req, res, rest, params })
    }
    sendError(res, 404, 'Not found')
  }

  // WebSocket

  function reject(socket: Duplex, status: number, text: string): void {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy())
  }

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => undefined)
    if (!hostAllowed(req)) return reject(socket, 403, 'Forbidden')
    const rest = routeSegments(req)
    const entry = rest && rest.length === 3 && rest[0] === 'ws' && rest[1] === 'projects' ? lookup(rest[2]!) : undefined
    if (!entry) return reject(socket, 404, 'Not Found')
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => undefined)
      entry.clients.add(ws)
      ws.on('close', () => {
        entry.clients.delete(ws)
        entry.shown.delete(ws)
        updateRetry(entry)
      })
      void loadProject(entry.folder).then(
        async (project) => {
          send(entry, ws, { type: 'project', project, seaPaths: await seaPathsFor(entry, project) })
          updateRetry(entry)
        },
        () => ws.close(1011, 'Could not load the project'),
      )
    })
  })

  /** Sends `message` to an open socket of `entry`, and notes what it now shows. */
  function send(entry: Registered, ws: WebSocket, message: ServerMessage, paths = JSON.stringify(message.seaPaths)): void {
    if (ws.readyState !== WebSocket.OPEN || !entry.clients.has(ws)) return
    ws.send(JSON.stringify(message))
    const retry = Object.values(message.seaPaths).some(retriesSoon)
    entry.shown.set(ws, { updatedAt: message.project.updatedAt, paths, retry })
  }

  // Retrying unverified sea routes

  /**
   * Keeps a retry coming while an open socket shows a sea route the network or the budget left unverified, and none
   * otherwise: an unsettled route waits a day, for the next call after that. Each retry is `retryMs` after the last
   * one finished, so a slow one never overlaps the next.
   */
  function updateRetry(entry: Registered): void {
    const wanted = !closed && projects.get(entry.key) === entry && [...entry.shown.values()].some((s) => s.retry)
    if (!wanted) {
      clearTimeout(entry.retry)
      entry.retry = undefined
      return
    }
    if (entry.retry !== undefined || entry.retrying) return
    entry.retry = setTimeout(() => {
      entry.retry = undefined
      void retryPaths(entry)
    }, retryMs)
    entry.retry.unref()
  }

  /**
   * Works out the project's sea routes again, through the cache, which routes an unverified one only once its minute
   * is up. Sockets showing this version get the routes when they differ from what they show, as a paths-only message
   * the studio takes without clearing its undo history. A version the server hasn't passed on yet goes out as an
   * ordinary reload instead, with its origin.
   */
  async function retryPaths(entry: Registered): Promise<void> {
    entry.retrying = true
    try {
      let project: Project
      try {
        project = await loadProject(entry.folder)
      } catch {
        return // Half-written or invalid; the watcher or the next retry sees it.
      }
      if (closed || projects.get(entry.key) !== entry) return
      const hash = projectHash(project)
      const current = (): boolean => project.updatedAt === entry.lastUpdatedAt && hash === entry.lastHash
      if (!current()) {
        await reload(entry)
        return
      }
      const seaPaths = await seaPathsFor(entry, project)
      // A newer version came in meanwhile; its own broadcast carries its routes.
      if (closed || projects.get(entry.key) !== entry || !current()) return
      const paths = JSON.stringify(seaPaths)
      const message: ServerMessage = { type: 'project', project, seaPaths, origin: PATHS_ORIGIN }
      for (const ws of entry.clients) {
        const shown = entry.shown.get(ws)
        if (shown && shown.updatedAt === project.updatedAt && shown.paths !== paths) send(entry, ws, message, paths)
      }
    } finally {
      entry.retrying = false
      updateRetry(entry)
    }
  }

  // Watching

  function scheduleReload(entry: Registered): void {
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      void reload(entry)
    }, WATCH_DEBOUNCE_MS)
  }

  /**
   * Passes on the project on disk when it isn't the last version the server knew. A newer `updatedAt` is broadcast
   * whatever the content, so the studios patch against it. The same `updatedAt` and content (an identical rewrite or a
   * reformat) sends nothing. Anything else (a hand edit that kept `updatedAt`, or an older file restored) would be
   * dropped by the studio, so it's saved again with a later `updatedAt`, and the watcher passes that on.
   */
  async function reload(entry: Registered): Promise<void> {
    let project
    try {
      project = await loadProject(entry.folder)
    } catch {
      return // Half-written or temporarily invalid; the next file event tries again.
    }
    if (closed || projects.get(entry.key) !== entry) return
    const hash = projectHash(project)
    if (project.updatedAt === entry.lastUpdatedAt && hash === entry.lastHash) return
    if (!(Date.parse(project.updatedAt) > Date.parse(entry.lastUpdatedAt))) {
      // Leaves the file alone if anything wrote since it was read; that write fires its own change.
      const restamped = await restampProject(entry.folder, { hash, after: entry.lastUpdatedAt }).catch(() => undefined)
      // A change from outside the studio, even if a patch's version once had the same time.
      if (restamped) entry.origins.delete(restamped.updatedAt)
      return
    }
    entry.lastUpdatedAt = project.updatedAt
    entry.lastHash = hash
    const origin = entry.origins.get(project.updatedAt)
    const seaPaths = await seaPathsFor(entry, project)
    if (closed || projects.get(entry.key) !== entry) return
    const message: ServerMessage =
      origin === undefined ? { type: 'project', project, seaPaths } : { type: 'project', project, seaPaths, origin }
    const paths = JSON.stringify(seaPaths)
    for (const ws of entry.clients) send(entry, ws, message, paths)
    updateRetry(entry)
  }

  function dispose(entry: Registered): void {
    clearTimeout(entry.timer)
    clearTimeout(entry.retry)
    entry.retry = undefined
    entry.watcher?.close()
    entry.watcher = undefined
  }

  // Public interface

  async function registerProject(folder: string): Promise<string> {
    assertAbsolute(folder)
    const resolved = path.resolve(folder)
    // Checks there is a valid project to serve.
    const project = await loadProject(resolved)
    const known = keys.get(resolved)
    if (known !== undefined) return known

    const entry: Registered = {
      folder: resolved,
      key: randomBytes(16).toString('hex'),
      watcher: undefined,
      clients: new Set(),
      lastUpdatedAt: project.updatedAt,
      lastHash: projectHash(project),
      timer: undefined,
      origins: new Map(),
      seaPathsFailed: false,
      shown: new Map(),
      retry: undefined,
      retrying: false,
    }
    // Watch the folder, not the file: atomic saves rename a temporary file over mapper.json.
    try {
      entry.watcher = watch(resolved, (_event, filename) => {
        if (filename === null || filename === undefined || filename.toString() === PROJECT_FILE) scheduleReload(entry)
      })
      entry.watcher.on('error', () => undefined)
    } catch {
      // Without a watcher the studio still works; it just won't see outside edits.
    }
    projects.set(entry.key, entry)
    keys.set(resolved, entry.key)
    return entry.key
  }

  function studioUrl(key: string, query: Record<string, string> = {}): string {
    const extra = new URLSearchParams(query).toString()
    return `${mapper.base}studio/?project=${encodeURIComponent(key)}${extra ? `&${extra}` : ''}`
  }

  async function close(): Promise<void> {
    if (closed) return
    closed = true
    for (const entry of projects.values()) dispose(entry)
    projects.clear()
    keys.clear()
    // Every socket the server accepted, whichever entry it belongs to.
    for (const ws of wss.clients) ws.terminate()
    wss.close()
    await Promise.allSettled([...resolving])
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('The server did not report a port.')
  port = address.port

  const mapper: MapperServer = {
    port,
    token,
    base: `http://127.0.0.1:${port}/${token}/`,
    registerProject,
    studioUrl,
    close,
  }
  return mapper
}

let shared: Promise<MapperServer> | undefined

/** The one server for this process. It starts on first use; concurrent callers share the start. */
export function getServer(): Promise<MapperServer> {
  if (!shared) {
    const starting = startServer({
      studioDir: path.join(packageRoot(), 'dist', 'studio'),
      cacheDir: process.env.MAPPER_CACHE_DIR ?? path.join(os.homedir(), '.cache', 'mapper'),
      tileUpstream: process.env.MAPPER_TILE_UPSTREAM || undefined,
    }).then((server) => {
      const close = server.close
      // After close, the next getServer() starts a fresh server.
      return {
        ...server,
        close: async () => {
          if (shared === starting) shared = undefined
          await close()
        },
      }
    })
    shared = starting
    starting.catch(() => {
      if (shared === starting) shared = undefined
    })
  }
  return shared
}

/** Closes the process's server if `getServer` started one. Starting it just to close it would be wasteful. */
export async function closeServerIfStarted(): Promise<void> {
  const starting = shared
  if (!starting) return
  const server = await starting.catch(() => undefined)
  await server?.close()
}
