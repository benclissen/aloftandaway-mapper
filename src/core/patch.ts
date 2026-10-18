import { z } from 'zod'
import {
  InputLegModeSchema,
  LegSchema,
  LngLatSchema,
  SymbolKindSchema,
  ViaPointSchema,
  defaultModeFor,
  ProjectError,
  StopInputSchema,
  StopSchema,
  SceneSchema,
  parseProject,
  zodIssues,
  type Context,
  type InputLegMode,
  type Leg,
  type LngLat,
  type Project,
  type ProjectIssue,
  type Scene,
  type Stop,
  type SymbolKind,
  type ViaPoint,
  type StopInput,
} from './schema.js'
import { sceneTravel } from './timeline.js'
import { BLANK_SCENE_NAME, SceneRefSchema, applySceneOp, resolveScene, sceneTitle, type SceneRef } from './scenes.js'

// Ops and patches

const index = z.number().int().min(0)

const clearable = <T extends z.ZodType>(schema: T) => schema.nullable().optional()

const StopChangesSchema = StopSchema.omit({ id: true })
  .partial()
  .extend({
    label: clearable(z.string()),
    terminal: clearable(z.boolean()),
    sharp: clearable(z.boolean()),
    day: clearable(z.number().int()),
    ref: clearable(z.string()),
  })

const LegChangesSchema = LegSchema.partial().extend({ symbol: clearable(SymbolKindSchema) })
/** What `update_leg` changes on a leg. */
export type LegChanges = z.infer<typeof LegChangesSchema>

/**
 * The changes `update_leg` makes to `leg`. A symbol without a mode also sets the mode it implies, except on a track
 * leg, which stays on its track. `invertPatch` reads the same changes, so undo restores what was changed.
 */
export function legChangesFor(leg: Leg, changes: LegChanges): LegChanges {
  const { symbol, mode } = changes
  return symbol && !mode && leg.mode !== 'track' ? { ...changes, mode: defaultModeFor(symbol) } : changes
}

/** Applies `changes` over `target`: a `null` removes an (optional) key. Required keys never reach here as null. */
function withChanges<T extends object>(target: T, changes: object): T {
  const result = { ...target } as Record<string, unknown>
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete result[key]
    else if (value !== undefined) result[key] = value
  }
  return result as T
}

const StopOpSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('insert_stop'), index, stop: StopInputSchema }),
  z.strictObject({ op: z.literal('update_stop'), id: z.string(), changes: StopChangesSchema }),
  z.strictObject({ op: z.literal('remove_stop'), id: z.string() }),
  z.strictObject({ op: z.literal('move_stop'), id: z.string(), index }),
  z.strictObject({ op: z.literal('update_leg'), index, changes: LegChangesSchema }),
  z.strictObject({ op: z.literal('insert_via'), leg: index, index, point: ViaPointSchema }),
  z.strictObject({
    op: z.literal('update_via'),
    leg: index,
    index,
    changes: z.strictObject({ at: LngLatSchema.optional(), sharp: clearable(z.boolean()) }),
  }),
  z.strictObject({ op: z.literal('remove_via'), leg: index, index }),
])
/** The ops on the chosen scene's stops, legs and via points. */
export type StopOp = z.infer<typeof StopOpSchema>

export const SceneOpSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('add_scene'),
    index: index.optional(),
    name: z.string().optional(),
    copyLookFrom: SceneRefSchema.optional(),
    id: z.uuid().optional(),
  }),
  z.strictObject({ op: z.literal('duplicate_scene'), id: z.string(), newId: z.uuid().optional() }),
  z.strictObject({ op: z.literal('remove_scene'), id: z.string() }),
  z.strictObject({ op: z.literal('move_scene'), id: z.string(), index }),
  z.strictObject({ op: z.literal('restore_scene'), index, scene: SceneSchema }),
])
/** The ops that add, duplicate, remove, move and restore scenes. */
export type SceneOp = z.infer<typeof SceneOpSchema>

const CopyContextOpSchema = z.strictObject({
  op: z.literal('copy_context'),
  /** The absolute path of another project's folder. Without it, the scene is copied from this project. */
  folder: z.string().min(1).optional(),
  /** The scene to copy: its id, or its 1-based position. Defaults to the first scene. */
  scene: SceneRefSchema.optional(),
})
/** Copies another scene's route into the chosen scene as its context. */
export type CopyContextOp = z.infer<typeof CopyContextOpSchema>

const PatchOpSchema = z.discriminatedUnion('op', [StopOpSchema, SceneOpSchema, CopyContextOpSchema])
export type PatchOp = z.infer<typeof PatchOpSchema>

/** The names of the ops that add, duplicate, remove, move and restore scenes. The tests check it against `SceneOpSchema`. */
export const SCENE_OP_NAMES = ['add_scene', 'duplicate_scene', 'remove_scene', 'move_scene', 'restore_scene'] as const

const SCENE_OP_SET: ReadonlySet<string> = new Set(SCENE_OP_NAMES)

/** True for the ops that change the list of scenes, as opposed to editing the chosen scene's stops and legs. */
export function isSceneOp(op: { op: string }): op is SceneOp {
  return SCENE_OP_SET.has(op.op)
}

export const ProjectPatchSchema = z.strictObject({
  /** JSON Merge Patch over the project's own fields: name, output and credit. */
  set: z.record(z.string(), z.unknown()).optional(),
  /** The scene `sceneSet` and `ops` act on: its id, or its 1-based position. Defaults to the first scene. */
  scene: SceneRefSchema.optional(),
  /** JSON Merge Patch over the chosen scene's name, timing, look, camera and context. `context: null` removes the context. */
  sceneSet: z.record(z.string(), z.unknown()).optional(),
  /**
   * Edits applied in order after `set` and `sceneSet`: to the chosen scene's stops and legs, its context
   * (`copy_context`), and to the list of scenes itself (add, duplicate, remove, move, restore).
   */
  ops: z.array(PatchOpSchema).optional(),
})
export type ProjectPatch = z.infer<typeof ProjectPatchSchema>

const SET_FORBIDDEN = new Map(Object.entries({
  timing: "'timing' belongs to the scene; change it with sceneSet",
  look: "'look' belongs to the scene; change it with sceneSet",
  camera: "'camera' belongs to the scene; change it with sceneSet",
  stops: "'stops' can't be changed with set; use ops or set_stops",
  legs: "'legs' can't be changed with set; use ops or set_stops (legs follow the stops)",
  scenes: "'scenes' can't be changed with set; use sceneSet for the scene's name, timing, look and camera, and ops for its stops and legs",
  schemaVersion: "'schemaVersion' can't be changed",
  id: "'id' can't be changed",
  createdAt: "'createdAt' can't be changed",
  updatedAt: "'updatedAt' is set when the project is saved",
}))

const SCENE_SET_FORBIDDEN = new Map(Object.entries({
  id: "the scene's 'id' can't be changed",
  stops: "'stops' can't be changed with sceneSet; use ops or set_stops",
  legs: "'legs' can't be changed with sceneSet; use ops or set_stops (legs follow the stops)",
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
  const { legMode: _legMode, symbol: _symbol, pause, sign, ...rest } = input
  return { id: newStopId(), ...rest, pause: pause ?? 0, sign: sign ?? 'always' }
}

// Leg syncing

interface LegHints {
  /** Mode for the leg leaving each of these stops (from a new stop's `legMode`). */
  leaving?: Map<string, InputLegMode>
  /** Symbol for the leg leaving each of these stops (from a new stop's `symbol`). */
  symbols?: Map<string, SymbolKind>
  /** Mode for any other new leg, ahead of the old project's legs. */
  fallback?: InputLegMode
}

/**
 * Rebuilds legs for `stops` after the stops changed. A leg from stop a to stop b that existed before is reused whole.
 *
 * A new leg follows recorded track T, with no via points, when the old leg leaving a and the old leg arriving at b
 * both follow T, unless a is a new stop with its own `legMode`. A new stop is looked through to the nearest old stop
 * on its side, so a stop inserted on a track leg splits it into two legs on T, and removing a stop between two legs on
 * T joins them. The leg takes the new stop's `symbol`, else the one both old legs have, if they have the same one.
 *
 * Any other new leg takes, in order: the `legMode` of the new stop it leaves, `fallback`, the old leg leaving a, the
 * old leg arriving at b, 'line'. An old leg's `track` mode becomes 'line' there, since the new leg has no track in
 * common.
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
  // The id of the nearest old stop at or before each index, and at or after it.
  const isOld = new Set(old.stops.map((s) => s.id))
  const oldBefore: (string | undefined)[] = []
  const oldAfter: (string | undefined)[] = []
  let near: string | undefined
  for (let k = 0; k < stops.length; k++) {
    if (isOld.has(stops[k]!.id)) near = stops[k]!.id
    oldBefore[k] = near
  }
  near = undefined
  for (let k = stops.length - 1; k >= 0; k--) {
    if (isOld.has(stops[k]!.id)) near = stops[k]!.id
    oldAfter[k] = near
  }
  return stops.slice(1).map((b, i): Leg => {
    const a = stops[i]!
    const kept = byPair.get(JSON.stringify([a.id, b.id]))
    if (kept) return kept
    const symbol = hints.symbols?.get(a.id)
    const asked = hints.leaving?.get(a.id)
    const from = leaving.get(oldBefore[i] ?? '')
    const to = arriving.get(oldAfter[i + 1] ?? '')
    if (!asked && from?.mode === 'track' && to?.mode === 'track' && from.track !== undefined && from.track === to.track) {
      const shared = symbol ?? (from.symbol === to.symbol ? from.symbol : undefined)
      return shared ? { mode: 'track', track: from.track, via: [], symbol: shared } : { mode: 'track', track: from.track, via: [] }
    }
    const inherited = leaving.get(a.id)?.mode ?? arriving.get(b.id)?.mode
    const mode = asked ?? (symbol && defaultModeFor(symbol)) ?? hints.fallback ?? (inherited === 'track' ? 'line' : inherited) ?? 'line'
    return symbol ? { mode, via: [], symbol } : { mode, via: [] }
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

// Fixed length

/** Writes each fixed-length scene's leftover travel into `timing.travel`, so the file reads true. */
export function fitLength(project: Project): Project {
  const scenes = project.scenes.map((scene) => {
    if (scene.timing.length === undefined) return scene
    const travel = Math.round(sceneTravel(scene) * 1e6) / 1e6
    return travel === scene.timing.travel ? scene : { ...scene, timing: { ...scene.timing, travel } }
  })
  return { ...project, scenes }
}

// setStops

/**
 * Replaces the chosen scene's stops (the first by default) with `stops`, or appends them with `replace: false`, and
 * rebuilds its legs. The other scenes are untouched.
 */
export function setStops(
  project: Project,
  args: { scene?: SceneRef; stops: StopInput[]; legMode?: InputLegMode; replace?: boolean },
): Project {
  return fitLength(parseProject(withStops(project, args).work))
}

/** `setStops` before the result is checked: a changed copy of `project`, and the index of the scene it changed. */
function withStops(
  project: Project,
  args: { scene?: SceneRef; stops: StopInput[]; legMode?: InputLegMode; replace?: boolean },
): { work: Project; at: number } {
  const inputs = parseOrThrow(z.array(StopInputSchema), args.stops, ['stops'])
  const legMode = parseOrThrow(InputLegModeSchema.optional(), args.legMode, ['legMode'])
  const work = structuredClone(project)
  const { scene, index: at } = resolveScene(work, args.scene)
  const old = args.replace === false ? { stops: scene.stops, legs: scene.legs } : { stops: [], legs: [] }
  const added = inputs.map((input) => ({ stop: toStop(input), legMode: input.legMode, symbol: input.symbol }))
  const stops = [...old.stops, ...added.map((a) => a.stop)]
  const leaving = new Map<string, InputLegMode>()
  const symbols = new Map<string, SymbolKind>()
  for (const { stop, legMode: mode, symbol } of added) {
    if (mode) leaving.set(stop.id, mode)
    if (symbol) symbols.set(stop.id, symbol)
  }
  work.scenes[at] = { ...scene, stops, legs: syncLegs(old, stops, { leaving, symbols, fallback: legMode }) }
  return { work, at }
}

// importTrack

/**
 * Replaces the chosen scene's stops (the first by default) with `stops`, as `setStops` does, and puts every leg on the
 * recorded track `track`, with `symbol` when it's given. The other scenes are untouched.
 */
export function importTrack(
  project: Project,
  args: { scene?: SceneRef; stops: { name: string; at: LngLat }[]; track: string; symbol?: SymbolKind },
): Project {
  const track = parseOrThrow(LegSchema.shape.track.unwrap(), args.track, ['track'])
  const symbol = parseOrThrow(SymbolKindSchema.optional(), args.symbol, ['symbol'])
  const { work, at } = withStops(project, { scene: args.scene, stops: args.stops })
  const scene = work.scenes[at]!
  const legs = scene.legs.map((): Leg => (symbol ? { mode: 'track', track, via: [], symbol } : { mode: 'track', track, via: [] }))
  work.scenes[at] = { ...scene, legs }
  return fitLength(parseProject(work))
}

// applyPatch

function applyOp(scene: Scene, op: StopOp, at: number): Scene {
  const stopIndex = (id: string): number => {
    const i = scene.stops.findIndex((s) => s.id === id)
    if (i < 0) fail(['ops', at, 'id'], `unknown stop id '${id}'`)
    return i
  }
  const old = { stops: scene.stops, legs: scene.legs }

  switch (op.op) {
    case 'insert_stop': {
      if (op.index > scene.stops.length) {
        fail(['ops', at, 'index'], `index ${op.index} is out of range; use 0 to ${scene.stops.length}`)
      }
      const stop = toStop(op.stop)
      const stops = scene.stops.toSpliced(op.index, 0, stop)
      const leaving = op.stop.legMode ? new Map([[stop.id, op.stop.legMode]]) : undefined
      const symbols = op.stop.symbol ? new Map([[stop.id, op.stop.symbol]]) : undefined
      return { ...scene, stops, legs: syncLegs(old, stops, { leaving, symbols }) }
    }
    case 'update_stop': {
      const i = stopIndex(op.id)
      return { ...scene, stops: scene.stops.map((s, j) => (j === i ? withChanges(s, op.changes) : s)) }
    }
    case 'remove_stop': {
      const stops = scene.stops.toSpliced(stopIndex(op.id), 1)
      return { ...scene, stops, legs: syncLegs(old, stops) }
    }
    case 'move_stop': {
      const i = stopIndex(op.id)
      if (op.index > scene.stops.length - 1) {
        fail(['ops', at, 'index'], `index ${op.index} is out of range; use 0 to ${scene.stops.length - 1}`)
      }
      const stops = scene.stops.toSpliced(i, 1).toSpliced(op.index, 0, scene.stops[i]!)
      return { ...scene, stops, legs: syncLegs(old, stops) }
    }
    case 'update_leg': {
      if (op.index >= scene.legs.length) {
        const range = scene.legs.length ? `use 0 to ${scene.legs.length - 1}` : 'there are no legs'
        fail(['ops', at, 'index'], `leg index ${op.index} is out of range; ${range}`)
      }
      return { ...scene, legs: scene.legs.map((l, j) => (j === op.index ? withChanges(l, legChangesFor(l, op.changes)) : l)) }
    }
    case 'insert_via':
    case 'update_via':
    case 'remove_via': {
      if (op.leg >= scene.legs.length) {
        const range = scene.legs.length ? `use 0 to ${scene.legs.length - 1}` : 'there are no legs'
        fail(['ops', at, 'leg'], `leg index ${op.leg} is out of range; ${range}`)
      }
      const via = scene.legs[op.leg]!.via
      const max = op.op === 'insert_via' ? via.length : via.length - 1
      if (op.index > max) {
        const range = max >= 0 ? `use 0 to ${max}` : 'there are no via points'
        fail(['ops', at, 'index'], `via index ${op.index} is out of range; ${range}`)
      }
      let next: ViaPoint[]
      if (op.op === 'insert_via') next = via.toSpliced(op.index, 0, op.point)
      else if (op.op === 'remove_via') next = via.toSpliced(op.index, 1)
      else next = via.map((v, j) => (j === op.index ? withChanges(v, op.changes) : v))
      return { ...scene, legs: scene.legs.map((l, j) => (j === op.leg ? { ...l, via: next } : l)) }
    }
  }
}

/** The projects `copy_context` may copy from besides the one being patched, keyed by the folder they were loaded from. */
export interface PatchOptions {
  sources?: ReadonlyMap<string, Project>
}

/** `scene` with the route of a scene of `op.folder` (or of `project`) as its context. */
function copyContext(project: Project, scene: Scene, op: CopyContextOp, at: number, sources: ReadonlyMap<string, Project>): Scene {
  let source = project
  if (op.folder !== undefined) {
    const loaded = sources.get(op.folder)
    if (!loaded) fail(['ops', at, 'folder'], `the project in '${op.folder}' wasn't loaded, so its scenes can't be copied`)
    source = loaded
  }
  let found: ReturnType<typeof resolveScene>
  try {
    found = resolveScene(source, op.scene)
  } catch (e) {
    if (e instanceof ProjectError) fail(['ops', at, 'scene'], e.issues[0]!.message)
    throw e
  }
  const from = found.scene
  if (op.folder === undefined && from.id === scene.id) {
    fail(['ops', at, 'scene'], "a scene can't be its own context; copy another scene")
  }
  if (from.stops.length < 2) {
    fail(['ops', at, 'scene'], `scene '${sceneTitle(source, found.index)}' has ${from.stops.length} ${from.stops.length === 1 ? 'stop' : 'stops'}; it needs at least 2 to be a context`)
  }
  const context: Context = {
    from: `${source.name} · ${sceneTitle(source, found.index)}`,
    stops: from.stops.map((s) => ({ name: s.name, at: [...s.at] })),
    // A context keeps no recorded tracks, so a track leg is copied as a plain line between its stops.
    legs: from.legs.map((l) => ({ mode: l.mode === 'track' ? 'line' : l.mode, via: structuredClone(l.via) })),
  }
  return { ...scene, context }
}

function checkKeys(patch: Record<string, unknown>, forbidden: Map<string, string>, name: string): void {
  for (const key of Object.keys(patch)) {
    const message = forbidden.get(key)
    if (message) fail([name, key], message)
  }
}

/**
 * Applies `set` (a merge patch over the project), then `sceneSet` (a merge patch over the chosen scene), then `ops`
 * (stop, leg and via ops and `copy_context` on the chosen scene, and scene ops on the project), in order. `copy_context`
 * with a `folder` reads that folder's project from `opts.sources`, which the caller loads; those projects are not modified.
 * Pure and all or nothing: the input is never modified, and any failure throws a `ProjectError`.
 */
export function applyPatch(project: Project, patch: ProjectPatch, opts: PatchOptions = {}): Project {
  return fitLength(parseProject(patchSteps(project, patch, undefined, opts)))
}

/**
 * `applyPatch` before the result is checked: `set`, then `sceneSet`, then each op, in order, with no check in between,
 * since the patch is all or nothing. `visit` is called with the state each op runs on, before it runs, and must not
 * keep or change it. `invertPatch` uses it to invert each op against what applyPatch would run it on. `opts` is as for
 * `applyPatch`.
 */
export function patchSteps(
  project: Project,
  patch: ProjectPatch,
  visit?: (state: Project, op: PatchOp) => void,
  opts: PatchOptions = {},
): Project {
  const { ops, scene: ref } = parseOrThrow(ProjectPatchSchema, patch)
  // Read `set` and `sceneSet` from the caller's object: Zod's copy silently drops a `__proto__` key, and we want it
  // rejected.
  const { set, sceneSet } = patch
  let work: Project = structuredClone(project)
  if (set) {
    checkKeys(set, SET_FORBIDDEN, 'set')
    work = mergePatch(work, set) as Project
  }
  // The scene is looked up by id before each step, so an op that moves it (a scene op) can't leave a stale index.
  const { scene: chosen } = resolveScene(work, ref)
  const sceneId = chosen.id
  const edit = (change: (scene: Scene) => Scene, at?: number): void => {
    const i = work.scenes.findIndex((s) => s.id === sceneId)
    if (i < 0) fail(at === undefined ? [] : ['ops', at], `scene '${sceneId}' was removed earlier in this patch`)
    work.scenes[i] = change(work.scenes[i]!)
  }
  if (sceneSet) {
    checkKeys(sceneSet, SCENE_SET_FORBIDDEN, 'sceneSet')
    // A name is stored trimmed, and a blank one is refused. (Other types fall through to the schema.)
    const name = sceneSet.name
    if (typeof name === 'string' && !name.trim()) fail(['sceneSet', 'name'], BLANK_SCENE_NAME)
    const merged = typeof name === 'string' ? { ...sceneSet, name: name.trim() } : sceneSet
    edit((scene) => mergePatch(scene, merged) as Scene)
  }
  ops?.forEach((op, i) => {
    visit?.(work, op)
    if (isSceneOp(op)) work = applySceneOp(work, op, i, newStopId)
    else if (op.op === 'copy_context') edit((scene) => copyContext(work, scene, op, i, opts.sources ?? new Map()), i)
    else edit((scene) => applyOp(scene, op, i), i)
  })
  return work
}
