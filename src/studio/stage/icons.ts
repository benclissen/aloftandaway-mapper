/**
 * Transport icons on a 24 by 24 grid, drawn with a 2 px stroke, round caps and joins, and no fill.
 *
 * `facing` says which way the drawing points: `right` is a side view facing east, `front` is upright (or
 * has no direction), `north-east` is Lucide's plane, and `up` points north.
 */
export interface IconDef {
  paths: string[]
  facing: 'right' | 'front' | 'north-east' | 'up'
}

// Lucide icons (https://lucide.dev, ISC licence, text in data/LICENSES/Lucide-ISC.txt). Everything between the
// markers is written by `npm run build:icons`: edit scripts/build-icons.ts, not this block.
// BEGIN GENERATED (npm run build:icons)
const LUCIDE_ICONS = {
  footprints: {
    facing: 'up',
    paths: [
      "M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z",
      "M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z",
      "M16 17h4",
      "M4 13h4",
    ],
  },
  bike: {
    facing: 'right',
    paths: [
      "M15 17.5a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0 -7 0Z",
      "M2 17.5a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0 -7 0Z",
      "M14 5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0Z",
      "M12 17.5V14l-3-3 4-3 2 3h2",
    ],
  },
  motorbike: {
    facing: 'right',
    paths: [
      "m18 14-1-3",
      "m3 9 6 2a2 2 0 0 1 2-2h2a2 2 0 0 1 1.99 1.81",
      "M8 17h3a1 1 0 0 0 1-1 6 6 0 0 1 6-6 1 1 0 0 0 1-1v-.75A5 5 0 0 0 17 5",
      "M16 17a3 3 0 1 0 6 0a3 3 0 1 0 -6 0Z",
      "M2 17a3 3 0 1 0 6 0a3 3 0 1 0 -6 0Z",
    ],
  },
  scooter: {
    facing: 'right',
    paths: [
      "M21 4h-3.5l2 11.05",
      "M6.95 17h5.142c.523 0 .95-.406 1.063-.916a6.5 6.5 0 0 1 5.345-5.009",
      "M17 17.5a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0Z",
      "M2 17.5a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0Z",
    ],
  },
  car: {
    facing: 'right',
    paths: [
      "M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2",
      "M5 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0Z",
      "M9 17h6",
      "M15 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0Z",
    ],
  },
  bus: {
    facing: 'right',
    paths: [
      "M8 6v6",
      "M15 6v6",
      "M2 12h19.6",
      "M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3",
      "M5 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0Z",
      "M9 18h5",
      "M14 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0Z",
    ],
  },
  'train-front': {
    facing: 'front',
    paths: [
      "M8 3.1V7a4 4 0 0 0 8 0V3.1",
      "m9 15-1-1",
      "m15 15 1-1",
      "M9 19c-2.8 0-5-2.2-5-5v-4a8 8 0 0 1 16 0v4c0 2.8-2.2 5-5 5Z",
      "m8 19-2 3",
      "m16 19 2 3",
    ],
  },
  'tram-front': {
    facing: 'front',
    paths: [
      "M6 3h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2Z",
      "M4 11h16",
      "M12 3v8",
      "m8 19-2 3",
      "m18 22-2-3",
      "M8 15h.01",
      "M16 15h.01",
    ],
  },
  'cable-car': {
    facing: 'front',
    paths: [
      "M10 3h.01",
      "M14 2h.01",
      "m2 9 20-5",
      "M12 12V6.5",
      "M7 12h10a3 3 0 0 1 3 3v4a3 3 0 0 1 -3 3h-10a3 3 0 0 1 -3 -3v-4a3 3 0 0 1 3 -3Z",
      "M9 12v5",
      "M15 12v5",
      "M4 17h16",
    ],
  },
  ship: {
    facing: 'front',
    paths: [
      "M12 2v2",
      "M12 9.189V13",
      "M19 12V6a2 2 0 00-2-2H7a2 2 0 00-2 2v6",
      "M19.38 19A11.6 11.6 0 0021 13l-8.188-3.639a2 2 0 00-1.624 0L3 13.001a11.6 11.6 0 002.81 7.76",
      "M2 20c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1s1.2 1 2.5 1c2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1",
    ],
  },
  sailboat: {
    facing: 'right',
    paths: [
      "M10 2v15",
      "M7 22a4 4 0 0 1-4-4 1 1 0 0 1 1-1h16a1 1 0 0 1 1 1 4 4 0 0 1-4 4z",
      "M9.159 2.46a1 1 0 0 1 1.521-.193l9.977 8.98A1 1 0 0 1 20 13H4a1 1 0 0 1-.824-1.567z",
    ],
  },
  kayak: {
    facing: 'north-east',
    paths: [
      "M18 17a1 1 0 0 0-1 1v1a2 2 0 1 0 2-2z",
      "M20.97 3.61a.45.45 0 0 0-.58-.58C10.2 6.6 6.6 10.2 3.03 20.39a.45.45 0 0 0 .58.58C13.8 17.4 17.4 13.8 20.97 3.61",
      "m6.707 6.707 10.586 10.586",
      "M7 5a2 2 0 1 0-2 2h1a1 1 0 0 0 1-1z",
    ],
  },
  plane: {
    facing: 'north-east',
    paths: [
      "M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z",
    ],
  },
  helicopter: {
    facing: 'right',
    paths: [
      "M11 17v4",
      "M14 3v8a2 2 0 0 0 2 2h5.865",
      "M17 17v4",
      "M18 17a4 4 0 0 0 4-4 8 6 0 0 0-8-6 6 5 0 0 0-6 5v3a2 2 0 0 0 2 2z",
      "M2 10v5",
      "M6 3h16",
      "M7 21h14",
      "M8 13H2",
    ],
  },
} satisfies Record<string, IconDef>
// END GENERATED

// Drawn for Mapper in Lucide's style. They are original artwork, not traced from any other icon set.
const MAPPER_ICONS = {
  campervan: {
    facing: 'right',
    paths: [
      'M5 18H3a1 1 0 0 1-1-1V8a2 2 0 0 1 2-2h11.5a2 2 0 0 1 1.6.8L21 12.5V17a1 1 0 0 1-1 1h-1',
      'M5 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0Z',
      'M15 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0Z',
      'M9 18h6',
      'M6 6V4h6v2',
      'M6 9.5h5v3H6Z',
      'M15.5 9.5l1.5 3h4',
    ],
  },
  coach: {
    facing: 'right',
    paths: [
      'M5 18H3a1 1 0 0 1-1-1V7a2 2 0 0 1 2-2h13a2 2 0 0 1 1.7 1L22 11.5V17a1 1 0 0 1-1 1h-2',
      'M5 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0Z',
      'M15 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0Z',
      'M9 18h6',
      'M5 8.5h10.5l2.5 3H5Z',
      'M2 14.5h20',
    ],
  },
  ferry: {
    facing: 'right',
    paths: ['M2 14h20l-3.5 6H2Z', 'M5 14V9h12v5', 'M8 9V5h5v4', 'M8 11.5h.01', 'M12 11.5h.01', 'M16 11.5h.01'],
  },
  speedboat: {
    facing: 'right',
    paths: ['M2 12h13l6.5 2.5-1.2 3a2 2 0 0 1-1.9 1.5H7a5 5 0 0 1-5-5Z', 'M8 12l2-4.5h4.5L16 12', 'M2 22h4', 'M9 22h3'],
  },
  balloon: {
    facing: 'front',
    paths: [
      'M12 2a7 7 0 0 0-7 7c0 3.5 2.5 6 5 8h4c2.5-2 5-4.5 5-8a7 7 0 0 0-7-7Z',
      'M10 17l.5 2.5',
      'M14 17l-.5 2.5',
      'M9.5 19.5h5V22h-5Z',
      'M12 2c-2 2.5-2.5 5-2.5 7s1 5 2.5 8',
    ],
  },
  arrow: { facing: 'up', paths: ['M12 3 5 20l7-4 7 4Z'] },
} satisfies Record<string, IconDef>

export type IconName = keyof typeof LUCIDE_ICONS | keyof typeof MAPPER_ICONS

export const ICONS: Record<IconName, IconDef> = { ...LUCIDE_ICONS, ...MAPPER_ICONS }
