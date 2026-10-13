import { z } from 'zod'
import {
  LegModeSchema,
  LegSchema,
  ProjectError,
  StopInputSchema,
  StopSchema,
  parseProject,
  zodIssues,
  type Leg,
  type LegMode,
  type Project,
  type ProjectIssue,
  type Stop,
  type StopInput,
} from './schema.js'

// Ops and patches

const index = z.number().int().min(0)

const StopOpSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('insert_stop'), index, stop: StopInputSchema }),
  z.strictObject({ op: z.literal('update_stop'), id: z.string(), changes: StopSchema.omit({ id: true }).partial() }),
  z.strictObject({ op: z.literal('remove_stop'), id: z.string() }),
  z.strictObject({ op: z.literal('move_stop'), id: z.string(), index }),
  z.strictObject({ op: z.literal('update_leg'), index, changes: LegSchema.partial() }),
])
export type StopOp = z.infer<typeof StopOpSchema>

export const ProjectPatchSchema = z.strictObject({
  /** JSON Merge Patch over the project. Not for stops, legs, schemaVersion, id or createdAt. */
  set: z.record(z.string(), z.unknown()).optional(),
  ops: z.array(StopOpSchema).optional(),
})
export type ProjectPatch = z.infer<typeof ProjectPatchSchema>

const SET_FORBIDDEN = new Map(Object.entries({
  stops: "'stops' can't be changed with set; use ops or set_stops",
  legs: "'legs' can't be changed with set; use ops or set_stops (legs follow the stops)",
  schemaVersion: "'schemaVersion' can't be changed",
  id: "'id' can't be changed",
  createdAt: "'createdAt' can't be changed",
}))

// Merge patch (RFC 7396)

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Defines an own property, so a `__proto__` key from JSON stays data and never reaches the prototype. */
function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

/** RFC 7396 JSON Merge Patch. Returns a new value; neither argument is modified. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch
  const result: Record<string, unknown> = {}
  if (isPlainObject(target)) for (const [key, value] of Object.entries(target)) define(result, key, value)
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key]
    else define(result, key, mergePatch(Object.hasOwn(result, key) ? result[key] : undefined, value))
  }
  return result
}

// Stop ids and conversion

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'

/** `s_` plus 8 random base-36 characters. */
export function newStopId(): string {
  let id = 's_'
  while (id.length < 10) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      // 252 is the largest multiple of 36 that fits in a byte; reject the rest to avoid modulo bias.
      if (byte < 252 && id.length < 10) id += BASE36[byte % 36]
    }
  }
  return id
}

function toStop(input: StopInput): Stop {
  const { legMode: _legMode, pause, sign, ...rest } = input
  return { id: newStopId(), ...rest, pause: pause ?? 0, sign: sign ?? 'always' }
}

// Leg syncing

interface LegHints {
  /** Mode for the leg leaving each of these stops (from a new stop's `legMode`). */
  leaving?: Map<string, LegMode>
  /** Mode for any other new leg, ahead of the old project's legs. */
  fallback?: LegMode
}

/**
 * Rebuilds legs for `stops` after the stops changed. A leg from stop a to stop b that
 * existed before is reused whole. A new leg takes, in order: the `legMode` of the new
 * stop it leaves, `fallback`, the old leg leaving a, the old leg arriving at b, 'line'.
 */
function syncLegs(old: { stops: Stop[]; legs: Leg[] }, stops: Stop[], hints: LegHints = {}): Leg[] {
  const byPair = new Map<string, Leg>()
  const leaving = new Map<string, Leg>()
  const arriving = new Map<string, Leg>()
  old.legs.forEach((leg, i) => {
    const a = old.stops[i]
    const b = old.stops[i + 1]
    if (!a || !b) return
    byPair.set(JSON.stringify([a.id, b.id]), leg)
    leaving.set(a.id, leg)
    arriving.set(b.id, leg)
  })
  return stops.slice(1).map((b, i) => {
    const a = stops[i]!
    const kept = byPair.get(JSON.stringify([a.id, b.id]))
    if (kept) return kept
    const mode = hints.leaving?.get(a.id) ?? hints.fallback ?? leaving.get(a.id)?.mode ?? arriving.get(b.id)?.mode ?? 'line'
    return { mode, via: [] }
  })
}

// Errors

function fail(path: (string | number)[], message: string): never {
  throw new ProjectError([{ path, message }])
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, prefix: (string | number)[] = []): T {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  throw new ProjectError(zodIssues(result.error).map((i): ProjectIssue => ({ ...i, path: [...prefix, ...i.path] })))
}

// setStops

/** Replaces the project's stops with `stops` (or appends them with `replace: false`) and rebuilds the legs. */
export function setStops(
  project: Project,
  args: { stops: StopInput[]; legMode?: LegMode; replace?: boolean },
): Project {
  const inputs = parseOrThrow(z.array(StopInputSchema), args.stops, ['stops'])
  const legMode = parseOrThrow(LegModeSchema.optional(), args.legMode, ['legMode'])
  const old = args.replace === false ? { stops: project.stops, legs: project.legs } : { stops: [], legs: [] }
  const added = inputs.map((input) => ({ stop: toStop(input), legMode: input.legMode }))
  const stops = [...structuredClone(old.stops), ...added.map((a) => a.stop)]
  const leaving = new Map<string, LegMode>()
  for (const { stop, legMode: mode } of added) if (mode) leaving.set(stop.id, mode)
  return parseProject({ ...structuredClone(project), stops, legs: syncLegs(old, stops, { leaving, fallback: legMode }) })
}

// applyPatch

function applyOp(project: Project, op: StopOp, at: number): Project {
  const stopIndex = (id: string): number => {
    const i = project.stops.findIndex((s) => s.id === id)
    if (i < 0) fail(['ops', at, 'id'], `unknown stop id '${id}'`)
    return i
  }
  const old = { stops: project.stops, legs: project.legs }

  switch (op.op) {
    case 'insert_stop': {
      if (op.index > project.stops.length) {
        fail(['ops', at, 'index'], `index ${op.index} is out of range; use 0 to ${project.stops.length}`)
      }
      const stop = toStop(op.stop)
      const stops = project.stops.toSpliced(op.index, 0, stop)
      const leaving = op.stop.legMode ? new Map([[stop.id, op.stop.legMode]]) : undefined
      return { ...project, stops, legs: syncLegs(old, stops, { leaving }) }
    }
    case 'update_stop': {
      const i = stopIndex(op.id)
      return { ...project, stops: project.stops.map((s, j) => (j === i ? { ...s, ...op.changes } : s)) }
    }
    case 'remove_stop': {
      const stops = project.stops.toSpliced(stopIndex(op.id), 1)
      return { ...project, stops, legs: syncLegs(old, stops) }
    }
    case 'move_stop': {
      const i = stopIndex(op.id)
      if (op.index > project.stops.length - 1) {
        fail(['ops', at, 'index'], `index ${op.index} is out of range; use 0 to ${project.stops.length - 1}`)
      }
      const stops = project.stops.toSpliced(i, 1).toSpliced(op.index, 0, project.stops[i]!)
      return { ...project, stops, legs: syncLegs(old, stops) }
    }
    case 'update_leg': {
      if (op.index >= project.legs.length) {
        const range = project.legs.length ? `use 0 to ${project.legs.length - 1}` : 'there are no legs'
        fail(['ops', at, 'index'], `leg index ${op.index} is out of range; ${range}`)
      }
      return { ...project, legs: project.legs.map((l, j) => (j === op.index ? { ...l, ...op.changes } : l)) }
    }
  }
}

/**
 * Applies a merge patch (`set`) and then `ops`, in order. Pure and all or nothing:
 * the input is never modified, and any failure throws a `ProjectError`.
 */
export function applyPatch(project: Project, patch: ProjectPatch): Project {
  const { ops } = parseOrThrow(ProjectPatchSchema, patch)
  // Read `set` from the caller's object: Zod's copy silently drops a `__proto__` key, and we want it rejected.
  const set = patch.set
  let work: Project = structuredClone(project)
  if (set) {
    for (const key of Object.keys(set)) {
      const message = SET_FORBIDDEN.get(key)
      if (message) fail(['set', key], message)
    }
    work = mergePatch(work, set) as Project
  }
  ops?.forEach((op, i) => {
    work = applyOp(work, op, i)
  })
  return parseProject(work)
}
