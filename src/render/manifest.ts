import { randomUUID } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Output, Project } from '../core/index.js'
import type { Codec } from './encode.js'
import type { CompletedPass } from './export-types.js'

/**
 * `manifest.json` in a render folder. It is written before the first frame, after each finished layer and when the
 * render ends, so a cancelled or failed render still says which layers are complete. Output paths are relative to
 * the render folder.
 */
export interface ExportManifest {
  manifestVersion: 2
  mapperVersion: string
  projectId: string
  projectHash: string
  name: string
  output: Output
  frameSize: { width: number; height: number }
  credit: string
  creditPlacement: Project['credit']
  status: 'running' | 'done' | 'cancelled' | 'failed'
  scenes: { id: string; name: string; range: { fromFrame: number; toFrame: number } }[]
  /** Finished layers only, in render order. A failed or cancelled layer is never listed. */
  outputs: CompletedPass[]
  /** Frames in the rendered range, not multiplied by the number of layers. */
  totalFrames: number
  completedWorkFrames: number
  totalWorkFrames: number
  durationSeconds: number
  renderedAt: string
  renderFps: number
  chrome?: { channel: string; webgl: string }
  fcpxml?: string
  fcpxmlValidation?: 'passed' | 'skipped-no-fcp'
  error?: string
  // Stage 1 fields, kept for renders of the flattened clip alone.
  codec?: Codec
  range?: { fromFrame: number; toFrame: number }
  segments?: number
  recoveries?: number
  cancelled?: boolean
  framesDone?: number
}

/**
 * Writes the manifest to a temporary file beside `file`, then renames it into place, so a reader never sees half a
 * manifest. If either step fails the temporary file is removed and the previous manifest is left as it was.
 */
export async function writeManifest(file: string, value: ExportManifest): Promise<void> {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID().slice(0, 8)}.tmp`)
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`)
    await rename(temp, file)
  } catch (e) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw e
  }
}
