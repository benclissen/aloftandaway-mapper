// Sea routing benchmark: five routes, each routed three ways. Cold is an empty temp cache dir and the live OpenFreeMap
// service. Disk is the same cache dir with a new tile store and a new SeaWater, so nothing is in memory. Memory is
// that same SeaWater again. Fetches zoom-12 tiles from the live service, so run it sparingly.
// Usage: npm run bench:sea [-- --profile]

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import type { LngLat } from '../src/core/index.js'
import { loadLand } from '../src/server/land.js'
import { createSeaWater, SEA_BUDGET_TILES, type SeaWater } from '../src/server/sea-water.js'
import { createTileStore, type TileStore } from '../src/server/tiles.js'

interface Place {
  name: string
  at: LngLat
}

const STOCKHOLM: Place = { name: 'Stockholm', at: [18.087, 59.317] }
const ROUTES: Array<[Place, Place]> = [
  [STOCKHOLM, { name: 'Sandhamn', at: [18.9073, 59.2893] }],
  [STOCKHOLM, { name: 'Mariehamn', at: [19.935, 60.095] }],
  [STOCKHOLM, { name: 'Helsinki', at: [24.95, 60.165] }],
  [{ name: 'Bergen', at: [5.32, 60.395] }, { name: 'Geiranger', at: [7.205, 62.101] }],
  [{ name: 'Piraeus', at: [23.6466, 37.942] }, { name: 'Mykonos', at: [25.3289, 37.4467] }],
]
/** The budgets, in seconds, for the disk pass on the user's Mac. */
const BUDGETS: Record<string, number> = { 'Stockholm–Mariehamn': 6, 'Stockholm–Helsinki': 10 }

type PassName = 'cold' | 'disk' | 'memory'

interface Row {
  route: string
  pass: PassName
  /** Tiles the route used, or the reason it came back unverified. */
  tiles: string
  rounds: string
  seconds: number
  /** Tiles fetched from OpenFreeMap during the pass (budget spent). */
  fetched: number
  /** Time spent inside tile `get` calls, summed over the (up to 4) requests in flight; and how many calls. */
  getSeconds: number
  gets: number
  status: string
}

/** Set MAPPER_TILE_UPSTREAM to point the bench at another tile server (or at a dead one, to see the offline message). */
const upstream = process.env.MAPPER_TILE_UPSTREAM || undefined

const log = (message: string) => process.stderr.write(`${message}\n`)

/** A tile store that counts and times its `get` calls, for the profile. */
function counted(store: TileStore): { store: TileStore; stats: { ms: number; gets: number } } {
  const stats = { ms: 0, gets: 0 }
  return {
    stats,
    store: {
      forget: (subpath) => store.forget(subpath),
      planetBuild: () => store.planetBuild(),
      async get(subpath, opts) {
        const start = performance.now()
        try {
          return await store.get(subpath, opts)
        } finally {
          stats.ms += performance.now() - start
          stats.gets++
        }
      },
    },
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { profile: { type: 'boolean', default: false } } })
  const base = await loadLand()
  const root = await mkdtemp(path.join(os.tmpdir(), 'mapper-bench-sea-'))
  const rows: Row[] = []
  try {
    // The build lookup doubles as the network check: no answer, no benchmark.
    try {
      await createTileStore({ cacheDir: path.join(root, 'probe'), upstream, retryDelaysMs: [] }).planetBuild()
    } catch (e) {
      log(`No network to OpenFreeMap (${e instanceof Error ? e.message : String(e)}); skipping the sea routing benchmark.`)
      return
    }

    for (const [a, b] of ROUTES) {
      const route = `${a.name}–${b.name}`
      const cacheDir = await mkdtemp(path.join(root, 'cache-'))

      const time = async (pass: PassName, water: SeaWater, stats: { ms: number; gets: number }): Promise<void> => {
        const budget = { tiles: SEA_BUDGET_TILES }
        stats.ms = 0
        stats.gets = 0
        const start = performance.now()
        const sea = await water.route(a.at, b.at, [], base, budget)
        const seconds = (performance.now() - start) / 1000
        const note = sea.water
        const verified = 'build' in note
        rows.push({
          route,
          pass,
          tiles: verified ? String(note.tiles) : `unverified: ${note.unverified}`,
          rounds: verified ? String(note.rounds) : '–',
          seconds,
          fetched: SEA_BUDGET_TILES - budget.tiles,
          getSeconds: stats.ms / 1000,
          gets: stats.gets,
          status: sea.status,
        })
        log(`${route} ${pass}: ${seconds.toFixed(2)} s, ${verified ? `${note.tiles} tiles, ${note.rounds} rounds` : `unverified (${note.unverified})`}`)
      }

      // Cold: an empty cache directory, so every tile comes from OpenFreeMap.
      const cold = counted(createTileStore({ cacheDir, upstream }))
      await time('cold', createSeaWater({ store: cold.store }), cold.stats)

      // Disk: the tiles are cached, but this store and SeaWater remember nothing.
      const disk = counted(createTileStore({ cacheDir, upstream }))
      const water = createSeaWater({ store: disk.store })
      await time('disk', water, disk.stats)

      // Memory: the same SeaWater, with its decoded tiles.
      await time('memory', water, disk.stats)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  const header = ['Route', 'Pass', 'Tiles', 'Rounds', 'Seconds', 'Fetched']
  if (values.profile) header.push('Tile gets (n, summed s)')
  const lines = [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`]
  for (const r of rows) {
    const cells = [r.route, r.pass, r.tiles, r.rounds, r.seconds.toFixed(2), String(r.fetched)]
    if (values.profile) cells.push(`${r.gets}, ${r.getSeconds.toFixed(2)}`)
    lines.push(`| ${cells.join(' | ')} |`)
  }
  process.stdout.write(`${lines.join('\n')}\n`)

  for (const [route, budget] of Object.entries(BUDGETS)) {
    const row = rows.find((r) => r.route === route && r.pass === 'disk')
    if (!row) continue
    const verdict = row.seconds <= budget ? 'within' : 'OVER'
    process.stdout.write(`${route} from disk: ${row.seconds.toFixed(2)} s, ${verdict} the ${budget} s budget\n`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
