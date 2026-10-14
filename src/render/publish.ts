import { rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Project } from '../core/index.js'
import { RenderCancelled } from './errors.js'
import type { SceneExport } from './export-types.js'
import { slug } from './export-plan.js'
import { writeFcpxml } from './fcpxml.js'
import { validateFcpxml } from './fcpxml-validation.js'

export interface PublishedFcpxml {
  /** The file name in the render folder, `<project>.fcpxml`. */
  name: string
  validation: 'passed' | 'skipped-no-fcp'
}

/**
 * Writes the project's FCPXML to `<slug>.fcpxml.tmp`, validates it, then renames it to `<slug>.fcpxml`, so the final
 * name only ever holds a validated document. If validation fails the `.tmp` stays for diagnosis and the error
 * propagates. If `signal` aborts before the rename, the `.tmp` is removed and `RenderCancelled` is thrown.
 * `dtdPath` is a test hook that replaces the installed Final Cut Pro DTD.
 */
export async function publishFcpxml(args: {
  dir: string
  project: Pick<Project, 'name' | 'output' | 'credit'>
  scenes: SceneExport[]
  signal?: AbortSignal
  dtdPath?: string
}): Promise<PublishedFcpxml> {
  const { dir, project, scenes, signal } = args
  const name = `${slug(project.name)}.fcpxml`
  const final = path.join(dir, name)
  const temp = `${final}.tmp`
  await writeFile(temp, writeFcpxml({ projectName: project.name, output: project.output, credit: project.credit, scenes }), 'utf8')
  let validation: PublishedFcpxml['validation']
  try {
    validation = await validateFcpxml(temp, { dtdPath: args.dtdPath })
  } catch (e) {
    if (signal?.aborted) await rm(temp, { force: true }).catch(() => undefined)
    throw e
  }
  if (signal?.aborted) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw new RenderCancelled()
  }
  await rename(temp, final)
  return { name, validation }
}
