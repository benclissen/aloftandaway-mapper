// Builds test/fixtures/sea-tiles/: the water-only OpenFreeMap tiles the sea-route tests run on offline.
// It routes the fixture legs with the real SeaWater on live OpenFreeMap through a recording store, then writes the
// `water` layer of every zoom-12 tile a leg used and of every zoom-14 tile within 300 m of a leg's final path. Run by
// hand with network: `npm run build:sea-fixtures`. Tiles are cached in a fresh temp folder, so the output depends on
// OpenFreeMap's current planet build and nothing local.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'
import { toXY, tilesNear, WATER_ZOOM, type LngLat } from '../src/core/index.js'
import { loadLand } from '../src/server/land.js'
import { createSeaWater, SEA_BUDGET_TILES } from '../src/server/sea-water.js'
import { createTileStore, type TileReply, type TileStore } from '../src/server/tiles.js'
import { greekIslands } from '../test/fixtures/projects.js'
import { gunzipSync } from 'node:zlib'

const OUT = new URL('../test/fixtures/sea-tiles/', import.meta.url).pathname
const NEAR_ZOOM = 14
const NEAR_KM = 0.3
const STOP_LIMIT_M = 150
/** How far past the limit a stop's distance to water is still measured. */
const STOP_SEARCH_M = 600

interface Stop {
  name: string
  /** The coordinates the brief or project gave. */
  given: LngLat
  /** Where the leg actually starts or ends, when the given point was moved onto the water. */
  at?: LngLat
  /** Why it was moved. */
  why?: string
}

interface Leg {
  name: string
  from: Stop
  to: Stop
}

const stop = (name: string, given: LngLat, at?: LngLat, why?: string): Stop => ({ name, given, at, why })

const stadsgarden = stop('Stockholm, Stadsgården quay', [18.087, 59.317])
const sandhamn = stop(
  'Sandhamn harbour',
  [18.9105, 59.288],
  [18.9073, 59.2893],
  'The given point is on land, over 150 m from zoom-14 water; moved about 230 m north-west into the middle of the harbour inlet.',
)
const mariehamn = stop('Mariehamn, Västra hamnen', [19.925, 60.0935])
const greek = greekIslands().scenes[0]!.stops.map((s) => stop(s.name, s.at))

const LEGS: Leg[] = [
  { name: 'Stockholm to Sandhamn', from: stadsgarden, to: sandhamn },
  { name: 'Stockholm to Mariehamn', from: stadsgarden, to: mariehamn },
  { name: 'Piraeus to Mykonos', from: greek[0]!, to: greek[1]! },
  { name: 'Mykonos to Santorini', from: greek[1]!, to: greek[2]! },
  { name: 'Santorini to Rhodes', from: greek[2]!, to: greek[3]! },
]

const point = (s: Stop): LngLat => s.at ?? s.given

/** A store that remembers every subpath it was asked for. */
function recording(store: TileStore): TileStore & { asked: Set<string> } {
  const asked = new Set<string>()
  return {
    asked,
    forget: (subpath) => store.forget(subpath),
      planetBuild: () => store.planetBuild(),
    async get(subpath, opts) {
      asked.add(subpath)
      return store.get(subpath, opts)
    },
  }
}

function varint(buf: Uint8Array, at: number): [number, number] {
  let value = 0
  let shift = 0
  for (let i = at; ; i++) {
    const byte = buf[i]!
    value += (byte & 0x7f) * 2 ** shift
    shift += 7
    if (byte < 0x80) return [value, i + 1]
  }
}

/**
 * The bytes of the tile's `water` layer: the top-level field 3 (wire type 2) entry whose message has field 1 equal to
 * "water", key and length included, copied as they are. Undefined when the tile has no such layer.
 */
function waterLayer(body: Uint8Array): Uint8Array | undefined {
  const bytes = body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body
  let at = 0
  while (at < bytes.length) {
    const start = at
    const [key, afterKey] = varint(bytes, at)
    const field = key >> 3
    const wire = key & 7
    if (wire === 2) {
      const [length, bodyAt] = varint(bytes, afterKey)
      const end = bodyAt + length
      if (field === 3 && bytes[bodyAt] === 0x0a) {
        const [nameLength, nameAt] = varint(bytes, bodyAt + 1)
        if (Buffer.from(bytes.subarray(nameAt, nameAt + nameLength)).toString('utf8') === 'water') return bytes.subarray(start, end)
      }
      at = end
    } else if (wire === 0) at = varint(bytes, afterKey)[1]
    else if (wire === 1) at = afterKey + 8
    else if (wire === 5) at = afterKey + 4
    else throw new Error(`Unexpected wire type ${wire} in a tile`)
  }
  return undefined
}

async function tileBody(store: TileStore, build: string, z: number, x: number, y: number): Promise<TileReply> {
  const reply = await store.get(`planet/${build}/${z}/${x}/${y}.pbf`, { use: 'download' })
  if (reply.status !== 200 && reply.status !== 204) throw new Error(`Tile ${z}/${x}/${y} answered ${reply.status}`)
  return reply
}

/** Water features of a z14 tile as rings in tile units, tunnels left out, as the basemap draws them. */
async function waterFeatures(store: TileStore, build: string, x: number, y: number): Promise<{ extent: number; rings: { x: number; y: number }[][][] } | undefined> {
  const reply = await tileBody(store, build, NEAR_ZOOM, x, y)
  if (reply.status === 204) return undefined
  const body = reply.body[0] === 0x1f && reply.body[1] === 0x8b ? gunzipSync(reply.body) : reply.body
  const layer = new VectorTile(new PbfReader(body)).layers.water
  if (!layer) return undefined
  const rings: { x: number; y: number }[][][] = []
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i)
    if (feature.type !== 3 || feature.properties.brunnel === 'tunnel') continue
    rings.push(feature.loadGeometry())
  }
  return { extent: layer.extent, rings }
}

function inRing(px: number, py: number, ring: { x: number; y: number }[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!
    const b = ring[j]!
    if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** Metres from `at` to the nearest point sampled inside zoom-14 water (0 if `at` is in water), or undefined past `maxM`. */
async function metresToWater(store: TileStore, build: string, at: LngLat, maxM: number): Promise<number | undefined> {
  const cache = new Map<string, Awaited<ReturnType<typeof waterFeatures>>>()
  const span = 2 ** NEAR_ZOOM
  const wet = async (lng: number, lat: number): Promise<boolean> => {
    const [wx, wy] = toXY([lng, lat])
    const tx = Math.floor(wx * span)
    const ty = Math.floor(wy * span)
    const key = `${tx}/${ty}`
    if (!cache.has(key)) cache.set(key, await waterFeatures(store, build, tx, ty))
    const tile = cache.get(key)
    if (!tile) return false
    const px = (wx * span - tx) * tile.extent
    const py = (wy * span - ty) * tile.extent
    return tile.rings.some((feature) => feature.reduce((inside, ring) => (inRing(px, py, ring) ? !inside : inside), false))
  }
  const mPerDegLat = 111_320
  const mPerDegLng = mPerDegLat * Math.cos((at[1] * Math.PI) / 180)
  for (let r = 0; r <= maxM; r += 5) {
    const bearings = r === 0 ? 1 : 36
    for (let b = 0; b < bearings; b++) {
      const angle = (b / bearings) * 2 * Math.PI
      if (await wet(at[0] + (Math.sin(angle) * r) / mPerDegLng, at[1] + (Math.cos(angle) * r) / mPerDegLat)) return r
    }
  }
  return undefined
}

function pathKm(p: LngLat[]): number {
  let km = 0
  for (let i = 1; i < p.length; i++) {
    const [lng0, lat0] = p[i - 1]!
    const [lng1, lat1] = p[i]!
    const dLat = ((lat1 - lat0) * Math.PI) / 180
    const dLng = ((lng1 - lng0) * Math.PI) / 180
    const h = Math.sin(dLat / 2) ** 2 + Math.cos((lat0 * Math.PI) / 180) * Math.cos((lat1 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
    km += 2 * 6371 * Math.asin(Math.sqrt(h))
  }
  return km
}

const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mapper-sea-fixtures-'))
try {
  const store = createTileStore({ cacheDir })
  const build = await store.planetBuild()
  const base = await loadLand()
  const root = path.join(OUT, build)
  // Clear the old build folders and manifest; the README stays.
  await fs.mkdir(OUT, { recursive: true })
  for (const entry of await fs.readdir(OUT, { withFileTypes: true }))
    if (entry.isDirectory()) await fs.rm(path.join(OUT, entry.name), { recursive: true, force: true })

  console.log(`Planet build ${build}`)
  const stopReport: Record<string, unknown>[] = []
  const seen = new Set<string>()
  for (const leg of LEGS) {
    for (const s of [leg.from, leg.to]) {
      const id = `${s.name}@${point(s)}`
      if (seen.has(id)) continue
      seen.add(id)
      const m = await metresToWater(store, build, point(s), STOP_SEARCH_M)
      const far = m === undefined || m > STOP_LIMIT_M
      console.log(`  stop ${s.name} [${point(s)}]: ${m === undefined ? `more than ${STOP_SEARCH_M} m` : `${m} m`} from z14 water${far ? ` (OVER ${STOP_LIMIT_M} m)` : ''}`)
      stopReport.push({
        name: s.name,
        given: s.given,
        at: point(s),
        metresToWater: m ?? `over ${STOP_SEARCH_M}`,
        ...(s.why ? { adjusted: s.why } : {}),
        ...(far ? { note: `More than ${STOP_LIMIT_M} m from zoom-14 water. ${s.at ? 'Adjusted point still too far.' : 'Existing fixture coordinates, left as they are.'}` } : {}),
      })
    }
  }

  const z12 = new Map<string, Uint8Array | null>()
  const z14 = new Map<string, Uint8Array | null>()
  const legReport: Record<string, unknown>[] = []
  const keep = async (z: number, x: number, y: number, into: Map<string, Uint8Array | null>): Promise<void> => {
    const key = `${x}/${y}`
    if (into.has(key)) return
    const reply = await tileBody(store, build, z, x, y)
    into.set(key, reply.status === 204 || reply.body.length === 0 ? null : (waterLayer(reply.body) ?? null))
  }

  for (const leg of LEGS) {
    const t0 = Date.now()
    const rec = recording(store)
    const sea = await createSeaWater({ store: rec }).route(point(leg.from), point(leg.to), [], base, { tiles: SEA_BUDGET_TILES })
    const seconds = (Date.now() - t0) / 1000
    if (!('build' in sea.water)) throw new Error(`${leg.name} was not verified: ${JSON.stringify(sea.water)} ${sea.reason ?? ''}`)
    if (sea.status !== 'ok') throw new Error(`${leg.name} fell back: ${sea.reason}`)
    const used = [...rec.asked].flatMap((p) => {
      const m = new RegExp(`^planet/${build}/${WATER_ZOOM}/(\\d+)/(\\d+)\\.pbf$`).exec(p)
      return m ? [[Number(m[1]), Number(m[2])] as const] : []
    })
    if (used.length !== sea.water.tiles) throw new Error(`${leg.name}: fetched ${used.length} zoom-${WATER_ZOOM} tiles but the route used ${sea.water.tiles}`)
    for (const [x, y] of used) await keep(WATER_ZOOM, x, y, z12)
    const near = tilesNear(sea.path, { zoom: NEAR_ZOOM, bufferKm: NEAR_KM })
    for (const key of near) {
      const [x, y] = key.split('/').map(Number) as [number, number]
      await keep(NEAR_ZOOM, x % 2 ** NEAR_ZOOM, y, z14)
    }
    const km = pathKm(sea.path)
    console.log(`  leg ${leg.name}: verified, ${sea.water.rounds} rounds, ${sea.water.tiles} z12 tiles, ${near.length} z14 tiles, ${km.toFixed(1)} km, ${seconds.toFixed(1)} s, stop gaps ${JSON.stringify(sea.stopGapKm ?? null)}`)
    legReport.push({
      name: leg.name,
      from: { name: leg.from.name, at: point(leg.from) },
      to: { name: leg.to.name, at: point(leg.to) },
      verified: true,
      rounds: sea.water.rounds,
      z12Tiles: sea.water.tiles,
      z14TilesNear: near.length,
      km: Math.round(km * 10) / 10,
      pathPoints: sea.path.length,
    })
  }

  let files = 0
  let bytes = 0
  const write = async (z: number, tiles: Map<string, Uint8Array | null>): Promise<{ written: number; noWater: number }> => {
    let written = 0
    let noWater = 0
    for (const [key, layer] of tiles) {
      if (!layer) {
        noWater++
        continue
      }
      const [x, y] = key.split('/')
      const dir = path.join(root, String(z), x!)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, `${y}.pbf`), layer)
      written++
      files++
      bytes += layer.length
    }
    return { written, noWater }
  }
  const w12 = await write(WATER_ZOOM, z12)
  const w14 = await write(NEAR_ZOOM, z14)

  const manifest = {
    build,
    note: 'Water layer only, copied byte for byte from OpenFreeMap tiles. Written by npm run build:sea-fixtures.',
    legs: legReport,
    stops: stopReport,
    tiles: {
      [`z${WATER_ZOOM}`]: { ...w12, noWater: w12.noWater },
      [`z${NEAR_ZOOM}`]: { ...w14, noWater: w14.noWater },
      bytes,
      files,
    },
  }
  await fs.writeFile(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Wrote ${files} tiles, ${bytes} bytes of tile data, to ${OUT}`)
  console.log(`z${WATER_ZOOM}: ${w12.written} written, ${w12.noWater} with no water layer. z${NEAR_ZOOM}: ${w14.written} written, ${w14.noWater} with no water layer.`)
} finally {
  await fs.rm(cacheDir, { recursive: true, force: true })
}
