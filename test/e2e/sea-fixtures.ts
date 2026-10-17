import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSeaWater, type SeaWater } from '../../src/server/sea-water.js'
import { createTileStore } from '../../src/server/tiles.js'
import { startFakeTiles } from '../helpers/fake-tiles.js'

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/sea-tiles')

export interface SeaFixtures {
  /** The fake's origin. Pass it to an MCP child as `MAPPER_TILE_UPSTREAM`. */
  url: string
  /** A sea router on the fixtures with a cache of its own, for `resolveSeaPaths(folder, project, { water })`. */
  water: SeaWater
  /** Stops the fake, puts `MAPPER_TILE_UPSTREAM` back as it was and removes the cache. */
  close(): Promise<void>
}

/**
 * A fake OpenFreeMap serving the committed water-only fixtures, so an e2e test that routes a sea leg doesn't reach
 * the network. The fixtures cover the Greek Islands stops; a tile they don't have answers 204, an empty tile.
 *
 * With `env` (the default) it also sets `MAPPER_TILE_UPSTREAM` to the fake in this process, which the studio server
 * these tests start reads when it's created, so call it before the first page is opened. That server then serves the
 * fake's water-only tiles to the map as well. A file that needs live map tiles under MAPPER_NET passes `env: false`
 * and hands `water` to `resolveSeaPaths` instead.
 */
export async function startSeaFixtures(opts: { env?: boolean } = {}): Promise<SeaFixtures> {
  const setEnv = opts.env ?? true
  const previous = process.env.MAPPER_TILE_UPSTREAM
  const fake = await startFakeTiles(FIXTURES)
  const cache = await mkdtemp(path.join(os.tmpdir(), 'mapper-sea-fixtures-'))
  if (setEnv) process.env.MAPPER_TILE_UPSTREAM = fake.url
  return {
    url: fake.url,
    water: createSeaWater({ store: createTileStore({ cacheDir: cache, upstream: fake.url, retryDelaysMs: [] }) }),
    close: async () => {
      if (setEnv) {
        if (previous === undefined) delete process.env.MAPPER_TILE_UPSTREAM
        else process.env.MAPPER_TILE_UPSTREAM = previous
      }
      await fake.close()
      await rm(cache, { recursive: true, force: true })
    },
  }
}
