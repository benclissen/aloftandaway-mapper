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

export function symbolStyleOf(look: Look): SymbolStyle {
  return look.symbolStyle ?? 'badge'
}
