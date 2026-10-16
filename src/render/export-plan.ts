import {
  buildRoute, buildTimeline, fpsValue, ProjectError, resolveScene,
  type Project, type Scene, type SceneRef, type SeaPaths, type Stop, type Timeline,
} from '../core/index.js'
import type { Codec } from './encode.js'
import type { ExportMarker, ExportPlan, LayerRequest, MediaKind, PlannedJoin, PlannedScene, RenderPass } from './export-types.js'
import { RenderError } from './errors.js'

/** A file-safe slug of `value`, or `fallback` when nothing is left. */
export function slug(value: string, fallback = 'project'): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 80).replace(/-$/, '') || fallback
}

const ORDER: LayerRequest[] = ['map', 'route', 'signs', 'all', 'preview']

/**
 * The 0-based indexes of the scenes `scenes` picks, in film order. Without `scenes`, every scene. Throws a
 * `RenderError` for an empty list, an unknown scene or a scene picked twice.
 */
export function pickedSceneIndexes(project: Project, scenes?: SceneRef[]): number[] {
  if (!scenes) return project.scenes.map((_, index) => index)
  if (scenes.length === 0) {
    throw new RenderError('Pick at least one scene.', 'Leave scenes out to render every scene, or list scene ids or 1-based positions.')
  }
  const indexes = scenes.map(ref => {
    try {
      return resolveScene(project, ref).index
    } catch (error) {
      if (!(error instanceof ProjectError)) throw error
      const list = project.scenes.map((s, i) => `${i + 1} "${s.name}" (id ${s.id})`).join(', ')
      const named = typeof ref === 'number' ? String(ref) : `'${ref}'`
      throw new RenderError(`There is no scene ${named} to render.`, `Pick scenes by id or 1-based position. The scenes are ${list}.`)
    }
  })
  if (new Set(indexes).size !== indexes.length) {
    throw new RenderError('Each scene may be picked only once.', 'List each scene once, by id or by position.')
  }
  return indexes.sort((a, b) => a - b)
}

export function planExport(project: Project, args: {
  /** The project's resolved sea paths. They change the length of a sea leg, so the arrival frames. */
  seaPaths: SeaPaths
  layers?: LayerRequest[]
  /** Codec of the flattened `all` clip. Unset means H.264; isolated layers are always ProRes. */
  codec?: Codec
  /** Seconds on the timeline of the picked scenes back to back. */
  range?: { from: number; to: number }
  /** The scenes to render, by id or 1-based position. Unset means all of them. They are planned in film order. */
  scenes?: SceneRef[]
  /** Default true: the flattened clip is the scenes joined. false: one flattened clip per scene. */
  join?: boolean
}): ExportPlan {
  const layers = args.layers ?? ['all']
  const join = args.join ?? true
  const invalid = (message: string): never => {
    throw new RenderError(message, 'Request unique layers from map, route, signs, all or preview. The codec option applies only to the flattened all clip; all and preview cannot be combined.')
  }
  if (layers.length === 0) invalid('Request at least one layer.')
  if (layers.some(layer => !ORDER.includes(layer))) invalid('Unknown render layer.')
  if (new Set(layers).size !== layers.length) invalid('Each layer may be requested only once.')
  if (layers.includes('all') && layers.includes('preview')) invalid('Do not combine all and preview.')
  if (args.codec === 'h264' && !layers.includes('all') && layers.some(layer => layer === 'map' || layer === 'route' || layer === 'signs')) {
    invalid('Isolated layers are always ProRes, so the h264 codec only applies to the flattened clip.')
  }

  const picked = pickedSceneIndexes(project, args.scenes)
  if (args.range && !join && picked.length > 1) {
    throw new RenderError('A range needs one scene, or a joined render.', 'Pick one scene with scenes, or leave join on.')
  }

  // Each scene's route and timeline are built once here and carried in the plan.
  const planned = picked.map(index => planScene(project, project.scenes[index]!, index + 1, args.seaPaths))
  // The range is in seconds on the picked scenes back to back.
  const starts: number[] = []
  let total = 0
  for (const scene of planned) {
    starts.push(total)
    total += scene.totalFrames
  }
  const range = frameRange(args.range, total, fpsValue(project.output.fps))
  const kept = planned.flatMap((scene, i) => {
    const start = starts[i]!
    const from = Math.max(range.fromFrame, start)
    const to = Math.min(range.toFrame, start + scene.totalFrames)
    if (to <= from) return []
    return [{ scene: { ...scene, offsetFrame: join ? from - range.fromFrame : 0 }, fromFrame: from - start, toFrame: to - start }]
  })

  const parts = join && kept.length > 1
  const requests = ORDER.filter(layer => layers.includes(layer))
  const passes = kept.flatMap(({ scene, fromFrame, toFrame }) => requests.map((request): RenderPass => {
    const layer = request === 'preview' ? 'all' : request
    const kind = mediaKind(request, args.codec)
    const name = `${String(scene.position).padStart(2, '0')}-${scene.slug}`
    const ext = kind === 'h264' ? 'mp4' : 'mov'
    const path = layer !== 'all' ? `${name}/${request}.mov`
      : parts ? `${name}${request === 'preview' ? '-preview' : ''}.part.${ext}`
      : join ? (request === 'preview' ? 'preview.mp4' : `all.${ext}`)
      : `${name}${request === 'preview' ? '-preview' : ''}.${ext}`
    return { sceneId: scene.id, request, layer, kind, path, fromFrame, toFrame }
  }))
  const joins: PlannedJoin[] = !parts ? [] : requests.flatMap(request => {
    if (request !== 'all' && request !== 'preview') return []
    const kind = mediaKind(request, args.codec)
    const path = request === 'preview' ? 'preview.mp4' : `all.${kind === 'h264' ? 'mp4' : 'mov'}`
    return [{ request, path, kind, parts: passes.filter(pass => pass.request === request).map(pass => pass.path) }]
  })
  return {
    scenes: kept.map(k => k.scene),
    passes,
    fcpxml: ['map', 'route', 'signs'].every(layer => layers.includes(layer as LayerRequest)),
    join,
    joins,
  }
}

function mediaKind(request: LayerRequest, codec: Codec | undefined): MediaKind {
  return request === 'preview' || (request === 'all' && codec !== 'prores')
    ? 'h264' : request === 'route' || request === 'signs' ? 'prores-4444' : 'prores-hq'
}

function planScene(project: Project, scene: Scene, position: number, seaPaths: SeaPaths): PlannedScene {
  const timeline = buildTimeline(scene, project.output.fps, buildRoute(scene, seaPaths))
  return {
    id: scene.id, name: scene.name, position, slug: slug(scene.name, 'scene'), scene,
    totalFrames: timeline.totalFrames, arrivals: timeline.arrivals, offsetFrame: 0,
  }
}

export function sceneMarkers(stops: Stop[], arrivals: Timeline['arrivals'], range: {
  fromFrame: number; toFrame: number
}): ExportMarker[] {
  return arrivals.filter(arrival => arrival.frame >= range.fromFrame && arrival.frame < range.toFrame).map(arrival => {
    const stop = stops.find(stop => stop.id === arrival.stopId)
    if (!stop) throw new Error(`Arrival refers to unknown stop ${arrival.stopId}.`)
    const value = stop.label ?? (stop.day !== undefined ? `Day ${stop.day} · ${stop.name}` : stop.name)
    return { frame: arrival.frame - range.fromFrame, value }
  })
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

const round6 = (n: number) => Math.round(n * 1e6) / 1e6
