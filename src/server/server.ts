import { randomBytes, timingSafeEqual } from 'node:crypto'
import { watch, existsSync, type FSWatcher } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import http from 'node:http'
import type { Duplex } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import { applyPatch, ProjectError, type PatchRequest, type ServerMessage } from '../core/index.js'
import { assertAbsolute, loadProject, mutateProject, PROJECT_FILE, StoreError } from './store.js'

export interface MapperServer {
  port: number
  token: string
  /** `http://127.0.0.1:<port>/<token>/` */
  base: string
  /** Registers a project folder and returns the project's id. */
  registerProject(folder: string): Promise<string>
  studioUrl(projectId: string, query?: Record<string, string>): string
  close(): Promise<void>
}

export interface ServerOptions {
  studioDir: string
  cacheDir: string
  tileUpstream?: string
}

const MAX_BODY_BYTES = 1024 * 1024
const WATCH_DEBOUNCE_MS = 50

const CONTENT_TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.pbf': 'application/x-protobuf',
}))

interface Registered {
  folder: string
  id: string
  watcher: FSWatcher | undefined
  clients: Set<WebSocket>
  /** `updatedAt` of the last project this entry broadcast or loaded. */
  lastUpdatedAt: string
  timer: NodeJS.Timeout | undefined
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
function packageRoot(): string {
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
  const token = randomBytes(32).toString('hex')
  const projects = new Map<string, Registered>()
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
        await respondWithProject(res, () => loadProject(entry.folder))
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
        await respondWithProject(res, () => mutateProject(entry.folder, (p) => applyPatch(p, patch)))
      },
    },
    {
      // Task 10 mounts the tile proxy here.
      method: 'GET',
      match: (rest) => (rest[0] === 'tiles' ? [] : undefined),
      handle: ({ res }) => sendError(res, 404, 'Not found'),
    },
  ]

  async function respondWithProject(res: http.ServerResponse, run: () => Promise<unknown>): Promise<void> {
    try {
      sendJson(res, 200, { project: await run() })
    } catch (e) {
      if (e instanceof ProjectError) {
        sendError(res, 400, e.message, { path: e.issues[0]?.path ?? [], issues: e.issues })
      } else if (e instanceof StoreError) {
        sendError(res, 400, e.message, { fix: e.fix })
      } else {
        throw e
      }
    }
  }

  function lookup(encodedId: string): Registered | undefined {
    const id = decode(encodedId)
    return id === undefined ? undefined : projects.get(id)
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
      ws.on('close', () => entry.clients.delete(ws))
      void loadProject(entry.folder).then(
        (project) => send(ws, { type: 'project', project }),
        () => ws.close(1011, 'Could not load the project'),
      )
    })
  })

  function send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
  }

  // Watching

  function scheduleReload(entry: Registered): void {
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      void reload(entry)
    }, WATCH_DEBOUNCE_MS)
  }

  async function reload(entry: Registered): Promise<void> {
    let project
    try {
      project = await loadProject(entry.folder)
    } catch {
      return // Half-written or temporarily invalid; the next file event tries again.
    }
    if (closed || projects.get(entry.id) !== entry || project.updatedAt === entry.lastUpdatedAt) return
    entry.lastUpdatedAt = project.updatedAt
    for (const ws of entry.clients) send(ws, { type: 'project', project })
  }

  function dispose(entry: Registered): void {
    clearTimeout(entry.timer)
    entry.watcher?.close()
    entry.watcher = undefined
  }

  // Public interface

  async function registerProject(folder: string): Promise<string> {
    assertAbsolute(folder)
    const resolved = path.resolve(folder)
    const project = await loadProject(resolved)
    const existing = projects.get(project.id)
    if (existing?.folder === resolved) return project.id

    for (const entry of projects.values()) {
      if (entry.folder === resolved && entry.id !== project.id) {
        dispose(entry)
        projects.delete(entry.id)
      }
    }
    const entry: Registered = {
      folder: resolved,
      id: project.id,
      watcher: undefined,
      clients: existing?.clients ?? new Set(),
      lastUpdatedAt: project.updatedAt,
      timer: undefined,
    }
    if (existing) dispose(existing)
    // Watch the folder, not the file: atomic saves rename a temporary file over mapper.json.
    try {
      entry.watcher = watch(resolved, (_event, filename) => {
        if (filename === null || filename === undefined || filename.toString() === PROJECT_FILE) scheduleReload(entry)
      })
      entry.watcher.on('error', () => undefined)
    } catch {
      // Without a watcher the studio still works; it just won't see outside edits.
    }
    projects.set(project.id, entry)
    return project.id
  }

  function studioUrl(projectId: string, query: Record<string, string> = {}): string {
    const extra = new URLSearchParams(query).toString()
    return `${mapper.base}studio/?project=${encodeURIComponent(projectId)}${extra ? `&${extra}` : ''}`
  }

  async function close(): Promise<void> {
    if (closed) return
    closed = true
    for (const entry of projects.values()) {
      dispose(entry)
      for (const ws of entry.clients) ws.terminate()
    }
    projects.clear()
    wss.close()
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
