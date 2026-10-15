import { toLngLat, toXY, unwrapLng, type XY } from './geo.js'
import type { Route } from './route.js'
import { layoutSize, type Aspect, type LngLat, type Scene, type Shot } from './schema.js'
import { ease, type Timeline } from './timeline.js'

/** Tile size in layout px. The world is `TILE_SIZE · 2^zoom` layout px across at `zoom`. */
export const TILE_SIZE = 512

const DEFAULT_PADDING = 0.12
const FIT_MIN_ZOOM = 0
const FIT_MAX_ZOOM = 16
/** Zoom for bounds that are a single point. */
const POINT_ZOOM = 12
const MIN_ZOOM = 0
const MAX_ZOOM = 22
/** van Wijk & Nuij's ρ: how far the fly path zooms out for a given move. */
const RHO = 1.42
/** Below this distance in world units the centres count as the same. */
const SAME_CENTRE = 1e-9

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

/** `deg` in (-180, 180]. */
function normaliseBearing(deg: number): number {
  const n = ((deg % 360) + 360) % 360
  return n > 180 ? n - 360 : n
}

/**
 * The shot that frames `bounds` (south-west and north-east corners) in the layout frame of `aspect`, leaving `padding`
 * of each side clear. The centre is the Mercator mid-point, so its longitude may be unwrapped beyond 180.
 */
export function fitShot(bounds: [LngLat, LngLat], aspect: Aspect, padding: number = DEFAULT_PADDING): Shot {
  const [sw, ne] = bounds
  const a = toXY(sw)
  const b = toXY(ne)
  const center = toLngLat([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])
  const dx = Math.abs(b[0] - a[0])
  const dy = Math.abs(b[1] - a[1])
  const { width, height } = layoutSize(aspect)
  const inner = 1 - 2 * padding
  // World size in layout px that fits each axis; the tighter axis wins.
  const fits = [dx > 0 ? (width * inner) / dx : Infinity, dy > 0 ? (height * inner) / dy : Infinity]
  const worldPx = Math.min(...fits)
  const zoom = worldPx === Infinity ? POINT_ZOOM : clamp(Math.log2(worldPx / TILE_SIZE), FIT_MIN_ZOOM, FIT_MAX_ZOOM)
  return { center, zoom, bearing: 0, pitch: 0 }
}

/** The scene camera's start and end shots. A missing one is fitted to the route's bounds in the output aspect. */
export function resolveShots(scene: Scene, aspect: Aspect, route: Route): { start: Shot; end: Shot } {
  const { start, end } = scene.camera
  const fitted = () => fitShot(route.bounds, aspect)
  return { start: start ?? fitted(), end: end ?? fitted() }
}

/**
 * Smooth zoom-and-pan from `a` (u = 0) to `b` (u = 1) after van Wijk & Nuij (2003), "Smooth and efficient zooming and
 * panning", worked in Mercator world units with the viewport width taken as the layout frame's larger side. `b`'s
 * longitude is unwrapped against `a`'s, so the move takes the short way round. Bearing takes the shortest turn and
 * pitch is linear.
 */
export function flyInterpolator(a: Shot, b: Shot, aspect: Aspect): (u: number) => Shot {
  const { width, height } = layoutSize(aspect)
  const side = Math.max(width, height)
  /** Viewport width in world units at `zoom`, and back. */
  const widthAt = (zoom: number) => side / (TILE_SIZE * 2 ** zoom)
  const zoomAt = (w: number) => Math.log2(side / (TILE_SIZE * w))

  const c0 = toXY(a.center)
  const c1 = toXY([unwrapLng(a.center[0], b.center[0]), b.center[1]])
  const w0 = widthAt(a.zoom)
  const w1 = widthAt(b.zoom)
  const u1 = Math.hypot(c1[0] - c0[0], c1[1] - c0[1])

  const turn = normaliseBearing(b.bearing - a.bearing)
  const rest = (u: number) => ({
    bearing: normaliseBearing(a.bearing + turn * u),
    pitch: a.pitch + (b.pitch - a.pitch) * u,
  })

  if (u1 < SAME_CENTRE) {
    return (raw) => {
      const u = clamp(raw, 0, 1)
      const xy: XY = [c0[0] + (c1[0] - c0[0]) * u, c0[1] + (c1[1] - c0[1]) * u]
      return { center: toLngLat(xy), zoom: a.zoom + (b.zoom - a.zoom) * u, ...rest(u) }
    }
  }

  // b_i = (w1² − w0² ± ρ⁴u1²) / (2 w_i ρ² u1), r_i = ln(−b_i + √(b_i² + 1)) = −asinh(b_i).
  const rho2 = RHO * RHO
  const r0 = -Math.asinh((w1 * w1 - w0 * w0 + rho2 * rho2 * u1 * u1) / (2 * w0 * rho2 * u1))
  const r1 = -Math.asinh((w1 * w1 - w0 * w0 - rho2 * rho2 * u1 * u1) / (2 * w1 * rho2 * u1))
  const pathLength = (r1 - r0) / RHO
  const dir: XY = [(c1[0] - c0[0]) / u1, (c1[1] - c0[1]) / u1]
  const k = w0 / rho2

  return (raw) => {
    const u = clamp(raw, 0, 1)
    const s = u * pathLength
    // Distance along the move and viewport width at path parameter s.
    const along = k * Math.cosh(r0) * Math.tanh(RHO * s + r0) - k * Math.sinh(r0)
    const w = (w0 * Math.cosh(r0)) / Math.cosh(RHO * s + r0)
    const xy: XY = [c0[0] + dir[0] * along, c0[1] + dir[1] * along]
    return { center: toLngLat(xy), zoom: clamp(zoomAt(w), MIN_ZOOM, MAX_ZOOM), ...rest(u) }
  }
}

/**
 * The map view on `frame`. `fixed` holds `start`. `glide` flies from `start` to `end` across the travel section with
 * `camera.easing` applied once to the overall travel progress, holding at both ends. `follow` acts as `glide` for now.
 */
export function cameraAt(scene: Scene, aspect: Aspect, route: Route, timeline: Timeline, frame: number): Shot {
  const { start, end } = resolveShots(scene, aspect, route)
  if (scene.camera.mode === 'fixed') {
    const [lng, lat] = start.center
    return { center: [lng, lat], zoom: start.zoom, bearing: normaliseBearing(start.bearing), pitch: start.pitch }
  }
  const { travelT } = timeline.stateAt(frame)
  return flyInterpolator(start, end, aspect)(ease(scene.camera.easing, travelT))
}
