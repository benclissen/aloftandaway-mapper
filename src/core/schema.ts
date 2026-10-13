import { z } from 'zod'

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

const MAX_LAT = 85.0511

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
  day: z.number().int().optional(),
  ref: z.string().optional(),
})
export type Stop = z.infer<typeof StopSchema>

export const LegModeSchema = z.enum(['sea', 'air', 'land', 'line'])
export type LegMode = z.infer<typeof LegModeSchema>

export const SymbolKindSchema = z.enum(['none', 'dot', 'arrow', 'ship', 'plane', 'car', 'train', 'walk'])
export type SymbolKind = z.infer<typeof SymbolKindSchema>

export const LegSchema = z.strictObject({
  mode: LegModeSchema,
  via: z.array(LngLatSchema),
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

export const ProjectSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    name: z.string(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    output: OutputSchema,
    timing: TimingSchema,
    stops: z.array(StopSchema),
    legs: z.array(LegSchema),
    look: LookSchema,
    camera: CameraSchema,
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

export function parseProject(json: unknown): Project {
  const result = ProjectSchema.safeParse(json)
  if (result.success) return result.data
  const issues = result.error.issues.flatMap((issue): ProjectIssue[] => {
    const path = issue.path.map((p) => (typeof p === 'number' ? p : String(p)))
    // Point at the offending key itself, not just its parent object.
    if (issue.code === 'unrecognized_keys') return issue.keys.map((key) => ({ path: [...path, key], message: 'unknown key' }))
    return [{ path, message: issue.message }]
  })
  throw new ProjectError(issues)
}

// Defaults

export function defaultProject(args: { id: string; name: string; now: string; output?: Partial<Output> }): Project {
  return {
    schemaVersion: 1,
    id: args.id,
    name: args.name,
    createdAt: args.now,
    updatedAt: args.now,
    output: { aspect: '16:9', height: 2160, fps: { num: 25, den: 1 }, ...args.output },
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
    credit: 'burned',
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
