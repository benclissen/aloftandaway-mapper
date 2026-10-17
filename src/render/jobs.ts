import { randomUUID } from 'node:crypto'
import { fixOf } from '../server/errors.js'
import { addOutput, renderProject, type CompletedOutput, type RenderArgs, type RenderProgress, type RenderResult } from './render.js'

export type JobState = 'running' | 'done' | 'failed' | 'cancelled'

export interface RenderStatus {
  jobId: string
  state: JobState
  /** Absent until the job starts. A queued job is `running` with no progress. */
  progress?: RenderProgress
  result?: RenderResult
  /** Why the job failed. */
  error?: string
  /** What to do about `error`, when Mapper knows. */
  fix?: string
  /** The render folder, once it exists. */
  dir?: string
  /**
   * Outputs finished so far, with absolute paths. Kept when a later pass fails or the job is cancelled. A joined clip
   * replaces the scene parts it was made from.
   */
  outputs?: CompletedOutput[]
  /** The render's warnings so far, as `RenderResult.warnings` words them. Absent while there are none. */
  warnings?: string[]
}

interface Job {
  status: RenderStatus
  controller: AbortController
  started: boolean
  /** Resolves once the job reaches a final state. Never rejects. */
  settled: Promise<void>
  settle(): void
}

/** Every job this process has started, finished ones included. */
const jobs = new Map<string, Job>()
/** One render runs at a time; each job waits for the one before it. */
let queue: Promise<void> = Promise.resolve()

/** Queues a render of the project and returns its job id at once. Poll it with `renderStatus`. */
export function startRenderJob(args: Omit<RenderArgs, 'onProgress' | 'onStart' | 'onOutput' | 'onWarnings' | 'signal'>): string {
  const jobId = randomUUID()
  let settle!: () => void
  const settled = new Promise<void>((resolve) => (settle = resolve))
  const job: Job = { status: { jobId, state: 'running' }, controller: new AbortController(), started: false, settled, settle }
  jobs.set(jobId, job)
  queue = queue.then(() => runJob(job, args))
  return jobId
}

async function runJob(job: Job, args: Omit<RenderArgs, 'onProgress' | 'onStart' | 'onOutput' | 'onWarnings' | 'signal'>): Promise<void> {
  // Cancelled while queued: already settled.
  if (job.controller.signal.aborted) return
  job.started = true
  const { status } = job
  try {
    status.result = await renderProject({
      ...args,
      signal: job.controller.signal,
      onStart: ({ dir }) => (status.dir = dir),
      onProgress: (progress) => (status.progress = progress),
      onOutput: (output) => addOutput((status.outputs ??= []), { ...output }),
      onWarnings: (warnings) => (status.warnings = warnings),
    })
    status.state = 'done'
  } catch (e) {
    if (job.controller.signal.aborted) {
      status.state = 'cancelled'
    } else {
      status.state = 'failed'
      status.error = e instanceof Error ? e.message : String(e)
      status.fix = fixOf(e)
    }
  }
  job.settle()
}

function find(jobId: string): Job {
  const job = jobs.get(jobId)
  if (!job) throw new Error(`No render job has the id '${jobId}'. Check the job id: render returns it when the job starts.`)
  return job
}

/** A copy of the job's current status. Throws for an unknown id. */
export function renderStatus(jobId: string): RenderStatus {
  return copy(find(jobId).status)
}

/**
 * Cancels the job, stopping ffmpeg and Chrome, and resolves with its final status once they're gone. A queued job
 * is dropped without starting. A finished job is left as it is.
 */
export async function cancelRender(jobId: string): Promise<RenderStatus> {
  const job = find(jobId)
  if (job.status.state === 'running') {
    job.controller.abort()
    if (!job.started) {
      job.status.state = 'cancelled'
      job.settle()
    }
    await job.settled
  }
  return copy(job.status)
}

function copy(status: RenderStatus): RenderStatus {
  return structuredClone(status)
}

/** Cancels every job that is running or queued and resolves once they have all stopped. */
export async function cancelAll(): Promise<void> {
  await Promise.all([...jobs.keys()].map((jobId) => cancelRender(jobId)))
}
