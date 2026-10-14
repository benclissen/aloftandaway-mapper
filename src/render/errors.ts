import type { Issue } from '../core/index.js'

/** A render that can't start or failed. `fix` tells the agent what to do. */
export class RenderError extends Error {
  readonly fix: string
  readonly issues: Issue[] | undefined

  constructor(message: string, fix: string, issues?: Issue[]) {
    super(message)
    this.name = 'RenderError'
    this.fix = fix
    this.issues = issues
  }
}

/** Thrown when the render's signal aborts. */
export class RenderCancelled extends Error {
  constructor() {
    super('The render was cancelled.')
    this.name = 'AbortError'
  }
}

