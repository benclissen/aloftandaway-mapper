import type { Output, Project, RenderLayer, Scene } from '../core/index.js'

export type LayerRequest = RenderLayer | 'preview'
export type MediaKind = 'prores-hq' | 'prores-4444' | 'h264'

export interface SceneRenderInput {
  id: string
  name: string
  output: Output
  credit: Project['credit']
  scene: Scene
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

export interface ExportPlan {
  scenes: SceneRenderInput[]
  passes: RenderPass[]
  fcpxml: boolean
}

export interface FcpxmlInput {
  projectName: string
  output: Output
  credit: Project['credit']
  scenes: SceneExport[]
}
