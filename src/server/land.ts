import { readFile } from 'node:fs/promises'
import { decodeLand, landIndex, type LandData, type LandSource } from '../core/index.js'
import { StoreError } from './store.js'

/** The shipped land outlines. This resolves from both `src/server` and `dist/server`. */
export const LAND_FILE: URL = new URL('../../data/land-10m.bin', import.meta.url)

let loaded: Promise<LandData> | undefined
let indexed: Promise<LandSource> | undefined

/** The decoded land data, read once per process. A missing or bad file throws a `StoreError`. */
export function loadLandData(): Promise<LandData> {
  loaded ??= readFile(LAND_FILE).then(
    (bytes) => decodeLand(bytes),
    (err: unknown) => {
      throw landError(err)
    },
  )
  // A failure is not remembered, so a later call can try again.
  loaded.catch(() => {
    loaded = undefined
  })
  return loaded
}

function landError(err: unknown): StoreError {
  if (err instanceof StoreError) return err
  const why = err instanceof Error ? err.message : String(err)
  return new StoreError(`Could not load the land data: ${why}`, 'Reinstall Mapper, or run npm run build:land in its folder.')
}

/** The land as a searchable index, built once per process. */
export function loadLand(): Promise<LandSource> {
  indexed ??= loadLandData()
    .then((data) => landIndex(data))
    .catch((err: unknown) => {
      indexed = undefined
      throw landError(err)
    })
  return indexed
}
