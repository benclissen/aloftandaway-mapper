# Camera keys and route context implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not begin implementation until the user approves this plan.

**Goal:** A one-leg subclip that opens on the whole cruise, zooms in to the first port in about a second, and only then sails the leg. Two features make it possible: a glide camera timed on its own clock (keys), and another route drawn faintly underneath as context.

**Why:** A glide today holds through `holdStart` and then eases from `start` to `end` across the whole travel window, so the zoom and the ship always move together. And a scene draws only its own stops and legs, so a one-leg clip's wide opening shot shows an empty sea.

**Tech stack:** TypeScript, Zod 4, React, MapLibre GL 6.14.0, Vitest, the MCP SDK.

**Branch:** `camera-keys-and-context`, off `main` at `0b9d83c`.

## Decisions (agreed with Ben, 2026-10-18)

**1. Camera keys.** `camera.keys?: { at: number; shot: Shot }[]`, `at` in seconds from the scene's first frame.
- Glide mode only. With keys set, the camera holds the first key's shot until its time, flies key to key (the same van Wijk & Nuij move as today, `camera.easing` applied per segment), and holds the last key's shot after it. The ship's timing is untouched.
- Keys must be in ascending `at` order with no two at the same time: a validation error otherwise (it blocks a render). `cameraAt` sorts a copy anyway, so a bad file never crashes a preview.
- `start` and `end` are ignored while keys are set (a warning says so). `resolveShots` returns the first and last key's shots, so `resolvedStart`/`resolvedEnd` in tool results stay meaningful.
- Keys in fixed or follow mode are ignored, with a warning.
- A key after the scene's last frame is a warning. Every key's zoom is checked against the theme's maximum, like `start` and `end`.
- `add_scene` doesn't copy keys (it copies only mode, easing and follow today); `duplicate_scene` does.

**2. Route context, copied into the scene.** `scene.context?: { from: string; stops: { name: string; at: LngLat }[]; legs: { mode: LegMode; via: ViaPoint[] }[] }`.
- `from` is a label for people, such as `Icon of the Seas - Eastern Caribbean · Scene 1`. At least 2 stops, and `stops.length - 1` legs (schema check, like a scene's own legs).
- A new patch op `copy_context { folder?: string; scene?: SceneRef }` copies another scene's stops (name and position) and legs (mode and via points) into the chosen scene. Without `folder` it copies from this project; a scene can't be its own context. `applyPatch` stays pure: it takes `opts.sources`, a map of folder → `Project` that the caller loaded. `update_project` loads each `copy_context` folder before it calls `mutateProject`. The source project is only read.
- `sceneSet: { context: null }` removes it. `sceneSet.context` can also be written directly.
- Context sea legs are routed like any sea leg: `seaLegsOf` includes them, so `resolveSeaPaths`, the studio and renders all have their paths. A context sea leg that falls back to a line is a warning.
- A copy is a snapshot. If the main route changes, run `copy_context` again.

**3. How context looks.** Under the scene's own route: the whole context route as a line in `look.line.color` at 35 % opacity and 60 % of the line width, no outline or glow, plus a faint dot (half opacity, the normal dot size) at each context stop. No name tags. The active leg draws on top exactly as today. Context belongs to the `route` layer in a layered export.

**4. Tool results.** Each scene's `camera` entry gains `keys` (as stored, when set) and `resolvedContext`, a shot fitted to the context route in the output aspect, when the scene has context. That gives an agent the "whole cruise" shot for key 0 without working it out.

## Global constraints

- Coordinates are `[lng, lat]` everywhere in the public interface.
- `core` imports nothing else from the package and has no DOM, filesystem or network imports (`test/core/purity.test.ts`).
- Schema stays at version 2. Both new fields are optional, so every existing project still loads.
- Every render carries the map credit.
- Public repo: nothing private in code, tests or docs. The Icon of the Seas project files stay outside the repo.

## Files

- `src/core/schema.ts`: `CameraKeySchema`, `camera.keys`, `ContextSchema`, `scene.context`, the context legs check in `ProjectSchema.superRefine`.
- `src/core/camera.ts`: `keyedShot`, keys in `cameraAt` and `resolveShots`, `contextShot`.
- `src/core/route.ts`: `buildContextRoute(scene, seaPaths)`.
- `src/core/patch.ts`: `copy_context` op, `applyPatch(project, patch, opts?)`.
- `src/core/validate.ts`: key order, keys ignored, key past the end, key zoom, context sea fallback.
- `src/server/paths.ts`: `seaLegsOf` walks context legs.
- `src/studio/stage/MapStage.ts`, `src/studio/stage/overlay.ts`: context line layer and dots.
- `src/studio/edit/ShotPanel.tsx`, `App.tsx`, `edit.css`: key controls.
- `src/mcp/tools.ts`: `update_project` loads sources, descriptions, `keys` and `resolvedContext` in results.
- `skills/mapper/SKILL.md` and `~/.claude/skills/mapper/SKILL.md`: how to make a subclip.
- Tests: `test/core/camera.test.ts`, `schema.test.ts`, `patch.test.ts`, `validate.test.ts`, `route.test.ts`, `test/server/paths.test.ts`, `test/mcp/tools.test.ts`, and an e2e check that context draws.

### Task 1: Camera keys in core (Opus)

- [ ] Schema: `CameraKeySchema = z.strictObject({ at: z.number().min(0), shot: ShotSchema })`; `keys: z.array(CameraKeySchema).min(1).optional()` on `CameraSchema`.
- [ ] `cameraAt`: glide with keys → `keyedShot(keys, aspect, easing, seconds)` where `seconds = frame / fps`. Holds before the first and after the last key; between keys, `flyInterpolator(a.shot, b.shot, aspect)(ease(easing, u))`. Sort a copy by `at`.
- [ ] `resolveShots`: with keys in glide mode, `start` = first key's shot and `end` = last key's.
- [ ] `contextShot(scene, aspect, seaPaths?)` lives in Task 2; leave it out here.
- [ ] Validation: `camera-keys-order` (error), `camera-keys-ignored` (warning, fixed/follow mode), `camera-start-end-ignored` (warning, glide with keys and a stored start or end), `camera-key-late` (warning, key after the last frame), `zoom-above-max` per key.
- [ ] Tests in `camera.test.ts`: holds before key 0, hits each key's shot exactly at its frame, eases between, holds after the last, unsorted keys behave as sorted, ship timing unchanged by keys. Schema and validation tests in their files.

### Task 2: Route context in core and the sea router (Sonnet)

- [ ] Schema: `ContextSchema` and `scene.context`; legs count check with path `['scenes', i, 'context', 'legs']`.
- [ ] `buildContextRoute(scene, seaPaths)` in `route.ts`: `buildRoute` over a stand-in scene made from the context's stops (pause 0, sign 'none') and legs; `undefined` when there's no context.
- [ ] `contextShot(scene, aspect, seaPaths)` in `camera.ts`: `fitShot` of the context route's bounds.
- [ ] `seaLegsOf` adds context sea legs.
- [ ] `copy_context` op and `applyPatch(project, patch, opts: { sources?: ReadonlyMap<string, Project> })`. Errors: unknown folder in sources (a bug if the tool didn't load it), no such scene, a scene that is its own context, a source scene with fewer than 2 stops.
- [ ] Validation: `context-sea-fallback` warning.
- [ ] Tests: schema, route, patch (copy from this project, from a source, errors, `context: null`), `paths.test.ts` for `seaLegsOf`.

### Task 3: Drawing context (Sonnet)

- [ ] `MapStage.load`: build the context route, put it in a `mapper-context` GeoJSON source, add a `mapper-context-line` layer under the route layers. Visibility follows the route layer.
- [ ] Overlay: faint dots at context stops, under the scene's own stop dots, on the route layer.
- [ ] e2e test in `test/e2e/stage.test.ts` style: a scene with context shows the faint line where its own route doesn't go.

### Task 4: MCP tools (Sonnet)

- [ ] `update_project` collects `copy_context` folders, checks each is absolute, loads it (a missing project is a `ToolError` with a fix), and passes `sources` to `applyPatch`.
- [ ] `projectResult`: `camera.keys` and `camera.resolvedContext` per scene; a summary line `Context: <from>, N stops.` and `Camera keys: 0 s, 1 s, …`.
- [ ] Descriptions: `update_project` (keys, `copy_context`, `context: null`), `get_project` (`resolvedContext`, keys).
- [ ] Tests in `test/mcp/tools.test.ts`.

### Task 5: Studio (Sonnet)

- [ ] Glide mode adds **Add key** (the current view at the scrubber's time; replaces a key at that frame), a chip per key showing its time (click scrubs there; × removes it) and **Clear keys**. **Fit to route** also clears keys. Each is one undoable edit.
- [ ] When keys are set, **Use as start/end shot** are hidden, since keys win.
- [ ] Context draws in the studio through the stage. No copy UI; that stays an agent job.
- [ ] Studio e2e test for adding and removing a key.

### Task 6: Docs (Haiku)

- [ ] Skill doc (repo copy and `~/.claude/skills/mapper/SKILL.md`): a "Subclip of one leg" recipe with `copy_context` and keys, and the two new fields.
- [ ] `docs/plan.md` gets a line for this feature.

### Final review (Opus)

Whole-branch review, then set up `/Users/benclissen/Movies/Mapper/icon-sxm-to-stt-test` with context from `icon-of-the-seas-eastern-caribbean` (read only) and keys, and check the contact sheet: whole route at 0 s, St. Maarten close by about 1 s, then the ship sailing to St. Thomas.
