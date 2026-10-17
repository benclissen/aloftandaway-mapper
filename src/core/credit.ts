import { MAP_CREDIT, type Project, type Scene } from './schema.js'

/** Required for the `satellite` style. Only the 2016 EOX Cloudless layer may be used (CC BY 4.0). */
export const SATELLITE_CREDIT = 'Sentinel-2 cloudless 2016 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016), CC BY 4.0'

/**
 * Required when the style uses elevation data (`look.terrain`, or `outdoor`; AWS Terrain Tiles). The Terrain Tiles documentation lists one line per source
 * dataset; this is those lines shortened to what fits in the burned-in credit strip, naming the sources that cover most of
 * the world. The `written` form carries the full text.
 */
export const TERRAIN_CREDIT = 'Terrain: USGS, Copernicus EU-DEM, NOAA ETOPO1 and others'

/**
 * The satellite credit as written into FCPXML notes, the manifest and tool text: the wording the EOxCloudless layer
 * asks for, with its link and licence.
 */
export const SATELLITE_CREDIT_WRITTEN =
  'EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016), CC BY 4.0'

/**
 * The terrain credit as written: the "required attribution" the Tilezen Joerd documentation lists for AWS Terrain
 * Tiles, one entry per source dataset.
 */
export const TERRAIN_CREDIT_WRITTEN =
  'Terrain: ' +
  [
    'ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and funded under National Science Foundation awards 1043681, 1559691, and 1542736',
    'Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017',
    'Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich',
    'Canada terrain data contains information licensed under the Open Government Licence – Canada',
    'Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers',
    'Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration',
    'Mexico terrain data source: INEGI, Continental relief, 2016',
    'New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and the New Zealand Government (All rights reserved)',
    'Norway terrain data © Kartverket',
    'United Kingdom terrain data © Environment Agency copyright and/or database right 2015. All rights reserved',
    'United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey',
  ].join('; ')

/**
 * Whether the style reads elevation data (AWS Terrain Tiles): `terrain` asks for 3D and hill shading, and `outdoor`
 * always shades hills. The credit and the style builder both ask this, so they can't disagree.
 */
export function usesElevation(look: { theme: string; terrain?: boolean }): boolean {
  return look.terrain === true || look.theme === 'outdoor'
}

/** `burned` is short enough for the credit strip on the picture; `written` is the full text for notes and the manifest. */
export type CreditForm = 'burned' | 'written'

/** Separates credit lines where one string is needed: FCPXML notes, the manifest, tool text. */
export const CREDIT_SEPARATOR = ' · '

/**
 * The credit lines a scene needs, in order. The map credit comes first, also for satellite (its labels are
 * OpenStreetMap data); `blank` shows no map data, so without elevation data it needs none.
 */
export function sceneCredit(scene: Scene, form: CreditForm = 'burned'): string[] {
  const { theme } = scene.look
  const lines: string[] = []
  if (theme !== 'blank') lines.push(MAP_CREDIT)
  if (theme === 'satellite') lines.push(form === 'written' ? SATELLITE_CREDIT_WRITTEN : SATELLITE_CREDIT)
  if (usesElevation(scene.look)) lines.push(form === 'written' ? TERRAIN_CREDIT_WRITTEN : TERRAIN_CREDIT)
  return lines
}

/** Every credit line the project's scenes need, once each, in first-seen order. */
export function projectCredit(project: Pick<Project, 'scenes'>, form: CreditForm = 'burned'): string[] {
  return [...new Set(project.scenes.flatMap((scene) => sceneCredit(scene, form)))]
}

/** Credit lines as one string. */
export function joinCredit(lines: readonly string[]): string {
  return lines.join(CREDIT_SEPARATOR)
}
