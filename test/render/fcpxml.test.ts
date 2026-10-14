import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { describe, expect, test } from 'vitest'
import { MAP_CREDIT, type Fps, type Output } from '../../src/core/index.js'
import type { FcpxmlInput, SceneExport } from '../../src/render/export-types.js'
import { frameTime, writeFcpxml } from '../../src/render/fcpxml.js'

type Node = Record<string, any>

const ARRAYS = new Set(['asset', 'media', 'ref-clip', 'asset-clip', 'marker', 'media-rep', 'format', 'note'])
const parser = new XMLParser({
  ignoreAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  htmlEntities: true,
  isArray: (name) => ARRAYS.has(name),
})

function parse(xml: string): Node {
  expect(XMLValidator.validate(xml)).toBe(true)
  return parser.parse(xml)
}

const out25: Output = { aspect: '16:9', height: 1080, fps: { num: 25, den: 1 } }

function scene(id: string, name: string, frames: number, dir: string, extra: Partial<SceneExport> = {}): SceneExport {
  return {
    id,
    name,
    frames,
    sourceRange: { fromFrame: 0, toFrame: frames },
    layers: { map: `${dir}/map.mov`, route: `${dir}/route.mov`, signs: `${dir}/signs.mov` },
    markers: [{ frame: 0, value: `${name} start` }, { frame: 24, value: `${name} arrival` }],
    ...extra,
  }
}

function twoScenes(output: Output = out25): FcpxmlInput {
  return {
    projectName: 'Trip',
    output,
    credit: 'burned',
    scenes: [scene('a', 'Drive', 50, '/renders/trip/01-drive'), scene('b', 'Sail', 75, '/renders/trip/02-sail')],
  }
}

function resources(doc: Node) { return doc.fcpxml.resources }
function event(doc: Node) { return doc.fcpxml.library.event }
function compoundClips(doc: Node) {
  return (resources(doc).media as Node[]).map((m) => {
    const map = m.sequence.spine['asset-clip'][0] as Node
    return { media: m, sequence: m.sequence as Node, map, connected: (map['asset-clip'] ?? []) as Node[], markers: (map.marker ?? []) as Node[] }
  })
}

function allIds(doc: Node): string[] {
  const r = resources(doc)
  return [...r.format, ...r.asset, ...r.media].map((n: Node) => n['@_id'])
}

/** Every `ref`/`format` attribute in the document, wherever it is. */
function allRefs(node: unknown, acc: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => allRefs(n, acc))
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '@_ref' || k === '@_format') acc.push(v as string)
      else allRefs(v, acc)
    }
  }
  return acc
}

describe('frameTime', () => {
  test('uses exact fractional frame times', () => {
    expect(frameTime(1, { num: 24000, den: 1001 })).toBe('1001/24000s')
    expect(frameTime(48, { num: 24000, den: 1001 })).toBe('1001/500s')
    expect(frameTime(0, { num: 25, den: 1 })).toBe('0s')
    expect(frameTime(50, { num: 25, den: 1 })).toBe('2s')
    expect(frameTime(24, { num: 25, den: 1 })).toBe('24/25s')
    expect(frameTime(1, { num: 25, den: 1 })).toBe('1/25s')
    expect(frameTime(125, { num: 24000, den: 1001 })).toBe('1001/192s')
  })

  test('stays exact for frame counts whose product exceeds the safe integer range', () => {
    // 2^53 - 1 shares no factor with 60000, and 1001 shares none with 60000.
    expect(frameTime(Number.MAX_SAFE_INTEGER, { num: 60000, den: 1001 })).toBe('9016206453995731991/60000s')
  })

  test.each([
    [-1, { num: 25, den: 1 }],
    [1.5, { num: 25, den: 1 }],
    [Number.NaN, { num: 25, den: 1 }],
    [Number.MAX_SAFE_INTEGER + 1, { num: 25, den: 1 }],
    [1, { num: 0, den: 1 }],
    [1, { num: 25, den: 0 }],
    [1, { num: 25.5, den: 1 }],
    [1, { num: -25, den: 1 }],
  ])('rejects frames %s at %o', (frames, fps) => {
    expect(() => frameTime(frames, fps as Fps)).toThrow(RangeError)
  })
})

describe('writeFcpxml', () => {
  test('writes a v1.11 document with a DOCTYPE', () => {
    const xml = writeFcpxml(twoScenes())
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n')).toBe(true)
    expect(parse(xml).fcpxml['@_version']).toBe('1.11')
  })

  test('joins two scenes at 25 fps with resolved, unique resource ids', () => {
    const doc = parse(writeFcpxml(twoScenes()))
    const r = resources(doc)
    expect(r.format).toHaveLength(1)
    expect(r.format[0]).toMatchObject({ '@_width': '1920', '@_height': '1080', '@_frameDuration': '1/25s' })
    expect(r.asset).toHaveLength(6)
    expect(r.media).toHaveLength(2)

    const ids = allIds(doc)
    expect(new Set(ids).size).toBe(ids.length)
    for (const ref of allRefs(doc)) expect(ids).toContain(ref)

    expect(r.asset.map((a: Node) => [a['@_name'], a['@_duration'], a['media-rep'][0]['@_src']])).toEqual([
      ['Map', '2s', 'file:///renders/trip/01-drive/map.mov'],
      ['Route', '2s', 'file:///renders/trip/01-drive/route.mov'],
      ['Signs', '2s', 'file:///renders/trip/01-drive/signs.mov'],
      ['Map', '3s', 'file:///renders/trip/02-sail/map.mov'],
      ['Route', '3s', 'file:///renders/trip/02-sail/route.mov'],
      ['Signs', '3s', 'file:///renders/trip/02-sail/signs.mov'],
    ])
    for (const a of r.asset) {
      expect(a).toMatchObject({ '@_start': '0s', '@_hasVideo': '1', '@_hasAudio': '0', '@_format': r.format[0]['@_id'] })
      expect(a['media-rep'][0]['@_kind']).toBe('original-media')
    }
    expect(r.media.map((m: Node) => m['@_name'])).toEqual(['Trip · Drive', 'Trip · Sail'])

    const ev = event(doc)
    expect(ev['@_name']).toBe('Mapper')
    const browser = ev['ref-clip'] as Node[]
    expect(browser).toHaveLength(2)
    expect(browser.map((c) => [c['@_ref'], c['@_name'], c['@_start'], c['@_duration']])).toEqual([
      [r.media[0]['@_id'], 'Trip · Drive', '0s', '2s'],
      [r.media[1]['@_id'], 'Trip · Sail', '0s', '3s'],
    ])

    expect(ev.project['@_name']).toBe('Trip')
    const seq = ev.project.sequence
    expect(seq).toMatchObject({ '@_duration': '5s', '@_format': r.format[0]['@_id'], '@_tcStart': '0s' })
    const placed = seq.spine['ref-clip'] as Node[]
    expect(placed.map((c) => [c['@_ref'], c['@_offset'], c['@_start'], c['@_duration']])).toEqual([
      [r.media[0]['@_id'], '0s', '0s', '2s'],
      [r.media[1]['@_id'], '2s', '0s', '3s'],
    ])
  })

  test('puts map on the spine and route and signs on lanes with roles and markers', () => {
    const doc = parse(writeFcpxml(twoScenes()))
    const assets = resources(doc).asset as Node[]
    const clips = compoundClips(doc)
    clips.forEach((c, i) => {
      const [map, route, signs] = assets.slice(i * 3, i * 3 + 3).map((a) => a['@_id'])
      const dur = i === 0 ? '2s' : '3s'
      expect(c.sequence).toMatchObject({ '@_duration': dur, '@_tcStart': '0s', '@_tcFormat': 'NDF' })
      expect(c.sequence.spine['asset-clip']).toHaveLength(1)
      expect(c.map).toMatchObject({ '@_ref': map, '@_name': 'Map', '@_offset': '0s', '@_start': '0s', '@_duration': dur, '@_videoRole': 'Map.Base' })
      expect(c.map['@_lane']).toBeUndefined()
      expect(c.connected.map((k) => [k['@_ref'], k['@_name'], k['@_lane'], k['@_offset'], k['@_start'], k['@_duration'], k['@_videoRole']])).toEqual([
        [route, 'Route', '1', '0s', '0s', dur, 'Map.Route'],
        [signs, 'Signs', '2', '0s', '0s', dur, 'Map.Signs'],
      ])
      const name = i === 0 ? 'Drive' : 'Sail'
      expect(c.markers.map((m) => [m['@_start'], m['@_duration'], m['@_value']])).toEqual([
        ['0s', '1/25s', `${name} start`],
        ['24/25s', '1/25s', `${name} arrival`],
      ])
    })
  })

  test('joins two scenes at 24000/1001 with exact rational times', () => {
    const doc = parse(writeFcpxml(twoScenes({ aspect: '16:9', height: 1080, fps: { num: 24000, den: 1001 } })))
    const r = resources(doc)
    expect(r.format[0]['@_frameDuration']).toBe('1001/24000s')
    expect(r.asset.map((a: Node) => a['@_duration'])).toEqual(['1001/480s', '1001/480s', '1001/480s', '1001/320s', '1001/320s', '1001/320s'])
    const seq = event(doc).project.sequence
    expect(seq['@_duration']).toBe('1001/192s')
    expect(seq.spine['ref-clip'].map((c: Node) => [c['@_offset'], c['@_duration']])).toEqual([
      ['0s', '1001/480s'],
      ['1001/480s', '1001/320s'],
    ])
    expect(compoundClips(doc)[0].markers.map((m) => [m['@_start'], m['@_duration']])).toEqual([
      ['0s', '1001/24000s'],
      ['1001/1000s', '1001/24000s'],
    ])
  })

  test('keeps range-rebased markers clip-local and every compound starts at zero', () => {
    const input = twoScenes()
    input.scenes[0] = { ...input.scenes[0], sourceRange: { fromFrame: 100, toFrame: 150 } }
    input.scenes[1] = { ...input.scenes[1], sourceRange: { fromFrame: 25, toFrame: 100 } }
    const doc = parse(writeFcpxml(input))
    for (const c of compoundClips(doc)) {
      expect(c.map['@_start']).toBe('0s')
      expect(c.map['@_offset']).toBe('0s')
      expect(c.markers.map((m) => m['@_start'])).toEqual(['0s', '24/25s'])
    }
    expect(event(doc).project.sequence['@_duration']).toBe('5s')
  })

  test('escapes special characters and keeps valid Unicode in names, markers and paths', () => {
    const project = `Tom & "Jerry's" <Trip> ✈️ 𝄞`
    const sceneName = `Zürich > Côte d'Azur & "más"`
    const marker = `Day 2 · Ηράκλειο <&> '🚢'`
    const dir = `/Users/me/My Trips/#1 50% Tom's ü`
    const input: FcpxmlInput = {
      projectName: project,
      output: out25,
      credit: 'burned',
      scenes: [scene('a', sceneName, 50, dir, { markers: [{ frame: 10, value: marker }] })],
    }
    const xml = writeFcpxml(input)
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/)
    const doc = parse(xml)
    expect(event(doc).project['@_name']).toBe(project)
    expect(resources(doc).media[0]['@_name']).toBe(`${project} · ${sceneName}`)
    expect(compoundClips(doc)[0].markers[0]['@_value']).toBe(marker)
    expect(resources(doc).asset.map((a: Node) => a['media-rep'][0]['@_src'])).toEqual([
      "file:///Users/me/My%20Trips/%231%2050%25%20Tom's%20%C3%BC/map.mov",
      "file:///Users/me/My%20Trips/%231%2050%25%20Tom's%20%C3%BC/route.mov",
      "file:///Users/me/My%20Trips/%231%2050%25%20Tom's%20%C3%BC/signs.mov",
    ])
  })

  test('strips characters XML 1.0 forbids', () => {
    const input: FcpxmlInput = {
      projectName: 'Tr\u0000ip\u0007',
      output: out25,
      credit: 'burned',
      scenes: [scene('a', 'Dr\u001Bive\uFFFE', 50, '/r/a', { markers: [{ frame: 1, value: 'A\u0001B\uD800C\tD' }] })],
    }
    const xml = writeFcpxml(input)
    // eslint-disable-next-line no-control-regex
    expect(xml).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/)
    expect(xml).toContain('value="ABC&#9;D"')
    const doc = parse(xml)
    expect(event(doc).project['@_name']).toBe('Trip')
    expect(resources(doc).media[0]['@_name']).toBe('Trip · Drive')
    expect(compoundClips(doc)[0].markers[0]['@_value']).toBe('ABC\tD')
  })

  test('names the compound project · scene even when names match, and keeps duplicate names distinct', () => {
    const input: FcpxmlInput = {
      projectName: 'Crete',
      output: out25,
      credit: 'burned',
      scenes: [scene('x', 'Crete', 25, '/r/x'), scene('y', 'Crete', 25, '/r/y')],
    }
    const doc = parse(writeFcpxml(input))
    const media = resources(doc).media as Node[]
    expect(media.map((m) => m['@_name'])).toEqual(['Crete · Crete', 'Crete · Crete'])
    expect(media[0]['@_id']).not.toBe(media[1]['@_id'])
    expect(event(doc)['ref-clip'].map((c: Node) => c['@_ref'])).toEqual(media.map((m) => m['@_id']))
  })

  test('puts the credit in each compound note only for description placement', () => {
    const described = parse(writeFcpxml({ ...twoScenes(), credit: 'description' }))
    for (const c of compoundClips(described)) expect(c.sequence.note).toEqual([MAP_CREDIT])
    expect(event(described).project.sequence.note).toBeUndefined()

    const burned = writeFcpxml(twoScenes())
    expect(burned).not.toContain('<note')
    expect(burned).not.toContain('OpenStreetMap')
  })

  test.each([
    ['16:9', 1080, '1920', '1080'],
    ['16:9', 2160, '3840', '2160'],
    ['9:16', 1080, '1080', '1920'],
    ['9:16', 1440, '1440', '2560'],
    ['1:1', 1080, '1080', '1080'],
    ['4:5', 1080, '1080', '1350'],
    ['4:5', 2160, '2160', '2700'],
  ] as const)('writes a %s %d format at %sx%s without a guessed format name', (aspect, height, w, h) => {
    const doc = parse(writeFcpxml(twoScenes({ aspect, height, fps: { num: 25, den: 1 } })))
    const format = resources(doc).format[0]
    expect(format).toMatchObject({ '@_width': w, '@_height': h, '@_frameDuration': '1/25s', '@_colorSpace': '1-1-1 (Rec. 709)' })
    expect(format['@_name']).toBeUndefined()
  })

  test.each([
    [24000, 1001, '1001/24000s', '1001/480s'],
    [24, 1, '1/24s', '25/12s'],
    [25, 1, '1/25s', '2s'],
    [30000, 1001, '1001/30000s', '1001/600s'],
    [30, 1, '1/30s', '5/3s'],
    [50, 1, '1/50s', '1s'],
    [60000, 1001, '1001/60000s', '1001/1200s'],
    [60, 1, '1/60s', '5/6s'],
  ])('writes %d/%d fps', (num, den, frameDuration, firstDuration) => {
    const doc = parse(writeFcpxml(twoScenes({ aspect: '16:9', height: 2160, fps: { num, den } })))
    expect(resources(doc).format[0]['@_frameDuration']).toBe(frameDuration)
    expect(resources(doc).media[0].sequence['@_duration']).toBe(firstDuration)
    expect(compoundClips(doc)[0].markers[0]['@_duration']).toBe(frameDuration)
  })

  test('accepts markers on the first and last frame', () => {
    const input: FcpxmlInput = {
      ...twoScenes(),
      scenes: [scene('a', 'Drive', 50, '/r/a', { markers: [{ frame: 0, value: 'first' }, { frame: 49, value: 'last' }] })],
    }
    const doc = parse(writeFcpxml(input))
    expect(compoundClips(doc)[0].markers.map((m) => m['@_start'])).toEqual(['0s', '49/25s'])
  })

  test('writes a compound with no markers', () => {
    const input: FcpxmlInput = { ...twoScenes(), scenes: [scene('a', 'Drive', 50, '/r/a', { markers: [] })] }
    const xml = writeFcpxml(input)
    expect(xml).not.toContain('<marker')
    expect(compoundClips(parse(xml))[0].connected).toHaveLength(2)
  })

  const bad: [string, (input: FcpxmlInput) => void][] = [
    ['an empty scene list', (i) => { i.scenes = [] }],
    ['duplicate scene ids', (i) => { i.scenes[1].id = 'a' }],
    ['an empty scene id', (i) => { i.scenes[0].id = '' }],
    ['zero frames', (i) => { i.scenes[0].frames = 0; i.scenes[0].sourceRange = { fromFrame: 0, toFrame: 0 }; i.scenes[0].markers = [] }],
    ['fractional frames', (i) => { i.scenes[0].frames = 50.5 }],
    ['a source range that disagrees with frames', (i) => { i.scenes[0].sourceRange = { fromFrame: 0, toFrame: 49 } }],
    ['a relative layer path', (i) => { i.scenes[0].layers.route = 'renders/route.mov' }],
    ['an empty layer path', (i) => { i.scenes[1].layers.signs = '' }],
    ['a marker at the clip length', (i) => { i.scenes[0].markers = [{ frame: 50, value: 'x' }] }],
    ['a negative marker', (i) => { i.scenes[0].markers = [{ frame: -1, value: 'x' }] }],
    ['a fractional marker', (i) => { i.scenes[0].markers = [{ frame: 1.5, value: 'x' }] }],
    ['an unsupported fps', (i) => { i.output = { ...i.output, fps: { num: 0, den: 1 } } }],
  ]
  test.each(bad)('rejects %s before emitting XML', (_, mutate) => {
    const input = structuredClone(twoScenes())
    mutate(input)
    expect(() => writeFcpxml(input)).toThrow()
  })
})
