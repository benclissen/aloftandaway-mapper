import type { ProjectPatch } from './patch.js'
import type { Project } from './schema.js'

/** How render mode's error for map data that failed to load begins. Node recognises it by this text. */
export const MAP_DATA_ERROR = 'The map could not load its data'

/** Messages the server sends to the studio. */
export type ServerMessage = { type: 'project'; project: Project }

/** A patch the studio sends to the server. */
export interface PatchRequest extends ProjectPatch {}

/** The visual content painted by a render page. */
export type RenderLayer = 'map' | 'route' | 'signs' | 'all'

export interface RenderPageOptions {
  layer?: RenderLayer
  faultAtFrame?: number
  faultAfterRenderFrame?: number
}
