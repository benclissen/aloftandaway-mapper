import { fpsValue, frameSize, joinCredit, projectCredit, type Output, type Project } from '../core/index.js'
import { writeFileAtomic } from '../server/atomic.js'
import type { Codec } from './encode.js'
import type { CompletedPass, ExportPlan, RenderPass } from './export-types.js'

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
  /** What the rendered scenes need credited, in the written form. */
  credit: string
  creditPlacement: Project['credit']
  status: 'running' | 'done' | 'cancelled' | 'failed'
  /**
   * The rendered scenes, in film order. `position` is the scene's 1-based place in the project, `offsetFrame` where
   * its frames start in the joined clip (0 when the scenes aren't joined) and `range` its own frames that were rendered.
   */
  scenes: { id: string; name: string; position: number; offsetFrame: number; range: { fromFrame: number; toFrame: number } }[]
  /** Whether the scenes were asked to be joined into one clip. */
  join: boolean
  /**
   * Finished outputs only, in render order. A failed or cancelled pass is never listed. A clip joined from the scenes'
   * parts has `sceneId: 'joined'` and replaces the parts, which are deleted.
   */
  outputs: CompletedPass[]
  /** Frames rendered: the sum of the scenes' ranges, not multiplied by the number of layers. */
  totalFrames: number
  completedWorkFrames: number
  totalWorkFrames: number
  durationSeconds: number
  renderedAt: string
  /** Clip frames per second, over every scene: completed work frames ÷ number of layers ÷ elapsed seconds. */
  renderFps: number
  chrome?: { channel: string; webgl: string }
  fcpxml?: string
  fcpxmlValidation?: 'passed' | 'skipped-no-fcp'
  /**
   * What may be wrong with the render without failing it, one line each, as the render result words them. Only
   * written when there are any; manifests from before warnings existed have none.
   */
  warnings?: string[]
  error?: string
  // Stage 1 fields, kept for renders of the flattened clip of one scene alone.
  codec?: Codec
  range?: { fromFrame: number; toFrame: number }
  segments?: number
  recoveries?: number
  cancelled?: boolean
  framesDone?: number
}

export interface ManifestInput {
  /** The project snapshot the render was planned from. */
  project: Project
  projectHash: string
  mapperVersion: string
  plan: ExportPlan
  /** Codec of the flattened clip. */
  codec: Codec
  /** Whether only the flattened clip was asked for. With one scene, the manifest then keeps the Stage 1 fields. */
  flattenedOnly: boolean
  status: ExportManifest['status']
  completed: CompletedPass[]
  completedWorkFrames: number
  renderFps: number
  renderedAt: string
  chrome?: { channel: string; webgl: string }
  fcpxml?: { name: string; validation: 'passed' | 'skipped-no-fcp' }
  /** The render's warnings so far. Left out of the manifest when empty. */
  warnings?: string[]
  error?: string
}

/** The manifest for a render in the state `input` describes. */
export function buildManifest(input: ManifestInput): ExportManifest {
  const { project, plan, completed, status } = input
  const scenes = plan.scenes.map((scene) => ({
    id: scene.id,
    name: scene.name,
    position: scene.position,
    offsetFrame: scene.offsetFrame,
    range: sceneRange(plan.passes, scene.id),
  }))
  const totalFrames = renderedFrames(plan)
  const legacy = input.flattenedOnly && scenes.length === 1
  return {
    manifestVersion: 2,
    mapperVersion: input.mapperVersion,
    projectId: project.id,
    projectHash: input.projectHash,
    name: project.name,
    output: project.output,
    frameSize: frameSize(project.output),
    credit: joinCredit(projectCredit({ scenes: plan.scenes.map((scene) => scene.scene) }, 'written')),
    creditPlacement: project.credit,
    status,
    scenes,
    join: plan.join,
    outputs: completed.map((pass) => ({ ...pass })),
    totalFrames,
    completedWorkFrames: input.completedWorkFrames,
    totalWorkFrames: plan.passes.reduce((sum, pass) => sum + pass.toFrame - pass.fromFrame, 0),
    durationSeconds: totalFrames / fpsValue(project.output.fps),
    renderedAt: input.renderedAt,
    renderFps: input.renderFps,
    chrome: input.chrome,
    ...(legacy
      ? {
          codec: input.codec,
          range: scenes[0]!.range,
          ...(completed[0] && { segments: completed[0].segments, recoveries: completed[0].recoveries }),
          ...(status === 'cancelled' && { cancelled: true, framesDone: input.completedWorkFrames }),
        }
      : {}),
    ...(input.fcpxml && { fcpxml: input.fcpxml.name, fcpxmlValidation: input.fcpxml.validation }),
    ...(input.warnings && input.warnings.length > 0 && { warnings: input.warnings }),
    ...(input.error !== undefined && { error: input.error }),
  }
}

/** The frames the scene's passes cover. Every pass of a scene shares one range. */
export function sceneRange(passes: RenderPass[], sceneId: string): { fromFrame: number; toFrame: number } {
  const pass = passes.find((p) => p.sceneId === sceneId)!
  return { fromFrame: pass.fromFrame, toFrame: pass.toFrame }
}

/** Frames the plan renders: the sum of its scenes' ranges, not multiplied by the number of layers. */
export function renderedFrames(plan: ExportPlan): number {
  return plan.scenes.reduce((sum, scene) => {
    const { fromFrame, toFrame } = sceneRange(plan.passes, scene.id)
    return sum + toFrame - fromFrame
  }, 0)
}

/**
 * Writes the manifest with `writeFileAtomic`, so a reader never sees half a manifest. If the write fails, the previous
 * manifest is left as it was.
 */
export async function writeManifest(file: string, value: ExportManifest): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}
