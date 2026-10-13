import { parseProject, type Project, type ProjectPatch, type ServerMessage } from '../../core/index.js'

// The page is served at `<base>studio/?project=<key>`, where the base already carries the session token and the key
// is the server's opaque key for the project folder.

function projectKey(): string {
  const key = new URLSearchParams(location.search).get('project')
  if (!key) throw new Error('This link has no project in it. Ask your agent to open the studio again.')
  return key
}

const apiUrl = (suffix = '') => new URL(`../api/projects/${encodeURIComponent(projectKey())}${suffix}`, location.href)

async function readProject(res: Response): Promise<Project> {
  const body = (await res.json().catch(() => undefined)) as { project?: unknown; error?: { message?: string } } | undefined
  if (!res.ok || !body?.project) {
    throw new Error(body?.error?.message ?? `The server answered ${res.status} ${res.statusText}.`)
  }
  return parseProject(body.project)
}

export async function getProject(): Promise<Project> {
  return readProject(await fetch(apiUrl()))
}

/** Applies `body` on the server and returns the saved project. Rejects with the server's error message. */
export async function patch(body: ProjectPatch): Promise<Project> {
  const res = await fetch(apiUrl('/patch'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return readProject(res)
}

/**
 * Calls `onProject` with the project when connected and again whenever it changes on disk, including after this
 * page's own patches. `onClose` hears if the connection drops. Returns a function that disconnects.
 */
export function subscribe(onProject: (p: Project) => void, onClose?: () => void): () => void {
  const url = new URL(`../ws/projects/${encodeURIComponent(projectKey())}`, location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(url)
  let closing = false
  ws.addEventListener('message', (event) => {
    let message: ServerMessage
    try {
      message = JSON.parse(String(event.data)) as ServerMessage
      if (message.type !== 'project') return
      onProject(parseProject(message.project))
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
