import { buildRoute, buildTimeline, fpsValue, type Project, type Stop, type Timeline } from '../core/index.js'
import type { Codec } from './encode.js'
import type { ExportMarker, ExportPlan, LayerRequest, SceneRenderInput } from './export-types.js'
import { RenderError } from './errors.js'

export function adaptV1Scene(p: Project): SceneRenderInput {
  return { id: p.id, name: p.name, output: p.output, credit: p.credit,
    content: { timing: p.timing, stops: p.stops, legs: p.legs, look: p.look, camera: p.camera } }
}

/** Temporary v1 browser boundary; metadata is fixed and is not render provenance. */
export function toPageProject(scene: SceneRenderInput): Project {
  return { schemaVersion: 1, id: scene.id, name: scene.name,
    createdAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z',
    output: scene.output, credit: scene.credit, ...scene.content }
}

export function slug(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 80).replace(/-$/, '') || 'project'
}

const ORDER: LayerRequest[] = ['map', 'route', 'signs', 'all', 'preview']

export function planExport(project: Project, args: {
  layers?: LayerRequest[]
  codec?: Codec
  range?: { from: number; to: number }
}): ExportPlan {
  const layers = args.layers ?? ['all']
  const invalid = (message: string): never => {
    throw new RenderError(message, 'Request unique layers from map, route, signs, all or preview. Isolated layers require ProRes; all and preview cannot be combined.')
  }
  if (layers.length === 0) invalid('Request at least one layer.')
  if (layers.some(layer => !ORDER.includes(layer))) invalid('Unknown render layer.')
  if (new Set(layers).size !== layers.length) invalid('Each layer may be requested only once.')
  if (layers.includes('all') && layers.includes('preview')) invalid('Do not combine all and preview.')
  if (args.codec === 'h264' && layers.some(layer => layer === 'map' || layer === 'route' || layer === 'signs')) {
    invalid('Isolated layers require ProRes.')
  }

  const scene = adaptV1Scene(project)
  const page = toPageProject(scene)
  const timeline = buildTimeline(page, buildRoute(page))
  const range = frameRange(args.range, timeline.totalFrames, fpsValue(scene.output.fps))
  const directory = `01-${slug(project.name)}`
  const passes = ORDER.filter(layer => layers.includes(layer)).map(request => {
    const layer = request === 'preview' ? 'all' : request
    const kind = request === 'preview' || (request === 'all' && args.codec === 'h264')
      ? 'h264' : request === 'route' || request === 'signs' ? 'prores-4444' : 'prores-hq'
    const path = request === 'preview' ? 'preview.mp4'
      : request === 'all' ? `all.${kind === 'h264' ? 'mp4' : 'mov'}` : `${directory}/${request}.mov`
    return { sceneId: scene.id, request, layer, kind, path, ...range } as const
  })
  return { scenes: [scene], passes, fcpxml: ['map', 'route', 'signs'].every(layer => layers.includes(layer as LayerRequest)) }
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
