/**
 * The two MapLibre internals that make a terrain frame the same however it was reached. Neither is documented API,
 * so each is looked up here and a clear error is thrown if a MapLibre upgrade moved it: quietly skipping either would
 * let frames depend on the frames rendered before them.
 */

/** The parts of a MapLibre map these helpers reach into. Everything is optional, since that is what they check. */
export interface TerrainInternalsMap {
  style?: { tileManagers?: Record<string, { clearTiles?: () => void } | undefined> }
  terrain?: { tileManager?: { releaseAllRTT?: () => void } } | null
}

function moved(what: string): Error {
  return new Error(
    `Mapper can't render terrain deterministically with this MapLibre version: ${what} is missing. ` +
      'Install the MapLibre version in package.json, or update src/studio/stage/terrain-internals.ts.',
  )
}

/** Forgets every tile of the elevation source `sourceId`, so the next frame loads its own. */
export function dropElevationTiles(map: TerrainInternalsMap, sourceId: string): void {
  const manager = map.style?.tileManagers?.[sourceId]
  if (typeof manager?.clearTiles !== 'function') throw moved(`map.style.tileManagers['${sourceId}'].clearTiles`)
  manager.clearTiles()
}

/** Drops every terrain tile's cached drawing, so the next repaint draws the terrain from scratch. */
export function redrawTerrain(map: TerrainInternalsMap): void {
  const manager = map.terrain?.tileManager
  if (typeof manager?.releaseAllRTT !== 'function') throw moved('map.terrain.tileManager.releaseAllRTT')
  manager.releaseAllRTT()
}
