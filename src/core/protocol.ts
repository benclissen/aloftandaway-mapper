import type { ProjectPatch } from './patch.js'
import type { Project } from './schema.js'

/** Messages the server sends to the studio. */
export type ServerMessage = { type: 'project'; project: Project }

/** A patch the studio sends to the server. */
export interface PatchRequest extends ProjectPatch {}
