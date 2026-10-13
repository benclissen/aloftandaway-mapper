import type { LngLat } from './schema.js'

/** Web Mercator world units: 0 to 1 across one world, x east, y south. Unwrapped longitudes can leave 0 to 1. */
export type XY = [number, number]

const EARTH_RADIUS_KM = 6371

export function toXY([lng, lat]: LngLat): XY {
  const phi = (lat * Math.PI) / 180
  return [(lng + 180) / 360, (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2]
}

/** Inverse of `toXY`. Does not wrap, so x beyond 1 gives a longitude beyond 180. */
export function toLngLat([x, y]: XY): LngLat {
  return [x * 360 - 180, ((2 * Math.atan(Math.exp(Math.PI * (1 - 2 * y))) - Math.PI / 2) * 180) / Math.PI]
}

/** Shift `lng` by whole turns so that it lies within 180 degrees of `prev`. */
export function unwrapLng(prev: number, lng: number): number {
  let out = lng
  while (out - prev > 180) out -= 360
  while (out - prev < -180) out += 360
  return out
}

export function haversineKm(a: LngLat, b: LngLat): number {
  const rad = Math.PI / 180
  const dLat = (b[1] - a[1]) * rad
  const dLng = (b[0] - a[0]) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Compass bearing of the step from `a` to `b`, clockwise from north, in [0, 360). */
export function headingDeg(a: XY, b: XY): number {
  const deg = (Math.atan2(b[0] - a[0], a[1] - b[1]) * 180) / Math.PI
  return (deg + 360) % 360
}
