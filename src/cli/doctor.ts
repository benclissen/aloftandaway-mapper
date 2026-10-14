import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, statfs } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { launchBrowser } from '../render/chrome.js'
import { findFcpxmlDtd } from '../render/fcpxml-validation.js'

export interface Check {
  name: string
  ok: boolean
  /** How much a failure matters. Only a failed `error` makes `mapper doctor` exit 1. */
  level: 'error' | 'warn'
  detail: string
  /** What to do about it. Set when the check fails. */
  fix?: string
}

/** What `runDoctor` asks of the machine. Tests replace these. */
export interface Probes {
  nodeVersion(): string
  /** The full path of the command on PATH, or null. */
  which(cmd: string): Promise<string | null>
  /** The output of `ffmpeg -encoders`. */
  ffmpegEncoders(): Promise<string>
  /** Launches headless Chrome (or Playwright's Chromium) and reads the WebGL renderer. Null when neither launches. */
  chrome(): Promise<{ channel: 'chrome' | 'chromium'; webgl: string } | null>
  /** Free bytes on the volume that holds `dir`. Creates `dir` when it is missing. */
  freeBytes(dir: string): Promise<number>
  /** The installed Final Cut Pro FCPXML 1.11 DTD, or undefined. */
  fcpxmlDtd(): Promise<string | undefined>
}

const MIN_NODE_MAJOR = 22
const MIN_FREE_BYTES = 20e9
const GB = 1e9
const SOFTWARE_WEBGL = /SwiftShader|llvmpipe|software/i

/** The cache directory: tiles live under it. Same place `getServer` uses. */
function cacheDir(): string {
  return process.env.MAPPER_CACHE_DIR ?? path.join(os.homedir(), '.cache', 'mapper')
}

export const realProbes: Probes = {
  nodeVersion: () => process.versions.node,

  async which(cmd) {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!dir) continue
      const file = path.join(dir, cmd)
      try {
        await access(file, constants.X_OK)
        return file
      } catch {
        // Not in this directory.
      }
    }
    return null
  },

  async ffmpegEncoders() {
    const { stdout } = await promisify(execFile)('ffmpeg', ['-hide_banner', '-encoders'], { maxBuffer: 10 * 1024 * 1024 })
    return stdout
  },

  async chrome() {
    let launched: Awaited<ReturnType<typeof launchBrowser>>
    try {
      launched = await launchBrowser()
    } catch {
      return null
    }
    try {
      return { channel: launched.channel, webgl: launched.webgl }
    } finally {
      await launched.browser.close()
    }
  },

  async freeBytes(dir) {
    await mkdir(dir, { recursive: true })
    const stats = await statfs(dir)
    return Number(stats.bavail) * Number(stats.bsize)
  },

  fcpxmlDtd: () => findFcpxmlDtd(),
}

const gb = (bytes: number) => `${(bytes / GB).toFixed(1)} GB`

/** Runs a probe, turning a throw into `fallback` so one broken probe doesn't hide the other checks. */
async function attempt<T>(probe: () => Promise<T> | T, fallback: T): Promise<T> {
  try {
    return await probe()
  } catch {
    return fallback
  }
}

/** Checks the machine: Node, ffmpeg with ProRes, Chrome with GPU WebGL, and disk. */
export async function runDoctor(probes: Probes = realProbes): Promise<Check[]> {
  const checks: Check[] = []

  // Node
  const version = probes.nodeVersion()
  const major = Number.parseInt(version, 10)
  const nodeOk = major >= MIN_NODE_MAJOR
  checks.push({
    name: 'Node',
    ok: nodeOk,
    level: 'error',
    detail: nodeOk ? `v${version}` : `v${version} is too old; Mapper needs Node ${MIN_NODE_MAJOR} or newer`,
    ...(nodeOk ? {} : { fix: `Install Node ${MIN_NODE_MAJOR} or newer: brew install node` }),
  })

  // ffmpeg and its encoders
  const ffmpegPath = await attempt(() => probes.which('ffmpeg'), null)
  checks.push({
    name: 'ffmpeg',
    ok: ffmpegPath !== null,
    level: 'error',
    detail: ffmpegPath ?? 'not found on PATH',
    ...(ffmpegPath ? {} : { fix: 'brew install ffmpeg' }),
  })
  if (ffmpegPath) {
    const encoders = await attempt(() => probes.ffmpegEncoders(), null)
    const has = (name: string) => encoders !== null && new RegExp(`\\b${name}\\b`).test(encoders)
    const prores = has('prores_ks')
    checks.push({
      name: 'ProRes encoder',
      ok: prores,
      level: 'error',
      detail: prores ? 'prores_ks' : encoders === null ? 'could not list ffmpeg encoders' : 'prores_ks is missing from this ffmpeg',
      ...(prores ? {} : { fix: 'Install an ffmpeg build with prores_ks: brew reinstall ffmpeg' }),
    })
    const h264 = has('h264_videotoolbox') ? 'h264_videotoolbox' : has('libx264') ? 'libx264' : null
    checks.push({
      name: 'H.264 encoder',
      ok: h264 !== null,
      level: 'warn',
      detail: h264 ?? 'neither h264_videotoolbox nor libx264 is available',
      ...(h264 ? {} : { fix: 'Install an ffmpeg build with h264_videotoolbox or libx264: brew reinstall ffmpeg' }),
    })
  }

  // Chrome and WebGL
  const browser = await attempt(() => probes.chrome(), null)
  checks.push({
    name: 'Chrome',
    ok: browser !== null,
    level: 'error',
    detail: browser ? (browser.channel === 'chrome' ? 'Google Chrome launches' : "Playwright's Chromium launches (Chrome is not installed)") : 'neither Google Chrome nor Playwright Chromium launches',
    ...(browser ? {} : { fix: 'Install Google Chrome, or run: npx playwright install chromium' }),
  })
  if (browser) {
    if (browser.webgl === 'none') {
      checks.push({
        name: 'WebGL',
        ok: false,
        level: 'error',
        detail: 'headless Chrome has no WebGL',
        fix: 'Update Google Chrome, or run: npx playwright install chromium',
      })
    } else {
      const software = SOFTWARE_WEBGL.test(browser.webgl)
      checks.push({
        name: 'WebGL',
        ok: !software,
        level: 'warn',
        detail: browser.webgl,
        ...(software ? { fix: 'Chrome is rendering WebGL in software, so renders will be slow. Try 1080p.' } : {}),
      })
    }
  }

  // Disk
  const dir = cacheDir()
  const free = await attempt(() => probes.freeBytes(dir), null)
  const diskOk = free !== null && free >= MIN_FREE_BYTES
  checks.push({
    name: 'Disk',
    ok: diskOk,
    level: 'warn',
    detail: free === null ? `could not read free space for ${dir}` : `${gb(free)} free in ${dir}`,
    ...(diskOk ? {} : { fix: '4K ProRes needs about 8.5 GB per minute of video.' }),
  })

  // FCPXML validation: optional, since flattened rendering works without Final Cut.
  const dtd = await attempt(() => probes.fcpxmlDtd(), undefined)
  if (!dtd) {
    checks.push({
      name: 'FCPXML validation',
      ok: false,
      level: 'warn',
      detail: 'Final Cut Pro 1.11 DTD not found, so FCPXML validation will be skipped and exports will not be checked',
      fix: 'Install Final Cut Pro to validate FCPXML exports. Flattened rendering works without it.',
    })
  } else {
    const xmllintPath = await attempt(() => probes.which('xmllint'), null)
    checks.push({
      name: 'FCPXML validation',
      ok: xmllintPath !== null,
      level: 'warn',
      detail: xmllintPath ? `${path.basename(dtd)} and xmllint found` : 'xmllint not found on PATH, so FCPXML validation cannot run',
      ...(xmllintPath ? {} : { fix: 'Install libxml2 (brew install libxml2) and add its bin directory to PATH' }),
    })
  }

  return checks
}

/** 1 when any check at level `error` failed, otherwise 0. */
export function doctorExitCode(checks: Check[]): 0 | 1 {
  return checks.some((c) => !c.ok && c.level === 'error') ? 1 : 0
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** One line per check (✓, ✗ or !), an indented `Fix:` line under each failure, then a summary. Plain text, no colour. */
export function formatChecks(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length))
  const lines: string[] = []
  for (const c of checks) {
    const mark = c.ok ? '✓' : c.level === 'error' ? '✗' : '!'
    lines.push(`${mark} ${c.name.padEnd(width)}  ${c.detail}`)
    if (!c.ok && c.fix) lines.push(`    Fix: ${c.fix}`)
  }
  const problems = checks.filter((c) => !c.ok && c.level === 'error').length
  const warnings = checks.filter((c) => !c.ok && c.level === 'warn').length
  if (problems === 0 && warnings === 0) lines.push('', `All ${checks.length} checks passed.`)
  else lines.push('', `${plural(problems, 'problem')}, ${plural(warnings, 'warning')}.`)
  return lines.join('\n')
}
