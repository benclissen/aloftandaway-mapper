import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MAP_CREDIT, frameSize, type Fps } from '../core/index.js'
import type { FcpxmlInput, SceneExport } from './export-types.js'

/** Exact FCPXML rational time for a whole number of frames, e.g. `1001/24000s`. */
export function frameTime(frames: number, fps: Fps): string {
  if (!Number.isSafeInteger(frames) || frames < 0 ||
      !Number.isSafeInteger(fps.num) || fps.num <= 0 ||
      !Number.isSafeInteger(fps.den) || fps.den <= 0) {
    throw new RangeError('Frame time requires nonnegative integer frames and positive integer fps.')
  }
  if (frames === 0) return '0s'
  const n = BigInt(frames) * BigInt(fps.den)
  const d = BigInt(fps.num)
  let a = n, b = d
  while (b !== 0n) { const r = a % b; a = b; b = r }
  return d / a === 1n ? `${n / a}s` : `${n / a}/${d / a}s`
}

const LAYERS = [
  { key: 'map', name: 'Map', role: 'Map.Base' },
  { key: 'route', name: 'Route', role: 'Map.Route' },
  { key: 'signs', name: 'Signs', role: 'Map.Signs' },
] as const

/** The XML 1.0 `Char` production. Lone surrogates fall outside it. */
function isXmlChar(cp: number): boolean {
  return cp === 0x9 || cp === 0xa || cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
}

/** Drop characters XML 1.0 forbids, keeping every valid code point. */
function clean(text: string): string {
  let out = ''
  for (const ch of text) if (isXmlChar(ch.codePointAt(0)!)) out += ch
  return out
}

function escapeText(text: string): string {
  return clean(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(text: string): string {
  return escapeText(text)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;')
}

function attrs(values: Record<string, string | number | undefined>): string {
  return Object.entries(values)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`)
    .join('')
}

function isFrameCount(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0
}

function validate(input: FcpxmlInput): void {
  frameTime(1, input.output.fps)
  if (input.scenes.length === 0) throw new Error('FCPXML needs at least one scene export.')
  const ids = new Set<string>()
  let total = 0
  for (const scene of input.scenes) {
    const label = `Scene export ${JSON.stringify(scene.id)}`
    if (!scene.id) throw new Error('Scene export has an empty id.')
    if (ids.has(scene.id)) throw new Error(`${label} appears more than once.`)
    ids.add(scene.id)
    if (!isFrameCount(scene.frames) || scene.frames === 0) {
      throw new Error(`${label} has ${scene.frames} frames; it needs a positive whole number.`)
    }
    const { fromFrame, toFrame } = scene.sourceRange
    if (!isFrameCount(fromFrame) || !isFrameCount(toFrame) || toFrame - fromFrame !== scene.frames) {
      throw new Error(`${label} source range ${fromFrame}–${toFrame} does not span its ${scene.frames} frames.`)
    }
    for (const { key } of LAYERS) {
      const path = scene.layers[key]
      if (typeof path !== 'string' || !path || !isAbsolute(path)) {
        throw new Error(`${label} ${key} layer path ${JSON.stringify(path)} is not absolute.`)
      }
    }
    for (const marker of scene.markers) {
      if (!Number.isInteger(marker.frame) || marker.frame < 0 || marker.frame >= scene.frames) {
        throw new Error(`${label} marker at frame ${marker.frame} is outside [0, ${scene.frames}).`)
      }
    }
    total += scene.frames
    if (!Number.isSafeInteger(total)) throw new Error('Joined scene exports are too long.')
  }
}

interface SceneIds { media: string; assets: Record<'map' | 'route' | 'signs', string> }

/** Serialize completed scene exports as an FCPXML 1.11 document with one compound clip per scene. */
export function writeFcpxml(input: FcpxmlInput): string {
  validate(input)
  const { fps } = input.output
  const t = (frames: number) => frameTime(frames, fps)
  const { width, height } = frameSize(input.output)

  let next = 1
  const id = () => `r${next++}`
  const formatId = id()
  const sceneIds: SceneIds[] = input.scenes.map(() => {
    const assets = { map: id(), route: id(), signs: id() }
    return { assets, media: id() }
  })
  const compoundName = (scene: SceneExport) => `${input.projectName} · ${scene.name}`

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    '<fcpxml version="1.11">',
    '  <resources>',
    `    <format${attrs({ id: formatId, width, height, frameDuration: t(1), colorSpace: '1-1-1 (Rec. 709)' })}/>`,
  ]

  input.scenes.forEach((scene, i) => {
    const ids = sceneIds[i]
    const duration = t(scene.frames)
    for (const layer of LAYERS) {
      lines.push(
        `    <asset${attrs({ id: ids.assets[layer.key], name: layer.name, start: '0s', duration, hasVideo: 1, hasAudio: 0, format: formatId })}>`,
        `      <media-rep${attrs({ kind: 'original-media', src: pathToFileURL(scene.layers[layer.key]).href })}/>`,
        '    </asset>',
      )
    }
    lines.push(
      `    <media${attrs({ id: ids.media, name: compoundName(scene) })}>`,
      `      <sequence${attrs({ format: formatId, duration, tcStart: '0s', tcFormat: 'NDF' })}>`,
    )
    if (input.credit === 'description') lines.push(`        <note>${escapeText(MAP_CREDIT)}</note>`)
    const [base, ...connected] = LAYERS
    lines.push(
      '        <spine>',
      `          <asset-clip${attrs({ ref: ids.assets[base.key], name: base.name, offset: '0s', start: '0s', duration, videoRole: base.role })}>`,
    )
    connected.forEach((layer, lane) => {
      lines.push(`            <asset-clip${attrs({ ref: ids.assets[layer.key], name: layer.name, lane: lane + 1, offset: '0s', start: '0s', duration, videoRole: layer.role })}/>`)
    })
    for (const marker of scene.markers) {
      lines.push(`            <marker${attrs({ start: t(marker.frame), duration: t(1), value: marker.value })}/>`)
    }
    lines.push(
      '          </asset-clip>',
      '        </spine>',
      '      </sequence>',
      '    </media>',
    )
  })

  lines.push('  </resources>', '  <library>', `    <event${attrs({ name: 'Mapper' })}>`)
  input.scenes.forEach((scene, i) => {
    lines.push(`      <ref-clip${attrs({ ref: sceneIds[i].media, name: compoundName(scene), start: '0s', duration: t(scene.frames) })}/>`)
  })

  const totalFrames = input.scenes.reduce((sum, scene) => sum + scene.frames, 0)
  lines.push(
    `      <project${attrs({ name: input.projectName })}>`,
    `        <sequence${attrs({ format: formatId, duration: t(totalFrames), tcStart: '0s', tcFormat: 'NDF' })}>`,
    '          <spine>',
  )
  let offset = 0
  input.scenes.forEach((scene, i) => {
    lines.push(`            <ref-clip${attrs({ ref: sceneIds[i].media, name: compoundName(scene), offset: t(offset), start: '0s', duration: t(scene.frames) })}/>`)
    offset += scene.frames
  })
  lines.push(
    '          </spine>',
    '        </sequence>',
    '      </project>',
    '    </event>',
    '  </library>',
    '</fcpxml>',
    '',
  )
  return lines.join('\n')
}
