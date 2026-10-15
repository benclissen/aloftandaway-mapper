import { z } from 'zod'
import type { Leg, Project, Scene, SymbolKind } from './schema.js'

// A frozen copy of the version 1 project schema, as stage 1 and 2 wrote it. It must not change when the current
// schema does, so it shares nothing with schema.ts but types. Never edit it to follow the current schema.

const V1_FPS = [
  { num: 24000, den: 1001 },
  { num: 24, den: 1 },
  { num: 25, den: 1 },
  { num: 30000, den: 1001 },
  { num: 30, den: 1 },
  { num: 50, den: 1 },
  { num: 60000, den: 1001 },
  { num: 60, den: 1 },
] as const

const V1_MAX_LAT = 85.0511

const LngLatV1 = z.tuple([z.number().min(-180).max(180), z.number().min(-V1_MAX_LAT).max(V1_MAX_LAT)])

const FpsV1 = z
  .strictObject({ num: z.number().int().positive(), den: z.number().int().positive() })
  .refine((f) => V1_FPS.some((a) => a.num === f.num && a.den === f.den), {
    message: `fps must be one of ${V1_FPS.map((a) => `${a.num}/${a.den}`).join(', ')}`,
  })

const OutputV1 = z.strictObject({
  aspect: z.enum(['16:9', '9:16', '1:1', '4:5']),
  height: z.union([z.literal(1080), z.literal(1440), z.literal(2160)]),
  fps: FpsV1,
})

const secondsV1 = z.number().min(0)

const StopV1 = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  at: LngLatV1,
  label: z.string().optional(),
  pause: secondsV1,
  sign: z.enum(['always', 'on-arrival', 'none']),
  terminal: z.boolean().optional(),
  day: z.number().int().optional(),
  ref: z.string().optional(),
})

const SymbolKindV1 = z.enum(['none', 'dot', 'arrow', 'ship', 'plane', 'car', 'train', 'walk'])
type SymbolKindV1 = z.infer<typeof SymbolKindV1>

const LegV1 = z.strictObject({
  mode: z.enum(['sea', 'air', 'land', 'line']),
  via: z.array(LngLatV1),
  symbol: SymbolKindV1.optional(),
})

const LookV1 = z.strictObject({
  theme: z.enum(['paper', 'blank']),
  labels: z.enum(['local', 'en']),
  terrain: z.boolean(),
  line: z.strictObject({
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb colour'),
    width: z.number().min(0.5).max(40),
    dash: z.enum(['solid', 'dashed', 'dotted']),
    outline: z.boolean(),
    glow: z.boolean(),
  }),
  symbol: SymbolKindV1,
  signStyle: z.enum(['tag']),
})

const ShotV1 = z.strictObject({
  center: LngLatV1,
  zoom: z.number().min(0).max(22),
  bearing: z.number().min(-180).max(180),
  pitch: z.number().min(0).max(60),
})

const CameraV1 = z.strictObject({
  mode: z.enum(['fixed', 'glide', 'follow']),
  start: ShotV1.optional(),
  end: ShotV1.optional(),
  follow: z
    .strictObject({
      zoom: z.number().min(0).max(22),
      orient: z.enum(['north', 'heading']),
      lookAhead: z.number().min(0),
      smoothing: z.number().min(0).max(1),
    })
    .optional(),
  easing: z.enum(['linear', 'smooth']),
})

export const ProjectV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    name: z.string(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    output: OutputV1,
    timing: z.strictObject({ holdStart: secondsV1, travel: secondsV1, holdEnd: secondsV1 }),
    stops: z.array(StopV1),
    legs: z.array(LegV1),
    look: LookV1,
    camera: CameraV1,
    credit: z.enum(['burned', 'description']),
  })
  .superRefine((project, ctx) => {
    const expectedLegs = Math.max(0, project.stops.length - 1)
    if (project.legs.length !== expectedLegs) {
      ctx.addIssue({
        code: 'custom',
        path: ['legs'],
        message: `expected ${expectedLegs} legs for ${project.stops.length} stops, got ${project.legs.length}`,
      })
    }
    const seen = new Set<string>()
    project.stops.forEach((stop, i) => {
      if (seen.has(stop.id)) {
        ctx.addIssue({ code: 'custom', path: ['stops', i, 'id'], message: `duplicate stop id '${stop.id}'` })
      }
      seen.add(stop.id)
    })
  })
export type ProjectV1 = z.infer<typeof ProjectV1Schema>

/** Version 1 symbol names that changed in version 2. The rest kept their names. */
const RENAMED_SYMBOLS: Partial<Record<SymbolKindV1, SymbolKind>> = { ship: 'cruise-ship' }

const upgradeSymbol = (symbol: SymbolKindV1): SymbolKind => RENAMED_SYMBOLS[symbol] ?? (symbol as SymbolKind)

/**
 * Upgrades a parsed version 1 project to version 2: its scene fields become one scene with the project's id and name,
 * each via point becomes `{ at }`, and renamed symbols take their new names. The result still needs parsing with the
 * current schema.
 */
export function upgradeV1(v1: ProjectV1): unknown {
  const legs = v1.legs.map((leg): Leg => {
    const { symbol, ...rest } = leg
    return {
      ...rest,
      via: leg.via.map((at) => ({ at })),
      ...(symbol !== undefined ? { symbol: upgradeSymbol(symbol) } : {}),
    }
  })
  const scene: Scene = {
    id: v1.id,
    name: v1.name,
    timing: v1.timing,
    stops: v1.stops,
    legs,
    look: { ...v1.look, symbol: upgradeSymbol(v1.look.symbol) },
    camera: v1.camera,
  }
  const project: Project = {
    schemaVersion: 2,
    id: v1.id,
    name: v1.name,
    createdAt: v1.createdAt,
    updatedAt: v1.updatedAt,
    output: v1.output,
    credit: v1.credit,
    scenes: [scene],
  }
  return project
}
