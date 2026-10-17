import { readFileSync } from 'node:fs'
import { mkdir, statfs } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  fpsValue,
  frameSize,
  sceneLabel,
  validateProject,
  type Fps,
  type Project,
  type RenderLayer,
  type SceneRef,
  type SeaPaths,
} from '../core/index.js'
import { resolveSeaPaths } from '../server/paths.js'
import { packageRoot } from '../server/server.js'
import { assertAbsolute, loadProject, projectHash } from '../server/store.js'
import { launchBrowser, type LaunchedBrowser } from './chrome.js'
import { assertCanValidateFcpxml } from './fcpxml-validation.js'
import { pickH264Encoder, type Codec, type H264Encoder } from './encode.js'
import { RenderError, RenderCancelled } from './errors.js'
import { pickedSceneIndexes, planExport, sceneMarkers } from './export-plan.js'
import type { CompletedPass, LayerRequest, MediaKind, PlannedJoin, PlannedScene, RenderPass, SceneExport } from './export-types.js'
import { buildManifest, renderedFrames, writeManifest, type ExportManifest } from './manifest.js'
import { publishFcpxml, type PublishedFcpxml } from './publish.js'
import { errorMessage, joinParts, MEDIA, removeParts, renderPass, throwIfAborted } from './render-pass.js'
import { describeWarnings, mergeWarnings, NO_WARNINGS, type RenderWarnings } from './warnings.js'

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
  /**
   * The flattened clip, when it was requested and there is one: `all.mov` or `all.mp4`, or the one scene's clip.
   * Absent when each of several scenes has its own file; `outputs` lists them.
   */
  video?: string
  manifest: string
  /** Frames rendered: the sum of the scenes' ranges, not multiplied by the number of layers. */
  frames: number
  /** The project's frame rate. */
  fps: Fps
  /** Clip frames per second, over every scene: completed work frames ÷ number of layers ÷ elapsed seconds. */
  renderFps: number
  projectHash: string
  /** Every finished layer, in render order. */
  outputs: CompletedOutput[]
  /** Scenes whose map, route and signs layers all finished. */
  scenes: SceneExport[]
  fcpxml?: string
  /** How the FCPXML was checked: `skipped-no-fcp` when Final Cut Pro's DTD isn't installed. */
  fcpxmlValidation?: 'passed' | 'skipped-no-fcp'
  /** The H.264 preview, when it was requested and there is one. */
  preview?: string
  /**
   * Where each rendered scene starts in the joined clip, in film order. `position` is the scene's 1-based place in the
   * project. Empty when the scenes were not joined.
   */
  sceneStarts: { id: string; name: string; position: number; seconds: number }[]
  /** What may be wrong with the render without failing it, one line each. Empty for a clean render. */
  warnings: string[]
}

export interface RenderArgs {
  folder: string
  /** Codec of the flattened `all` clip. Isolated layers are always ProRes. */
  codec?: Codec
  /** Layers to render. Defaults to `['all']`, the flattened clip. */
  layers?: LayerRequest[]
  /**
   * Seconds into the picked scenes back to back. Frames `[floor(from·fps), ceil(to·fps))` are rendered, clamped to
   * the clip. With `join: false`, only one scene may be picked.
   */
  range?: { from: number; to: number }
  /** Scenes to render, by id or 1-based position. Default all. They are always rendered in film order. */
  scenes?: SceneRef[]
  /** Default true: one flattened clip with the scenes back to back. false: one file per scene. */
  join?: boolean
  onProgress?: (p: RenderProgress) => void
  /** Called once the render folder exists, before the first frame. */
  onStart?: (info: { dir: string }) => void
  /**
   * Called after each output is finished and recorded in the manifest. A clip joined from the scenes' parts comes
   * last and replaces them; `addOutput` keeps a list in step.
   */
  onOutput?: (output: CompletedOutput) => void
  /** Called with every warning so far, as `RenderResult.warnings` words them, each time one is added. */
  onWarnings?: (warnings: string[]) => void
  signal?: AbortSignal
  /** Test hook: loses the page's WebGL context the first time this frame is rendered. Only the first page gets it. */
  faultAtFrame?: number
  /** Test hook: loses the context just after this frame is painted, before it is captured. First page only. */
  faultAfterRenderFrame?: number
  /** Test hook: the layer whose first page gets the faults above. Defaults to the first layer rendered. */
  faultLayer?: RenderLayer
  /** Test hook: every page of every pass reports this frame of its scene as unsettled. */
  forceUnsettledAt?: number
  /** Test hook: validates the FCPXML against this DTD instead of the installed Final Cut Pro one. */
  fcpxmlDtdPath?: string
  /** Test hook: the H.264 encoder to use instead of the one `pickH264Encoder` picks. */
  h264Encoder?: H264Encoder
  /** Test hook: deletes a joined part or segment, instead of `rm(path, { force: true })`. */
  removeFile?: (path: string) => Promise<void>
}

export { RenderError, RenderCancelled } from './errors.js'
export { frameRange } from './export-plan.js'
export { joinParts } from './render-pass.js'

/**
 * Renders the picked scenes (default all) of the project in `folder` to `renders/<YYYY-MM-DD-HHmmss>/`, one pass per
 * scene and requested layer, with a `manifest.json`. With no `layers`, that is the flattened clip: H.264 (the default)
 * or, with `codec: 'prores'`, ProRes 422 HQ. Isolated layers go to `<NN>-<scene>/map.mov` (422 HQ), `route.mov` and
 * `signs.mov` (4444 with alpha). Each scene's passes share its frame range; different scenes have different ranges.
 *
 * Joined (the default), the flattened clip is `all.mp4` (or `all.mov`) and the preview `preview.mp4`. With several
 * scenes, each is first rendered to `<NN>-<scene>.part.<ext>`, and the parts are joined without re-encoding once
 * every pass is done. The joined clip then replaces them in the manifest, and only after that are they deleted; a part
 * that can't be deleted is a warning, not a failure. With `join: false` each scene keeps its own `<NN>-<scene>.<ext>`.
 *
 * The project is read once, so later edits don't affect a running render. Each pass recovers from page faults on its
 * own (see `renderPass`). Finished outputs, scene parts included, stay on disk and in the manifest when a later pass
 * or a join fails or the render is cancelled.
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
  // Only the picked scenes have to be renderable.
  assertRenderable(snapshot, seaPaths, pickedSceneIndexes(snapshot, args.scenes))
  const plan = planExport(snapshot, {
    seaPaths, layers: args.layers, codec: args.codec, range: args.range, scenes: args.scenes, join: args.join,
  })
  const frames = renderedFrames(plan)
  const fps = fpsValue(snapshot.output.fps)
  const size = frameSize(snapshot.output)
  const totalWork = plan.passes.reduce((sum, pass) => sum + pass.toFrame - pass.fromFrame, 0)
  if (plan.fcpxml) await assertCanValidateFcpxml({ dtdPath: args.fcpxmlDtdPath })
  await checkDisk(folder, plan.passes, size, plan.joins)
  const h264Encoder = plan.passes.some((pass) => pass.kind === 'h264') ? (args.h264Encoder ?? (await pickH264Encoder())) : undefined
  throwIfAborted(signal)

  const dir = await makeRenderDir(folder, new Date())
  const manifestFile = path.join(dir, 'manifest.json')
  /** The flattened clip alone: with one scene, the manifest keeps the Stage 1 fields. */
  const flattenedOnly = args.layers === undefined || (args.layers.length === 1 && args.layers[0] === 'all')
  const faultPass = args.faultLayer ? plan.passes.find((pass) => pass.layer === args.faultLayer) : plan.passes[0]

  let launched: LaunchedBrowser | undefined
  const completed: CompletedPass[] = []
  let completedWork = 0
  let active: RenderPass | undefined
  let published: PublishedFcpxml | undefined
  let loopStart = performance.now()
  /** Every picked scene renders the same layers, so the passes are scenes × layers. */
  const layerCount = new Set(plan.passes.map((pass) => pass.layer)).size
  /** Clip frames per second over every scene: work frames divided by the number of layers, per elapsed second. */
  const elapsedFps = () => completedWork / layerCount / Math.max((performance.now() - loopStart) / 1000, 1e-9)
  /** Started with the first pass, so Chrome's launch doesn't count against the fps. */
  let progress: ReturnType<typeof rollingProgress> | undefined
  /** Reports `done` frames of work across the export, naming the active scene and layer. */
  const report = (done: number) => {
    completedWork = done
    progress?.(done, active && { sceneId: active.sceneId, layer: active.layer })
  }
  /** Warnings by scene id, since frame numbers are per scene. Those of no scene are under `undefined`. */
  const warnings = new Map<string | undefined, RenderWarnings>()
  /** On a project of several scenes, each scene's line starts with its label. */
  const label = (scene: PlannedScene) => (snapshot.scenes.length > 1 ? sceneLabel(snapshot, scene.position - 1) : undefined)
  const warningLines = () => [
    ...plan.scenes.flatMap((scene) => describeWarnings(warnings.get(scene.id) ?? NO_WARNINGS, label(scene))),
    ...describeWarnings(warnings.get(undefined) ?? NO_WARNINGS),
  ]
  /** Adds `found` to the render's warnings, under `sceneId` when its frames are a scene's. */
  const warn = (found: RenderWarnings, sceneId?: string) => {
    if (found.unsettled.length === 0 && found.other.length === 0) return
    warnings.set(sceneId, mergeWarnings(warnings.get(sceneId) ?? NO_WARNINGS, found))
    args.onWarnings?.(warningLines())
  }
  const makeManifest = (status: ExportManifest['status'], extra: { renderFps?: number; error?: string } = {}): ExportManifest =>
    buildManifest({
      project: snapshot,
      projectHash: hash,
      mapperVersion: mapperVersion(),
      plan,
      codec,
      flattenedOnly,
      status,
      completed,
      completedWorkFrames: completedWork,
      renderFps: extra.renderFps ?? round2(elapsedFps()),
      renderedAt: new Date().toISOString(),
      chrome: launched && { channel: launched.channel, webgl: launched.webgl },
      fcpxml: published,
      warnings: warningLines(),
      error: extra.error,
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
      const unsettled: number[] = []
      const other: string[] = []
      const done = await renderPass({
        browser, project: snapshot, seaPaths, scene, pass, dir, signal, h264Encoder, ...faults,
        forceUnsettledAt: args.forceUnsettledAt,
        removeFile: args.removeFile,
        onFrame: (n) => report(base + n),
        onUnsettled: (n) => unsettled.push(n),
        onWarning: (line) => other.push(line),
      })
      // Only a finished pass's frames count: a failed pass leaves no output for them to be in.
      warn({ unsettled, other }, scene.id)
      completed.push(done)
      completedWork = base + done.frames
      await writeManifest(manifestFile, makeManifest('running'))
      args.onOutput?.(absolute(done))
    }
    // The scene parts are joined only once every pass has finished. Until a join succeeds, its parts are the outputs.
    // The joined clip replaces them in the manifest before they are deleted, so the manifest never lists a deleted part.
    for (const join of plan.joins) {
      throwIfAborted(signal)
      const { joined, parts } = await joinScenes(dir, join, completed, signal)
      addOutput(completed, joined)
      await writeManifest(manifestFile, makeManifest('running'))
      args.onOutput?.(absolute(joined))
      const warning = await removeParts(parts, { dir, what: 'scene part', removeFile: args.removeFile })
      if (warning) warn({ unsettled: [], other: [warning] })
    }
    throwIfAborted(signal)
    const scenes = sceneExports(plan.scenes, completed, dir)
    if (plan.fcpxml) {
      // Only the rendered scenes, so the FCPXML credits what the render shows.
      const rendered = { ...snapshot, scenes: plan.scenes.map((scene) => scene.scene) }
      published = await publishFcpxml({ dir, project: rendered, scenes, join: plan.join, signal, dtdPath: args.fcpxmlDtdPath })
    }
    const outputs = completed.map(absolute)
    const renderFps = round2(elapsedFps())
    await writeManifest(manifestFile, makeManifest('done', { renderFps }))
    /** The one output of a request, if there is exactly one. */
    const only = (request: LayerRequest) => {
      const matches = outputs.filter((output) => output.request === request)
      return matches.length === 1 ? matches[0]!.path : undefined
    }
    return {
      dir,
      video: only('all'),
      manifest: manifestFile,
      frames,
      fps: snapshot.output.fps,
      renderFps,
      projectHash: hash,
      outputs,
      scenes,
      fcpxml: published && path.join(dir, published.name),
      fcpxmlValidation: published?.validation,
      preview: only('preview'),
      sceneStarts: plan.join
        ? plan.scenes.map((scene) => ({ id: scene.id, name: scene.name, position: scene.position, seconds: scene.offsetFrame / fps }))
        : [],
      warnings: warningLines(),
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

/**
 * Adds a finished output to `outputs`. A clip joined from the scenes' parts (`sceneId: 'joined'`) replaces the
 * outputs it was made from: every earlier one with its request.
 */
export function addOutput<T extends Pick<CompletedPass, 'sceneId' | 'request'>>(outputs: T[], output: T): void {
  if (output.sceneId === JOINED) {
    for (let i = outputs.length - 1; i >= 0; i--) if (outputs[i]!.request === output.request) outputs.splice(i, 1)
  }
  outputs.push(output)
}

/** The `sceneId` of a clip joined from the scenes' parts. */
const JOINED = 'joined'

/**
 * Joins the finished parts of `join` into its clip without re-encoding. Returns the joined clip, whose frames,
 * segments and recoveries are the parts' totals, and the parts' absolute paths for the caller to delete. If the join
 * fails or `signal` aborts it, the parts are kept, and a failure names them in the fix.
 */
async function joinScenes(
  dir: string,
  join: PlannedJoin,
  completed: CompletedPass[],
  signal: AbortSignal | undefined,
): Promise<{ joined: CompletedPass; parts: string[] }> {
  const parts = join.parts.map((part) => {
    const pass = completed.find((p) => p.path === part)
    if (!pass) throw new Error(`The part ${part} was not rendered.`)
    return pass
  })
  const files = parts.map((pass) => path.join(dir, pass.path))
  await joinParts({
    parts: files,
    out: path.join(dir, join.path),
    codec: MEDIA[join.kind].codec,
    kept: 'scene clips',
    signal,
  })
  const sum = (key: 'frames' | 'segments' | 'recoveries') => parts.reduce((total, pass) => total + pass[key], 0)
  const frames = sum('frames')
  const joined: CompletedPass = {
    sceneId: JOINED,
    request: join.request,
    layer: 'all',
    kind: join.kind,
    path: join.path,
    fromFrame: 0,
    toFrame: frames,
    frames,
    segments: sum('segments'),
    recoveries: sum('recoveries'),
  }
  return { joined, parts: files }
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
      position: scene.position,
      frames: map.frames,
      sourceRange,
      layers: { map: path.join(dir, map.path), route: path.join(dir, route.path), signs: path.join(dir, signs.path) },
      markers: sceneMarkers(scene.scene.stops, scene.arrivals, sourceRange),
    }]
  })
}

/**
 * Throws a `RenderError` listing the errors that block rendering the scenes at the 0-based indexes in `picked`. An
 * error in a scene that isn't picked doesn't block; one that isn't in a scene always does.
 */
export function assertRenderable(project: Project, seaPaths: SeaPaths, picked: number[]): void {
  const errors = validateProject(project, { seaPaths }).errors.filter(
    (e) => e.path?.[0] !== 'scenes' || picked.includes(e.path[1] as number),
  )
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
 * The bytes each pass needs, and the total the render needs: every pass, plus the largest extra copy a join makes.
 * Joining a pass's segments writes the whole pass again before the segments are deleted, and joining scene parts
 * writes all of that join's parts again. Joins run one at a time, so only the largest counts.
 */
export function estimateDiskBytes(
  passes: RenderPass[],
  size: { width: number; height: number },
  joins: PlannedJoin[] = [],
): { bytes: number[]; neededBytes: number } {
  const bytes = passes.map(
    (pass) => (pass.toFrame - pass.fromFrame) * size.width * size.height * BYTES_PER_PIXEL[pass.kind] * DISK_MARGIN,
  )
  const byPath = new Map(passes.map((pass, i) => [pass.path, bytes[i]!]))
  const joined = joins.map((join) => join.parts.reduce((sum, part) => sum + (byPath.get(part) ?? 0), 0))
  return { bytes, neededBytes: bytes.reduce((sum, b) => sum + b, 0) + Math.max(...bytes, ...joined) }
}

async function checkDisk(folder: string, passes: RenderPass[], size: { width: number; height: number }, joins: PlannedJoin[]): Promise<void> {
  const { neededBytes } = estimateDiskBytes(passes, size, joins)
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
