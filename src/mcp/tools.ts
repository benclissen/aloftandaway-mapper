import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  applyPatch,
  buildRoute,
  buildTimeline,
  formatTimecode,
  frameSize,
  LegModeSchema,
  MAP_CREDIT,
  OutputSchema,
  ProjectError,
  ProjectPatchSchema,
  resolveShots,
  setStops,
  StopInputSchema,
  unwrapLng,
  validateProject,
  zodIssues,
  type Issue,
  type Project,
  type Scene,
  type Shot,
} from '../core/index.js'
import { contactSheet, PreviewAtSchema, previewFrame } from '../render/preview.js'
import { cancelRender, renderStatus, startRenderJob, type RenderStatus } from '../render/jobs.js'
import type { RenderResult } from '../render/render.js'
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
function legLine(scene: Scene, i: number): string | undefined {
  const leg = scene.legs[i]!
  const parts: string[] = []
  if (leg.symbol) parts.push(`${leg.symbol} (${leg.mode})`)
  if (leg.via.length) parts.push(plural(leg.via.length, 'via point'))
  const sharp = leg.via.filter((v) => v.sharp).length
  if (sharp) parts.push(`${sharp} sharp`)
  if (!parts.length) return undefined
  return `Leg ${i + 1} ${scene.stops[i]?.name ?? ''} → ${scene.stops[i + 1]?.name ?? ''}: ${parts.join(', ')}`
}

/**
 * What every project-changing tool returns: the project, one entry per scene with its timeline and the camera's start
 * and end shots as rendered (fitted to the route where the scene has none), and what validation says.
 */
function projectResult(project: Project): ToolResult {
  const { width, height } = frameSize(project.output)
  const lines: string[] = []
  const scenes = project.scenes.map((scene) => {
    const route = buildRoute(scene)
    const timeline = buildTimeline(scene, project.output.fps, route)
    const shots = resolveShots(scene, project.output.aspect, route)
    const arrivals = timeline.arrivals.map((a) => ({
      stopId: a.stopId,
      name: scene.stops.find((s) => s.id === a.stopId)?.name ?? '',
      seconds: a.seconds,
      frame: a.frame,
    }))
    lines.push(
      `${project.name}: ${plural(scene.stops.length, 'stop')}, ${timeline.durationSeconds.toFixed(1)} s (${plural(timeline.totalFrames, 'frame')}), ${width}×${height}.`,
      ...(scene.stops.length
        ? scene.stops.map((s, i) => `${i + 1}. ${s.name} [${s.at[0]}, ${s.at[1]}] arrives ${formatTimecode(arrivals[i]!.frame, timeline.fps)}`)
        : ['No stops yet.']),
      ...scene.legs.flatMap((_, i) => legLine(scene, i) ?? []),
    )
    return {
      id: scene.id,
      name: scene.name,
      timeline: { durationSeconds: timeline.durationSeconds, totalFrames: timeline.totalFrames, arrivals },
      camera: { resolvedStart: wrapped(shots.start), resolvedEnd: wrapped(shots.end) },
    }
  })
  const validation = validateProject(project)
  const summary = [
    ...lines,
    validationLine(validation.errors, validation.warnings),
    ...issueLines('error', validation.errors),
    ...issueLines('warning', validation.warnings),
  ].join('\n')
  return { summary, data: { project, scenes, validation } }
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
  try {
    placement = (JSON.parse(await readFile(manifestPath, 'utf8')) as { creditPlacement?: unknown }).creditPlacement
  } catch {
    // The manifest is unreadable; say what to credit without saying where.
  }
  const where = placement === 'burned' ? ' (burned in)' : placement === 'description' ? ' (put it in the video description)' : ''
  return `Credit required: ${MAP_CREDIT}${where}`
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

async function statusSummary(status: RenderStatus): Promise<string> {
  switch (status.state) {
    case 'running': {
      const p = status.progress
      if (p) return `Frame ${p.frame} of ${p.totalFrames} · ${p.fps.toFixed(1)} fps · ${etaText(p.etaSeconds)}${p.layer ? ` · ${p.layer}` : ''}`
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
      return projectResult(await createProject(folder, name, output))
    },
  }),

  tool({
    name: 'get_project',
    description:
      'Read a project: name, output and credit, plus scenes. Stops, legs, look, camera and timing live in project.scenes[0]. The result also has scenes[0].timeline (arrival times) and scenes[0].camera (resolvedStart and resolvedEnd, the shots fitted to the route when none are stored), and validation. Positions are [lng, lat]. Read it before changing anything; the user may have edited in the studio. The folder must be absolute.',
    input: z.strictObject({ folder }),
    async run({ folder }) {
      return projectResult(await loadProject(folder))
    },
  }),

  tool({
    name: 'set_stops',
    description:
      "Set a project's stops in travel order. Each stop's 'at' is [lng, lat], longitude first. Replaces all stops unless replace is false, which appends. Makes one leg per pair, with legMode (default 'line'). A stop's 'symbol' is the transport for the leg leaving it, and sets that leg's usual mode when legMode is missing. The folder must be absolute.",
    input: z.strictObject({
      folder,
      stops: z.array(StopInputSchema),
      legMode: LegModeSchema.optional().describe("Mode of every new leg; a stop's own legMode wins"),
      replace: z.boolean().optional().describe('Default true; false appends to the existing stops'),
    }),
    async run({ folder, stops, legMode, replace }) {
      return projectResult(await mutateProject(folder, (project) => setStops(project, { stops, legMode, replace })))
    },
  }),

  tool({
    name: 'update_project',
    description:
      "Change a project, all or nothing. 'set' is a JSON Merge Patch over name, output and credit. 'sceneSet' is a JSON Merge Patch over the scene's name, timing, look and camera. 'ops' edits stops, legs and via points: insert_stop, update_stop, remove_stop, move_stop, update_leg, insert_via, update_via, remove_via. null removes a key. Setting a leg's symbol without a mode also sets that transport's usual mode. Coordinates are [lng, lat]. The folder must be absolute.",
    input: z.strictObject({ folder, ...ProjectPatchSchema.shape }),
    async run({ folder, set, sceneSet, ops }) {
      return projectResult(await mutateProject(folder, (project) => applyPatch(project, { set, sceneSet, ops })))
    },
  }),

  tool({
    name: 'validate_project',
    description:
      "Check a project for problems before you preview or render it. Errors block a render; warnings don't. Every issue says how to fix it. The folder must be absolute.",
    input: z.strictObject({ folder }),
    async run({ folder }) {
      const { errors, warnings } = validateProject(await loadProject(folder))
      const summary = [validationLine(errors, warnings), ...issueLines('error', errors), ...issueLines('warning', warnings)].join('\n')
      return { summary, data: { errors, warnings } }
    },
  }),

  tool({
    name: 'preview_frame',
    description:
      'Render one frame as a PNG to look at. Give "at" as exactly one of { seconds }, { frame } or { progress } (0 to 1). Width is 240 to 3840 px, default 960. The PNG is also saved under the project\'s .mapper/previews. The folder must be absolute.',
    input: z.strictObject({
      folder,
      at: PreviewAtSchema,
      width: z.number().int().min(240).max(3840).default(960),
    }),
    async run({ folder, at, width }) {
      const r = await previewFrame({ folder, at, width })
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
      'Render evenly spaced frames as one PNG grid, each with a timestamp. Use it to review the whole clip: framing, labels and stop timing. count is 2 to 25 (default 9); width is 640 to 3840 px (default 1920). The folder must be absolute.',
    input: z.strictObject({
      folder,
      count: z.number().int().min(2).max(25).default(9),
      width: z.number().int().min(640).max(3840).default(1920),
    }),
    async run({ folder, count, width }) {
      const r = await contactSheet({ folder, count, width })
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
