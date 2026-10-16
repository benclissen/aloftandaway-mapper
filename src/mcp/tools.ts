import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  applyPatch,
  buildRoute,
  buildTimeline,
  formatTimecode,
  frameSize,
  GpxError,
  gpxToStops,
  importGpx,
  LegModeSchema,
  MAP_CREDIT,
  OutputSchema,
  parseGpx,
  ProjectError,
  ProjectPatchSchema,
  resolveFollow,
  resolveScene,
  resolveShots,
  sceneLabel,
  SceneRefSchema,
  setStops,
  StopInputSchema,
  SymbolKindSchema,
  unwrapLng,
  validateProject,
  zodIssues,
  type Issue,
  type Project,
  type Route,
  type Scene,
  type SceneRef,
  type SeaPaths,
  type GpxImport,
  type Shot,
} from '../core/index.js'
import { contactSheet, PreviewAtSchema, previewFrame } from '../render/preview.js'
import { cancelRender, renderStatus, startRenderJob, type RenderStatus } from '../render/jobs.js'
import type { RenderResult } from '../render/render.js'
import { resolveSeaPaths } from '../server/paths.js'
import { fixOf } from '../server/errors.js'
import { getServer } from '../server/server.js'
import { assertAbsolute, createProject, loadProject, mutateProject } from '../server/store.js'

/** An error the agent can act on. `fix` says what to do next. */
export class ToolError extends Error {
  readonly fix: string

  constructor(message: string, fix: string) {
    super(message)
    this.name = 'ToolError'
    this.fix = fix
  }
}

export interface ToolResult {
  /** Short plain text for the agent to read. */
  summary: string
  /** Becomes the result's `structuredContent`, after `summary`. */
  data: Record<string, unknown>
  /** A PNG, returned as MCP image content. */
  image?: Buffer
}

export interface ToolDef<I extends z.ZodObject> {
  name: string
  description: string
  input: I
  run(input: z.infer<I>): Promise<ToolResult>
}

function tool<I extends z.ZodObject>(def: ToolDef<I>): ToolDef<I> {
  return def
}

// Results

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function issueLines(kind: 'error' | 'warning', issues: Issue[]): string[] {
  return issues.map((i) => `- ${kind} ${i.code}: ${i.message}${i.fix ? ` Fix: ${i.fix}` : ''}`)
}

function validationLine(errors: Issue[], warnings: Issue[]): string {
  return `${plural(errors.length, 'error')}, ${plural(warnings.length, 'warning')}`
}

/** `shot` with its longitude wrapped to ±180, as the schema stores it. Fitted shots can lie beyond 180. */
const wrapped = (shot: Shot): Shot => ({ ...shot, center: [unwrapLng(0, shot.center[0]), shot.center[1]] })

/** One line for a leg that has a transport or via points; nothing for a plain leg. */
function legLine(scene: Scene, i: number, route: Route): string | undefined {
  const leg = scene.legs[i]!
  const parts: string[] = []
  if (leg.symbol) parts.push(`${leg.symbol} (${leg.mode})`)
  if (leg.via.length) parts.push(plural(leg.via.length, 'via point'))
  const sharp = leg.via.filter((v) => v.sharp).length
  if (sharp) parts.push(`${sharp} sharp`)
  const drawn = route.legs[i]
  if (drawn?.drawnAs === 'air') parts.push('flight arc')
  else if (drawn?.sea) {
    const { status, reason, crossesLand } = drawn.sea
    if (status === 'fallback') parts.push(`sea route failed: ${reason ?? 'no route found'}`)
    else if (crossesLand) parts.push(`sea route crosses land near [${crossesLand[0].toFixed(4)}, ${crossesLand[1].toFixed(4)}]`)
    else parts.push('sea route')
  }
  if (!parts.length) return undefined
  return `Leg ${i + 1} ${scene.stops[i]?.name ?? ''} → ${scene.stops[i + 1]?.name ?? ''}: ${parts.join(', ')}`
}

/**
 * What every project-changing tool returns: the project, one entry per scene with its timeline and the camera's start
 * and end shots as rendered (fitted to the route where the scene has none), the follow settings in use when the camera
 * follows, and what validation says. With more than one scene, the summary opens with the joined length and heads each
 * scene's lines. `startSeconds` is where the scene starts in a join of every scene.
 */
function projectResult(project: Project, seaPaths: SeaPaths): ToolResult {
  const { width, height } = frameSize(project.output)
  const many = project.scenes.length > 1
  const blocks: string[][] = []
  let startSeconds = 0
  let totalFrames = 0
  const scenes = project.scenes.map((scene, index) => {
    const route = buildRoute(scene, seaPaths)
    const timeline = buildTimeline(scene, project.output.fps, route)
    const shots = resolveShots(scene, project.output.aspect, route)
    const arrivals = timeline.arrivals.map((a) => ({
      stopId: a.stopId,
      name: scene.stops.find((s) => s.id === a.stopId)?.name ?? '',
      seconds: a.seconds,
      frame: a.frame,
    }))
    blocks.push([
      ...(many ? [`${sceneLabel(project, index)} (id ${scene.id})`] : []),
      `${project.name}: ${plural(scene.stops.length, 'stop')}, ${timeline.durationSeconds.toFixed(1)} s (${plural(timeline.totalFrames, 'frame')}), ${width}×${height}.`,
      `Style: ${scene.look.theme}, terrain ${scene.look.terrain ? 'on' : 'off'}.`,
      ...(scene.stops.length
        ? scene.stops.map((s, i) => `${i + 1}. ${s.name} [${s.at[0]}, ${s.at[1]}] arrives ${formatTimecode(arrivals[i]!.frame, timeline.fps)}${s.sharp ? ' · sharp' : ''}`)
        : ['No stops yet.']),
      ...scene.legs.flatMap((_, i) => legLine(scene, i, route) ?? []),
    ])
    const entry = {
      id: scene.id,
      name: scene.name,
      position: index + 1,
      startSeconds,
      timeline: { durationSeconds: timeline.durationSeconds, totalFrames: timeline.totalFrames, arrivals },
      camera: {
        resolvedStart: wrapped(shots.start),
        resolvedEnd: wrapped(shots.end),
        ...(scene.camera.mode === 'follow' ? { resolvedFollow: resolveFollow(scene, project.output.aspect, route) } : {}),
      },
    }
    startSeconds += timeline.durationSeconds
    totalFrames += timeline.totalFrames
    return entry
  })
  const validation = validateProject(project, { seaPaths })
  const summary = [
    ...(many ? [`${project.name}: ${project.scenes.length} scenes, ${startSeconds.toFixed(1)} s joined (${plural(totalFrames, 'frame')}), ${width}×${height}.`] : []),
    ...blocks.flat(),
    validationLine(validation.errors, validation.warnings),
    ...issueLines('error', validation.errors),
    ...issueLines('warning', validation.warnings),
  ].join('\n')
  return { summary, data: { project, scenes, validation } }
}

/** `projectResult` for a project just read or written in `folder`, with its sea legs routed first. */
async function withPaths(folder: string, project: Project): Promise<ToolResult> {
  return projectResult(project, await resolveSeaPaths(folder, project))
}

/**
 * `withPaths` for a write that changed one scene. With more than one scene the summary opens with `Changed <scene>.`,
 * or with `lead` when it is given. `note` is a line of its own, after that one. `data.scene` names the scene, when it
 * is still in the project.
 */
async function withChange(folder: string, project: Project, sceneId: string, opts: { lead?: string; note?: string } = {}): Promise<ToolResult> {
  const result = await withPaths(folder, project)
  const index = project.scenes.findIndex((s) => s.id === sceneId)
  const head = project.scenes.length > 1 ? (opts.lead ?? (index >= 0 ? `Changed ${sceneLabel(project, index)}.` : undefined)) : undefined
  return {
    summary: [head, opts.note, result.summary].filter((line) => line !== undefined).join('\n'),
    data: { ...result.data, ...(index >= 0 ? { scene: { id: sceneId, position: index + 1 } } : {}) },
  }
}

/** `Scenes: 1 Drive, 2 Sail.` */
function scenesLine(project: Project): string {
  return `Scenes: ${project.scenes.map((s, i) => `${i + 1} ${s.name || 'Untitled'}`).join(', ')}.`
}

/** True for the ops that add, duplicate, remove, move or restore scenes, as opposed to editing a scene's stops. */
const isSceneOp = (op: { op: string }) => op.op.endsWith('_scene')

// GPX

const MAX_GPX_BYTES = 20 * 1024 * 1024

async function readGpxFile(file: string): Promise<string> {
  if (!path.isAbsolute(file)) {
    throw new ToolError(`The GPX path '${file}' is not absolute.`, 'Pass the full path to the file, starting with /.')
  }
  if (path.extname(file).toLowerCase() !== '.gpx') {
    throw new ToolError(`'${path.basename(file)}' does not end in .gpx.`, 'Choose a GPX file, whose name ends in .gpx.')
  }
  let size: number
  try {
    const info = await stat(file)
    if (!info.isFile()) throw new Error('not a file')
    size = info.size
  } catch {
    throw new ToolError(`There is no GPX file at ${file}.`, 'Check the path. It must be absolute and point to a file.')
  }
  if (size > MAX_GPX_BYTES) {
    throw new ToolError(
      `${path.basename(file)} is ${(size / 1024 / 1024).toFixed(1)} MB, more than the 20 MB limit.`,
      'Trim the track in your GPS app or route planner, then export it again.',
    )
  }
  try {
    return await readFile(file, 'utf8')
  } catch {
    throw new ToolError(`Could not read ${path.basename(file)}.`, 'Check that the file is readable.')
  }
}

function importLine(imported: GpxImport): string {
  const { line, stops, skipped } = imported
  const source = line ? `${line.kind}${line.name ? ` "${line.name}"` : ''}` : 'waypoints'
  const head = `Imported ${plural(stops.length, 'stop')} from ${source}`
  if (!skipped.length) return `${head}.`
  const list = skipped.map((s) => `${s.name}, ${s.km.toFixed(1)} km`).join('; ')
  return `${head}; skipped ${plural(skipped.length, 'waypoint')} more than 2 km from the track (${list}).`
}

// Errors

const BUG_FIX = 'This looks like a bug in Mapper. Run mapper doctor, then report it.'
const PREVIEW_AT_FIX = 'Give exactly one of { seconds }, { frame } or { progress }.'

function formatIssues(issues: { path: (string | number)[]; message: string }[]): string {
  return issues.map((i) => `${i.path.length ? i.path.join('.') : '(input)'}: ${i.message}`).join('\n')
}

/** The `Error: …` and `Fix: …` text for any failure. The CLI uses it for its own commands too. */
export function errorText(e: unknown, toolName: string): string {
  const text = (message: string, fix: string) => `Error: ${message}\nFix: ${fix}`
  if (e instanceof ProjectError) {
    return text(
      formatIssues(e.issues),
      'Change the listed fields and try again. Paths are relative to the project (for example output.fps).',
    )
  }
  if (e instanceof z.ZodError) {
    const issues = zodIssues(e)
    if (issues.some((i) => i.path[0] === 'at')) {
      const others = issues.filter((i) => i.path[0] !== 'at')
      return text(
        formatIssues([{ path: ['at'], message: 'expected exactly one of seconds, frame or progress' }, ...others]),
        PREVIEW_AT_FIX,
      )
    }
    return text(
      `Invalid input for ${toolName}:\n${formatIssues(issues)}`,
      'Change the listed fields and try again. Paths are relative to the tool input.',
    )
  }
  // StoreError, RenderError, EnvironmentError and ToolError all carry a fix.
  const fix = fixOf(e)
  if (fix !== undefined) return text((e as Error).message, fix)
  return text(e instanceof Error ? e.message : String(e), BUG_FIX)
}

function errorResult(e: unknown, toolName: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: errorText(e, toolName) }] }
}

function toCallToolResult({ summary, data, image }: ToolResult): CallToolResult {
  return {
    content: [
      { type: 'text', text: summary },
      ...(image ? [{ type: 'image' as const, data: image.toString('base64'), mimeType: 'image/png' }] : []),
    ],
    // Some clients show the model only structuredContent and drop the text, so the summary rides along.
    structuredContent: { summary, ...data },
  }
}

/** Parses the input, runs the tool and turns any failure into a tool error. Never throws. */
export async function callTool(def: ToolDef<z.ZodObject>, rawInput: unknown): Promise<CallToolResult> {
  try {
    const input = def.input.parse(rawInput ?? {}) as { folder?: unknown }
    if (typeof input.folder === 'string') assertAbsolute(input.folder)
    return toCallToolResult(await def.run(input))
  } catch (e) {
    return errorResult(e, def.name)
  }
}

// Inputs

const folder = z.string().describe('Absolute path of the project folder')
const jobId = z.string().describe('The jobId that render returned')
const sceneInput = SceneRefSchema.optional().describe('Scene id, or its 1-based position. Default: the first scene')

// Render

/** The layers a render can be asked for. Which combinations are allowed is up to `planExport`. */
export const LayersSchema = z
  .array(z.enum(['map', 'route', 'signs', 'all', 'preview']))
  .min(1)
  .refine((xs) => new Set(xs).size === xs.length, 'Each layer may be requested only once')

/** How long `render` waits for the job to start or fail before it reports the job as queued. */
const START_WAIT_MS = 10_000
const START_POLL_MS = 100

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function unknownJob(id: string): ToolError {
  return new ToolError(`No render job has the id '${id}'.`, 'Use the jobId that render returned. Job ids only last as long as this Mapper process.')
}

function statusOf(id: string): RenderStatus {
  try {
    return renderStatus(id)
  } catch {
    throw unknownJob(id)
  }
}

export function etaText(seconds: number): string {
  if (seconds < 60) return 'under a minute left'
  return `about ${Math.round(seconds / 60)} min left`
}

/** The reminder to credit the map, with where the render put it. */
export async function creditLine(manifestPath: string): Promise<string> {
  let placement: unknown
  let credit: unknown
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { creditPlacement?: unknown; credit?: unknown }
    placement = manifest.creditPlacement
    credit = manifest.credit
  } catch {
    // The manifest is unreadable; say what to credit without saying where.
  }
  // The manifest holds the credit for what the render showed; the base line is the safe fallback.
  const text = typeof credit === 'string' ? credit : MAP_CREDIT
  if (text === '') return 'No map credit is required for this render.'
  const where = placement === 'burned'
      ? ' (the short credit lines are burned into the picture; the full text still goes in the video description)' : placement === 'description' ? ' (put it in the video description)' : ''
  return `Credit required: ${text}${where}`
}


/** The finished render: every file it wrote, the folder and the required map credit. */
export async function doneSummary(r: RenderResult): Promise<string> {
  const layers = r.outputs.filter((o) => o.request !== 'all' && o.request !== 'preview')
  return [
    `Done. ${plural(r.frames, 'frame')} at ${r.renderFps.toFixed(1)} fps.`,
    ...(r.fcpxml
      ? [
          `FCPXML: ${r.fcpxml}`,
          r.fcpxmlValidation === 'passed'
            ? 'FCPXML validated against the Final Cut Pro DTD.'
            : 'FCPXML validation was skipped: Final Cut Pro is not installed, so the DTD is unavailable.',
        ]
      : []),
    ...(r.video ? [`Video: ${r.video}`] : []),
    ...layers.map((o) => `Layer ${o.layer}: ${o.path}`),
    ...(r.preview ? [`Preview: ${r.preview}`] : []),
    `Manifest: ${r.manifest}`,
    `Folder: ${r.dir}`,
    await creditLine(r.manifest),
  ].join('\n')
}

/** What a failed or cancelled render left behind. The CLI prints the same text. */
export async function leftover(status: Pick<RenderStatus, 'outputs' | 'dir'>): Promise<string[]> {
  const label = (o: NonNullable<RenderStatus['outputs']>[number]) => (o.request === 'preview' ? 'preview' : o.request === 'all' ? 'clip' : o.layer)
  return [
    ...(status.outputs?.length ? ['Finished outputs kept:', ...status.outputs.map((o) => `- ${label(o)}: ${o.path}`)] : ['No outputs were finished.']),
    ...(status.dir ? [`Folder: ${status.dir}`, await creditLine(path.join(status.dir, 'manifest.json'))] : []),
  ]
}

/** The one-line summary of a render job. */
export async function statusSummary(status: RenderStatus): Promise<string> {
  switch (status.state) {
    case 'running': {
      const p = status.progress
      if (p) {
        const all = p.layers && p.layers > 1 ? ' (all layers)' : ''
        return `Frame ${p.frame} of ${p.totalFrames}${all} · ${p.fps.toFixed(1)} fps · ${etaText(p.etaSeconds)}${p.layer ? ` · ${p.layer}` : ''}`
      }
      return status.dir ? 'Starting. The render folder exists; no frames yet.' : 'Queued behind another render. No frames yet.'
    }
    case 'done':
      return doneSummary(status.result!)
    case 'failed':
      return [`Failed. ${status.error ?? 'No error was recorded.'}\nFix: ${status.fix ?? BUG_FIX}`, ...(await leftover(status))].join('\n')
    case 'cancelled':
      return ['Cancelled.', ...(await leftover(status))].join('\n')
  }
}

async function statusResult(status: RenderStatus): Promise<ToolResult> {
  return { summary: await statusSummary(status), data: { ...status } }
}

// Tools

export const TOOLS: ToolDef<any>[] = [
  tool({
    name: 'create_project',
    description:
      'Start a new map-animation project. The folder must be an absolute path; it is created if missing, and must not hold a project yet. Defaults to 3840×2160, 25 fps, 16:9. Next, call set_stops.',
    input: z.strictObject({
      folder,
      name: z.string().describe('Project name'),
      output: OutputSchema.partial().optional().describe('Aspect, height (the short side) or fps'),
    }),
    async run({ folder, name, output }) {
      return withPaths(folder, await createProject(folder, name, output))
    },
  }),

  tool({
    name: 'get_project',
    description:
      'Read a project: name, output and credit, plus scenes. The scenes are in project.scenes, in film order; each has its own stops, legs, look, camera and timing. The result also has, per scene, position, startSeconds (its start in a join of every scene), timeline (arrival times) and camera (resolvedStart and resolvedEnd, the shots fitted to the route when none are stored; resolvedFollow when camera.mode is follow), and validation. Positions are [lng, lat]. Read it before changing anything; the user may have edited in the studio. The folder must be absolute.',
    input: z.strictObject({ folder }),
    async run({ folder }) {
      return withPaths(folder, await loadProject(folder))
    },
  }),

  tool({
    name: 'set_stops',
    description:
      "Set a project's stops in travel order. Each stop's 'at' is [lng, lat], longitude first. Replaces all stops unless replace is false, which appends. Makes one leg per pair, with legMode (default 'line'). A stop's 'symbol' is the transport for the leg leaving it, and sets that leg's usual mode when legMode is missing. scene picks the scene to change; it defaults to the first. The folder must be absolute.",
    input: z.strictObject({
      folder,
      scene: sceneInput,
      stops: z.array(StopInputSchema),
      legMode: LegModeSchema.optional().describe("Mode of every new leg; a stop's own legMode wins"),
      replace: z.boolean().optional().describe('Default true; false appends to the existing stops'),
    }),
    async run({ folder, scene: ref, stops, legMode, replace }) {
      const project = await mutateProject(folder, (p) => setStops(p, { scene: ref, stops, legMode, replace }))
      return withChange(folder, project, resolveScene(project, ref).scene.id)
    },
  }),

  tool({
    name: 'import_gpx',
    description:
      "Read a local GPX file into the scene's stops, replacing them. stops: 'ends' (default) makes a stop at the start and end of the track; 'waypoints' makes a stop of each named waypoint within 2 km of it. The track between stops becomes simplified via points. track picks a track or route by 1-based index or name. legMode (default 'line') and symbol set every leg. scene picks the scene to change; it defaults to the first. path and folder must be absolute.",
    input: z.strictObject({
      folder,
      scene: sceneInput,
      path: z.string().describe('Absolute path of a .gpx file, at most 20 MB'),
      track: z.union([z.number().int().min(1), z.string()]).optional().describe('Track or route, by 1-based index or name'),
      stops: z.enum(['waypoints', 'ends']).optional().describe("Default 'ends'"),
      legMode: LegModeSchema.optional().describe("Mode of every leg; default 'line'"),
      symbol: SymbolKindSchema.optional().describe('Symbol of every leg'),
    }),
    async run({ folder, scene: ref, path: file, track, stops, legMode, symbol }) {
      const text = await readGpxFile(file)
      let imported: GpxImport
      try {
        imported = gpxToStops(parseGpx(text), { track, stops })
      } catch (e) {
        if (e instanceof GpxError) throw new ToolError(e.message, e.fix)
        throw e
      }
      const project = await mutateProject(folder, (p) => importGpx(p, imported, { scene: ref, legMode, symbol }))
      const result = await withChange(folder, project, resolveScene(project, ref).scene.id, { note: importLine(imported) })
      return {
        summary: result.summary,
        data: { ...result.data, import: { line: imported.line, stops: imported.stops.length, skipped: imported.skipped } },
      }
    },
  }),

  tool({
    name: 'update_project',
    description:
      "Change a project, all or nothing. 'set' is a JSON Merge Patch over name, output and credit. scene picks the scene that sceneSet and the stop, leg and via ops change (an id, or a 1-based position; default the first). 'sceneSet' patches that scene's name, timing, look and camera; null removes a key. look.theme: aloftandaway, aloftandaway-warm, paper, light, dark, nautical, atlas, outdoor, satellite, monochrome, blank. look.terrain: true adds hill shading and 3D elevation. look.symbolStyle: badge, badge-line, icon. camera.follow fields are optional; follow.pitch is 0 to 60. 'ops' edits stops, legs and via points, and the scene list: add_scene { index?, name?, copyLookFrom? }, duplicate_scene { id }, remove_scene { id }, move_scene { id, index }. A leg symbol alone sets its usual mode. Coordinates are [lng, lat]. The folder must be absolute.",
    input: z.strictObject({ folder, ...ProjectPatchSchema.shape }),
    async run({ folder, set, scene: ref, sceneSet, ops }) {
      // The scene is found before the patch runs, so a scene op that moves it can't change which scene the result names.
      let target = ''
      const project = await mutateProject(folder, (p) => {
        target = resolveScene(p, ref).scene.id
        return applyPatch(p, { set, scene: ref, sceneSet, ops })
      })
      const editsScene = sceneSet !== undefined || (ops ?? []).some((op) => !isSceneOp(op))
      const listsScenes = !editsScene && (ops ?? []).length > 0
      if (!editsScene && !listsScenes) return withPaths(folder, project)
      return withChange(folder, project, target, { lead: listsScenes ? scenesLine(project) : undefined })
    },
  }),

  tool({
    name: 'validate_project',
    description:
      "Check a project for problems before you preview or render it. Errors block a render; warnings don't. Every issue says how to fix it. The folder must be absolute.",
    input: z.strictObject({ folder }),
    async run({ folder }) {
      const project = await loadProject(folder)
      const { errors, warnings } = validateProject(project, { seaPaths: await resolveSeaPaths(folder, project) })
      const summary = [validationLine(errors, warnings), ...issueLines('error', errors), ...issueLines('warning', warnings)].join('\n')
      return { summary, data: { errors, warnings } }
    },
  }),

  tool({
    name: 'preview_frame',
    description:
      'Render one frame as a PNG to look at. Give "at" as exactly one of { seconds }, { frame } or { progress } (0 to 1). Width is 240 to 3840 px, default 960. scene picks the scene to show; it defaults to the first. The PNG is also saved under the project\'s .mapper/previews. The folder must be absolute.',
    input: z.strictObject({
      folder,
      scene: sceneInput,
      at: PreviewAtSchema,
      width: z.number().int().min(240).max(3840).default(960),
    }),
    async run({ folder, scene: ref, at, width }) {
      const r = await previewFrame({ folder, at, width, scene: ref })
      return {
        summary: `Frame ${r.frame} at ${r.seconds.toFixed(2)} s, ${width} px wide. Saved to ${r.path}`,
        data: { path: r.path, frame: r.frame, seconds: r.seconds },
        image: r.png,
      }
    },
  }),

  tool({
    name: 'preview_contact_sheet',
    description:
      'Render evenly spaced frames as one PNG grid, each with a timestamp. Use it to review the whole clip: framing, labels and stop timing. count is 2 to 25 (default 9); width is 640 to 3840 px (default 1920); scene picks the scene to show (default the first). The folder must be absolute.',
    input: z.strictObject({
      folder,
      scene: sceneInput,
      count: z.number().int().min(2).max(25).default(9),
      width: z.number().int().min(640).max(3840).default(1920),
    }),
    async run({ folder, scene: ref, count, width }) {
      const r = await contactSheet({ folder, count, width, scene: ref })
      return {
        summary: `Contact sheet of ${r.frames.length} frames, ${width} px wide. Saved to ${r.path}`,
        data: { path: r.path, frames: r.frames },
        image: r.png,
      }
    },
  }),

  tool({
    name: 'open_studio',
    description:
      "Get a local link to the studio, where the user can scrub the preview, drag stops and set start and end shots. Give the link to the user. It doesn't open a browser. Edits there save to the project. The folder must be absolute.",
    input: z.strictObject({ folder }),
    async run({ folder }) {
      const server = await getServer()
      const url = server.studioUrl(await server.registerProject(folder))
      return { summary: `Studio is running at ${url}\nGive this link to the user; it works only on this computer.`, data: { url } }
    },
  }),

  tool({
    name: 'render',
    description:
      "Render the clip to video. The default is one flattened H.264 MP4 (all.mp4); codec: 'prores' makes a ProRes master. Optional range { from, to } in seconds. Look at a contact sheet before rendering. Returns a jobId; poll render_status. The folder must be absolute. For a layered Final Cut Pro export, pass layers ['map','route','signs'] (ProRes plus FCPXML).",
    input: z.strictObject({
      folder,
      codec: z.enum(['prores', 'h264']).optional().describe("Codec of the flattened clip: h264 (default) or prores. Isolated layers are always ProRes"),
      range: z.strictObject({ from: z.number().min(0), to: z.number().min(0) }).optional(),
      layers: LayersSchema.optional().describe("Any of map, route, signs, all (the flattened clip, default) or preview (H.264 check clip). All can't join preview; map, route and signs are always ProRes, so codec h264 needs all alongside them"),
    }),
    async run({ folder, codec, range, layers }) {
      const id = startRenderJob({ folder, codec, range, layers })
      const deadline = Date.now() + START_WAIT_MS
      for (;;) {
        const status = statusOf(id)
        if (status.state === 'failed') {
          throw new ToolError(status.error ?? 'The render failed.', status.fix ?? BUG_FIX)
        }
        if (status.state === 'cancelled') throw new ToolError('The render was cancelled.', 'Start it again with render.')
        if (status.dir) {
          return {
            summary: `Render started. Folder: ${status.dir}\nPoll render_status with jobId ${id}.`,
            data: { jobId: id, dir: status.dir },
          }
        }
        if (Date.now() >= deadline) {
          return {
            summary: `Render queued behind another render. Poll render_status with jobId ${id}.`,
            data: { jobId: id },
          }
        }
        await sleep(START_POLL_MS)
      }
    },
  }),

  tool({
    name: 'render_status',
    description:
      'Check a render job: frame progress, speed and time left; or, when done, the output paths and the map credit the video needs; or the error. Poll every few seconds. Put the credit in the video, as the result says.',
    input: z.strictObject({ jobId }),
    async run({ jobId }) {
      return statusResult(statusOf(jobId))
    },
  }),

  tool({
    name: 'cancel_render',
    description: 'Stop a running or queued render and return its final status. Safe to call on a job that has finished.',
    input: z.strictObject({ jobId }),
    async run({ jobId }) {
      statusOf(jobId)
      return statusResult(await cancelRender(jobId))
    },
  }),
]
