import { toXY } from './geo.js'
import type { Route } from './route.js'
import type { Look, SymbolKind, SymbolStyle } from './schema.js'

/**
 * How a symbol faces as it travels. `side` is a side view that flips to face east or west, `turn` rotates with the
 * line, `upright` always stands upright, and `none` draws nothing.
 */
export type SymbolFacing = 'side' | 'turn' | 'upright' | 'none'

export const SYMBOL_FACING: Record<SymbolKind, SymbolFacing> = {
  none: 'none',
  dot: 'upright',
  arrow: 'turn',
  walk: 'upright',
  bike: 'side',
  motorcycle: 'side',
  scooter: 'side',
  car: 'side',
  campervan: 'side',
  bus: 'side',
  coach: 'side',
  train: 'upright',
  tram: 'upright',
  'cable-car': 'upright',
  ferry: 'side',
  'cruise-ship': 'upright',
  sailboat: 'side',
  speedboat: 'side',
  kayak: 'side',
  plane: 'turn',
  helicopter: 'turn',
  balloon: 'upright',
}

/** The name of each symbol's icon in the studio's icon table. `none` and `dot` have no icon. */
export const SYMBOL_ICON = {
  walk: 'footprints',
  bike: 'bike',
  motorcycle: 'motorbike',
  scooter: 'scooter',
  car: 'car',
  campervan: 'campervan',
  bus: 'bus',
  coach: 'coach',
  train: 'train-front',
  tram: 'tram-front',
  'cable-car': 'cable-car',
  ferry: 'ferry',
  'cruise-ship': 'ship',
  sailboat: 'sailboat',
  speedboat: 'speedboat',
  kayak: 'kayak',
  plane: 'plane',
  helicopter: 'helicopter',
  balloon: 'balloon',
  arrow: 'arrow',
} as const satisfies Partial<Record<SymbolKind, string>>

/** The east-west direction of a leg is its end against its start, so a loop route flips once per leg. */
const FLIP_EPSILON = 1e-9

/**
 * Whether a side-view symbol faces west on this leg: its last point is west of its first by more than 1e-9 world
 * units. Route points are unwrapped, so a leg across the antimeridian is judged by where it actually travels. A
 * leg that runs due north or south, or that does not exist, is not flipped.
 */
export function legFlipped(route: Route, legIndex: number): boolean {
  const leg = route.legs[legIndex]
  if (!leg || leg.path.length < 2) return false
  const first = toXY(leg.path[0]!)
  const last = toXY(leg.path[leg.path.length - 1]!)
  return last[0] < first[0] - FLIP_EPSILON
}

/** Degrees to add to a turning drawing's rotation so it points along the line, by the way the drawing faces. */
export const TURN_OFFSET = { right: -90, 'north-east': -45, up: 0, front: 0 } as const

/** Two screen points closer than this, in layout px, have no direction between them. */
const MIN_SCREEN_STEP = 0.01

/**
 * The direction of the step from `from` to `to` on screen, in degrees clockwise from screen-up, in [0, 360). Points
 * are layout px with y growing downwards, so a step east is 90 and a step west 270. Undefined when the two points are
 * under 0.01 px apart.
 */
export function screenAngle(from: [number, number], to: [number, number]): number | undefined {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  if (Math.hypot(dx, dy) < MIN_SCREEN_STEP) return undefined
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI
  return (deg + 360) % 360
}

/** A line within this many degrees of straight up or down on screen takes its leg's east-west facing. */
const UPRIGHT_BAND_DEG = 15
const UPRIGHT_BAND = Math.sin((UPRIGHT_BAND_DEG * Math.PI) / 180)

/**
 * How to draw a turning symbol whose line runs at `angle` on screen (see `screenAngle`): the canvas rotation in
 * degrees, then whether to mirror the drawing top to bottom. Only a side view (`right`) is ever mirrored, when the
 * line points west on screen, so it stays the right way up. Within 15 degrees of vertical the leg's own facing
 * (`legFlipped`) decides, so a north-south leg doesn't flicker.
 */
export function turnPose(
  angle: number,
  facing: keyof typeof TURN_OFFSET,
  legFlipped: boolean,
): { rotate: number; mirrorY: boolean } {
  const rotate = angle + TURN_OFFSET[facing]
  if (facing !== 'right') return { rotate, mirrorY: false }
  const east = Math.sin((angle * Math.PI) / 180)
  return { rotate, mirrorY: Math.abs(east) <= UPRIGHT_BAND ? legFlipped : east < 0 }
}

export function symbolStyleOf(look: Look): SymbolStyle {
  return look.symbolStyle ?? 'badge'
}

/** Sizes of the head's symbol in layout px. The studio overlay draws with these, and sign placement measures with them. */
export const SYMBOL_SIZES = { dotRadius: 6, badgeRadius: 22, badgeRing: 3, iconSize: 26, iconHalo: 6 }

/** How far a symbol reaches from the head's centre in layout px, for keeping signs clear of it. */
export function vehicleRadius(symbol: SymbolKind, style: SymbolStyle): number {
  if (symbol === 'dot' || symbol === 'none') return SYMBOL_SIZES.dotRadius
  if (style === 'icon') return SYMBOL_SIZES.iconSize / 2 + SYMBOL_SIZES.iconHalo / 2
  return SYMBOL_SIZES.badgeRadius + SYMBOL_SIZES.badgeRing
}
