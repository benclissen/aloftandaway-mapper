import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { FcpxmlInput, SceneExport } from '../../src/render/export-types.js'
import { writeFcpxml } from '../../src/render/fcpxml.js'
import { findFcpxmlDtd, validateFcpxml } from '../../src/render/fcpxml-validation.js'

const dtd = await findFcpxmlDtd()
let dir: string
beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'mapper-fcpxml-e2e-')) })
afterAll(() => rm(dir, { recursive: true, force: true }))

function scene(id: string, name: string, frames: number, d: string): SceneExport {
  return {
    id,
    name,
    frames,
    sourceRange: { fromFrame: 0, toFrame: frames },
    layers: { map: `${d}/map.mov`, route: `${d}/route.mov`, signs: `${d}/signs.mov` },
    markers: [{ frame: 0, value: `${name} start` }, { frame: 24, value: `${name} arrival` }],
  }
}

const input: FcpxmlInput = {
  projectName: 'Trip',
  output: { aspect: '16:9', height: 1080, fps: { num: 25, den: 1 } },
  credit: 'burned',
  scenes: [scene('a', 'Drive', 50, '/renders/trip/01-drive'), scene('b', 'Sail', 75, '/renders/trip/02-sail')],
}

describe.skipIf(!dtd)(dtd ? 'FCPXML vs installed Apple DTD' : 'skipped: Final Cut Pro FCPXMLv1_11.dtd is not installed', () => {
  test('a generated two-scene document validates', async () => {
    const file = path.join(dir, 'ok.fcpxml')
    await writeFile(file, writeFcpxml(input))
    expect(await validateFcpxml(file)).toBe('passed')
  })

  test('a DTD-invalid document is rejected with xmllint output', async () => {
    const file = path.join(dir, 'bad.fcpxml')
    await writeFile(file, writeFcpxml(input).replace('<resources>', '<resources><bogus/>'))
    await expect(validateFcpxml(file)).rejects.toThrow(/bogus/)
  })
})
