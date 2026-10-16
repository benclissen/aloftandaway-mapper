import { applyPatch, type PatchResponse, type Project, type ProjectPatch } from '../../core/index.js'

/** One studio edit: the patch that made it, the patch that undoes it, and the scene to show after each. */
export interface Entry {
  label: string
  forward: ProjectPatch
  inverse: ProjectPatch
  /** The scene on screen when the edit was made, shown again after an undo. */
  sceneBefore: string
  /** The scene shown after the edit: the new one for add and duplicate, the neighbour for delete. Shown after a redo. */
  sceneAfter: string
}

/** The ops that change the list of scenes; a patch with only these names no scene. */
export const SCENE_OPS = new Set(['add_scene', 'duplicate_scene', 'remove_scene', 'move_scene', 'restore_scene'])

/**
 * The scenes to show around `patch`, made on `before` while scene `shown` was on screen. A scene that is added or
 * duplicated is shown after it. When the scene on screen is removed, the one that takes its place is shown, or the
 * new last scene when it was last.
 */
export function scenesAround(before: Project, patch: ProjectPatch, shown: string): { sceneBefore: string; sceneAfter: string } {
  let after = shown
  let state = before
  for (const op of patch.ops ?? []) {
    if (op.op === 'add_scene' && op.id !== undefined) after = op.id
    else if (op.op === 'duplicate_scene' && op.newId !== undefined) after = op.newId
    else if (op.op === 'restore_scene') after = op.scene.id
    else if (op.op === 'remove_scene' && op.id === after) {
      const at = state.scenes.findIndex((s) => s.id === after)
      const left = state.scenes.toSpliced(at, 1)
      after = left[Math.min(at, left.length - 1)]?.id ?? after
    }
    if (SCENE_OPS.has(op.op)) state = applyPatch(state, { ops: [op] })
  }
  return { sceneBefore: shown, sceneAfter: after }
}

/**
 * The patch to redo `forward` with, given `saved`, the project it made. A duplicate gives the copy's stops fresh ids,
 * so doing it again would make a copy that later edits to these stops can't find; it is redone by putting back the
 * copy as saved. Anything else is redone as it was made.
 */
export function redoPatch(forward: ProjectPatch, saved: Project): ProjectPatch {
  const op = forward.ops?.length === 1 ? forward.ops[0] : undefined
  if (op?.op !== 'duplicate_scene' || op.newId === undefined) return forward
  const index = saved.scenes.findIndex((s) => s.id === op.newId)
  if (index < 0) return forward
  return { ops: [{ op: 'restore_scene', index, scene: structuredClone(saved.scenes[index]!) }] }
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
 * The newest version written from outside the studio (by the agent or the CLI) that the studio knows of. An edit that
 * finds a leg or via point by index is refused when the view it was made on is older than that write, since the
 * write may have moved what the index points at.
 */
export class OutsideWrites {
  private last: string | undefined

  /** Notes that version `updatedAt` was written from outside the studio. */
  saw(updatedAt: string): void {
    if (this.last === undefined || Date.parse(updatedAt) > Date.parse(this.last)) this.last = updatedAt
  }

  /** Whether something outside the studio wrote after version `seen`. */
  since(seen: string): boolean {
    return this.last !== undefined && Date.parse(this.last) > Date.parse(seen)
  }
}

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
