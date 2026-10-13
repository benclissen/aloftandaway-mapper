import type {
  ExpressionSpecification,
  LayerSpecification,
  StyleSpecification,
} from '@maplibre/maplibre-gl-style-spec'
import type { Look, ThemeId } from '../../core/index.js'

export interface StyleOptions {
  /** `<server base>tiles/`, ending in a slash. */
  tileBase: string
  labels: Look['labels']
}

/** The `blank` theme's only colour. */
export const BLANK_BACKGROUND = '#e9e4da'

const REGULAR = ['Noto Sans Regular']
const BOLD = ['Noto Sans Bold']

/**
 * `paper`: warm off-white land, a soft grey-blue sea and quiet sage greens, with labels in muted browns. Everything
 * sits low in contrast so a saturated route colour reads clearly on top.
 */
const PAPER = {
  land: '#f2ece0',
  water: '#a9c3cb',
  wood: '#e1e2cb',
  grass: '#e7e6d1',
  wetland: '#dfe3d4',
  sand: '#eee2c6',
  ice: '#f8f7f2',
  rock: '#e7e1d6',
  park: '#dde2c7',
  builtUp: '#ebe3d4',
  country: '#a99d91',
  region: '#c9bdaf',
  roadCasing: '#dacdbb',
  road: '#fbf8f1',
  countryLabel: '#7c7165',
  cityLabel: '#463f38',
  townLabel: '#5d554c',
  waterLabel: '#58808b',
  halo: '#f6f1e7',
}

function nameField(labels: Look['labels']): ExpressionSpecification {
  return labels === 'en' ? ['coalesce', ['get', 'name:en'], ['get', 'name']] : ['get', 'name']
}

const zoomRamp = (...stops: number[]): ExpressionSpecification => ['interpolate', ['linear'], ['zoom'], ...stops]

function paperLayers(labels: Look['labels']): LayerSpecification[] {
  const name = nameField(labels)
  const landcover = (cls: string, color: string, opacity: ExpressionSpecification | number): LayerSpecification => ({
    id: `landcover-${cls}`,
    type: 'fill',
    source: 'openmaptiles',
    'source-layer': 'landcover',
    filter: ['==', ['get', 'class'], cls],
    paint: { 'fill-color': color, 'fill-opacity': opacity, 'fill-antialias': false },
  })
  const labelPaint = (color: string) => ({ 'text-color': color, 'text-halo-color': PAPER.halo, 'text-halo-width': 1.4 })

  return [
    { id: 'land', type: 'background', paint: { 'background-color': PAPER.land } },
    landcover('wood', PAPER.wood, zoomRamp(4, 0.5, 10, 0.9)),
    landcover('grass', PAPER.grass, 0.8),
    landcover('wetland', PAPER.wetland, 0.8),
    landcover('sand', PAPER.sand, 0.9),
    landcover('rock', PAPER.rock, 0.8),
    landcover('ice', PAPER.ice, 1),
    {
      id: 'landuse-built-up',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'landuse',
      minzoom: 9,
      filter: ['in', ['get', 'class'], ['literal', ['residential', 'suburb', 'quarter', 'neighbourhood']]],
      paint: { 'fill-color': PAPER.builtUp, 'fill-opacity': zoomRamp(9, 0, 11, 0.8) },
    },
    {
      id: 'park',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'park',
      minzoom: 6,
      paint: { 'fill-color': PAPER.park, 'fill-opacity': zoomRamp(6, 0.3, 10, 0.7) },
    },
    {
      id: 'water',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'water',
      filter: ['!=', ['get', 'brunnel'], 'tunnel'],
      paint: { 'fill-color': PAPER.water },
    },
    {
      id: 'boundary-region',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'boundary',
      minzoom: 5,
      filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
      layout: { 'line-join': 'round' },
      paint: { 'line-color': PAPER.region, 'line-width': zoomRamp(5, 0.5, 12, 1.2), 'line-dasharray': [3, 2] },
    },
    {
      id: 'boundary-country',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'boundary',
      filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': PAPER.country, 'line-width': zoomRamp(2, 0.6, 10, 1.8) },
    },
    ...(['casing', 'fill'] as const).map(
      (part): LayerSpecification => ({
        id: `road-major-${part}`,
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        minzoom: 8,
        filter: [
          'all',
          ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary']]],
          ['!=', ['get', 'brunnel'], 'tunnel'],
        ],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint:
          part === 'casing'
            ? { 'line-color': PAPER.roadCasing, 'line-width': zoomRamp(8, 1.2, 14, 6) }
            : { 'line-color': PAPER.road, 'line-width': zoomRamp(8, 0.5, 14, 4) },
      }),
    ),
    {
      id: 'water-name',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'water_name',
      filter: ['==', ['geometry-type'], 'Point'],
      layout: {
        'text-field': name,
        'text-font': REGULAR,
        'text-size': zoomRamp(3, 11, 8, 14),
        'text-letter-spacing': 0.15,
        'text-max-width': 8,
      },
      paint: { 'text-color': PAPER.waterLabel, 'text-halo-color': PAPER.water, 'text-halo-width': 0.8 },
    },
    {
      id: 'place-town',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'place',
      minzoom: 8,
      filter: ['==', ['get', 'class'], 'town'],
      layout: {
        'text-field': name,
        'text-font': REGULAR,
        'text-size': zoomRamp(8, 11, 13, 14),
        'text-max-width': 8,
        'symbol-sort-key': ['get', 'rank'],
      },
      paint: labelPaint(PAPER.townLabel),
    },
    {
      id: 'place-city',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'place',
      minzoom: 4,
      filter: ['==', ['get', 'class'], 'city'],
      layout: {
        'text-field': name,
        'text-font': REGULAR,
        'text-size': zoomRamp(4, 11, 10, 18),
        'text-max-width': 8,
        'symbol-sort-key': ['get', 'rank'],
      },
      paint: labelPaint(PAPER.cityLabel),
    },
    {
      id: 'place-country',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'place',
      maxzoom: 9,
      filter: ['==', ['get', 'class'], 'country'],
      layout: {
        'text-field': name,
        'text-font': BOLD,
        'text-size': zoomRamp(2, 10, 6, 14),
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.12,
        'text-max-width': 7,
        'symbol-sort-key': ['get', 'rank'],
      },
      paint: labelPaint(PAPER.countryLabel),
    },
  ]
}

/** The basemap style for a theme. `blank` is a plain background and needs no network. */
export function buildStyle(theme: ThemeId, opts: StyleOptions): StyleSpecification {
  if (theme === 'blank') {
    return {
      version: 8,
      sources: {},
      layers: [{ id: 'background', type: 'background', paint: { 'background-color': BLANK_BACKGROUND } }],
    }
  }
  return {
    version: 8,
    glyphs: `${opts.tileBase}fonts/{fontstack}/{range}.pbf`,
    sources: { openmaptiles: { type: 'vector', url: `${opts.tileBase}planet` } },
    layers: paperLayers(opts.labels),
  }
}
