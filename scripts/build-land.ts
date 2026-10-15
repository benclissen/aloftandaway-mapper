// Builds data/land-10m.bin from Natural Earth. Downloads are untrusted: they go into a fresh
// temp folder and are only ever parsed as JSON.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { encodeLand } from '../src/core/land.js'
import type { LngLat } from '../src/core/schema.js'

const TAG = 'v5.1.2'
const VERSION = 'ne-10m-5.1.2'
const BASE = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${TAG}/geojson/`
const LAYERS = ['ne_10m_land.geojson', 'ne_10m_minor_islands.geojson']

interface Geometry {
  type: string
  coordinates: unknown
}

function collect(geometry: Geometry, rings: LngLat[][]): void {
  if (geometry.type === 'Polygon') {
    for (const ring of geometry.coordinates as number[][][]) rings.push(ring.map((p) => [p[0]!, p[1]!]))
  } else if (geometry.type === 'MultiPolygon') {
    for (const poly of geometry.coordinates as number[][][][])
      for (const ring of poly) rings.push(ring.map((p) => [p[0]!, p[1]!]))
  }
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mapper-land-'))
try {
  const rings: LngLat[][] = []
  for (const name of LAYERS) {
    const res = await fetch(BASE + name)
    if (!res.ok) throw new Error(`download of ${name} failed: ${res.status}`)
    const file = path.join(dir, name)
    await fs.writeFile(file, Buffer.from(await res.arrayBuffer()))
    const json = JSON.parse(await fs.readFile(file, 'utf8')) as { features: { geometry: Geometry | null }[] }
    for (const f of json.features) if (f.geometry) collect(f.geometry, rings)
  }
  const bytes = encodeLand(VERSION, rings)
  const out = path.join(import.meta.dirname, '..', 'data', 'land-10m.bin')
  await fs.writeFile(out, bytes)
  console.log(`${rings.length} rings, ${(bytes.length / 1024 / 1024).toFixed(2)} MB -> ${out}`)
} finally {
  await fs.rm(dir, { recursive: true, force: true })
}
