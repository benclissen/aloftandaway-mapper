import { STRAIGHT_LINE, TRACK_NEAR_KM, UNVERIFIED_CAUSE, type Leg, type LegChanges, type LegMode, type RouteLeg, type SeaPath, type SymbolKind, type ThemeId } from '../../core/index.js'

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

export const MODE_LABELS: Record<LegMode, string> = { line: 'Line', land: 'Land', sea: 'Sea', air: 'Air', track: 'Recorded track' }

const MODES = Object.keys(MODE_LABELS) as LegMode[]

/**
 * The modes the legs panel offers for a leg. Recorded track needs a track to follow, so only a leg that has one gets it.
 * A leg on another mode keeps its `track`, which is how the studio can switch back.
 */
export function legModeOptions(leg: Pick<Leg, 'mode' | 'track'>): LegMode[] {
  return MODES.filter((m) => m !== 'track' || leg.track !== undefined || leg.mode === 'track')
}

/** What `update_leg` changes when the user picks `mode`. A track leg takes no via points; leaving one keeps its track. */
export function legModeChanges(mode: LegMode): LegChanges {
  return mode === 'track' ? { mode, via: [] } : { mode }
}

/**
 * The legs panel's note for a track leg that isn't drawn as logged: its file is missing, or a stop is more than
 * `TRACK_NEAR_KM` from the track, so the line jumps to it. The larger gap is the one named.
 */
export function trackNote(track: RouteLeg['track']): string | undefined {
  if (!track) return undefined
  if (track.status === 'missing') return "Its recorded track file is missing, so it's drawn as a straight line."
  const km = Math.max(...(track.stopGapKm ?? [0]))
  return km > TRACK_NEAR_KM ? `A stop is ${km.toFixed(1)} km from the recorded track.` : undefined
}

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
 * The legs panel's note for a sea leg drawn as a line because no route was found. An unverified one has none:
 * `unverifiedNote` says the same, and why.
 */
export function fallbackNote(sea: RouteLeg['sea']): string | undefined {
  if (sea?.status !== 'fallback' || sea.unverified) return undefined
  return sea.reason ? `No sea route found: ${sea.reason}. Drawn as a line.` : 'No sea route found. Drawn as a line.'
}

/**
 * The legs panel's note for a sea route that wasn't fully checked against the map's water. The network and the budget
 * clear by themselves, and the server pushes the checked route; an unsettled route stays as it is.
 */
export function unverifiedNote(why: NonNullable<SeaPath['unverified']>, status: SeaPath['status'] | 'pending'): string {
  if (status === 'fallback') {
    const line = `No route found: ${UNVERIFIED_CAUSE[why]}. ${STRAIGHT_LINE[0]!.toUpperCase()}${STRAIGHT_LINE.slice(1)}.`
    return why === 'unsettled' ? line : `${line} Mapper checks it again by itself.`
  }
  return why === 'unsettled'
    ? `Only partly checked: ${UNVERIFIED_CAUSE[why]}. It may cross small islands near the ones it found.`
    : `Checked against Natural Earth only: ${UNVERIFIED_CAUSE[why]}. Mapper checks it again by itself.`
}
