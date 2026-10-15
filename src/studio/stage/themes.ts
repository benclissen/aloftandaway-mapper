import type {
  ExpressionSpecification,
  LayerSpecification,
  SourceSpecification,
  StyleSpecification,
} from '@maplibre/maplibre-gl-style-spec'
import { THEME_MAX_ZOOM, usesElevation, type Look, type ThemeId } from '../../core/index.js'

export interface StyleOptions {
  /** `<server base>tiles/`, ending in a slash. */
  tileBase: string
  labels: Look['labels']
  /** Hill shading plus 3D elevation. */
  terrain: boolean
}

/** The `blank` theme's only colour. */
export const BLANK_BACKGROUND = '#e9e4da'

/**
 * Everything a map style is made from. Colours are fills unless noted; any colour may carry its own alpha. The
 * optional fields are switches: left out, the builder draws what `paper` draws.
 */
export interface Palette {
  water: string
  land: string
  /** A hairline along every shore. None when left out. */
  landLine?: string
  wood: string
  grass: string
  /** Defaults to `grass`. */
  wetland?: string
  park: string
  sand: string
  ice: string
  rock: string
  builtUp: string
  /** Defaults to `water`. */
  lake?: string
  /** One opacity for every land-cover and park fill. Left out, they fade in with zoom as `paper`'s do. */
  coverOpacity?: number
  roadMajor: string
  roadMinor: string
  /** Draws minor roads from zoom 11. Off when left out. */
  minorRoads?: boolean
  /** No casing when left out. */
  roadCasing?: string
  /** Fixed road widths in px. Left out, roads widen with zoom. */
  roadWidth?: { major: number; minor: number }
  border: string
  borderDash?: number[]
  /** Fixed country border width in px. Left out, it widens with zoom. */
  borderWidth?: number
  /** State and region borders, dashed. None when left out. */
  region?: string
  /** City labels. */
  label: string
  labelTown: string
  labelCountry: string
  labelWater: string
  /** Halo around place labels. */
  halo: string
  /** Halo around water labels. Defaults to `water`. */
  haloWater?: string
  labelFont: 'jakarta' | 'noto'
  labelCase: 'upper-spaced' | 'normal'
  hillshade: { shadow: string; highlight: string; exaggeration: number }
}

interface Theme {
  palette: Palette
  /** Satellite imagery in place of every fill. */
  imagery?: boolean
}

const NAVY = '#0a2434'

/** `paper`: warm off-white land, a soft grey-blue sea, quiet sage greens and muted brown labels. */
const PAPER: Palette = {
  water: '#a9c3cb',
  land: '#f2ece0',
  wood: '#e1e2cb',
  grass: '#e7e6d1',
  wetland: '#dfe3d4',
  park: '#dde2c7',
  sand: '#eee2c6',
  ice: '#f8f7f2',
  rock: '#e7e1d6',
  builtUp: '#ebe3d4',
  roadMajor: '#fbf8f1',
  roadMinor: '#fbf8f1',
  roadCasing: '#dacdbb',
  border: '#a99d91',
  region: '#c9bdaf',
  label: '#463f38',
  labelTown: '#5d554c',
  labelCountry: '#7c7165',
  labelWater: '#58808b',
  halo: '#f6f1e7',
  labelFont: 'noto',
  labelCase: 'normal',
  hillshade: { shadow: '#6b5d4a', highlight: '#fffaf0', exaggeration: 0.35 },
}

/** `light`: near-white land, a pale blue sea and grey labels. */
const LIGHT: Palette = {
  water: '#d6e4ec',
  land: '#f8f8f6',
  wood: '#e4ece0',
  grass: '#e9efe5',
  park: '#e2eadd',
  sand: '#f1efe6',
  ice: '#ffffff',
  rock: '#efefeb',
  builtUp: '#f1f1ee',
  roadMajor: '#ffffff',
  roadMinor: '#ffffff',
  minorRoads: true,
  roadCasing: '#e2e2e2',
  border: '#b9b9b9',
  label: '#4a4a4a',
  labelTown: '#5f5f5f',
  labelCountry: '#6e6e6e',
  labelWater: '#7895a5',
  halo: '#f8f8f6',
  labelFont: 'noto',
  labelCase: 'normal',
  hillshade: { shadow: '#7d7d7d', highlight: '#ffffff', exaggeration: 0.3 },
}

const THEMES_BY_ID: Record<Exclude<ThemeId, 'blank'>, Theme> = {
  /** The series map: cool greys, a navy coast hairline and spaced capitals in Plus Jakarta Sans. */
  aloftandaway: {
    palette: {
      water: '#eef2f4',
      land: '#d4dadf',
      landLine: 'rgba(10, 36, 52, 0.22)',
      wood: '#c9d1cf',
      grass: '#c9d1cf',
      park: '#c9d1cf',
      sand: '#d8dde1',
      ice: '#e4e8eb',
      rock: '#cfd5da',
      builtUp: '#ccd2d7',
      coverOpacity: 1,
      roadMajor: '#ffffff',
      roadMinor: '#ffffff',
      minorRoads: true,
      roadWidth: { major: 2, minor: 1 },
      border: 'rgba(10, 36, 52, 0.3)',
      borderDash: [3, 2],
      label: NAVY,
      labelTown: NAVY,
      labelCountry: NAVY,
      labelWater: 'rgba(10, 36, 52, 0.5)',
      halo: 'rgba(212, 218, 223, 0.8)',
      labelFont: 'jakarta',
      labelCase: 'upper-spaced',
      hillshade: { shadow: NAVY, highlight: '#ffffff', exaggeration: 0.25 },
    },
  },
  /** The warm variant: page-grey land, a soft blue sea, sage greens and sand borders. */
  'aloftandaway-warm': {
    palette: {
      water: '#c9dbe2',
      land: '#f4f4f4',
      landLine: 'rgba(10, 36, 52, 0.18)',
      wood: '#bcc8a2',
      grass: '#bcc8a2',
      park: '#bcc8a2',
      sand: '#ebe6d8',
      ice: '#fbfbfb',
      rock: '#e6e6e2',
      builtUp: '#ececea',
      coverOpacity: 0.55,
      roadMajor: '#ffffff',
      roadMinor: '#ffffff',
      minorRoads: true,
      roadCasing: '#dcdcdc',
      border: 'rgba(134, 122, 91, 0.6)',
      borderDash: [3, 2],
      label: NAVY,
      labelTown: NAVY,
      labelCountry: NAVY,
      labelWater: '#4f7381',
      halo: '#f4f4f4',
      labelFont: 'jakarta',
      labelCase: 'normal',
      hillshade: { shadow: '#867a5b', highlight: '#ffffff', exaggeration: 0.3 },
    },
  },
  paper: { palette: PAPER },
  light: { palette: LIGHT },
  /** Night blues with pale labels. */
  dark: {
    palette: {
      water: '#0e151e',
      land: '#1c2431',
      wood: '#1f2b2e',
      grass: '#1e2930',
      park: '#1f2b2e',
      sand: '#222a35',
      ice: '#252e3b',
      rock: '#202835',
      builtUp: '#202938',
      roadMajor: '#2b3546',
      roadMinor: '#2b3546',
      minorRoads: true,
      border: '#4a5568',
      label: '#c8d0db',
      labelTown: '#a8b2bf',
      labelCountry: '#8d98a8',
      labelWater: '#5f7489',
      halo: '#0e151e',
      labelFont: 'noto',
      labelCase: 'normal',
      hillshade: { shadow: '#05080c', highlight: '#3a4658', exaggeration: 0.35 },
    },
  },
  /** A deep sea against parchment land, like a chart. */
  nautical: {
    palette: {
      water: '#2e6a88',
      land: '#efe5cc',
      wood: '#dcd3b0',
      grass: '#e3dabb',
      park: '#dcd3b0',
      sand: '#f2e5c2',
      ice: '#f8f4ea',
      rock: '#e2d8c0',
      builtUp: '#e6dbbf',
      roadMajor: '#fffaf0',
      roadMinor: '#fffaf0',
      minorRoads: true,
      roadCasing: '#cbbf9c',
      border: '#8a6d4b',
      label: '#1d3557',
      labelTown: '#2e4868',
      labelCountry: '#6b5536',
      labelWater: '#e8f1f5',
      halo: '#efe5cc',
      labelFont: 'noto',
      labelCase: 'normal',
      hillshade: { shadow: '#6e5a3a', highlight: '#fffaf0', exaggeration: 0.35 },
    },
  },
  /** A school atlas: cream land, pale blue sea and red borders. */
  atlas: {
    palette: {
      water: '#b5d3e7',
      land: '#f3ebc8',
      wood: '#d9e2b4',
      grass: '#e2e6bd',
      park: '#d6e0ae',
      sand: '#f1e2b4',
      ice: '#fbf8ec',
      rock: '#e6dcbd',
      builtUp: '#ecdfb8',
      roadMajor: '#ffffff',
      roadMinor: '#ffffff',
      minorRoads: true,
      roadCasing: '#d8c99a',
      border: '#b04a4a',
      borderWidth: 1.5,
      label: '#3a2e1f',
      labelTown: '#544430',
      labelCountry: '#6a5a43',
      labelWater: '#4f7b97',
      halo: '#f3ebc8',
      labelFont: 'noto',
      labelCase: 'normal',
      hillshade: { shadow: '#6b5a3a', highlight: '#fffdf2', exaggeration: 0.35 },
    },
  },
  /** Greens and hill shading for walking and mountain country. */
  outdoor: {
    palette: {
      water: '#a6cee0',
      land: '#eef0e2',
      wood: '#c4d8a8',
      grass: '#d6e3bf',
      park: '#c9dcae',
      sand: '#ece4c6',
      ice: '#fafcfd',
      rock: '#dedbd0',
      builtUp: '#e6e4d6',
      roadMajor: '#ffffff',
      roadMinor: '#ffffff',
      minorRoads: true,
      roadCasing: '#c9c2a8',
      border: '#8f8f7a',
      label: '#33402b',
      labelTown: '#4a5740',
      labelCountry: '#5f6b52',
      labelWater: '#3f7590',
      halo: '#eef0e2',
      labelFont: 'noto',
      labelCase: 'normal',
      hillshade: { shadow: '#46533a', highlight: '#ffffff', exaggeration: 0.5 },
    },
  },
  /** EOxCloudless 2016 imagery with white labels and borders on top. Its fills are never drawn. */
  satellite: {
    imagery: true,
    palette: {
      ...LIGHT,
      border: 'rgba(255, 255, 255, 0.6)',
      label: '#ffffff',
      labelTown: '#ffffff',
      labelCountry: '#ffffff',
      labelWater: '#ffffff',
      halo: 'rgba(0, 0, 0, 0.6)',
      haloWater: 'rgba(0, 0, 0, 0.6)',
      hillshade: { shadow: '#000000', highlight: '#ffffff', exaggeration: 0.3 },
    },
  },
  /** Greys only, so any route colour stands out. */
  monochrome: {
    palette: {
      water: '#ffffff',
      land: '#e4e4e4',
      wood: '#d6d6d6',
      grass: '#dadada',
      park: '#d6d6d6',
      sand: '#e0e0e0',
      ice: '#f2f2f2',
      rock: '#dcdcdc',
      builtUp: '#dedede',
      roadMajor: '#ffffff',
      roadMinor: '#ffffff',
      minorRoads: true,
      roadCasing: '#cfcfcf',
      border: '#9a9a9a',
      label: '#3a3a3a',
      labelTown: '#555555',
      labelCountry: '#6a6a6a',
      labelWater: '#8a8a8a',
      halo: '#e4e4e4',
      labelFont: 'noto',
      labelCase: 'normal',
      hillshade: { shadow: '#555555', highlight: '#ffffff', exaggeration: 0.3 },
    },
  },
}

/** `blank`'s hill shading, when terrain is on. */
const BLANK_HILLSHADE: Palette['hillshade'] = { shadow: '#7a7060', highlight: '#fbf8f2', exaggeration: 0.3 }

/** Font stacks for each label font. The server serves the two Plus Jakarta Sans faces from disk. */
const FONTS = {
  noto: { regular: ['Noto Sans Regular'], bold: ['Noto Sans Bold'] },
  jakarta: { regular: ['Plus Jakarta Sans SemiBold'], bold: ['Plus Jakarta Sans Bold'] },
} as const

const SPACED = 0.14

/**
 * The label text. Plus Jakarta Sans only has Latin glyphs, so its styles prefer the Latin-script name and never draw a
 * name in a script they would show blank.
 */
function nameField(labels: Look['labels'], latinOnly: boolean): ExpressionSpecification {
  const get = (key: string): ExpressionSpecification => ['get', key]
  if (latinOnly) {
    return labels === 'en'
      ? ['coalesce', get('name:en'), get('name:latin'), get('name')]
      : ['coalesce', get('name:latin'), get('name')]
  }
  return labels === 'en' ? ['coalesce', get('name:en'), get('name')] : get('name')
}

const zoomRamp = (...stops: number[]): ExpressionSpecification => ['interpolate', ['linear'], ['zoom'], ...stops]

const TERRAIN_SOURCE = 'terrain'

function terrainSource(tileBase: string): SourceSpecification {
  return {
    type: 'raster-dem',
    encoding: 'terrarium',
    tiles: [`${tileBase}terrain/{z}/{x}/{y}.png`],
    maxzoom: 15,
    tileSize: 256,
  }
}

function hillshadeLayer({ shadow, highlight, exaggeration }: Palette['hillshade']): LayerSpecification {
  return {
    id: 'hillshade',
    type: 'hillshade',
    source: TERRAIN_SOURCE,
    paint: {
      'hillshade-shadow-color': shadow,
      'hillshade-highlight-color': highlight,
      'hillshade-accent-color': shadow,
      'hillshade-exaggeration': exaggeration,
      // Light from the map's north-west, so shading doesn't swing as the camera turns.
      'hillshade-illumination-anchor': 'map',
    },
  }
}

/** Land, land cover, parks and built-up areas, bottom to top. */
function fillLayers(p: Palette): LayerSpecification[] {
  const cover = (ramp: ExpressionSpecification | number) => p.coverOpacity ?? ramp
  const landcover = (cls: string, color: string, opacity: ExpressionSpecification | number): LayerSpecification => ({
    id: `landcover-${cls}`,
    type: 'fill',
    source: 'openmaptiles',
    'source-layer': 'landcover',
    filter: ['==', ['get', 'class'], cls],
    paint: { 'fill-color': color, 'fill-opacity': cover(opacity), 'fill-antialias': false },
  })
  return [
    { id: 'land', type: 'background', paint: { 'background-color': p.land } },
    landcover('wood', p.wood, zoomRamp(4, 0.5, 10, 0.9)),
    landcover('grass', p.grass, 0.8),
    landcover('wetland', p.wetland ?? p.grass, 0.8),
    landcover('sand', p.sand, 0.9),
    landcover('rock', p.rock, 0.8),
    landcover('ice', p.ice, 1),
    {
      id: 'landuse-built-up',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'landuse',
      minzoom: 9,
      filter: ['in', ['get', 'class'], ['literal', ['residential', 'suburb', 'quarter', 'neighbourhood']]],
      paint: { 'fill-color': p.builtUp, 'fill-opacity': zoomRamp(9, 0, 11, 0.8) },
    },
    {
      id: 'park',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'park',
      minzoom: 6,
      paint: { 'fill-color': p.park, 'fill-opacity': cover(zoomRamp(6, 0.3, 10, 0.7)) },
    },
  ]
}

function waterLayers(p: Palette): LayerSpecification[] {
  const notTunnel: ExpressionSpecification = ['!=', ['get', 'brunnel'], 'tunnel']
  const layers: LayerSpecification[] = [
    {
      id: 'water',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'water',
      filter: notTunnel,
      paint: { 'fill-color': p.lake ? ['match', ['get', 'class'], 'lake', p.lake, p.water] : p.water },
    },
  ]
  if (p.landLine) {
    layers.push({
      id: 'water-shore',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'water',
      filter: notTunnel,
      layout: { 'line-join': 'round' },
      paint: { 'line-color': p.landLine, 'line-width': 0.75 },
    })
  }
  return layers
}

function boundaryLayers(p: Palette): LayerSpecification[] {
  const layers: LayerSpecification[] = []
  if (p.region) {
    layers.push({
      id: 'boundary-region',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'boundary',
      minzoom: 5,
      filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
      layout: { 'line-join': 'round' },
      paint: { 'line-color': p.region, 'line-width': zoomRamp(5, 0.5, 12, 1.2), 'line-dasharray': [3, 2] },
    })
  }
  layers.push({
    id: 'boundary-country',
    type: 'line',
    source: 'openmaptiles',
    'source-layer': 'boundary',
    filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
    // A dash pattern needs butt caps, or the dashes run together.
    layout: { 'line-join': 'round', 'line-cap': p.borderDash ? 'butt' : 'round' },
    paint: {
      'line-color': p.border,
      'line-width': p.borderWidth ?? zoomRamp(2, 0.6, 10, 1.8),
      ...(p.borderDash ? { 'line-dasharray': p.borderDash } : {}),
    },
  })
  return layers
}

const ROADS = {
  minor: {
    classes: ['secondary', 'tertiary', 'minor'],
    minzoom: 11,
    casing: [11, 0.8, 14, 3.5],
    fill: [11, 0.4, 14, 2.5],
  },
  major: { classes: ['motorway', 'trunk', 'primary'], minzoom: 8, casing: [8, 1.2, 14, 6], fill: [8, 0.5, 14, 4] },
} as const

/** Minor roads, then major roads on top, each with its casing below it. */
function roadLayers(p: Palette): LayerSpecification[] {
  const layers: LayerSpecification[] = []
  for (const kind of p.minorRoads ? (['minor', 'major'] as const) : (['major'] as const)) {
    const road = ROADS[kind]
    const parts = p.roadCasing ? (['casing', 'fill'] as const) : (['fill'] as const)
    for (const part of parts) {
      const color = part === 'casing' ? p.roadCasing! : kind === 'major' ? p.roadMajor : p.roadMinor
      const width = p.roadWidth ? p.roadWidth[kind] + (part === 'casing' ? 1.5 : 0) : zoomRamp(...road[part])
      layers.push({
        id: `road-${kind}-${part}`,
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        minzoom: road.minzoom,
        filter: ['all', ['in', ['get', 'class'], ['literal', [...road.classes]]], ['!=', ['get', 'brunnel'], 'tunnel']],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': color, 'line-width': width },
      })
    }
  }
  return layers
}

/** Water names, then towns, cities and countries on top. */
function labelLayers(p: Palette, labels: Look['labels']): LayerSpecification[] {
  const name = nameField(labels, p.labelFont === 'jakarta')
  const font = FONTS[p.labelFont]
  const spaced = p.labelCase === 'upper-spaced'
  // Spaced capitals throughout, or the normal case's capitals for countries only.
  const caps = (spacing: number) =>
    spaced
      ? { 'text-transform': 'uppercase' as const, 'text-letter-spacing': SPACED }
      : { 'text-letter-spacing': spacing }
  const placePaint = (color: string) => ({ 'text-color': color, 'text-halo-color': p.halo, 'text-halo-width': 1.4 })
  const place = (
    cls: string,
    zoom: { minzoom?: number; maxzoom?: number },
    size: ExpressionSpecification,
    color: string,
  ): LayerSpecification => ({
    id: `place-${cls}`,
    type: 'symbol',
    source: 'openmaptiles',
    'source-layer': 'place',
    ...zoom,
    filter: ['==', ['get', 'class'], cls],
    layout: {
      'text-field': name,
      'text-font': [...font.regular],
      'text-size': size,
      'text-max-width': 8,
      'symbol-sort-key': ['get', 'rank'],
      ...(spaced ? caps(0) : {}),
    },
    paint: placePaint(color),
  })

  return [
    {
      id: 'water-name',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'water_name',
      filter: ['==', ['geometry-type'], 'Point'],
      layout: {
        'text-field': name,
        'text-font': [...font.regular],
        'text-size': zoomRamp(3, 11, 8, 14),
        'text-max-width': 8,
        ...caps(0.15),
      },
      paint: { 'text-color': p.labelWater, 'text-halo-color': p.haloWater ?? p.water, 'text-halo-width': 0.8 },
    },
    place('town', { minzoom: 8 }, zoomRamp(8, 11, 13, 14), p.labelTown),
    place('city', { minzoom: 4 }, zoomRamp(4, 11, 10, 18), p.label),
    {
      id: 'place-country',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'place',
      maxzoom: 9,
      filter: ['==', ['get', 'class'], 'country'],
      layout: {
        'text-field': name,
        'text-font': [...font.bold],
        'text-size': zoomRamp(2, 10, 6, 14),
        'text-transform': 'uppercase',
        'text-letter-spacing': spaced ? SPACED : 0.12,
        'text-max-width': 7,
        'symbol-sort-key': ['get', 'rank'],
      },
      paint: placePaint(p.labelCountry),
    },
  ]
}

/**
 * The basemap style for a theme. Every layer in it is basemap: the route layer pass hides them all, hill shading and
 * imagery included, while the style's `terrain` stays on. `blank` is a plain background and needs no network unless
 * terrain is on.
 */
export function buildStyle(theme: ThemeId, opts: StyleOptions): StyleSpecification {
  const terrain = opts.terrain ? { terrain: { source: TERRAIN_SOURCE, exaggeration: 1.3 } } : {}
  if (theme === 'blank') {
    const background: LayerSpecification = {
      id: 'background',
      type: 'background',
      paint: { 'background-color': BLANK_BACKGROUND },
    }
    if (!opts.terrain) return { version: 8, sources: {}, layers: [background] }
    return {
      version: 8,
      sources: { [TERRAIN_SOURCE]: terrainSource(opts.tileBase) },
      layers: [background, hillshadeLayer(BLANK_HILLSHADE)],
      ...terrain,
    }
  }

  const { palette: p, imagery } = THEMES_BY_ID[theme]
  // Terrarium carries sea-floor depth too, which would shade blotches into the imagery: satellite gets elevation only.
  const shaded = !imagery && usesElevation({ theme, terrain: opts.terrain })
  const sources: StyleSpecification['sources'] = {
    openmaptiles: { type: 'vector', url: `${opts.tileBase}planet` },
  }
  if (imagery) {
    sources.satellite = {
      type: 'raster',
      tiles: [`${opts.tileBase}satellite/{z}/{x}/{y}.jpg`],
      tileSize: 256,
      maxzoom: THEME_MAX_ZOOM.satellite,
    }
  }
  if (shaded || opts.terrain) sources[TERRAIN_SOURCE] = terrainSource(opts.tileBase)

  const base: LayerSpecification[] = imagery
    ? [{ id: 'satellite', type: 'raster', source: 'satellite', paint: { 'raster-fade-duration': 0 } }]
    : fillLayers(p)
  return {
    version: 8,
    glyphs: `${opts.tileBase}fonts/{fontstack}/{range}.pbf`,
    sources,
    layers: [
      ...base,
      ...(shaded ? [hillshadeLayer(p.hillshade)] : []),
      ...(imagery ? [] : waterLayers(p)),
      ...boundaryLayers(p),
      ...(imagery ? [] : roadLayers(p)),
      ...labelLayers(p, opts.labels),
    ],
    ...terrain,
  }
}
