import type { Output, Project, RenderLayer, Scene, Timeline } from '../core/index.js'

export type LayerRequest = RenderLayer | 'preview'
export type MediaKind = 'prores-hq' | 'prores-4444' | 'h264'

/** A scene to render, with its timeline's frame count and arrivals worked out once when the export is planned. */
export interface PlannedScene {
  id: string
  name: string
  /** 1-based position in the project's film order. File names start with it as two digits. */
  position: number
  /** `slug(name)`, or `scene` when the name has nothing to keep. */
  slug: string
  scene: Scene
  /** Frames in the scene's whole timeline, before any range is applied. */
  totalFrames: number
  arrivals: Timeline['arrivals']
  /** Where the scene's rendered frames start in the joined output. Always 0 when the scenes are not joined. */
  offsetFrame: number
}

export interface ExportMarker { frame: number; value: string }

export interface SceneExport {
  id: string
  name: string
  frames: number
  sourceRange: { fromFrame: number; toFrame: number }
  /** Absolute paths to completed layer media. */
  layers: { map: string; route: string; signs: string }
  /** Clip-local whole frames. */
  markers: ExportMarker[]
}

export interface RenderPass {
  sceneId: string
  /** What was asked for. `layer` is `all` for both the flattened clip and the preview; this tells them apart. */
  request: LayerRequest
  layer: RenderLayer
  kind: MediaKind
  /** Relative to the render directory. */
  path: string
  fromFrame: number
  toFrame: number
}

export interface CompletedPass extends RenderPass {
  frames: number
  segments: number
  recoveries: number
}

/** A flattened clip made by joining the scenes' parts, back to back with hard cuts. */
export interface PlannedJoin {
  request: 'all' | 'preview'
  /** Relative to the render directory. */
  path: string
  kind: MediaKind
  /** The parts' relative paths, in film order. */
  parts: string[]
}

export interface ExportPlan {
  /** The rendered scenes, in film order. */
  scenes: PlannedScene[]
  /** Scene by scene in film order, and within a scene in layer order. */
  passes: RenderPass[]
  fcpxml: boolean
  /** Whether the scenes were asked to be joined into one clip (the default). */
  join: boolean
  /** One per joined flattened request. Empty when only one scene is rendered or `join` is false. */
  joins: PlannedJoin[]
}

export interface FcpxmlInput {
  projectName: string
  output: Output
  credit: Project['credit']
  /** Every credit line the project's scenes need. Description placement joins them into each compound clip's note. */
  creditLines: string[]
  /** Whether to add a project that plays the scenes back to back. When false, the event holds only the compound clips. */
  join: boolean
  scenes: SceneExport[]
}
