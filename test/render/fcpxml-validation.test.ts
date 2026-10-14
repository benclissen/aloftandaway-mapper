import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

type Callback = (error: Error | null, stdout?: string, stderr?: string) => void
const execFileMock = vi.fn<(cmd: string, args: string[], opts: unknown, cb: Callback) => void>()
vi.mock('node:child_process', () => ({ execFile: (...a: [string, string[], unknown, Callback]) => execFileMock(...a) }))

const { assertCanValidateFcpxml, findFcpxmlDtd, validateFcpxml } = await import('../../src/render/fcpxml-validation.js')
const { EnvironmentError } = await import('../../src/server/errors.js')

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'mapper-fcpxml-validation-'))
  execFileMock.mockReset()
})
afterEach(() => rm(dir, { recursive: true, force: true }))

async function fakeApp(sub: string): Promise<{ app: string; dtd: string }> {
  const app = path.join(dir, 'Final Cut Pro.app')
  const dtd = path.join(app, 'Contents/Frameworks/Interchange.framework', sub, 'FCPXMLv1_11.dtd')
  await mkdir(path.dirname(dtd), { recursive: true })
  await writeFile(dtd, '<!-- fake -->')
  return { app, dtd }
}

test('findFcpxmlDtd: undefined when the app is missing', async () => {
  expect(await findFcpxmlDtd(path.join(dir, 'Nope.app'))).toBeUndefined()
})

test('findFcpxmlDtd: finds the v1.11 DTD under Versions/A, then Versions/Current', async () => {
  const a = await fakeApp('Versions/A/Resources')
  expect(await findFcpxmlDtd(a.app)).toBe(a.dtd)
  await rm(a.app, { recursive: true })
  const c = await fakeApp('Versions/Current/Resources')
  expect(await findFcpxmlDtd(c.app)).toBe(c.dtd)
})

test('findFcpxmlDtd: does not substitute another version', async () => {
  const app = path.join(dir, 'Final Cut Pro.app')
  const other = path.join(app, 'Contents/Frameworks/Interchange.framework/Versions/A/Resources/FCPXMLv1_14.dtd')
  await mkdir(path.dirname(other), { recursive: true })
  await writeFile(other, '')
  expect(await findFcpxmlDtd(app)).toBeUndefined()
})

test('validateFcpxml: skipped-no-fcp when no DTD is installed (no xmllint run)', async () => {
  expect(await validateFcpxml('/tmp/a.fcpxml', { appPath: path.join(dir, 'Nope.app') })).toBe('skipped-no-fcp')
  expect(execFileMock).not.toHaveBeenCalled()
})

test('validateFcpxml: passes a file URL (percent-encoded) to xmllint without a shell', async () => {
  const { dtd } = await fakeApp('Versions/A/Resources')
  execFileMock.mockImplementation((_c, _a, _o, cb) => cb(null, '', ''))
  expect(await validateFcpxml('/tmp/my file.fcpxml', { dtdPath: dtd })).toBe('passed')
  const [cmd, args] = execFileMock.mock.calls[0]!
  expect(cmd).toBe('xmllint')
  expect(args).toEqual(['--nonet', '--noout', '--dtdvalid', pathToFileURL(dtd).href, '/tmp/my file.fcpxml'])
  expect(args[3]).toContain('Final%20Cut%20Pro.app')
})

test('validateFcpxml: explicit missing dtdPath is an error', async () => {
  await expect(validateFcpxml('/tmp/a.fcpxml', { dtdPath: path.join(dir, 'missing.dtd') })).rejects.toThrow(/DTD/)
  expect(execFileMock).not.toHaveBeenCalled()
})

test('validateFcpxml: malformed or DTD-invalid XML throws with xmllint stderr', async () => {
  const { dtd } = await fakeApp('Versions/A/Resources')
  execFileMock.mockImplementation((_c, _a, _o, cb) =>
    cb(Object.assign(new Error('Command failed'), { code: 3 }), '', 'a.fcpxml:3: element bogus: validity error'),
  )
  await expect(validateFcpxml('/tmp/a.fcpxml', { dtdPath: dtd })).rejects.toThrow(/element bogus: validity error/)
})

test('validateFcpxml: missing xmllint is an EnvironmentError with a fix', async () => {
  const { dtd } = await fakeApp('Versions/A/Resources')
  execFileMock.mockImplementation((_c, _a, _o, cb) => cb(Object.assign(new Error('spawn xmllint ENOENT'), { code: 'ENOENT' })))
  const error = await validateFcpxml('/tmp/a.fcpxml', { dtdPath: dtd }).catch((e) => e)
  expect(error).toBeInstanceOf(EnvironmentError)
  expect(error.fix).toMatch(/libxml2/)
  expect(error.fix).toMatch(/PATH/)
})

test('assertCanValidateFcpxml: missing xmllint with a DTD installed is the same EnvironmentError', async () => {
  const { app } = await fakeApp('Versions/A/Resources')
  execFileMock.mockImplementation((_c, _a, _o, cb) => cb(Object.assign(new Error('spawn xmllint ENOENT'), { code: 'ENOENT' })))
  const error = await assertCanValidateFcpxml({ appPath: app }).catch((e) => e)
  expect(error).toBeInstanceOf(EnvironmentError)
  expect(error.fix).toMatch(/libxml2/)
})

test('assertCanValidateFcpxml: passes when xmllint exists, and does not look for it when no DTD is installed', async () => {
  const { app } = await fakeApp('Versions/A/Resources')
  execFileMock.mockImplementation((_c, _a, _o, cb) => cb(null, '', ''))
  await expect(assertCanValidateFcpxml({ appPath: app })).resolves.toBeUndefined()
  execFileMock.mockReset()
  await expect(assertCanValidateFcpxml({ appPath: path.join(dir, 'Nope.app') })).resolves.toBeUndefined()
  expect(execFileMock).not.toHaveBeenCalled()
})
