import type { LegMode, SymbolKind, ThemeId } from '../../core/index.js'

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

export const THEME_LABELS: Record<ThemeId, string> = { paper: 'Paper', blank: 'Blank' }
