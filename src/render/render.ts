import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, statfs, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  buildRoute,
  buildTimeline,
  fpsValue,
  frameSize,
  MAP_CREDIT,
  outputScale,
  validateProject,
  type Issue,
  type Project,
} from '../core/index.js'
import { packageRoot } from '../server/server.js'
import { assertAbsolute, loadProject, projectHash } from '../server/store.js'
import { launchBrowser, type LaunchedBrowser } from './chrome.js'
import { Encoder, ffmpegArgs, joinSegments, pickH264Encoder, type Codec } from './encode.js'
import { RenderPage } from './page.js'

/** How long one `renderFrame` or `capturePng` may take before the render fails. */
const STEP_TIMEOUT_MS = 60_000
/** How many times one render may reopen the page and carry on. The next failure fails the render. */
const MAX_RECOVERIES = 3
/** Progress fps is averaged over this many frames. */
const FPS_WINDOW = 25
/** Estimated bytes per pixel per frame, before the safety margin. */
const BYTES_PER_PIXEL: Record<Codec, number> = { prores: 0.45, h264: 0.03 }
const DISK_MARGIN = 1.5
const GB = 1e9
const RENDERS_DIR = 'renders'

export interface RenderProgress {
  /** Frames finished so far. */
  frame: number
  totalFrames: number
  /** Rolling average over the last 25 frames. */
  fps: number
  etaSeconds: number
}

export interface RenderResult {
  /** The render folder, `<project>/renders/<YYYY-MM-DD-HHmmss>`. */
  dir: string
  video: string
  manifest: string
  frames: number
  renderFps: number
  projectHash: string
}

export interface RenderArgs {
  folder: string
  codec?: Codec
  /** Seconds into the clip. Frames `[floor(from·fps), ceil(to·fps))` are rendered, clamped to the clip. */
  range?: { from: number; to: number }
  onProgress?: (p: RenderProgress) => void
  /** Called once the render folder exists, before the first frame. */
  onStart?: (info: { dir: string }) => void
  signal?: AbortSignal
  /** Test hook: loses the page's WebGL context the first time this frame is rendered. Only the first page gets it. */
  faultAtFrame?: number
  /** Test hook: loses the context just after this frame is painted, before it is captured. First page only. */
  faultAfterRenderFrame?: number
}

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

/**
 * Renders the project in `folder` to `renders/<YYYY-MM-DD-HHmmss>/all.mov` (ProRes 422 HQ) or `all.mp4` (H.264),
 * with a `manifest.json`. The project is read once, so later edits don't affect a running render.
 *
 * Frames are deterministic, so a render survives a crashed page, a lost WebGL context or a stuck frame: it opens a
 * fresh page and carries on from the failed frame into a new segment (`all.part<k>`), up to 3 times. The segments are
 * joined without re-encoding at the end.
 */
export async function renderProject(args: RenderArgs): Promise<RenderResult> {
  const { folder, signal } = args
  const codec = args.codec ?? 'prores'
  assertAbsolute(folder)
  throwIfAborted(signal)

  const snapshot = await loadProject(folder)
  const hash = projectHash(snapshot)
  assertRenderable(snapshot)
  const timeline = buildTimeline(snapshot, buildRoute(snapshot))
  const { fromFrame, toFrame } = frameRange(args.range, timeline.totalFrames, fpsValue(snapshot.output.fps))
  const frames = toFrame - fromFrame
  const size = frameSize(snapshot.output)
  await checkDisk(folder, frames * size.width * size.height * BYTES_PER_PIXEL[codec] * DISK_MARGIN)
  const h264Encoder = codec === 'h264' ? await pickH264Encoder() : undefined
  throwIfAborted(signal)

  const dir = await makeRenderDir(folder, new Date())
  const ext = codec === 'prores' ? 'mov' : 'mp4'
  const video = path.join(dir, `all.${ext}`)
  const manifestFile = path.join(dir, 'manifest.json')
  args.onStart?.({ dir })

  let launched: LaunchedBrowser | undefined
  let encoder: Encoder | undefined
  /** The segment files written so far, in order. */
  const parts: string[] = []
  let recoveries = 0
  let framesDone = 0
  let loopStart = performance.now()
  const elapsedFps = () => framesDone / Math.max((performance.now() - loopStart) / 1000, 1e-9)
  const manifest = (extra: object) => ({
    mapperVersion: mapperVersion(),
    projectId: snapshot.id,
    projectHash: hash,
    name: snapshot.name,
    output: snapshot.output,
    frameSize: size,
    codec,
    range: { fromFrame, toFrame },
    totalFrames: frames,
    segments: parts.length,
    recoveries,
    durationSeconds: frames / fpsValue(snapshot.output.fps),
    credit: MAP_CREDIT,
    creditPlacement: snapshot.credit,
    renderFps: round2(elapsedFps()),
    chrome: launched ? { channel: launched.channel, webgl: launched.webgl } : undefined,
    renderedAt: new Date().toISOString(),
    ...extra,
  })

  // Cancelling stops ffmpeg and Chrome at once; the pending step then rejects.
  const onAbort = () => {
    encoder?.kill()
    void launched?.browser.close().catch(() => undefined)
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    launched = await launchBrowser()
    throwIfAborted(signal)
    const { browser } = launched
    let page: RenderPage
    /** Rejects when `page` crashes or loses its WebGL context, so a step fails at once instead of timing out. */
    let pageFailed: Promise<never>
    /** Opens a page, loads the snapshot into it and arms `pageFailed`. */
    const openPage = async (faults: { faultAtFrame?: number; faultAfterRenderFrame?: number } = {}) => {
      const opened = await RenderPage.open({ browser, aspect: snapshot.output.aspect })
      try {
        const frameCount = await opened.load(snapshot, outputScale(snapshot.output), faults)
        if (frameCount !== timeline.totalFrames) {
          throw new Error(`The render page counted ${frameCount} frames, but the timeline has ${timeline.totalFrames}.`)
        }
      } catch (e) {
        await opened.close()
        throw e
      }
      const failed = new Promise<never>((_, reject) => {
        opened.onCrash(() => reject(new Error('the render page crashed or lost its WebGL context')))
      })
      failed.catch(() => undefined)
      page = opened
      pageFailed = failed
    }
    await openPage({ faultAtFrame: args.faultAtFrame, faultAfterRenderFrame: args.faultAfterRenderFrame })
    throwIfAborted(signal)

    const progress = rollingProgress(frames, args.onProgress)
    loopStart = performance.now()
    // Frame n+1 renders and captures while frame n is written, so at most one frame waits in Node.
    let writing: Promise<void> = Promise.resolve()
    /**
     * Ends the current segment and opens a fresh page, after frame `n` failed because of `cause`. A new page also drops
     * any tiles that errored, which MapLibre never refetches. Fails the render once the recoveries are used up.
     */
    const recover = async (n: number, cause: unknown) => {
      // The failed frame was never written. Finish the segment with every frame before it.
      await writing
      await encoder?.finish()
      encoder = undefined
      await page.close()
      for (let lastCause = cause; ; ) {
        if (recoveries >= MAX_RECOVERIES) {
          throw new RenderError(
            `Frame ${n} failed ${MAX_RECOVERIES + 1} times, after ${MAX_RECOVERIES} recoveries. Last error: ${errorMessage(lastCause)}`,
            'Check that Chrome has WebGL and the map tiles can load, then render again. A range starting near this frame is quicker to retry.',
          )
        }
        recoveries++
        try {
          await openPage()
          return
        } catch (e) {
          if (signal?.aborted) throw e
          lastCause = e
        }
      }
    }

    let n = fromFrame
    while (n < toFrame) {
      let png: Buffer
      try {
        await step(page!.renderFrame(n), `render frame ${n}`, pageFailed!)
        png = await step(page!.capturePng(), `capture frame ${n}`, pageFailed!)
        // The context can go after the frame was painted. The capture may then be a correctly sized blank map, and the
        // loss event may not have reached Node yet, so ask the page before trusting the PNG.
        if (await step(page!.contextLost(), `check frame ${n}`, pageFailed!)) {
          throw new Error(`Could not capture frame ${n}: the WebGL context was lost.`)
        }
      } catch (e) {
        if (signal?.aborted) throw e
        await recover(n, e)
        continue
      }
      // A wrong size is a bug, not a transient fault, so it fails the render without a recovery.
      checkPngSize(png, size, n)
      await writing
      if (!encoder) {
        const part = path.join(dir, `all.part${parts.length + 1}.${ext}`)
        parts.push(part)
        encoder = Encoder.start(ffmpegArgs({ codec, ...size, fps: snapshot.output.fps, out: part, h264Encoder }))
      }
      framesDone = n - fromFrame
      if (n > fromFrame) progress(framesDone)
      writing = encoder.write(png)
      // Rejections are awaited on the next frame; this stops them counting as unhandled until then.
      writing.catch(() => undefined)
      n++
    }
    await writing
    await encoder!.finish()
    framesDone = frames
    progress(framesDone)
    if (parts.length === 1) {
      await rename(parts[0]!, video)
    } else {
      await joinSegments({ parts, out: video, codec })
      await Promise.all(parts.map((part) => rm(part, { force: true })))
    }
    const renderFps = round2(elapsedFps())
    await writeFile(manifestFile, `${JSON.stringify(manifest({ renderFps }), null, 2)}\n`)
    return { dir, video, manifest: manifestFile, frames, renderFps, projectHash: hash }
  } catch (e) {
    if (!signal?.aborted) throw e
    encoder?.kill()
    await encoder?.finish().catch(() => undefined)
    await writeFile(manifestFile, `${JSON.stringify(manifest({ cancelled: true, framesDone }), null, 2)}\n`)
    throw new RenderCancelled()
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (encoder) {
      // A no-op after a clean finish. Otherwise wait until ffmpeg is gone.
      encoder.kill()
      await encoder.finish().catch(() => undefined)
    }
    await launched?.browser.close().catch(() => undefined)
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RenderCancelled()
}

function assertRenderable(project: Project): void {
  const { errors } = validateProject(project)
  if (errors.length === 0) return
  throw new RenderError(
    `The project has ${errors.length === 1 ? 'an error' : `${errors.length} errors`} that block a render:\n` +
      errors.map((e) => `- ${e.code}: ${e.message}`).join('\n'),
    errors.map((e) => e.fix ?? `Fix ${e.code}.`).join(' '),
    errors,
  )
}

/** Frames to render: `[floor(from·fps), ceil(to·fps))`, clamped to the clip. */
export function frameRange(
  range: { from: number; to: number } | undefined,
  totalFrames: number,
  fps: number,
): { fromFrame: number; toFrame: number } {
  if (!range) return { fromFrame: 0, toFrame: totalFrames }
  const { from, to } = range
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    throw new RenderError(
      `range { from: ${from}, to: ${to} } is not a valid range of seconds.`,
      'Pass range as { from, to } in seconds with to greater than from, or leave it out to render the whole clip.',
    )
  }
  const clamp = (frame: number) => Math.min(Math.max(frame, 0), totalFrames)
  // Rounding first stops float error from adding a frame, e.g. 0.28 × 25 = 7.000000000000001.
  const fromFrame = clamp(Math.floor(round6(from * fps)))
  const toFrame = clamp(Math.ceil(round6(to * fps)))
  if (toFrame <= fromFrame) {
    throw new RenderError(
      `range { from: ${from}, to: ${to} } has no frames in the ${(totalFrames / fps).toFixed(2)}-second clip.`,
      `Pick a range inside 0 to ${(totalFrames / fps).toFixed(2)} seconds, or leave it out to render the whole clip.`,
    )
  }
  return { fromFrame, toFrame }
}

const round2 = (n: number) => Math.round(n * 100) / 100
const round6 = (n: number) => Math.round(n * 1e6) / 1e6

async function checkDisk(folder: string, neededBytes: number): Promise<void> {
  const stats = await statfs(folder)
  const free = Number(stats.bavail) * Number(stats.bsize)
  if (free >= neededBytes) return
  const gb = (bytes: number) => (bytes / GB).toFixed(1)
  throw new RenderError(
    `Not enough disk space: the render needs about ${gb(neededBytes)} GB and ${gb(free)} GB is free.`,
    "Free up disk space, render a shorter range, or use codec: 'h264', which needs far less space.",
  )
}

/** Creates `renders/<YYYY-MM-DD-HHmmss>`, adding `-2`, `-3` and so on if that folder exists. */
async function makeRenderDir(folder: string, date: Date): Promise<string> {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  const parent = path.join(folder, RENDERS_DIR)
  await mkdir(parent, { recursive: true })
  for (let i = 1; ; i++) {
    const dir = path.join(parent, i === 1 ? stamp : `${stamp}-${i}`)
    try {
      await mkdir(dir)
      return dir
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
}

/**
 * Waits for `work`, which does `what` (e.g. "render frame 12"), and fails with an error naming it if `work` rejects,
 * `pageFailed` rejects or it takes over 60 s. A late rejection from `work` is ignored, since the step has already
 * failed by then.
 */
function step<T>(work: Promise<T>, what: string, pageFailed: Promise<never>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Could not ${what} within ${STEP_TIMEOUT_MS / 1000} s.`)), STEP_TIMEOUT_MS)
  })
  const named = Promise.race([work, pageFailed]).catch((e: unknown) => {
    throw new Error(`Could not ${what}: ${errorMessage(e)}`, { cause: e })
  })
  named.catch(() => undefined)
  return Promise.race([named, timeout]).finally(() => clearTimeout(timer))
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Checks the PNG's IHDR size against the output frame size. */
function checkPngSize(png: Buffer, size: { width: number; height: number }, frame: number): void {
  const valid = png.length >= 24 && png.subarray(0, 8).equals(PNG_SIGNATURE) && png.toString('latin1', 12, 16) === 'IHDR'
  if (!valid) throw new Error(`Frame ${frame} was not captured as a PNG.`)
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  if (width !== size.width || height !== size.height) {
    throw new Error(`Frame ${frame} was captured at ${width}×${height}, but the output is ${size.width}×${size.height}.`)
  }
}

/** Returns a function to call with the frames done so far, which reports progress with a rolling fps. */
function rollingProgress(totalFrames: number, onProgress: ((p: RenderProgress) => void) | undefined): (done: number) => void {
  const times: { done: number; at: number }[] = [{ done: 0, at: performance.now() }]
  return (done) => {
    times.push({ done, at: performance.now() })
    while (times.length > FPS_WINDOW + 1) times.shift()
    const first = times[0]!
    const last = times[times.length - 1]!
    const seconds = (last.at - first.at) / 1000
    const fps = seconds > 0 ? (last.done - first.done) / seconds : 0
    onProgress?.({
      frame: done,
      totalFrames,
      fps: round2(fps),
      etaSeconds: fps > 0 ? Math.round((totalFrames - done) / fps) : 0,
    })
  }
}

let version: string | undefined

/** The version in Mapper's package.json. */
function mapperVersion(): string {
  version ??= String((JSON.parse(readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')) as { version: unknown }).version)
  return version
}
