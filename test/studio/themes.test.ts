import { validateStyleMin, type LayerSpecification, type StyleSpecification } from '@maplibre/maplibre-gl-style-spec'
import { describe, expect, test } from 'vitest'
import { THEMES, type ThemeId } from '../../src/core/index.js'
import { buildStyle } from '../../src/studio/stage/themes.js'

const TILE_BASE = 'http://127.0.0.1:4321/tiles/'

const build = (theme: ThemeId, opts: { labels?: 'en' | 'local'; terrain?: boolean } = {}) =>
  buildStyle(theme, { tileBase: TILE_BASE, labels: opts.labels ?? 'en', terrain: opts.terrain ?? false })

const symbols = (style: StyleSpecification) =>
  style.layers.filter((l): l is Extract<LayerSpecification, { type: 'symbol' }> => l.type === 'symbol')

const layerIndex = (style: StyleSpecification, id: string) => style.layers.findIndex((l) => l.id === id)

describe('buildStyle', () => {
  test('every theme builds a valid style', () => {
    for (const theme of THEMES) {
      for (const labels of ['en', 'local'] as const) {
        for (const terrain of [false, true]) {
          const style = build(theme, { labels, terrain })
          expect(validateStyleMin(style), `${theme} ${labels} terrain=${terrain}`).toEqual([])
          // The route pass hides every style layer, and the stage's own layers are `mapper-…`.
          for (const layer of style.layers) expect(layer.id.startsWith('mapper-')).toBe(false)
        }
      }
    }
  })

  test('aloftandaway labels use Plus Jakarta Sans in upper case', () => {
    for (const theme of ['aloftandaway', 'aloftandaway-warm'] as const) {
      const labels = symbols(build(theme))
      expect(labels.length).toBeGreaterThan(0)
      for (const layer of labels) {
        const font = layer.layout?.['text-font'] as string[]
        expect(font[0]).toMatch(/^Plus Jakarta Sans (SemiBold|Bold)$/)
      }
    }
    for (const layer of symbols(build('aloftandaway'))) {
      expect(layer.layout?.['text-transform']).toBe('uppercase')
      expect(layer.layout?.['text-letter-spacing']).toBe(0.14)
    }
    const warmTown = symbols(build('aloftandaway-warm')).find((l) => l.id === 'place-town')!
    expect(warmTown.layout?.['text-transform']).toBeUndefined()
  })

  test('aloftandaway labels use Latin-script names', () => {
    const field = (theme: ThemeId, labels: 'en' | 'local') =>
      symbols(build(theme, { labels })).find((l) => l.id === 'place-city')!.layout?.['text-field']
    expect(field('aloftandaway', 'en')).toEqual([
      'coalesce',
      ['get', 'name:en'],
      ['get', 'name:latin'],
      ['get', 'name'],
    ])
    expect(field('aloftandaway-warm', 'local')).toEqual(['coalesce', ['get', 'name:latin'], ['get', 'name']])
    expect(field('paper', 'en')).toEqual(['coalesce', ['get', 'name:en'], ['get', 'name']])
    expect(field('paper', 'local')).toEqual(['get', 'name'])
  })

  test('non-Aloft themes use Noto Sans', () => {
    for (const theme of THEMES.filter((t) => !t.startsWith('aloftandaway') && t !== 'blank')) {
      const labels = symbols(build(theme))
      expect(labels.length, theme).toBeGreaterThan(0)
      for (const layer of labels) expect((layer.layout?.['text-font'] as string[])[0], theme).toMatch(/^Noto Sans /)
    }
  })

  test('terrain adds a raster-dem source, hillshade and style terrain', () => {
    const style = build('light', { terrain: true })
    expect(style.sources.terrain).toEqual({
      type: 'raster-dem',
      encoding: 'terrarium',
      tiles: [`${TILE_BASE}terrain/{z}/{x}/{y}.png`],
      maxzoom: 15,
      tileSize: 256,
    })
    expect(style.terrain).toEqual({ source: 'terrain', exaggeration: 1.3 })
    const hillshade = layerIndex(style, 'hillshade')
    expect(style.layers[hillshade]).toMatchObject({ type: 'hillshade', source: 'terrain' })
    // Above the land fills, below the water.
    expect(hillshade).toBeGreaterThan(layerIndex(style, 'landcover-wood'))
    expect(hillshade).toBeLessThan(layerIndex(style, 'water'))

    const flat = build('light')
    expect(flat.sources.terrain).toBeUndefined()
    expect(flat.terrain).toBeUndefined()
    expect(layerIndex(flat, 'hillshade')).toBe(-1)
  })

  test('outdoor always has hillshade', () => {
    const style = build('outdoor')
    expect(style.sources.terrain).toMatchObject({ type: 'raster-dem', encoding: 'terrarium' })
    expect(layerIndex(style, 'hillshade')).toBeGreaterThan(-1)
    // Hill shading only: no 3D elevation unless asked.
    expect(style.terrain).toBeUndefined()
    expect(build('outdoor', { terrain: true }).terrain).toEqual({ source: 'terrain', exaggeration: 1.3 })
  })

  test('satellite with terrain has 3D elevation but no hill shading', () => {
    // Terrarium carries sea-floor depth, which shades blotches into the imagery.
    const style = build('satellite', { terrain: true })
    expect(style.sources.terrain).toMatchObject({ type: 'raster-dem', encoding: 'terrarium' })
    expect(style.terrain).toEqual({ source: 'terrain', exaggeration: 1.3 })
    expect(style.layers.some((l) => l.type === 'hillshade')).toBe(false)
    for (const theme of THEMES.filter((t) => t !== 'satellite')) {
      expect(build(theme, { terrain: true }).layers.some((l) => l.type === 'hillshade'), theme).toBe(true)
    }
  })

  test('satellite uses the satellite raster and keeps labels', () => {
    const style = build('satellite')
    expect(style.sources.satellite).toMatchObject({ type: 'raster', tiles: [`${TILE_BASE}satellite/{z}/{x}/{y}.jpg`] })
    expect(style.layers[0]).toMatchObject({ id: 'satellite', type: 'raster', source: 'satellite' })
    const ids = style.layers.map((l) => l.id)
    for (const id of ['boundary-country', 'water-name', 'place-city', 'place-town', 'place-country']) {
      expect(ids).toContain(id)
    }
    // No land fill and no water fill over the imagery.
    expect(style.layers.some((l) => l.type === 'fill' || l.type === 'background')).toBe(false)
    for (const layer of symbols(style)) expect(layer.paint?.['text-color']).toBe('#ffffff')
  })

  test('paper keeps the layers it had before the eleven styles', () => {
    const before = [
      'land',
      'landcover-wood',
      'landcover-grass',
      'landcover-wetland',
      'landcover-sand',
      'landcover-rock',
      'landcover-ice',
      'landuse-built-up',
      'park',
      'water',
      'boundary-region',
      'boundary-country',
      'road-major-casing',
      'road-major-fill',
      'water-name',
      'place-town',
      'place-city',
      'place-country',
    ]
    for (const labels of ['en', 'local'] as const) {
      expect(build('paper', { labels }).layers.map((l) => l.id)).toEqual(before)
    }
    expect(build('aloftandaway').layers.map((l) => l.id)).toContain('road-minor-fill')
  })

  test('blank needs no network', () => {
    const style = build('blank')
    expect(style.sources).toEqual({})
    expect(style.glyphs).toBeUndefined()
    expect(style.layers.map((l) => l.type)).toEqual(['background'])
  })
})
