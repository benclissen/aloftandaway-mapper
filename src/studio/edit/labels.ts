import { UNVERIFIED_CAUSE, type LegMode, type SeaPath, type SymbolKind, type ThemeId } from '../../core/index.js'

export const SYMBOL_LABELS: Record<SymbolKind, string> = {
  none: 'None',
  dot: 'Dot',
  arrow: 'Arrow',
  walk: 'Walking',
  bike: 'Bike',
  motorcycle: 'Motorcycle',
  scooter: 'Scooter',
  car: 'Car',
  campervan: 'Campervan',
  bus: 'Bus',
  coach: 'Coach',
  train: 'Train',
  tram: 'Tram',
  'cable-car': 'Cable car',
  ferry: 'Ferry',
  'cruise-ship': 'Cruise ship',
  sailboat: 'Sailboat',
  speedboat: 'Speedboat',
  kayak: 'Kayak',
  plane: 'Plane',
  helicopter: 'Helicopter',
  balloon: 'Hot air balloon',
}

export const MODE_LABELS: Record<LegMode, string> = { line: 'Line', land: 'Land', sea: 'Sea', air: 'Air' }

export const THEME_NAMES: Record<ThemeId, string> = {
  aloftandaway: 'Aloft & Away',
  'aloftandaway-warm': 'Aloft & Away warm',
  paper: 'Paper',
  light: 'Light',
  dark: 'Dark',
  nautical: 'Nautical',
  atlas: 'Atlas',
  outdoor: 'Outdoor',
  satellite: 'Satellite',
  monochrome: 'Monochrome',
  blank: 'Blank',
}

/**
 * The legs panel's note for a sea route that wasn't fully checked against the map's water. The network and the budget
 * clear by themselves, and the server pushes the checked route; an unsettled route stays as it is.
 */
export function unverifiedNote(why: NonNullable<SeaPath['unverified']>): string {
  return why === 'unsettled'
    ? `Only partly checked: ${UNVERIFIED_CAUSE[why]}. It may cross small islands near the ones it found.`
    : `Checked against Natural Earth only: ${UNVERIFIED_CAUSE[why]}. Mapper checks it again by itself.`
}
