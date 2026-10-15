import {
  BASE_HEADER,
  CLIENT_HEADER,
  parseProject,
  type PatchResponse,
  type Project,
  type ProjectPatch,
  type ServerMessage,
} from '../../core/index.js'

// The page is served at `<base>studio/?project=<key>`, where the base already carries the session token and the key
// is the server's opaque key for the project folder.

function projectKey(): string {
  const key = new URLSearchParams(location.search).get('project')
  if (!key) throw new Error('This link has no project in it. Ask your agent to open the studio again.')
  return key
}

/** This page's id, sent with every patch. The server echoes it as the `origin` of the broadcast the patch causes. */
export const CLIENT_ID = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')

const apiUrl = (suffix = '') => new URL(`../api/projects/${encodeURIComponent(projectKey())}${suffix}`, location.href)

/** A request the server refused, with its status and message. */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** The response body, or the server's error message as a thrown RequestError. */
async function readBody(res: Response): Promise<{ project?: unknown; previousUpdatedAt?: unknown }> {
  const body = (await res.json().catch(() => undefined)) as
    | { project?: unknown; previousUpdatedAt?: unknown; error?: { message?: string } }
    | undefined
  if (!res.ok || !body?.project) {
    throw new RequestError(body?.error?.message ?? `The server answered ${res.status} ${res.statusText}.`, res.status)
  }
  return body
}

export async function getProject(): Promise<Project> {
  return parseProject((await readBody(await fetch(apiUrl()))).project)
}

/**
 * Applies `body` on the server. Resolves to the saved project and the `updatedAt` of the version it was applied to.
 * With `base`, the server applies it only if the project is still at that version, and otherwise rejects with a
 * RequestError of status 409. Rejects with the server's error message.
 */
export async function patch(body: ProjectPatch, base?: string): Promise<PatchResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', [CLIENT_HEADER]: CLIENT_ID }
  if (base !== undefined) headers[BASE_HEADER] = base
  const res = await fetch(apiUrl('/patch'), { method: 'POST', headers, body: JSON.stringify(body) })
  const saved = await readBody(res)
  if (typeof saved.previousUpdatedAt !== 'string') throw new Error("The server's answer is missing previousUpdatedAt.")
  return { project: parseProject(saved.project), previousUpdatedAt: saved.previousUpdatedAt }
}

/**
 * Calls `onMessage` with the project when connected and again whenever it changes on disk, including after this
 * page's own patches. `origin` is the client id of the studio whose patch made that version, if one did. `onClose`
 * hears if the connection drops. Returns a function that disconnects.
 */
export function subscribe(onMessage: (m: { project: Project; origin?: string }) => void, onClose?: () => void): () => void {
  const url = new URL(`../ws/projects/${encodeURIComponent(projectKey())}`, location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(url)
  let closing = false
  ws.addEventListener('message', (event) => {
    let message: ServerMessage
    try {
      message = JSON.parse(String(event.data)) as ServerMessage
      if (message.type !== 'project') return
      const project = parseProject(message.project)
      onMessage(typeof message.origin === 'string' ? { project, origin: message.origin } : { project })
    } catch {
      // A malformed message can't be shown; the next change on disk sends a fresh copy.
    }
  })
  ws.addEventListener('close', () => {
    if (!closing) onClose?.()
  })
  return () => {
    closing = true
    ws.close()
  }
}
