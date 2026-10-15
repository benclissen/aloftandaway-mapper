// Builds data/glyphs/<face>/<range>.pbf: SDF glyphs for MapLibre labels in Plus Jakarta Sans.
//
// Google Fonts ships Plus Jakarta Sans only as one variable TTF, so the two static weights are cut
// from it with fontTools' instancer, then turned into glyph PBFs by fontnik.
//
// Downloads are untrusted data. The font goes into a fresh temp folder and is only read as data by
// the instancer (run with `python -I`, from a different folder, in a throwaway venv) and fontnik.
// The venv and the instanced fonts live in their own temp folders, never next to the download.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import fontnik from 'fontnik'

/** google/fonts commit that the font and its licence come from. */
const FONTS_COMMIT = '1d0e46c7933245c8180fe83e47917961c913bbdb'
const BASE = `https://raw.githubusercontent.com/google/fonts/${FONTS_COMMIT}/ofl/plusjakartasans/`
const FONT_FILE = 'PlusJakartaSans[wght].ttf'
const LICENCE_FILE = 'OFL.txt'
/** Pinned so the instanced outlines don't change between rebuilds. */
const FONTTOOLS_VERSION = '4.67.0'

const FACES = [
  { name: 'Plus Jakarta Sans SemiBold', weight: 600 },
  { name: 'Plus Jakarta Sans Bold', weight: 700 },
]
/** Latin, Latin Extended, Vietnamese and general punctuation. The font has no Greek or Cyrillic, so those ranges are near empty. */
const RANGES: Array<[number, number]> = [
  [0, 255],
  [256, 511],
  [512, 767],
  [768, 1023],
  [1024, 1279],
  [7680, 7935],
  [8192, 8447],
  [8448, 8703],
]

const range = promisify(fontnik.range) as (opts: { font: Buffer; start: number; end: number }) => Promise<Buffer>

async function download(name: string, into: string): Promise<string> {
  const res = await fetch(BASE + encodeURIComponent(name))
  if (!res.ok) throw new Error(`download of ${name} failed: ${res.status}`)
  const file = path.join(into, name)
  await fs.writeFile(file, Buffer.from(await res.arrayBuffer()))
  return file
}

const root = path.join(import.meta.dirname, '..')
const downloads = await fs.mkdtemp(path.join(os.tmpdir(), 'mapper-glyphs-dl-'))
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'mapper-glyphs-work-'))
try {
  const fontFile = await download(FONT_FILE, downloads)
  const licenceFile = await download(LICENCE_FILE, downloads)

  const python = path.join(work, 'venv', 'bin', 'python')
  execFileSync('python3', ['-m', 'venv', path.join(work, 'venv')], { cwd: work, stdio: 'inherit' })
  execFileSync(python, ['-m', 'pip', 'install', '--quiet', `fonttools==${FONTTOOLS_VERSION}`], { cwd: work, stdio: 'inherit' })

  const outRoot = path.join(root, 'data', 'glyphs')
  await fs.rm(outRoot, { recursive: true, force: true })
  let total = 0
  for (const face of FACES) {
    const instanced = path.join(work, `${face.name}.ttf`)
    execFileSync(
      python,
      ['-I', '-m', 'fontTools.varLib.instancer', fontFile, `wght=${face.weight}`, '--update-name-table', '-o', instanced],
      { cwd: work, stdio: 'inherit' },
    )
    const font = await fs.readFile(instanced)
    const dir = path.join(outRoot, face.name)
    await fs.mkdir(dir, { recursive: true })
    for (const [start, end] of RANGES) {
      const pbf = await range({ font, start, end })
      await fs.writeFile(path.join(dir, `${start}-${end}.pbf`), pbf)
      total += pbf.length
    }
  }
  await fs.mkdir(path.join(root, 'data', 'LICENSES'), { recursive: true })
  await fs.copyFile(licenceFile, path.join(root, 'data', 'LICENSES', 'PlusJakartaSans-OFL.txt'))
  console.log(`Wrote ${FACES.length * RANGES.length} glyph files, ${(total / 1024).toFixed(0)} KiB.`)
} finally {
  await fs.rm(downloads, { recursive: true, force: true })
  await fs.rm(work, { recursive: true, force: true })
}
