import type { ProjectPatch } from './patch.js'
import type { Project } from './schema.js'

/** How render mode's error for map data that failed to load begins. Node recognises it by this text. */
export const MAP_DATA_ERROR = 'The map could not load its data'

/**
 * Messages the server sends to the studio. `origin` is the client id of the studio whose patch made this version, when
 * a studio made it; a version written any other way (the agent, the CLI) has none.
 */
export type ServerMessage = { type: 'project'; project: Project; origin?: string }

/** The server's answer to a patch: the saved project, and the `updatedAt` of the version the patch was applied to. */
export interface PatchResponse {
  project: Project
  previousUpdatedAt: string
}

/** The header a studio sends with each patch to name itself. */
export const CLIENT_HEADER = 'X-Mapper-Client'

/** What a client id must look like. The server ignores any other value. */
export const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** A patch the studio sends to the server. */
export interface PatchRequest extends ProjectPatch {}

/** The visual content painted by a render page. */
export type RenderLayer = 'map' | 'route' | 'signs' | 'all'

export interface RenderPageOptions {
  layer?: RenderLayer
  /** The id of the scene to show. The project's first scene when left out. */
  scene?: string
  faultAtFrame?: number
  faultAfterRenderFrame?: number
}
