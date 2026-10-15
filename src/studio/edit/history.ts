import type { PatchResponse, Project, ProjectPatch } from '../../core/index.js'

/** One studio edit: the patch that made it and the patch that undoes it. */
export interface Entry {
  label: string
  forward: ProjectPatch
  inverse: ProjectPatch
}

/** The studio's undo and redo stacks. It holds patches only; sending them is the caller's job. */
export class EditHistory {
  private undo: Entry[] = []
  private redo: Entry[] = []

  /** Records a new edit. A new edit ends the redo trail. */
  push(entry: Entry): void {
    this.undo.push(entry)
    this.redo = []
  }

  /** The edit to undo, moved onto the redo stack. */
  takeUndo(): Entry | undefined {
    const entry = this.undo.pop()
    if (entry) this.redo.push(entry)
    return entry
  }

  /** The edit to redo, moved back onto the undo stack. */
  takeRedo(): Entry | undefined {
    const entry = this.redo.pop()
    if (entry) this.undo.push(entry)
    return entry
  }

  /** Removes `entry` from whichever stack holds it, for a step that failed to save. */
  discard(entry: Entry): void {
    this.undo = this.undo.filter((e) => e !== entry)
    this.redo = this.redo.filter((e) => e !== entry)
  }

  clear(): void {
    this.undo = []
    this.redo = []
  }

  get canUndo(): boolean {
    return this.undo.length > 0
  }

  get canRedo(): boolean {
    return this.redo.length > 0
  }

  get undoLabel(): string | undefined {
    return this.undo.at(-1)?.label
  }

  get redoLabel(): string | undefined {
    return this.redo.at(-1)?.label
  }
}

const newer = (a: Project, b: Project) => Date.parse(a.updatedAt) > Date.parse(b.updatedAt)

/**
 * Sends patches one at a time. Each `make` runs only once the previous send has settled, and gets the newest project
 * it knows of: the caller's `current()` or the last saved response, whichever is newer. So a patch and its inverse are
 * always computed against the project the server will apply them to, unless something outside the studio writes too.
 *
 * A caller that chains `.then` on the promise `run` returns runs its handler before the next queued `make`.
 */
export class EditQueue {
  private tail: Promise<unknown> = Promise.resolve()
  private latest: Project | undefined

  /** `send` gets `base`, the `updatedAt` the patch was made against, for a conditional run only. */
  constructor(private readonly send: (patch: ProjectPatch, base?: string) => Promise<PatchResponse>) {}

  /**
   * Queues an edit. Resolves to the server's response, or undefined when `make` returned no patch. Rejects with the
   * send's error, and the queue carries on. A `conditional` run sends the base it was made against, so the server
   * refuses it if the project has moved on.
   */
  run(
    make: (current: Project) => ProjectPatch | undefined,
    current: () => Project,
    opts: { conditional?: boolean } = {},
  ): Promise<PatchResponse | undefined> {
    const job = this.tail.then(async () => {
      const held = current()
      const base = this.latest && newer(this.latest, held) ? this.latest : held
      const patch = make(base)
      if (!patch) return undefined
      const response = await (opts.conditional ? this.send(patch, base.updatedAt) : this.send(patch))
      if (!this.latest || newer(response.project, this.latest)) this.latest = response.project
      return response
    })
    this.tail = job.catch(() => undefined)
    return job
  }
}
