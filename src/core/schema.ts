import { z } from 'zod'
import { ProjectV1Schema, upgradeV1 } from './migrate.js'

// Constants

export const ALLOWED_FPS = [
  { num: 24000, den: 1001 },
  { num: 24, den: 1 },
  { num: 25, den: 1 },
  { num: 30000, den: 1001 },
  { num: 30, den: 1 },
  { num: 50, den: 1 },
  { num: 60000, den: 1001 },
  { num: 60, den: 1 },
] as const

export const THEMES = ['paper', 'blank'] as const
export type ThemeId = (typeof THEMES)[number]

/** Highest zoom each theme's tiles cover. Shots deeper than this over-zoom the last tile level. */
export const THEME_MAX_ZOOM: Record<ThemeId, number> = { paper: 14, blank: 22 }

export const SIGN_STYLES = ['tag'] as const

export const MAP_CREDIT = '© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap'

// Schemas

/** The schema's latitude limit. MapLibre's own is a little higher (85.051129), so views are clamped to this. */
export const MAX_LAT = 85.0511

export const LngLatSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-MAX_LAT).max(MAX_LAT)])
export type LngLat = z.infer<typeof LngLatSchema>

export const AspectSchema = z.enum(['16:9', '9:16', '1:1', '4:5'])
export type Aspect = z.infer<typeof AspectSchema>

export const FpsSchema = z
  .strictObject({ num: z.number().int().positive(), den: z.number().int().positive() })
  .refine((f) => ALLOWED_FPS.some((a) => a.num === f.num && a.den === f.den), {
    message: `fps must be one of ${ALLOWED_FPS.map((a) => `${a.num}/${a.den}`).join(', ')}`,
  })
export type Fps = z.infer<typeof FpsSchema>

export const OutputSchema = z.strictObject({
  aspect: AspectSchema,
  height: z.union([z.literal(1080), z.literal(1440), z.literal(2160)]),
  fps: FpsSchema,
})
export type Output = z.infer<typeof OutputSchema>

const seconds = z.number().min(0)

export const TimingSchema = z.strictObject({ holdStart: seconds, travel: seconds, holdEnd: seconds })
export type Timing = z.infer<typeof TimingSchema>

const SignVisibilitySchema = z.enum(['always', 'on-arrival', 'none'])

export const StopSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  at: LngLatSchema,
  label: z.string().optional(),
  pause: seconds,
  sign: SignVisibilitySchema,
  terminal: z.boolean().optional(),
  /** The line makes a corner here instead of curving through. */
  sharp: z.boolean().optional(),
  day: z.number().int().optional(),
  ref: z.string().optional(),
})
export type Stop = z.infer<typeof StopSchema>

export const LegModeSchema = z.enum(['sea', 'air', 'land', 'line'])
export type LegMode = z.infer<typeof LegModeSchema>

/** Every transport symbol, in the order the studio lists them. */
export const SYMBOLS = [
  'none',
  'dot',
  'arrow',
  'walk',
  'bike',
  'motorcycle',
  'scooter',
  'car',
  'campervan',
  'bus',
  'coach',
  'train',
  'tram',
  'cable-car',
  'ferry',
  'cruise-ship',
  'sailboat',
  'speedboat',
  'kayak',
  'plane',
  'helicopter',
  'balloon',
] as const

export const SymbolKindSchema = z.enum(SYMBOLS)
export type SymbolKind = z.infer<typeof SymbolKindSchema>

const SEA_SYMBOLS: ReadonlySet<SymbolKind> = new Set(['ferry', 'cruise-ship', 'sailboat', 'speedboat', 'kayak'])
const AIR_SYMBOLS: ReadonlySet<SymbolKind> = new Set(['plane', 'helicopter', 'balloon'])
const LINE_SYMBOLS: ReadonlySet<SymbolKind> = new Set(['none', 'dot', 'arrow'])

/** The leg mode a transport implies when it is set without one: boats sail, aircraft fly, markers draw a line. */
export function defaultModeFor(symbol: SymbolKind): LegMode {
  if (SEA_SYMBOLS.has(symbol)) return 'sea'
  if (AIR_SYMBOLS.has(symbol)) return 'air'
  if (LINE_SYMBOLS.has(symbol)) return 'line'
  return 'land'
}

export const ViaPointSchema = z.strictObject({
  at: LngLatSchema,
  /** A corner instead of a curve. */
  sharp: z.boolean().optional(),
})
export type ViaPoint = z.infer<typeof ViaPointSchema>

export const LegSchema = z.strictObject({
  mode: LegModeSchema,
  via: z.array(ViaPointSchema),
  /** Overrides `look.symbol` for this leg. */
  symbol: SymbolKindSchema.optional(),
})
export type Leg = z.infer<typeof LegSchema>

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb colour')

export const LookSchema = z.strictObject({
  theme: z.enum(THEMES),
  labels: z.enum(['local', 'en']),
  terrain: z.boolean(),
  line: z.strictObject({
    color: HexColor,
    width: z.number().min(0.5).max(40),
    dash: z.enum(['solid', 'dashed', 'dotted']),
    outline: z.boolean(),
    glow: z.boolean(),
  }),
  symbol: SymbolKindSchema,
  signStyle: z.enum(SIGN_STYLES),
})
export type Look = z.infer<typeof LookSchema>

export const ShotSchema = z.strictObject({
  center: LngLatSchema,
  zoom: z.number().min(0).max(22),
  bearing: z.number().min(-180).max(180),
  pitch: z.number().min(0).max(60),
})
export type Shot = z.infer<typeof ShotSchema>

export const CameraSchema = z.strictObject({
  mode: z.enum(['fixed', 'glide', 'follow']),
  start: ShotSchema.optional(),
  end: ShotSchema.optional(),
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
export type Camera = z.infer<typeof CameraSchema>

export const SceneSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  timing: TimingSchema,
  /** In travel order. */
  stops: z.array(StopSchema),
  /** `stops.length - 1` of them; leg i joins stop i and stop i + 1. */
  legs: z.array(LegSchema),
  look: LookSchema,
  camera: CameraSchema,
})
export type Scene = z.infer<typeof SceneSchema>

export const ProjectSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    id: z.uuid(),
    name: z.string(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    /** Shared by every scene. */
    output: OutputSchema,
    credit: z.enum(['burned', 'description']),
    /** In film order. */
    scenes: z.array(SceneSchema).min(1),
  })
  .superRefine((project, ctx) => {
    const sceneIds = new Set<string>()
    project.scenes.forEach((scene, i) => {
      if (sceneIds.has(scene.id)) {
        ctx.addIssue({ code: 'custom', path: ['scenes', i, 'id'], message: `duplicate scene id '${scene.id}'` })
      }
      sceneIds.add(scene.id)
      const expectedLegs = Math.max(0, scene.stops.length - 1)
      if (scene.legs.length !== expectedLegs) {
        ctx.addIssue({
          code: 'custom',
          path: ['scenes', i, 'legs'],
          message: `expected ${expectedLegs} legs for ${scene.stops.length} stops, got ${scene.legs.length}`,
        })
      }
      const stopIds = new Set<string>()
      scene.stops.forEach((stop, j) => {
        if (stopIds.has(stop.id)) {
          ctx.addIssue({ code: 'custom', path: ['scenes', i, 'stops', j, 'id'], message: `duplicate stop id '${stop.id}'` })
        }
        stopIds.add(stop.id)
      })
    })
  })
export type Project = z.infer<typeof ProjectSchema>

/** A stop as the agent supplies it. Defaults (pause 0, sign 'always', a fresh id) are applied when it becomes a Stop. */
export const StopInputSchema = z.strictObject({
  name: z.string(),
  at: LngLatSchema,
  day: z.number().int().optional(),
  label: z.string().optional(),
  pause: seconds.optional(),
  sign: SignVisibilitySchema.optional(),
  terminal: z.boolean().optional(),
  ref: z.string().optional(),
  /** Sets the symbol of the leg leaving this stop; unless `legMode` is given, also its mode. */
  symbol: SymbolKindSchema.optional(),
  legMode: LegModeSchema.optional(),
})
export type StopInput = z.infer<typeof StopInputSchema>

// Errors and parsing

export interface ProjectIssue {
  path: (string | number)[]
  message: string
}

export class ProjectError extends Error {
  readonly issues: ProjectIssue[]

  constructor(issues: ProjectIssue[]) {
    super(issues.map((i) => `${i.path.length ? i.path.join('.') : '(project)'}: ${i.message}`).join('\n'))
    this.name = 'ProjectError'
    this.issues = issues
  }
}

/** Flatten a Zod error into `ProjectIssue`s. Unknown keys get their own path entry. */
export function zodIssues(error: z.ZodError): ProjectIssue[] {
  return error.issues.flatMap((issue): ProjectIssue[] => {
    const path = issue.path.map((p) => (typeof p === 'number' ? p : String(p)))
    // Point at the offending key itself, not just its parent object.
    if (issue.code === 'unrecognized_keys') return issue.keys.map((key) => ({ path: [...path, key], message: 'unknown key' }))
    return [{ path, message: issue.message }]
  })
}

/** The schema version this build of Mapper writes. */
export const SCHEMA_VERSION = 2

function parseWith<T>(schema: z.ZodType<T>, json: unknown): T {
  const result = schema.safeParse(json)
  if (result.success) return result.data
  throw new ProjectError(zodIssues(result.error))
}

/**
 * Parses a project file of any version this build reads. A version 1 file is checked against the version 1 schema,
 * so its issues carry version 1 paths, and is then upgraded in memory to version 2. It is written as version 2 only
 * on the next save.
 */
export function parseProject(json: unknown): Project {
  const version = typeof json === 'object' && json !== null ? (json as { schemaVersion?: unknown }).schemaVersion : undefined
  if (version === 1) return parseWith(ProjectSchema, upgradeV1(parseWith(ProjectV1Schema, json)))
  if (typeof version === 'number' && version > SCHEMA_VERSION) {
    throw new ProjectError([
      {
        path: ['schemaVersion'],
        message: `This project was made by a newer version of Mapper (schema version ${version}). Update Mapper to open it.`,
      },
    ])
  }
  return parseWith(ProjectSchema, json)
}

// Defaults

/** A new project with one empty scene named after it. The scene's id is `sceneId`, or the project's id. */
export function defaultProject(args: {
  id: string
  name: string
  now: string
  output?: Partial<Output>
  sceneId?: string
}): Project {
  return {
    schemaVersion: 2,
    id: args.id,
    name: args.name,
    createdAt: args.now,
    updatedAt: args.now,
    output: { aspect: '16:9', height: 2160, fps: { num: 25, den: 1 }, ...args.output },
    credit: 'burned',
    scenes: [
      {
        id: args.sceneId ?? args.id,
        name: args.name,
        timing: { holdStart: 1, travel: 10, holdEnd: 2 },
        stops: [],
        legs: [],
        look: {
          theme: 'paper',
          labels: 'en',
          terrain: false,
          line: { color: '#d9472b', width: 4, dash: 'solid', outline: true, glow: false },
          symbol: 'dot',
          signStyle: 'tag',
        },
        camera: { mode: 'glide', easing: 'smooth' },
      },
    ],
  }
}

// Geometry helpers

const ASPECT_RATIO: Record<Aspect, { w: number; h: number }> = {
  '16:9': { w: 16, h: 9 },
  '9:16': { w: 9, h: 16 },
  '1:1': { w: 1, h: 1 },
  '4:5': { w: 4, h: 5 },
}

/** Size of a frame whose short side is `shortSide`. */
function sizeForShortSide(aspect: Aspect, shortSide: number): { width: number; height: number } {
  const { w, h } = ASPECT_RATIO[aspect]
  const unit = shortSide / Math.min(w, h)
  return { width: Math.round(w * unit), height: Math.round(h * unit) }
}

/** Output frame size in pixels. `output.height` is the frame's short side. */
export function frameSize(output: Output): { width: number; height: number } {
  return sizeForShortSide(output.aspect, output.height)
}

/** Size in CSS px of the layout frame every view lays the map out in. Its short side is 1080. */
export function layoutSize(aspect: Aspect): { width: number; height: number } {
  return sizeForShortSide(aspect, 1080)
}

/** Real pixels per layout pixel. */
export function outputScale(output: Output): number {
  return output.height / 1080
}

export function fpsValue(fps: Fps): number {
  return fps.num / fps.den
}
