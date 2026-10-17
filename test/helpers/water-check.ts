import { gunzipSync } from 'node:zlib'
import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'
import { haversineKm, toXY, type LngLat } from '../../src/core/index.js'

/*
 * An independent check of a sea path against the basemap's own water polygons. It decodes a tile's `water` layer and
 * asks, for points along the path, whether each lies inside a water feature. It shares nothing with the router's
 * pixel reading (`rasteriseTile`): it is a plain point-in-polygon test on the decoded geometry, even-odd per feature,
 * OR across features, tunnels left out as the basemap's style does.
 */

interface WaterFeature {
  minX: number
  minY: number
  maxX: number
  maxY: number
  /** Every ring of the feature, as x then y pairs in tile units. */
  rings: Array<{ xs: Float64Array; ys: Float64Array }>
}

interface WaterTile {
  extent: number
  features: WaterFeature[]
}

/** The water features of a tile's bytes. A tile with no water layer has none. */
function decode(body: Uint8Array): WaterTile {
  const bytes = body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body
  const layer = new VectorTile(new PbfReader(bytes)).layers.water
  const tile: WaterTile = { extent: layer?.extent ?? 4096, features: [] }
  if (!layer) return tile
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i)
    if (feature.type !== 3 || feature.properties.brunnel === 'tunnel') continue
    const rings = feature.loadGeometry().map((ring) => ({ xs: Float64Array.from(ring, (p) => p.x), ys: Float64Array.from(ring, (p) => p.y) }))
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const ring of rings) {
      for (let k = 0; k < ring.xs.length; k++) {
        minX = Math.min(minX, ring.xs[k]!)
        maxX = Math.max(maxX, ring.xs[k]!)
        minY = Math.min(minY, ring.ys[k]!)
        maxY = Math.max(maxY, ring.ys[k]!)
      }
    }
    tile.features.push({ minX, minY, maxX, maxY, rings })
  }
  return tile
}

/** Whether (x, y) is inside the feature by the even-odd rule over all its rings. */
function inside(feature: WaterFeature, x: number, y: number): boolean {
  if (x < feature.minX || x > feature.maxX || y < feature.minY || y > feature.maxY) return false
  let odd = false
  for (const { xs, ys } of feature.rings) {
    for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
      if (ys[i]! > y !== ys[j]! > y && x < ((xs[j]! - xs[i]!) * (y - ys[i]!)) / (ys[j]! - ys[i]!) + xs[i]!) odd = !odd
    }
  }
  return odd
}

/** Points along `path` every `stepM` metres or closer, each with how far along the path it is, in metres. */
export function sampleAlong(path: LngLat[], stepM: number): Array<{ at: LngLat; m: number }> {
  const out: Array<{ at: LngLat; m: number }> = [{ at: path[0]!, m: 0 }]
  let along = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!
    const b = path[i]!
    const length = haversineKm(a, b) * 1000
    const n = Math.max(1, Math.ceil(length / stepM))
    for (let k = 1; k <= n; k++) {
      out.push({ at: [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n], m: along + (length * k) / n })
    }
    along += length
  }
  return out
}

export interface LandCheck {
  /** Samples checked, after the ends were skipped. */
  checked: number
  /** Samples whose tile had no file, which the check could not decide. */
  missing: number
  /** Samples inside no water feature, in path order. */
  land: Array<{ at: LngLat; m: number }>
}

export interface CheckOptions {
  zoom: number
  /** Distance between samples, in metres. */
  stepM: number
  /** Metres to leave out at the start and at the end of the path. */
  skipM: [number, number]
  /** A tile's bytes, or undefined when the tile has no file. */
  tile: (x: number, y: number) => Promise<Uint8Array | undefined>
  /** True when a sample whose tile has no file is on land. Without it such a sample counts as `missing`. */
  landWhenMissing?: (at: LngLat) => boolean
}

/** Samples `path` and finds the samples that lie outside every water feature of the tile they are in. */
export async function findLand(path: LngLat[], opts: CheckOptions): Promise<LandCheck> {
  const total = sampleAlong(path, opts.stepM)
  const length = total[total.length - 1]!.m
  const samples = total.filter((s) => s.m >= opts.skipM[0] && s.m <= length - opts.skipM[1])
  const span = 2 ** opts.zoom
  const tileOf = (at: LngLat): [number, number, number, number] => {
    const [ux, uy] = toXY(at)
    const tx = Math.floor(ux * span)
    const ty = Math.floor(uy * span)
    return [tx, ty, ux * span - tx, uy * span - ty]
  }
  const tiles = new Map<string, WaterTile | undefined>()
  const wanted = new Set<string>()
  for (const s of samples) {
    const [tx, ty] = tileOf(s.at)
    wanted.add(`${tx}/${ty}`)
  }
  await Promise.all(
    [...wanted].map(async (key) => {
      const [x, y] = key.split('/').map(Number) as [number, number]
      const bytes = await opts.tile(x, y)
      tiles.set(key, bytes === undefined ? undefined : decode(bytes))
    }),
  )
  const result: LandCheck = { checked: samples.length, missing: 0, land: [] }
  for (const s of samples) {
    const [tx, ty, fx, fy] = tileOf(s.at)
    const tile = tiles.get(`${tx}/${ty}`)
    if (!tile) {
      if (opts.landWhenMissing) {
        if (opts.landWhenMissing(s.at)) result.land.push(s)
      } else result.missing++
      continue
    }
    const x = fx * tile.extent
    const y = fy * tile.extent
    if (!tile.features.some((f) => inside(f, x, y))) result.land.push(s)
  }
  return result
}

/** The first ten land samples, for a failure message. */
export function showLand(check: LandCheck): string {
  return check.land
    .slice(0, 10)
    .map((s) => `${s.at[0].toFixed(6)},${s.at[1].toFixed(6)} (${Math.round(s.m)} m along)`)
    .join('\n')
}
