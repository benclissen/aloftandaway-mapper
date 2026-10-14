import { expect, test } from 'vitest'
import { doctorExitCode, formatChecks, runDoctor, type Probes } from '../../src/cli/doctor.js'

const ENCODERS = ' V....D prores_ks  Apple ProRes (iCodec Pro)\n V....D h264_videotoolbox  VideoToolbox H.264 Encoder\n V....D libx264  H.264'

const healthy = (): Probes => ({
  nodeVersion: () => '26.1.0',
  which: async (cmd) => `/usr/local/bin/${cmd}`,
  ffmpegEncoders: async () => ENCODERS,
  chrome: async () => ({ channel: 'chrome', webgl: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M6, Unspecified Version)' }),
  freeBytes: async () => 200e9,
  fcpxmlDtd: async () => '/Applications/Final Cut Pro.app/FCPXMLv1_11.dtd',
})

const find = (checks: Awaited<ReturnType<typeof runDoctor>>, name: string) => {
  const check = checks.find((c) => c.name === name)
  expect(check, `no check called ${name}`).toBeDefined()
  return check!
}

test('healthy machine: every check is ok and the exit code is 0', async () => {
  const checks = await runDoctor(healthy())
  expect(checks.map((c) => c.name)).toEqual(['Node', 'ffmpeg', 'ProRes encoder', 'H.264 encoder', 'Chrome', 'WebGL', 'Disk', 'FCPXML validation'])
  expect(checks.every((c) => c.ok)).toBe(true)
  expect(doctorExitCode(checks)).toBe(0)
  expect(formatChecks(checks)).toMatch(/All 8 checks passed/)
})

test('ffmpeg missing: error with the brew fix and exit code 1', async () => {
  const checks = await runDoctor({ ...healthy(), which: async (cmd) => (cmd === 'ffmpeg' ? null : `/bin/${cmd}`) })
  const ffmpeg = find(checks, 'ffmpeg')
  expect(ffmpeg).toMatchObject({ ok: false, level: 'error', fix: 'brew install ffmpeg' })
  expect(doctorExitCode(checks)).toBe(1)
  const text = formatChecks(checks)
  expect(text).toContain('✗ ffmpeg')
  expect(text).toContain('    Fix: brew install ffmpeg')
})

test('old Node is an error', async () => {
  const checks = await runDoctor({ ...healthy(), nodeVersion: () => '20.11.0' })
  expect(find(checks, 'Node')).toMatchObject({ ok: false, level: 'error', fix: 'Install Node 22 or newer: brew install node' })
  expect(doctorExitCode(checks)).toBe(1)
})

test('ffmpeg without prores_ks is an error', async () => {
  const checks = await runDoctor({ ...healthy(), ffmpegEncoders: async () => ' V....D libx264  H.264' })
  expect(find(checks, 'ProRes encoder')).toMatchObject({
    ok: false,
    level: 'error',
    fix: 'Install an ffmpeg build with prores_ks: brew reinstall ffmpeg',
  })
  expect(doctorExitCode(checks)).toBe(1)
})

test('no H.264 encoder is only a warning', async () => {
  const checks = await runDoctor({ ...healthy(), ffmpegEncoders: async () => ' V....D prores_ks  Apple ProRes' })
  expect(find(checks, 'H.264 encoder')).toMatchObject({
    ok: false,
    level: 'warn',
    fix: 'Install an ffmpeg build with h264_videotoolbox or libx264: brew reinstall ffmpeg',
  })
  expect(doctorExitCode(checks)).toBe(0)
})

test('libx264 alone is enough for H.264', async () => {
  const checks = await runDoctor({ ...healthy(), ffmpegEncoders: async () => ' V....D prores_ks  x\n V....D libx264  y' })
  expect(find(checks, 'H.264 encoder').ok).toBe(true)
})

test('no browser: Chrome is an error, and WebGL is not checked', async () => {
  const checks = await runDoctor({ ...healthy(), chrome: async () => null })
  expect(find(checks, 'Chrome')).toMatchObject({
    ok: false,
    level: 'error',
    fix: 'Install Google Chrome, or run: npx playwright install chromium',
  })
  expect(checks.find((c) => c.name === 'WebGL')).toBeUndefined()
  expect(doctorExitCode(checks)).toBe(1)
})

test('a probe that throws counts as a failed check, not a crash', async () => {
  const checks = await runDoctor({
    ...healthy(),
    chrome: async () => {
      throw new Error('boom')
    },
  })
  expect(find(checks, 'Chrome').ok).toBe(false)
})

test('software WebGL is a warning and the exit code stays 0', async () => {
  const checks = await runDoctor({ ...healthy(), chrome: async () => ({ channel: 'chrome', webgl: 'Google SwiftShader' }) })
  expect(find(checks, 'WebGL')).toMatchObject({
    ok: false,
    level: 'warn',
    fix: 'Chrome is rendering WebGL in software, so renders will be slow. Try 1080p.',
  })
  expect(doctorExitCode(checks)).toBe(0)
  expect(formatChecks(checks)).toContain('! WebGL')
})

test('low disk is a warning that names the cost of H.264, ProRes and layers', async () => {
  const checks = await runDoctor({ ...healthy(), freeBytes: async () => 10e9 })
  expect(find(checks, 'Disk')).toMatchObject({
    ok: false,
    level: 'warn',
    fix: expect.stringMatching(/H\.264.*ProRes.*4\.4 GB per minute/s),
  })
  expect(doctorExitCode(checks)).toBe(0)
})

test('the disk check measures the cache directory', async () => {
  const seen: string[] = []
  const previous = process.env.MAPPER_CACHE_DIR
  process.env.MAPPER_CACHE_DIR = '/tmp/some-cache'
  try {
    await runDoctor({ ...healthy(), freeBytes: async (dir) => (seen.push(dir), 200e9) })
  } finally {
    if (previous === undefined) delete process.env.MAPPER_CACHE_DIR
    else process.env.MAPPER_CACHE_DIR = previous
  }
  expect(seen).toEqual(['/tmp/some-cache'])
})

test('formatted output has no ANSI colour codes and ends with a summary line', async () => {
  const checks = await runDoctor({ ...healthy(), which: async () => null, chrome: async () => ({ channel: 'chromium', webgl: 'llvmpipe' }) })
  const text = formatChecks(checks)
  // eslint-disable-next-line no-control-regex
  expect(text).not.toMatch(/\u001b\[/)
  const lines = text.trimEnd().split('\n')
  expect(lines.at(-1)).toMatch(/^\d+ problems?/)
})

test('no Final Cut DTD is a warning that says validation will be skipped', async () => {
  const checks = await runDoctor({ ...healthy(), fcpxmlDtd: async () => undefined })
  const check = find(checks, 'FCPXML validation')
  expect(check).toMatchObject({ ok: false, level: 'warn' })
  expect(check.detail).toMatch(/skipped/)
  expect(check.detail).toContain('FCPXML 1.11 DTD (Final Cut Pro) not found')
  expect(doctorExitCode(checks)).toBe(0)
})

test('Final Cut DTD without xmllint is a warning with an install fix', async () => {
  const checks = await runDoctor({ ...healthy(), which: async (cmd) => (cmd === 'xmllint' ? null : `/bin/${cmd}`) })
  const check = find(checks, 'FCPXML validation')
  expect(check).toMatchObject({ ok: false, level: 'warn' })
  expect(check.fix).toMatch(/libxml2/)
  expect(doctorExitCode(checks)).toBe(0)
})

test('a throwing DTD probe is treated as no Final Cut', async () => {
  const checks = await runDoctor({ ...healthy(), fcpxmlDtd: async () => { throw new Error('boom') } })
  expect(find(checks, 'FCPXML validation').ok).toBe(false)
})
