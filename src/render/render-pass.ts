import { mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Browser } from 'playwright'
import {
  frameSize,
  outputScale,
  type Aspect,
  type Project,
  type RenderPageOptions,
  type SeaPaths,
} from '../core/index.js'
import { Encoder, ffmpegArgs, joinSegments, pickH264Encoder, type Codec, type H264Encoder, type ProresProfile } from './encode.js'
import { RenderCancelled, RenderError } from './errors.js'
import type { CompletedPass, MediaKind, PlannedScene, RenderPass } from './export-types.js'
import { RenderPage } from './page.js'

/** How long one `renderFrame` or `capturePng` may take before the pass fails. */
const STEP_TIMEOUT_MS = 60_000
/** How many times one pass may reopen the page and carry on. The next failure fails the render. */
const MAX_RECOVERIES = 3

/** The encoder settings for each kind of media. */
export const MEDIA: Record<MediaKind, { codec: Codec; proresProfile?: ProresProfile }> = {
  'prores-hq': { codec: 'prores', proresProfile: 'hq' },
  'prores-4444': { codec: 'prores', proresProfile: '4444' },
  h264: { codec: 'h264' },
}

/** The parts of `RenderPage` a pass uses. */
export interface PassPage {
  load(project: Project, pixelRatio: number, opts?: RenderPageOptions): Promise<number>
  renderFrame(n: number): Promise<void>
  capturePng(): Promise<Buffer>
  contextLost(): Promise<boolean>
  onCrash(cb: () => void): void
  /** Resolves once the page is closed, also when a close is already under way. */
  close(): Promise<void>
}

/** The parts of `Encoder` a pass uses. */
export interface PassEncoder {
  write(frame: Buffer): Promise<void>
  finish(): Promise<void>
  kill(): void
}

/** What a pass opens pages and encoders with. Tests swap these to inject failures. */
export interface PassDeps {
  openPage(args: { browser: Browser; aspect: Aspect }): Promise<PassPage>
  startEncoder(args: string[]): PassEncoder
}

const DEFAULT_DEPS: PassDeps = {
  openPage: (args) => RenderPage.open(args),
  startEncoder: (args) => Encoder.start(args),
}

export interface RenderPassArgs {
  browser: Browser
  /** The project snapshot the render was planned from. The page loads it and shows `scene`. */
  project: Project
  /** The sea paths the render was planned with. Every page loads them so its frame count matches the plan's. */
  seaPaths: SeaPaths
  scene: PlannedScene
  pass: RenderPass
  /** The render folder. `pass.path` is relative to it. */
  dir: string
  signal?: AbortSignal
  /** Called with the frames of this pass handed to the encoder so far, and with the pass's frame count at the end. */
  onFrame?: (completed: number) => void
  /** Test hook: loses the page's WebGL context the first time this frame is rendered. First page of the pass only. */
  faultAtFrame?: number
  /** Test hook: loses the context just after this frame is painted, before it is captured. First page only. */
  faultAfterRenderFrame?: number
  /** The H.264 encoder for an `h264` pass. Picked here when left out. */
  h264Encoder?: H264Encoder
}

/**
 * Renders one layer of one scene to `<dir>/<pass.path>`. The browser belongs to the caller; the pass opens and closes
 * its own pages.
 *
 * Frames are deterministic, so a pass survives a crashed page, a lost WebGL context or a stuck frame: it opens a
 * fresh page with the same scene and layer and carries on from the failed frame into a new segment
 * (`<layer>.part<k>.<ext>` beside the output), up to 3 times. The segments are joined without re-encoding at the end.
 * An ffmpeg failure is not a page fault and fails the pass at once. A failed pass leaves its segments behind.
 */
export async function renderPass(args: RenderPassArgs, deps: PassDeps = DEFAULT_DEPS): Promise<CompletedPass> {
  const { browser, project, seaPaths, scene, pass, dir, signal } = args
  throwIfAborted(signal)
  const { output } = project
  const size = frameSize(output)
  const { fromFrame, toFrame } = pass
  const frames = toFrame - fromFrame
  const media = MEDIA[pass.kind]
  const h264Encoder = media.codec === 'h264' ? (args.h264Encoder ?? (await pickH264Encoder())) : undefined
  const out = path.join(dir, pass.path)
  const ext = path.extname(out)
  const stem = out.slice(0, out.length - ext.length)
  await mkdir(path.dirname(out), { recursive: true })
  throwIfAborted(signal)

  /** The segment files written so far, in order. */
  const parts: string[] = []
  let recoveries = 0
  let encoder: PassEncoder | undefined
  let page: PassPage | undefined
  /** A page that is open but still loading. */
  let loading: PassPage | undefined
  /** Rejects when `page` crashes or loses its WebGL context, so a step fails at once instead of timing out. */
  let pageFailed: Promise<never> = new Promise<never>(() => undefined)

  // Cancelling stops ffmpeg and closes the page at once; the pending step then rejects. The caller closes the browser
  // only after this pass has settled, which is after the page has finished closing.
  const onAbort = () => {
    encoder?.kill()
    void page?.close().catch(() => undefined)
    void loading?.close().catch(() => undefined)
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  /** Opens a page, loads the scene's layer into it and arms `pageFailed`. */
  const openPage = async (faults: { faultAtFrame?: number; faultAfterRenderFrame?: number } = {}) => {
    const opened = await deps.openPage({ browser, aspect: output.aspect })
    loading = opened
    try {
      throwIfAborted(signal)
      const frameCount = await opened.load(project, outputScale(output), { layer: pass.layer, scene: scene.id, seaPaths, ...faults })
      if (frameCount !== scene.totalFrames) {
        throw new Error(`The render page counted ${frameCount} frames, but the timeline has ${scene.totalFrames}.`)
      }
    } catch (e) {
      await opened.close()
      throw e
    } finally {
      loading = undefined
    }
    const failed = new Promise<never>((_, reject) => {
      opened.onCrash(() => reject(new Error('the render page crashed or lost its WebGL context')))
    })
    failed.catch(() => undefined)
    page = opened
    pageFailed = failed
  }

  try {
    await openPage({ faultAtFrame: args.faultAtFrame, faultAfterRenderFrame: args.faultAfterRenderFrame })
    throwIfAborted(signal)

    // Frame n+1 renders and captures while frame n is written, so at most one frame waits in Node.
    let writing: Promise<void> = Promise.resolve()
    /**
     * Ends the current segment and opens a fresh page, after frame `n` failed because of `cause`. A new page also drops
     * any tiles that errored, which MapLibre never refetches. Fails the pass once the recoveries are used up.
     */
    const recover = async (n: number, cause: unknown) => {
      // The failed frame was never written. Finish the segment with every frame before it. An ffmpeg error here is
      // not a page fault, so it fails the pass.
      await writing
      await encoder?.finish()
      encoder = undefined
      await page!.close()
      page = undefined
      for (let lastCause = cause; ; ) {
        if (recoveries >= MAX_RECOVERIES) {
          throw new RenderError(
            `Frame ${n} of the ${pass.layer} layer failed ${MAX_RECOVERIES + 1} times, after ${MAX_RECOVERIES} recoveries. Last error: ${errorMessage(lastCause)}`,
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
        await step(page!.renderFrame(n), `render frame ${n}`, pageFailed)
        png = await step(page!.capturePng(), `capture frame ${n}`, pageFailed)
        // The context can go after the frame was painted. The capture may then be a correctly sized blank map, and the
        // loss event may not have reached Node yet, so ask the page before trusting the PNG.
        if (await step(page!.contextLost(), `check frame ${n}`, pageFailed)) {
          throw new Error(`Could not capture frame ${n}: the WebGL context was lost.`)
        }
      } catch (e) {
        if (signal?.aborted) throw e
        await recover(n, e)
        continue
      }
      // A wrong size is a bug, not a transient fault, so it fails the pass without a recovery.
      checkPngSize(png, size, n)
      await writing
      if (!encoder) {
        const part = `${stem}.part${parts.length + 1}${ext}`
        parts.push(part)
        encoder = deps.startEncoder(ffmpegArgs({ ...media, ...size, fps: output.fps, out: part, h264Encoder }))
      }
      if (n > fromFrame) args.onFrame?.(n - fromFrame)
      writing = encoder.write(png)
      // Rejections are awaited on the next frame; this stops them counting as unhandled until then.
      writing.catch(() => undefined)
      n++
    }
    await writing
    await encoder!.finish()
    encoder = undefined
    args.onFrame?.(frames)
    if (parts.length === 1) {
      await rename(parts[0]!, out)
    } else {
      await joinParts({ parts, out, codec: media.codec })
    }
    return { ...pass, frames, segments: parts.length, recoveries }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (encoder) {
      // Wait until ffmpeg is gone, so nothing still writes to the render folder.
      encoder.kill()
      await encoder.finish().catch(() => undefined)
    }
    await page?.close().catch(() => undefined)
  }
}

/**
 * Joins the parts into `out` and deletes them. The concat list sits beside `out`, named after it, so joins in the
 * same folder never share one. If the join fails, the parts are kept and named in the fix, as `kept` (default
 * "segments rendered so far").
 */
export async function joinParts(args: { parts: string[]; out: string; codec: Codec; kept?: string }): Promise<void> {
  const ext = path.extname(args.out)
  const list = `${args.out.slice(0, args.out.length - ext.length)}.concat.txt`
  try {
    await joinSegments({ parts: args.parts, out: args.out, codec: args.codec, list })
  } catch (e) {
    throw new RenderError(
      errorMessage(e),
      `Render again. The ${args.parts.length} ${args.kept ?? 'segments rendered so far'} are kept: ${args.parts.join(', ')}`,
    )
  }
  await Promise.all(args.parts.map((part) => rm(part, { force: true })))
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RenderCancelled()
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

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

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
