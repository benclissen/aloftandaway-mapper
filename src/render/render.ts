import { readFileSync } from 'node:fs'
import { mkdir, statfs } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  fpsValue,
  frameSize,
  joinCredit,
  projectCredit,
  validateProject,
  type Project,
  type RenderLayer,
  type SeaPaths,
} from '../core/index.js'
import { resolveSeaPaths } from '../server/paths.js'
import { packageRoot } from '../server/server.js'
import { assertAbsolute, loadProject, projectHash } from '../server/store.js'
import { launchBrowser, type LaunchedBrowser } from './chrome.js'
import { assertCanValidateFcpxml } from './fcpxml-validation.js'
import { pickH264Encoder, type Codec } from './encode.js'
import { RenderError, RenderCancelled } from './errors.js'
import { planExport, sceneMarkers } from './export-plan.js'
import type { CompletedPass, LayerRequest, MediaKind, PlannedScene, RenderPass, SceneExport } from './export-types.js'
import { writeManifest, type ExportManifest } from './manifest.js'
import { publishFcpxml, type PublishedFcpxml } from './publish.js'
import { errorMessage, renderPass, throwIfAborted } from './render-pass.js'

/** Progress fps is averaged over this many frames. */
const FPS_WINDOW = 25
/**
 * Estimated bytes per pixel per frame, before the safety margin. Route and signs are the only ProRes 4444 layers, and
 * they are mostly transparent: the 4K acceptance outputs measured 0.016–0.028 B/px, far below Apple's nominal rate
 * (about 0.67 B/px at 4096×2160 24p). 0.2 leaves about seven times the busiest measured layer.
 */
const BYTES_PER_PIXEL: Record<MediaKind, number> = { 'prores-hq': 0.45, 'prores-4444': 0.2, h264: 0.03 }
const DISK_MARGIN = 1.5
const GB = 1e9
const RENDERS_DIR = 'renders'

export interface RenderProgress {
  /** Frames finished so far, counted over every layer of the export. */
  frame: number
  /** Frames in the range times the number of layers. */
  totalFrames: number
  /** Rolling average over the last 25 frames. */
  fps: number
  etaSeconds: number
  /** The scene and layer being rendered. */
  sceneId?: string
  layer?: RenderLayer
  /** Layers in the export. Absent or 1 for a single flattened clip. */
  layers?: number
}

/**
 * A finished layer as a result reports it: `path` is absolute. In a plan or manifest, `CompletedPass.path` is
 * relative to the render folder.
 */
export type CompletedOutput = Omit<CompletedPass, 'path'> & { path: string }

export interface RenderResult {
  /** The render folder, `<project>/renders/<YYYY-MM-DD-HHmmss>`. */
  dir: string
  /** The flattened clip, `all.mov` or `all.mp4`, when it was requested. */
  video?: string
  manifest: string
  /** Frames in the rendered range, not multiplied by the number of layers. */
  frames: number
  /** Clip frames per second: completed work frames ÷ number of passes ÷ elapsed seconds. */
  renderFps: number
  projectHash: string
  /** Every finished layer, in render order. */
  outputs: CompletedOutput[]
  /** Scenes whose map, route and signs layers all finished. */
  scenes: SceneExport[]
  fcpxml?: string
  /** How the FCPXML was checked: `skipped-no-fcp` when Final Cut Pro's DTD isn't installed. */
  fcpxmlValidation?: 'passed' | 'skipped-no-fcp'
  /** The H.264 preview, when it was requested. */
  preview?: string
}

export interface RenderArgs {
  folder: string
  /** Codec of the flattened `all` clip. Isolated layers are always ProRes. */
  codec?: Codec
  /** Layers to render. Defaults to `['all']`, the flattened clip. */
  layers?: LayerRequest[]
  /** Seconds into the clip. Frames `[floor(from·fps), ceil(to·fps))` are rendered, clamped to the clip. */
  range?: { from: number; to: number }
  onProgress?: (p: RenderProgress) => void
  /** Called once the render folder exists, before the first frame. */
  onStart?: (info: { dir: string }) => void
  /** Called after each layer is finished and recorded in the manifest. */
  onOutput?: (output: CompletedOutput) => void
  signal?: AbortSignal
  /** Test hook: loses the page's WebGL context the first time this frame is rendered. Only the first page gets it. */
  faultAtFrame?: number
  /** Test hook: loses the context just after this frame is painted, before it is captured. First page only. */
  faultAfterRenderFrame?: number
  /** Test hook: the layer whose first page gets the faults above. Defaults to the first layer rendered. */
  faultLayer?: RenderLayer
  /** Test hook: validates the FCPXML against this DTD instead of the installed Final Cut Pro one. */
  fcpxmlDtdPath?: string
}

export { RenderError, RenderCancelled } from './errors.js'
export { frameRange } from './export-plan.js'
export { joinParts } from './render-pass.js'

/**
 * Renders the project in `folder` to `renders/<YYYY-MM-DD-HHmmss>/`, one pass per requested layer, with a
 * `manifest.json`. With no `layers`, that is the flattened `all.mp4` (H.264, the default) or, with `codec: 'prores'`, `all.mov` (ProRes 422 HQ). Isolated
 * layers go to `01-<scene>/map.mov` (422 HQ), `route.mov` and `signs.mov` (4444 with alpha); `preview` is
 * `preview.mp4`. Every pass covers the same frames.
 *
 * The project is read once, so later edits don't affect a running render. Each pass recovers from page faults on its
 * own (see `renderPass`). Finished layers stay on disk and in the manifest when a later layer fails or the render
 * is cancelled.
 */
export async function renderProject(args: RenderArgs): Promise<RenderResult> {
  const { folder, signal } = args
  // Only the flattened clip has a codec choice; planExport sees the raw option so isolated layers aren't read as h264.
  const codec = args.codec ?? 'h264'
  assertAbsolute(folder)
  throwIfAborted(signal)

  const snapshot = await loadProject(folder)
  const hash = projectHash(snapshot)
  // Resolved once: validation, the plan and every page load share these paths, so the frame counts agree.
  const seaPaths = await resolveSeaPaths(folder, snapshot)
  assertRenderable(snapshot, seaPaths)
  const plan = planExport(snapshot, { seaPaths, layers: args.layers, codec: args.codec, range: args.range })
  const { fromFrame, toFrame } = plan.passes[0]!
  const frames = toFrame - fromFrame
  const size = frameSize(snapshot.output)
  const totalWork = plan.passes.reduce((sum, pass) => sum + pass.toFrame - pass.fromFrame, 0)
  if (plan.fcpxml) await assertCanValidateFcpxml({ dtdPath: args.fcpxmlDtdPath })
  await checkDisk(folder, plan.passes, size)
  const h264Encoder = plan.passes.some((pass) => pass.kind === 'h264') ? await pickH264Encoder() : undefined
  throwIfAborted(signal)

  const dir = await makeRenderDir(folder, new Date())
  const manifestFile = path.join(dir, 'manifest.json')
  /** The flattened clip alone: the manifest keeps the Stage 1 fields. */
  const legacy = args.layers === undefined || (args.layers.length === 1 && args.layers[0] === 'all')
  const faultPass = args.faultLayer ? plan.passes.find((pass) => pass.layer === args.faultLayer) : plan.passes[0]

  let launched: LaunchedBrowser | undefined
  const completed: CompletedPass[] = []
  let completedWork = 0
  let active: RenderPass | undefined
  let published: PublishedFcpxml | undefined
  let loopStart = performance.now()
  /** Clip frames per second: work frames over every pass, divided by the number of passes, per elapsed second. */
  const elapsedFps = () => completedWork / plan.passes.length / Math.max((performance.now() - loopStart) / 1000, 1e-9)
  /** Started with the first pass, so Chrome's launch doesn't count against the fps. */
  let progress: ReturnType<typeof rollingProgress> | undefined
  const layerCount = new Set(plan.passes.map((pass) => pass.layer)).size
  /** Reports `done` frames of work across the export, naming the active scene and layer. */
  const report = (done: number) => {
    completedWork = done
    progress?.(done, active && { sceneId: active.sceneId, layer: active.layer })
  }
  const makeManifest = (status: ExportManifest['status'], extra: Partial<ExportManifest> = {}): ExportManifest => ({
    manifestVersion: 2,
    mapperVersion: mapperVersion(),
    projectId: snapshot.id,
    projectHash: hash,
    name: snapshot.name,
    output: snapshot.output,
    frameSize: size,
    credit: joinCredit(projectCredit(snapshot, 'written')),
    creditPlacement: snapshot.credit,
    status,
    scenes: plan.scenes.map((scene) => ({ id: scene.id, name: scene.name, range: sceneRange(plan.passes, scene.id) })),
    outputs: completed.map((pass) => ({ ...pass })),
    totalFrames: frames,
    completedWorkFrames: completedWork,
    totalWorkFrames: totalWork,
    durationSeconds: frames / fpsValue(snapshot.output.fps),
    renderedAt: new Date().toISOString(),
    renderFps: round2(elapsedFps()),
    chrome: launched ? { channel: launched.channel, webgl: launched.webgl } : undefined,
    ...(legacy
      ? {
          codec,
          range: { fromFrame, toFrame },
          ...(completed[0] && { segments: completed[0].segments, recoveries: completed[0].recoveries }),
          ...(status === 'cancelled' && { cancelled: true, framesDone: completedWork }),
        }
      : {}),
    ...(published && { fcpxml: published.name, fcpxmlValidation: published.validation }),
    ...extra,
  })
  const absolute = (pass: CompletedPass): CompletedOutput => ({ ...pass, path: path.join(dir, pass.path) })

  await writeManifest(manifestFile, makeManifest('running'))
  args.onStart?.({ dir })

  // Cancelling is up to the active pass: it stops its ffmpeg and closes its page, and its pending step then rejects.
  // Chrome is closed in `finally`, once the pass has closed its page. Closing Chrome while a page's context is still
  // being closed can leave Chrome stuck in shutdown, and Playwright only kills it after 30 s.
  try {
    launched = await launchBrowser()
    throwIfAborted(signal)
    const { browser } = launched
    loopStart = performance.now()
    progress = rollingProgress(totalWork, args.onProgress, layerCount)
    for (const pass of plan.passes) {
      const scene = plan.scenes.find((s) => s.id === pass.sceneId)
      if (!scene) throw new Error(`Missing scene ${pass.sceneId}`)
      active = pass
      const base = completedWork
      const faults = pass === faultPass ? { faultAtFrame: args.faultAtFrame, faultAfterRenderFrame: args.faultAfterRenderFrame } : {}
      const done = await renderPass({ browser, project: snapshot, seaPaths, scene, pass, dir, signal, h264Encoder, ...faults, onFrame: (n) => report(base + n) })
      completed.push(done)
      completedWork = base + done.frames
      await writeManifest(manifestFile, makeManifest('running'))
      args.onOutput?.(absolute(done))
    }
    throwIfAborted(signal)
    const scenes = sceneExports(plan.scenes, completed, dir)
    if (plan.fcpxml) {
      published = await publishFcpxml({ dir, project: snapshot, scenes, signal, dtdPath: args.fcpxmlDtdPath })
    }
    const outputs = completed.map(absolute)
    const renderFps = round2(elapsedFps())
    await writeManifest(manifestFile, makeManifest('done', { renderFps }))
    const flattened = completed.find((pass) => pass.request === 'all')
    const preview = completed.find((pass) => pass.request === 'preview')
    return {
      dir,
      video: flattened && path.join(dir, flattened.path),
      manifest: manifestFile,
      frames,
      renderFps,
      projectHash: hash,
      outputs,
      scenes,
      fcpxml: published && path.join(dir, published.name),
      fcpxmlValidation: published?.validation,
      preview: preview && path.join(dir, preview.path),
    }
  } catch (e) {
    if (signal?.aborted) {
      await writeManifest(manifestFile, makeManifest('cancelled')).catch(() => undefined)
      throw new RenderCancelled()
    }
    await writeManifest(manifestFile, makeManifest('failed', { error: errorMessage(e) })).catch(() => undefined)
    throw e
  } finally {
    await launched?.browser.close().catch(() => undefined)
  }
}

/** The frames the scene's passes cover. Every pass of a scene shares one range. */
function sceneRange(passes: RenderPass[], sceneId: string): { fromFrame: number; toFrame: number } {
  const pass = passes.find((p) => p.sceneId === sceneId)!
  return { fromFrame: pass.fromFrame, toFrame: pass.toFrame }
}

/** Scenes whose map, route and signs layers all finished, with absolute media paths and clip-local markers. */
function sceneExports(scenes: PlannedScene[], completed: CompletedPass[], dir: string): SceneExport[] {
  return scenes.flatMap((scene) => {
    const layer = (name: RenderLayer) => completed.find((pass) => pass.sceneId === scene.id && pass.layer === name)
    const [map, route, signs] = [layer('map'), layer('route'), layer('signs')]
    if (!map || !route || !signs) return []
    const sourceRange = { fromFrame: map.fromFrame, toFrame: map.toFrame }
    return [{
      id: scene.id,
      name: scene.name,
      frames: map.frames,
      sourceRange,
      layers: { map: path.join(dir, map.path), route: path.join(dir, route.path), signs: path.join(dir, signs.path) },
      markers: sceneMarkers(scene.scene.stops, scene.arrivals, sourceRange),
    }]
  })
}

function assertRenderable(project: Project, seaPaths: SeaPaths): void {
  const { errors } = validateProject(project, { seaPaths })
  if (errors.length === 0) return
  throw new RenderError(
    `The project has ${errors.length === 1 ? 'an error' : `${errors.length} errors`} that block a render:\n` +
      errors.map((e) => `- ${e.code}: ${e.message}`).join('\n'),
    errors.map((e) => e.fix ?? `Fix ${e.code}.`).join(' '),
    errors,
  )
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Fails unless there is room for every output, plus the largest one again: joining segments writes a whole new
 * file before the segments are deleted.
 */
export function estimateDiskBytes(passes: RenderPass[], size: { width: number; height: number }): { bytes: number[]; neededBytes: number } {
  const bytes = passes.map(
    (pass) => (pass.toFrame - pass.fromFrame) * size.width * size.height * BYTES_PER_PIXEL[pass.kind] * DISK_MARGIN,
  )
  return { bytes, neededBytes: bytes.reduce((sum, b) => sum + b, 0) + Math.max(...bytes) }
}

async function checkDisk(folder: string, passes: RenderPass[], size: { width: number; height: number }): Promise<void> {
  const { neededBytes } = estimateDiskBytes(passes, size)
  const stats = await statfs(folder)
  const free = Number(stats.bavail) * Number(stats.bsize)
  if (free >= neededBytes) return
  const gb = (bytes: number) => (bytes / GB).toFixed(1)
  // H.264 has no alpha, so it is no substitute for the transparent layers. A pass that is already H.264 has no cheaper codec.
  const isolated = passes.some((pass) => pass.layer !== 'all')
  const hasProResClip = passes.some((pass) => pass.layer === 'all' && pass.kind !== 'h264')
  throw new RenderError(
    `Not enough disk space: the render needs about ${gb(neededBytes)} GB and ${gb(free)} GB is free.`,
    isolated || !hasProResClip
      ? 'Free up disk space, render a shorter range, or lower the output resolution.'
      : "Free up disk space, render a shorter range, lower the output resolution, or use codec: 'h264' (the default), which needs far less space.",
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
 * Returns a function to call with the frames done so far and the active scene and layer, which reports progress with
 * a rolling fps. When the active scene or layer changes, the window restarts from the new sample, so the page load
 * between passes doesn't skew the fps.
 */
export function rollingProgress(
  totalFrames: number,
  onProgress: ((p: RenderProgress) => void) | undefined,
  layers?: number,
): (done: number, active?: { sceneId: string; layer: RenderLayer }) => void {
  const times: { done: number; at: number }[] = [{ done: 0, at: performance.now() }]
  let lastPage: string | undefined
  return (done, active) => {
    const page = active && `${active.sceneId}\u0000${active.layer}`
    if (page !== undefined && lastPage !== undefined && page !== lastPage) times.splice(0)
    if (page !== undefined) lastPage = page
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
      ...(layers !== undefined && layers > 1 ? { layers } : {}),
      ...active,
    })
  }
}

let version: string | undefined

/** The version in Mapper's package.json. */
function mapperVersion(): string {
  version ??= String((JSON.parse(readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')) as { version: unknown }).version)
  return version
}
