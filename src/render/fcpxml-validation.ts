import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { EnvironmentError } from '../server/errors.js'

const DEFAULT_APP = '/Applications/Final Cut Pro.app'
const RESOURCES = 'Contents/Frameworks/Interchange.framework'
const DTD_FILE = 'FCPXMLv1_11.dtd'

async function readable(file: string): Promise<boolean> {
  try {
    await access(file, constants.R_OK)
    return true
  } catch {
    return false
  }
}

/** The installed Final Cut Pro FCPXML 1.11 DTD, or undefined. Never falls back to another version. */
export async function findFcpxmlDtd(appPath: string = DEFAULT_APP): Promise<string | undefined> {
  for (const version of ['A', 'Current']) {
    const dtd = path.join(appPath, RESOURCES, 'Versions', version, 'Resources', DTD_FILE)
    if (await readable(dtd)) return dtd
  }
  return undefined
}

interface XmllintResult { error: (Error & { code?: unknown }) | null; stderr: string }

function xmllint(args: string[]): Promise<XmllintResult> {
  return new Promise((resolve) => {
    execFile('xmllint', args, { maxBuffer: 10 * 1024 * 1024 }, (error, _stdout, stderr) => {
      resolve({ error, stderr: String(stderr ?? '') })
    })
  })
}

function noXmllint(): EnvironmentError {
  return new EnvironmentError(
    'xmllint is not installed, so the FCPXML cannot be validated against the Final Cut Pro DTD.',
    'Install libxml2 (brew install libxml2) and add its bin directory to PATH, e.g. export PATH="$(brew --prefix libxml2)/bin:$PATH"',
  )
}

/**
 * Throws the same EnvironmentError validation would, before any rendering, when the FCPXML will be validated
 * (a DTD is installed, or `dtdPath` is given) but xmllint is missing.
 */
export async function assertCanValidateFcpxml(options: { dtdPath?: string; appPath?: string } = {}): Promise<void> {
  if (options.dtdPath === undefined && !(await findFcpxmlDtd(options.appPath))) return
  const { error } = await xmllint(['--version'])
  if (error?.code === 'ENOENT') throw noXmllint()
}

/**
 * Validates an FCPXML file against Apple's FCPXML 1.11 DTD from the installed Final Cut Pro.
 * `dtdPath` (tests) must exist; `appPath` (tests) replaces the default app location.
 * Returns 'skipped-no-fcp' when no DTD is installed. Throws on invalid XML, with xmllint's output.
 */
export async function validateFcpxml(
  file: string,
  options: { dtdPath?: string; appPath?: string } = {},
): Promise<'passed' | 'skipped-no-fcp'> {
  let dtd: string | undefined
  if (options.dtdPath !== undefined) {
    if (!(await readable(options.dtdPath))) throw new Error(`The FCPXML DTD is missing or unreadable: ${options.dtdPath}`)
    dtd = options.dtdPath
  } else {
    dtd = await findFcpxmlDtd(options.appPath)
    if (!dtd) return 'skipped-no-fcp'
  }
  // A file URL, not a path: xmllint cannot parse a DTD path with spaces ("Final Cut Pro.app").
  const { error, stderr } = await xmllint(['--nonet', '--noout', '--dtdvalid', pathToFileURL(dtd).href, file])
  if (!error) return 'passed'
  if (error.code === 'ENOENT') {
    throw noXmllint()
  }
  throw new Error(`FCPXML failed validation against ${path.basename(dtd)}:\n${stderr.trim() || error.message}`)
}
