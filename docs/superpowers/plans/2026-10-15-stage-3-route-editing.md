# Stage 3 route editing implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not begin implementation until the user approves this plan.

**Goal:** Make scenes real in project file version 2, upgrade version 1 files on load, and let the user reshape a route by hand in the studio (via points, curved/sharp points, a legs panel with transport and mode pickers, a style picker, undo and redo), with every edit visible to the agent through `get_project` and the preview tools.

**Architecture:** `core` gains the version 2 schema, a version 1 upgrade inside `parseProject`, scene-level route/timeline/camera functions, via-point ops and a pure `invertPatch`. Every tool and the studio work on `scenes[0]`. The studio keeps its own undo history of `{ forward, inverse }` patches; the server tags broadcasts with the writing client's id, so any other writer clears that history. The render planner reads `scenes[0]` once and carries each scene's frame count and arrivals.

**Tech Stack:** TypeScript, Zod 4, React, MapLibre GL, Vite, Playwright with Chrome, ffmpeg, Vitest, pixelmatch.

**Spec:** [Mapper design](../specs/2026-10-13-mapper-local-agent-design.md), including the 2026-10-15 stage 3 revision at the top, plus Project file, Core › Routing, MCP tools, Studio and server, and Testing. Also read `AGENTS.md` and `docs/plan.md`.

## Global constraints

- Coordinates are `[lng, lat]` (GeoJSON order) everywhere in the public interface.
- Defaults for new projects: 3840×2160, 25 fps, 16:9.
- `core` imports nothing else from the package and has no DOM, filesystem or network imports.
- Writes are atomic (temp file, fsync, rename) and bump `updatedAt`. Server and MCP tools go through the same `core` load, patch and save functions.
- A patch is applied in full or not at all, and the result must pass schema validation.
- Version 1 files upgrade in memory on load and are written as version 2 on the next save. Nothing rewrites a file just because it was read.
- Stage 3 scope: scenes exist in the format, but tools and the studio use one scene (`scenes[0]`). No `scene?` tool argument, scene ops or scene tabs (stage 6). No new symbol drawings or themes (stage 5): every transport other than `none` still draws as the dot. No sea or air routing (stage 4).
- Every render carries the map credit (`MAP_CREDIT`). Satellite, if ever touched, is EOxCloudless 2016 only.
- Clean-room: no Map Animator code, assets, UI text or file format. Public repo: nothing private.
- Run `npm test` and `npm run test:e2e` one after the other, never together. CLI unit tests rebuild `dist`.

## Review focus

1. **An agent write lands between a studio edit and its response.** The studio must not record an inverse computed against a state the server didn't have, and the history must clear. Test: Task 9, "clears history when the saved project's base is not the one the studio held".
2. **Clicking a handle.** Clicking or dragging a stop or via handle must not also select a leg or insert a via point through the map's click handler. Test: Task 7, "clicking a via handle does not insert a point".
3. **Routes across the antimeridian.** Inserting a via point on the `pacific` fixture stores a longitude wrapped to ±180, and the route stays continuous (no jump across the world). Test: Task 2, `nearestOnLeg` on `pacific`; Task 3, `insert_via` with a wrapped point keeps route length within 1%.
4. **Files Mapper can't read.** A broken version 1 file reports its version 1 path, not a version 2 one, and a `schemaVersion` of 3 says it was made by a newer Mapper. Test: Task 1, `migrate.test.ts`.
5. **Fast repeated edits.** Two drags in quick succession must apply in order, each inverse computed against the project the server actually changed. Test: Task 9, "queues a second edit until the first is saved".

---

## Starting point

Branch `stage-3-route-editing` in the worktree `.claude/worktrees/stage-3-route-editing`, from `main` at `bdb9e57`. Baseline: `npm test` passes 469 tests. The spec revision is committed as `66ecf54`.

## Files

| File | Responsibility |
|---|---|
| `src/core/schema.ts` | Version 2 schema, full `SymbolKind`, `ViaPoint`, `Scene`, `defaultModeFor`, `defaultProject` |
| `src/core/migrate.ts` (new) | Frozen version 1 schema and `upgradeV1` |
| `src/core/route.ts` | Curves continuous across stops, sharp corners, `knots`, `nearestOnLeg` |
| `src/core/timeline.ts`, `camera.ts`, `validate.ts` | Take a scene and the output instead of a project |
| `src/core/patch.ts` | `set` / `sceneSet` split, via ops, `null` removes optional keys, transport default modes |
| `src/core/undo.ts` (new) | `invertPatch` |
| `src/core/protocol.ts` | `origin` on broadcasts, `PatchResponse` |
| `src/render/export-plan.ts`, `export-types.ts`, `render.ts`, `render-pass.ts`, `preview.ts`, `page.ts`, `src/studio/render-mode.ts` | Planner on `scenes[0]`, frame count and arrivals in the plan, `scene` page option |
| `src/render/capture.ts`, `manifest.ts`, `src/server/atomic.ts` (new), `src/server/store.ts`, `src/cli/main.ts` | Stage 2 follow-ups |
| `src/server/server.ts` | Client id header, `origin`, `previousUpdatedAt` |
| `src/mcp/tools.ts`, `src/cli/main.ts`, `skills/mapper/SKILL.md` | `sceneSet`, via ops, per-scene results, route-shaping guidance |
| `src/studio/stage/MapStage.ts` | Edit-only route layers and leg selection |
| `src/studio/edit/RouteEditor.ts` (new) | Via handles, click to select or insert, delete, Alt-click |
| `src/studio/edit/PointMenu.tsx` (new) | Right-click menu for stop and via handles |
| `src/studio/edit/LegsPanel.tsx`, `StylePicker.tsx`, `labels.ts` (new) | Legs sidebar, theme picker, display names |
| `src/studio/edit/history.ts` (new) | Undo/redo stacks and the serial edit queue, no DOM |
| `src/studio/edit/App.tsx`, `Stage.tsx`, `api.ts`, `edit.css` | Wiring |

---

### Task 1: Project file version 2 and the version 1 upgrade

**Model:** Opus 5.5 (`opus`). It touches every consumer and sets the data model the rest of the plan builds on.

**Files:**
- Modify: `src/core/schema.ts`, `src/core/patch.ts`, `src/core/route.ts`, `src/core/timeline.ts`, `src/core/camera.ts`, `src/core/validate.ts`, `src/core/index.ts`
- Create: `src/core/migrate.ts`, `test/core/migrate.test.ts`
- Modify call sites so everything compiles and passes: `src/render/*.ts`, `src/mcp/tools.ts`, `src/cli/main.ts`, `src/studio/**`, `bench/*.ts`, `test/fixtures/projects.ts` and every test that builds or reads a project
- Test: `test/core/schema.test.ts`, `test/core/patch.test.ts`, `test/core/migrate.test.ts`

**Interfaces:**
- Produces:
  - `ViaPointSchema` / `ViaPoint = { at: LngLat; sharp?: boolean }`; `Stop.sharp?: boolean`; `Leg = { mode: LegMode; via: ViaPoint[]; symbol?: SymbolKind }`
  - `SYMBOLS` (22 ids, in this order: `none dot arrow walk bike motorcycle scooter car campervan bus coach train tram cable-car ferry cruise-ship sailboat speedboat kayak plane helicopter balloon`), `SymbolKind`
  - `defaultModeFor(symbol: SymbolKind): LegMode`. Boats (`ferry cruise-ship sailboat speedboat kayak`) give `sea`. `plane helicopter balloon` give `air`. `none dot arrow` give `line`. Everything else gives `land`.
  - `SceneSchema` / `Scene = { id: string (uuid); name: string; timing; stops; legs; look; camera }`
  - `ProjectSchema` with `schemaVersion: 2` and `scenes: Scene[]` (min 1), plus `id name createdAt updatedAt output credit`. The superRefine checks the leg count and stop-id uniqueness per scene (paths `['scenes', i, 'legs']` and `['scenes', i, 'stops', j, 'id']`) and unique scene ids.
  - `ThemeId` stays `'paper' | 'blank'`.
  - `defaultProject({ id, name, now, output?, sceneId? })`: one scene named after the project, with `sceneId ?? id`.
  - `parseProject(json: unknown): Project` accepts version 1 or 2.
  - `src/core/migrate.ts`: `ProjectV1Schema` (a frozen copy of today's schema, including today's 8-symbol enum) and `upgradeV1(v1: ProjectV1): unknown`
  - `buildRoute(scene: Scene): Route`, `buildTimeline(scene: Scene, fps: Fps, route: Route): Timeline`, `resolveShots(scene: Scene, aspect: Aspect, route: Route)`, `cameraAt(scene: Scene, aspect: Aspect, route, timeline, frame)`, `validateProject(project: Project)`, which checks every scene and prefixes issue paths with `['scenes', i]`
  - `ProjectPatch = { set?: Record<string, unknown>; sceneSet?: Record<string, unknown>; ops?: Op[] }`. Ops act on `scenes[0]`. `setStops(project, args)` acts on `scenes[0]`.
  - `SceneRenderInput = { id; name; output; credit; scene: Scene }` (replaces `content`). `toPageProject` builds a version 2 project with `scenes: [scene]`. Task 5 removes it.
  - Fixtures: `greekIslands(scene?: Partial<Scene>)`, `pacific()`, `stopsAt(points, scene?: Partial<Scene>)`, `emptyProject()`, and a new `sceneOf(p: Project): Scene` returning `p.scenes[0]`. The project and scene ids stay fixed.

- [ ] **Step 1: Write the failing tests**

`test/core/migrate.test.ts`:
- `upgrades a version 1 project to one scene`: a v1 object with two stops, one leg `{ mode: 'line', via: [[24, 37]], symbol: 'ship' }` and `look.symbol: 'ship'` parses to `schemaVersion: 2`, `scenes.length === 1`, `scenes[0].id === project.id`, `scenes[0].name === project.name`, `legs[0].via` equal to `[{ at: [24, 37] }]`, and both symbols equal to `'cruise-ship'`. Timing, look, camera and stops match the input.
- `upgrade is stable across loads`: parsing the same v1 JSON twice gives deep-equal projects.
- `reports version 1 paths for a broken version 1 file`: a v1 file with `stops[0].at = [200, 0]` throws a `ProjectError` whose first issue path is `['stops', 0, 'at', 0]`.
- `rejects a newer schema version`: `schemaVersion: 3` throws a `ProjectError` with message `This project was made by a newer version of Mapper (schema version 3). Update Mapper to open it.` at path `['schemaVersion']`.

`test/core/schema.test.ts`, added:
- `defaultModeFor` for `ferry`→`sea`, `balloon`→`air`, `arrow`→`line`, `campervan`→`land`, and all 22 symbols map to some mode.
- `rejects a scene with the wrong leg count` (path `['scenes', 0, 'legs']`), `rejects duplicate scene ids`, `rejects a project with no scenes`, and `accepts sharp on stops and via points`.

`test/core/patch.test.ts`, added:
- `sceneSet patches the first scene`: `{ sceneSet: { look: { theme: 'blank' } } }` changes `scenes[0].look.theme`.
- `set rejects scene fields`: for each of `timing`, `look`, `camera`, `stops`, `legs`, `set` fails at `['set', key]` with a message containing `sceneSet` or `ops`. For `scenes`, `id`, `createdAt` and `schemaVersion` it fails at `['set', key]`.
- `sceneSet rejects other keys`: `id`, `stops` and `legs` fail at `['sceneSet', key]`.

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run --project unit test/core/migrate.test.ts test/core/schema.test.ts test/core/patch.test.ts`
Expected: FAIL (no `migrate.ts`, schema still version 1).

- [ ] **Step 3: Implement the schema, the upgrade and the core signatures**

`parseProject`: read `schemaVersion` from the raw object. A value of 1 goes through `ProjectV1Schema` (issues keep v1 paths), then `upgradeV1`, then `ProjectSchema`. A number above 2 throws the newer-version error. Anything else goes to `ProjectSchema`. `upgradeV1` maps `ship` → `cruise-ship` on `look.symbol` and on each `leg.symbol`, and wraps each via as `{ at }`. Route, timeline, camera and validate change signature as listed above. Their behaviour doesn't change in this task.

- [ ] **Step 4: Update every call site, fixture and test to version 2**

Consumers read `project.scenes[0]`. `applyPatch` splits `set` (only `name`, `output`, `credit`) from `sceneSet` (only `name`, `timing`, `look`, `camera`, merged into `scenes[0]`). The studio's existing `set: { camera: … }` patches become `sceneSet`. `update_project`'s MCP input picks up `sceneSet` through `ProjectPatchSchema.shape`, and its `run` passes it on. `projectResult` keeps its current data shape, computed from `scenes[0]` (Task 6 reshapes it).

- [ ] **Step 5: Run everything**

Run: `npm run typecheck && npm test`
Expected: no type errors; all unit tests pass.
Then run: `npm run test:e2e`
Expected: all pass. Rendering hasn't changed, so the goldens are untouched.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: project file version 2 with scenes, upgrading version 1 files on load"
```

---

### Task 2: Curves through stops, sharp corners and leg hit-testing

**Model:** Opus 5.5 (`opus`). Curve maths, plus a golden refresh that needs judgement.

**Files:**
- Modify: `src/core/route.ts`
- Test: `test/core/route.test.ts`; goldens in `test/e2e/golden/`

**Interfaces:**
- Consumes: `Scene`, `ViaPoint`, `Stop.sharp` from Task 1.
- Produces:
  - `RouteLeg.knots: number[]`: indices into `path`/`xy` of the leg's start stop, each via point in order, and the end stop. Its length is always `via.length + 2`, even when points coincide.
  - `nearestOnLeg(route: Route, legIndex: number, at: LngLat): { at: LngLat; insertIndex: number; distance: number }`. Here `at` is the nearest point on the leg with its longitude wrapped to ±180. `insertIndex` is the `via` index a new point there should take: the number of via knots at or before the nearest segment. `distance` is in Mercator units.

- [ ] **Step 1: Write the failing tests**

- `curves through a stop between two line legs`: `stopsAt([[0,0],[1,0],[1,1]])`. The turn between the last segment of leg 0 and the first segment of leg 1 is under 15°.
- `makes a corner at a sharp stop`: the same scene with `stops[1].sharp = true`. The turn is between 85° and 95°. Each leg is straight (every heading within the leg is within 0.5° of the next).
- `makes a corner at a sharp via point`: a single leg `[0,0]` → `[2,0]` with via `[{ at: [1,1], sharp: true }]`. The path contains `[1,1]` exactly, at `knots[1]`, and the turn there is over 60°.
- `breaks the curve at a sea or air leg`: legs `line`, `sea`. The turn at stop 1 equals the straight-segment angle, because nothing curves through.
- `knots stay aligned when points coincide`: a via equal to the start stop. `knots.length === 3` and `path[knots[i]]` equals each control point.
- `still passes exactly through every stop`: for greek islands, `path[knots[0]]` and `path.at(-1)` equal the stop coordinates.
- `nearestOnLeg returns the insert index`: a leg with vias at x = 1 and x = 2 on `[0,0]`→`[3,0]`. Points near x = 0.5, 1.5 and 2.5 give `insertIndex` 0, 1 and 2.
- `nearestOnLeg wraps longitude on the Pacific route`: on `pacific()`, a point at lng `-179.5` near the line returns `at[0]` in [-180, 180] and `distance` under 0.01.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project unit test/core/route.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Build chains of consecutive legs whose modes are `line` or `land`. A chain breaks at a stop with `sharp`. A `sea` or `air` leg is a chain on its own. For each chain, take the control points (stops and vias, unwrapped as today), split them at sharp vias, and run `curveThrough` on each run so neighbouring runs share their corner point. Then cut the sampled polyline back into legs at the stop knots. Track knot indices through the dedup of coincident points so that coincident knots point at the same sample.

- [ ] **Step 4: Run the unit tests, then the e2e tests with refreshed goldens**

Run: `npm test`
Expected: pass. Then run: `UPDATE_GOLDENS=1 npm run test:e2e`, look at the three refreshed `greek-*.png` frames (the line now curves smoothly through Mykonos and Santorini), then run `npm run test:e2e`.
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/route.ts test/core/route.test.ts test/e2e/golden
git commit -m "feat: curve routes through stops and make corners at sharp points"
```

---

### Task 3: Via-point ops, clearing optional fields and transport default modes

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Modify: `src/core/patch.ts`, `src/core/schema.ts` (`StopInputSchema`)
- Test: `test/core/patch.test.ts`

**Interfaces:**
- Consumes: Task 1's schema, and Task 2's `buildRoute` for one length check.
- Produces these ops, all acting on `scenes[0]`:
  - `{ op: 'insert_via', leg: number, index: number, point: ViaPoint }`, with `index` from 0 to `via.length`
  - `{ op: 'update_via', leg, index, changes: { at?: LngLat; sharp?: boolean | null } }`
  - `{ op: 'remove_via', leg, index }`
  - `update_stop.changes` and `update_leg.changes` accept `null` for an optional key (`label`, `terminal`, `sharp`, `day`, `ref` on stops; `symbol` on legs), which removes it. `update_leg.changes.via` is `ViaPoint[]`.
  - `update_leg` with `symbol` set and no `mode` also sets `mode = defaultModeFor(symbol)`. With `symbol: null` and no `mode`, the mode is left alone.
  - `StopInput.symbol?: SymbolKind`. It sets the leaving leg's `symbol`, and its mode when `legMode` is missing.
  - Range errors use the existing wording style. For example: `leg index 3 is out of range; use 0 to 1` at `['ops', i, 'leg']`, and `via index 4 is out of range; use 0 to 2` at `['ops', i, 'index']`.

- [ ] **Step 1: Write the failing tests**

- `insert_via adds a point at the index` (at 0, in the middle, and at the end), `update_via moves and toggles sharp`, `update_via with sharp null removes the key`, `remove_via removes the point`.
- `via ops reject out-of-range leg and via indexes`, with the paths and messages above.
- `update_stop with label null removes the label`.
- `update_leg symbol sets the default mode`: `ferry` → `sea`. `{ symbol: 'plane', mode: 'line' }` keeps `line`. `{ symbol: null }` removes `symbol` and leaves the mode.
- `set_stops symbol sets the leaving leg`: a stop with `symbol: 'train'` gives leg `{ mode: 'land', symbol: 'train' }`. With `legMode: 'line'` as well, it gives `{ mode: 'line', symbol: 'train' }`.
- `insert_via with a wrapped point keeps the Pacific route continuous`: inserting `{ at: [-179.9, -16] }` into `pacific()` leg 0 leaves `buildRoute` length within 1% of the original.
- `ops are all or nothing`: `[insert_via ok, remove_via out of range]` throws, and the input project is unchanged.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project unit test/core/patch.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement in `applyOp`, extending the op union in `ProjectPatchSchema`**

- [ ] **Step 4: Run them and see them pass**

Run: `npm test`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core test/core
git commit -m "feat: via-point ops, clearing optional fields and transport default modes"
```

---

### Task 4: Inverse patches

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Create: `src/core/undo.ts`, `test/core/undo.test.ts`
- Modify: `src/core/index.ts`

**Interfaces:**
- Consumes: `applyPatch`, `ProjectPatch` and the ops from Task 3.
- Produces: `invertPatch(before: Project, patch: ProjectPatch): ProjectPatch`. It returns a patch that, applied to `applyPatch(before, patch)`, gives a project deep-equal to `before`. It supports `sceneSet`, `update_stop`, `update_leg`, `insert_via`, `update_via` and `remove_via`. Any other op, and any `set`, throws `Error('invertPatch does not support <name>')`. Ops are inverted against each intermediate state and returned in reverse order.

- [ ] **Step 1: Write the failing tests**

`test/core/undo.test.ts`, with the helper `roundTrip(p, patch)`, which expects `applyPatch(applyPatch(p, patch), invertPatch(p, patch))` to equal `p`:
- A round trip for each supported op on `greekIslands()`. This includes `update_stop` adding `sharp: true` where there was none, `update_leg` setting `symbol: 'ferry'` (which also changes the mode), `update_leg` `symbol: null`, and `update_via` adding and removing `sharp`.
- `sceneSet` round trips: `look.theme`; `camera.start` set where none existed; `camera: { start: null, end: null }` where both existed.
- `a multi-op patch round trips`: `[insert_via 0, update_via 0, insert_via 1]`.
- `throws for insert_stop and set`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project unit test/core/undo.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

The inverse of a merge patch is computed key by key from the patch. Where both values are objects, recurse. Where `before` has the key, use its value. Otherwise use `null`. An inverse `update_*` op lists each changed key with its old value, or `null` where the key was absent. The inverse of `insert_via` is `remove_via` at the same index. The inverse of `remove_via` is `insert_via` with the old point.

- [ ] **Step 4: Run them and see them pass**

Run: `npm test`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/undo.ts src/core/index.ts test/core/undo.test.ts
git commit -m "feat: invertPatch for studio undo"
```

---

### Task 5: Render planner on scenes, plus the Stage 2 follow-ups

**Model:** Opus 5.5 (`opus`). The render pipeline and the cancel path.

**Files:**
- Modify: `src/render/export-plan.ts`, `export-types.ts`, `render.ts`, `render-pass.ts`, `preview.ts`, `page.ts`, `capture.ts`, `manifest.ts`, `src/studio/render-mode.ts`, `src/studio/stage/MapStage.ts`, `src/studio/stage/overlay.ts`, `src/server/store.ts`, `src/cli/main.ts`
- Create: `src/server/atomic.ts`
- Test: `test/render/export-plan.test.ts`, `test/render/manifest.test.ts`, `test/render/render-cancel.test.ts`, a new `test/render/capture.test.ts`, `test/cli/cli.test.ts`, `test/server/store.test.ts`

**Interfaces:**
- Consumes: Task 1's version 2 schema.
- Produces:
  - `PlannedScene = { id; name; scene: Scene; totalFrames: number; arrivals: Timeline['arrivals'] }`, with `ExportPlan.scenes: PlannedScene[]`. `planExport` builds the route and timeline once per scene. `SceneRenderInput`, `adaptV1Scene` and `toPageProject` are deleted. `render.ts` and `sceneMarkers` use the plan's `totalFrames` and `arrivals`, and `render-pass.ts` checks the page's `frameCount` against `plannedScene.totalFrames` without rebuilding.
  - Render page: `window.mapper.load(project: Project, { pixelRatio, layer?, scene?: string, … })`, which loads the scene with that id, or `scenes[0]` when it's omitted. An unknown id throws `Error('No scene <id> in this project.')`. `MapStage.load(project: Project, sceneId?: string)`. The overlay takes `scene` and `credit` instead of `project`.
  - `writeFileAtomic(file: string, text: string): Promise<void>` in `src/server/atomic.ts`: temp file in the same folder, write, `fsync`, rename, and remove the temp file on failure. `store.ts` and `manifest.ts` both use it.
  - `renderFps` in the manifest and result is clip frames per second: completed work frames ÷ number of passes ÷ elapsed seconds.
  - `capturePng` sends `Emulation.setDefaultBackgroundColorOverride` only when the `transparent` value differs from the last one sent on that page. The remembered value is forgotten when the page fires `load`.
  - CLI `render`: once the render has resolved, a signal arriving while the result and summary print doesn't report "Cancelled.". Set `ending = true` before printing.

- [ ] **Step 1: Write the failing tests**

- `export-plan.test.ts`: `planExport carries frame count and arrivals`. For greek islands, `plan.scenes[0].totalFrames` equals `buildTimeline(...)`'s, and `arrivals.length === 4`.
- `manifest.test.ts`: `writes the manifest through writeFileAtomic` (mock `../server/atomic.js` and assert it's called). `store.test.ts`: `writeFileAtomic leaves no temp file on failure` (write into a read-only folder).
- `capture.test.ts`: with a fake page and CDP session, two captures with `transparent: true` send the override once; a third with `false` sends it again; after `load` is emitted, the next capture sends it again.
- `render-cancel.test.ts` (or the existing render tests): `renderFps counts clip frames`. With a fake clock and a three-pass plan, completing 30 work frames in 1 s reports `renderFps` 10.
- `cli.test.ts`: `a signal after the render finishes is not reported as a cancel`. Use the existing CLI harness and send SIGINT once stdout has the JSON. stderr has no `Cancelled.`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project unit test/render test/server/store.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement the interfaces above**

- [ ] **Step 4: Run everything**

Run: `npm run typecheck && npm test`, then `npm run test:e2e`
Expected: all pass, with goldens unchanged since Task 2.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: plan renders from scenes and carry frame counts; fix stage 2 follow-ups"
```

---

### Task 6: Agent interface for version 2

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Modify: `src/mcp/tools.ts`, `src/cli/main.ts` (help text), `skills/mapper/SKILL.md`, `README.md`
- Test: `test/mcp/tools.test.ts`, `test/e2e/mcp.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3 and 5.
- Produces: `projectResult(project)` data is `{ project, scenes: [{ id, name, timeline: { durationSeconds, totalFrames, arrivals }, camera: { resolvedStart, resolvedEnd } }], validation }`, with the top-level `timeline` and `camera` removed. The summary text adds one line per leg that has vias or a transport, e.g. `Leg 1 Piraeus → Mykonos: ferry (sea), 2 via points, 1 sharp`.

- [ ] **Step 1: Write the failing tests**

- `tools.test.ts`: `get_project returns per-scene timelines` (`data.scenes[0].timeline.arrivals.length === 4`). `update_project applies sceneSet and via ops` (`sceneSet.look.theme = 'blank'`, plus `insert_via`, then `get_project` shows `scenes[0].legs[0].via[0].at`). `update_project rejects set.look with a hint to use sceneSet`. `the summary lists shaped legs`.
- `mcp.test.ts`: update the end-to-end flow to read `scenes[0]`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project unit test/mcp`
Expected: FAIL.

- [ ] **Step 3: Implement, and rewrite the `get_project` and `update_project` descriptions**

`update_project`: "'set' is a JSON Merge Patch over name, output and credit. 'sceneSet' is a JSON Merge Patch over the scene's name, timing, look and camera. 'ops' edits stops, legs and via points: insert_stop, update_stop, remove_stop, move_stop, update_leg, insert_via, update_via, remove_via. null removes a key. Setting a leg's symbol without a mode also sets that transport's usual mode. Coordinates are [lng, lat]."

SKILL.md gets a "Shaping routes" section: add via points to bend a line around land or a coastline, mark a stop or via `sharp` for a corner, set a transport per leg with `update_leg`, check the result with a contact sheet, and know that the user may have reshaped the route in the studio, so read `get_project` before changing legs. README examples move to `sceneSet`.

- [ ] **Step 4: Run them**

Run: `npm test`, then `npm run test:e2e -- test/e2e/mcp.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp src/cli skills README.md test/mcp test/e2e/mcp.test.ts
git commit -m "feat: sceneSet, via ops and per-scene results in the MCP tools"
```

---

### Task 7: Studio route editing on the map

**Model:** Opus 5.5 (`opus`). MapLibre interaction, event ordering and drag state.

**Files:**
- Modify: `src/studio/stage/MapStage.ts`, `src/studio/edit/Stage.tsx`, `src/studio/edit/App.tsx`, `src/studio/edit/edit.css`
- Create: `src/studio/edit/RouteEditor.ts`, `src/studio/edit/PointMenu.tsx`
- Test: `test/e2e/studio.test.ts`

**Interfaces:**
- Consumes: `nearestOnLeg`, `RouteLeg.knots` (Task 2) and the ops (Task 3).
- Produces:
  - `MapStageOptions.editing?: boolean`. When true, MapStage adds the source `mapper-edit` (one LineString per leg, property `leg: number`, using the full `route.legs[i].path`) and two layers beneath the route line. `mapper-edit-route` is the whole route at 35% opacity of the line colour and half its width. `mapper-edit-selected` is the selected leg at the line colour, width + 4, opacity 0.5. Also `MapStage.setSelectedLeg(leg: number | undefined)` and `MapStage.route` (the loaded `Route`). Render mode and previews never set `editing`.
  - `RouteEditor` (owned by `StageController`) shows stop handles (moved from `StageController`) and via handles for the selected leg. Its callbacks:
    `onSelectLeg(leg: number | undefined)`, `onEdit(patch: ProjectPatch, label: string): Promise<boolean>`, `onPointMenu(target: PointTarget, client: { x: number; y: number })`.
  - `type PointTarget = { kind: 'stop'; id: string } | { kind: 'via'; leg: number; index: number }`
  - `Stage` props add `selectedLeg`, `onSelectLeg`, `onEdit` and `onPointMenu`, replacing `onStopMoved`. Stop drags now go through `onEdit` with label `Move <stop name>`.
  - Edit labels: `Add a via point`, `Move a via point`, `Remove a via point`, `Make <name> sharp` / `Curve through <name>`, `Make a via point sharp` / `Curve through a via point`.
  - Test ids: `via-marker-<leg>-<index>` (handle, `tabindex=0`, `aria-label="Via point <index+1> of leg <leg+1>"`, with class `sharp` when sharp); `stop-marker-<id>` (existing, plus class `sharp`); `point-menu` with buttons `point-menu-sharp` (text `Sharp corner` or `Curve through`) and `point-menu-remove` (via points only, text `Remove`). The stage gets `data-selected-leg`.

Behaviour:
- A map click queries `mapper-edit-route` in a ±8 px box. A hit on another leg selects it. A hit on the selected leg sends `insert_via` at `nearestOnLeg(...).insertIndex`, with `at` rounded to 5 places and the latitude clamped. A miss does nothing.
- Clicks and mousedowns on handles never reach the map's click handler.
- Dragging a via handle sends `update_via { at }` on dragend.
- Delete or Backspace on a focused via handle sends `remove_via`. Escape deselects.
- Alt-click on a stop or via handle toggles `sharp` (`true`, or `null` to curve through).
- Right-click on a handle opens `PointMenu` at the pointer. It closes on Escape, an outside click or a choice.
- Sharp handles are squares and curved ones are circles (CSS on `.sharp`).

- [ ] **Step 1: Write the failing Playwright tests in `test/e2e/studio.test.ts`**

These use the existing studio harness and the greek fixture.
- `selects a leg by clicking its line`: click the midpoint of leg 1 (from `map.project`), and the stage has `data-selected-leg="1"`.
- `inserts a via point on the selected leg and the file has it`: click the midpoint again. `via-marker-1-0` appears and `loadProject(folder).scenes[0].legs[1].via.length === 1`.
- `drags a via point`: drag `via-marker-1-0` by (40, 30) px, and the saved `at` changes.
- `removes a via point with Delete`: focus it, press Delete, and the via is gone from the file.
- `Alt-click and the menu toggle sharp`: Alt-click a stop marker, and the file's stop has `sharp: true` and the marker has class `sharp`. Open the menu on the via, click `point-menu-sharp`, and the via has `sharp: true`.
- `clicking a via handle does not insert a point`: click `via-marker-1-0`, and the leg still has exactly one via.
- `Escape deselects`.
- `renders never show edit layers`: a preview through the existing helper has no `mapper-edit-route` layer (`map.getLayer` is undefined in render mode).

- [ ] **Step 2: Run them and see them fail**

Run: `npm run test:e2e -- test/e2e/studio.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the full e2e suite**

Run: `npm run typecheck && npm run test:e2e`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/studio test/e2e/studio.test.ts
git commit -m "feat: edit via points and sharp corners in the studio"
```

---

### Task 8: Legs panel and style picker

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Create: `src/studio/edit/LegsPanel.tsx`, `src/studio/edit/StylePicker.tsx`, `src/studio/edit/labels.ts`
- Modify: `src/studio/edit/App.tsx`, `edit.css`
- Test: `test/e2e/studio.test.ts`, `test/studio/labels.test.ts`

**Interfaces:**
- Consumes: `selectedLeg`/`onSelectLeg` from Task 7, `onEdit` (the same function App passes to Stage), and `buildRoute(scene).legs[i].notAvailable`.
- Produces:
  - `labels.ts`: `SYMBOL_LABELS: Record<SymbolKind, string>` (for example `'cruise-ship': 'Cruise ship'`, `'cable-car': 'Cable car'`, `none: 'None'`), `MODE_LABELS: Record<LegMode, string>` (`Line`, `Land`, `Sea`, `Air`), and `THEME_LABELS: Record<ThemeId, string>` (`Paper`, `Blank`).
  - `<LegsPanel scene route selectedLeg onSelectLeg onEdit />`: an `<aside>` titled `Legs`. Each row (`leg-row-<i>`, `aria-selected` when selected, clicking it selects the leg) reads `<i+1> · <from> → <to>` and has:
    - `leg-symbol-<i>`: a select whose first option is `Default (<scene symbol label>)` (value `''`, which sends `symbol: null`), followed by the 22 transports. Label `Change leg <i+1> transport`.
    - `leg-mode-<i>`: Line, Land, Sea, Air. Label `Change leg <i+1> mode`.
    - When `notAvailable`: a note `Drawn as a plain line for now.`
    With no legs, it shows `Add stops through your agent to see legs here.`
  - `<StylePicker theme onEdit />`: a select `theme-picker` labelled `Map style`, which sends `sceneSet: { look: { theme } }` with label `Map style: <label>`.
  - The studio layout puts the stage on the left and the legs panel on the right (fixed 280 px), with the controls row under both. The style picker sits in the controls row next to the shot panel.

- [ ] **Step 1: Write the failing tests**

- `labels.test.ts`: every `SymbolKind`, `LegMode` and `ThemeId` has a non-empty label.
- `studio.test.ts`: `lists legs`, with 3 rows for greek and the first reading `1 · Piraeus → Mykonos`. `transport picker sets symbol and mode`: choose `ferry` on leg 0, and the file has `{ symbol: 'ferry', mode: 'sea' }` and the row shows the note. `Default clears the symbol`. `mode picker overrides the mode`. `style picker changes the theme` (the file's `look.theme` is `blank`). `clicking a row selects the leg on the map` (`data-selected-leg`).

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project unit test/studio && npm run test:e2e -- test/e2e/studio.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run them and see them pass**

Run: `npm test && npm run test:e2e -- test/e2e/studio.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/studio test/studio test/e2e/studio.test.ts
git commit -m "feat: legs panel with transport and mode pickers, and a map style picker"
```

---

### Task 9: Undo, redo and outside changes

**Model:** Opus 5.5 (`opus`). The ordering between HTTP responses and WebSocket broadcasts is concurrency logic.

**Files:**
- Modify: `src/core/protocol.ts`, `src/server/server.ts`, `src/studio/edit/api.ts`, `src/studio/edit/App.tsx`, `edit.css`
- Create: `src/studio/edit/history.ts`, `test/studio/history.test.ts`
- Test: `test/server/server.test.ts`, `test/e2e/studio.test.ts`

**Interfaces:**
- Consumes: `invertPatch` (Task 4), and `onEdit` from Tasks 7 and 8.
- Produces:
  - `protocol.ts`: `ServerMessage = { type: 'project'; project: Project; origin?: string }` and `PatchResponse = { project: Project; previousUpdatedAt: string }`. Clients send the header `X-Mapper-Client: <id>`, matching `/^[A-Za-z0-9_-]{1,64}$/`. Any other value is ignored.
  - Server: the patch handler records `previousUpdatedAt` inside the `mutateProject` callback and responds with `{ project, previousUpdatedAt }`. It saves `saved.updatedAt → clientId` in a per-entry map of the last 32 entries. `reload` broadcasts with `origin` from that map when one is present.
  - `api.ts`: `CLIENT_ID` (random per page load), `patch(body): Promise<PatchResponse>` sending the header, and `subscribe(onMessage: (m: { project: Project; origin?: string }) => void, onClose)`.
  - `history.ts` (no DOM):
    ```ts
    interface Entry { label: string; forward: ProjectPatch; inverse: ProjectPatch }
    class EditHistory { push(e: Entry): void; takeUndo(): Entry | undefined; takeRedo(): Entry | undefined
      clear(): void; readonly canUndo: boolean; readonly canRedo: boolean; readonly undoLabel?: string; readonly redoLabel?: string }
    class EditQueue { constructor(send: (patch: ProjectPatch) => Promise<PatchResponse>)
      run(make: (current: Project) => ProjectPatch | undefined, current: () => Project): Promise<PatchResponse | undefined> }
    ```
    `push` clears the redo stack. `takeUndo` moves the entry to the redo stack and `takeRedo` moves it back. `EditQueue` sends one patch at a time. It calls `make` with the latest project only when the previous send has settled.
  - App: every studio edit, including the shot buttons and camera mode, goes through `edit(patch, label)`. That function queues the patch, computes `invertPatch(current, patch)` against the project at send time, and on success records `{ label, forward: patch, inverse }`. The history clears when:
    - the response's `previousUpdatedAt` isn't the `updatedAt` the studio held at send time, or
    - a broadcast newer than the current project arrives with `origin !== CLIENT_ID`.
    When either happens and the history wasn't empty, it shows the info notice `Your agent changed the project. Undo history cleared.`
  - Undo sends `inverse` and redo sends `forward`, both through the queue. A failure shows `Couldn't undo. <server message>` and drops the step.
  - Buttons `undo` and `redo` in the controls row, with titles `Undo <label> (⌘Z)` and `Redo <label> (⇧⌘Z)`, disabled when empty. Cmd-Z and Shift-Cmd-Z on `window` work unless the event target is an `input`, `select` or `textarea`.

- [ ] **Step 1: Write the failing tests**

- `history.test.ts`:
  - `undo then redo moves entries between stacks`
  - `push clears redo`
  - `queues a second edit until the first is saved`: two `run` calls where the first send is a deferred promise. `make` for the second sees the project from the first response.
- `server.test.ts`:
  - `patch responds with previousUpdatedAt`
  - `broadcast carries the patching client's origin`: open a WebSocket, patch with `X-Mapper-Client: abc`, and the message has `origin: 'abc'`
  - `outside writes broadcast with no origin`: `mutateProject` directly, and the message has no `origin`
  - `an invalid client id is ignored`
- `studio.test.ts`:
  - `undo and redo a via insert` (the file loses and regains the via; the buttons enable and disable)
  - `Cmd-Z undoes a transport change`
  - `Cmd-Z in a select does not undo`
  - `an agent write clears the history`: edit in the studio, then `mutateProject` from the test with a name change. The undo button is disabled and the notice is shown.
  - `clears history when the saved project's base is not the one the studio held`: intercept `**/patch` with Playwright `route`, write the project from the test before continuing the request, and check that the undo button stays disabled after the edit.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project unit test/studio test/server`, then `npm run test:e2e -- test/e2e/studio.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run them and see them pass**

Run: `npm run typecheck && npm test`, then `npm run test:e2e`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat: studio undo and redo, cleared by outside changes"
```

---

### Task 10: Acceptance test and docs

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Create: `test/e2e/route-editing.test.ts`
- Modify: `docs/plan.md`, `README.md` (studio section), `skills/mapper/SKILL.md` (tell the user what the studio can do)

- [ ] **Step 1: Write the acceptance test**

`studio edits reach the agent`:
1. Create a greek project through the MCP client (`test/e2e/mcp.test.ts` harness), call `open_studio` and load the URL in Playwright.
2. Take `preview_frame` at `{ progress: 1 }` and keep the PNG.
3. In the studio, select leg 0, insert a via point at the leg's midpoint, drag it 80 px north, and make it sharp. Set leg 1's transport to `ferry`.
4. MCP `get_project` returns `scenes[0].legs[0].via` with one point and `sharp: true`, and `legs[1]` is `{ symbol: 'ferry', mode: 'sea' }`.
5. A new `preview_frame` at `{ progress: 1 }` differs from the first by more than 0.5% of pixels (pixelmatch).
6. A version 1 `mapper.json` written by the test opens in the studio and shows its legs. After one studio edit, the file on disk has `schemaVersion: 2`.

- [ ] **Step 2: Run it**

Run: `npm run test:e2e -- test/e2e/route-editing.test.ts`
Expected: PASS. If it fails, fix the cause in the owning task's code, not in the test.

- [ ] **Step 3: Update docs**

`docs/plan.md`: mark stage 3 `(built)`. README: describe studio route editing and undo. SKILL.md: say the user can reshape routes in the studio, and that the agent should call `get_project` afterwards.

- [ ] **Step 4: Run the full verification**

Run: `npm run typecheck && npm test`, then `npm run test:e2e`, then `MAPPER_NET=1 npm run test:e2e`
Expected: all pass; the network tests pass when online.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/route-editing.test.ts docs/plan.md README.md skills
git commit -m "test: studio route edits reach the agent; docs for stage 3"
```

---

### Final review

**Model:** Opus 5.5 (`opus`), reviewing the whole branch against the spec, the 2026-10-15 revision and this plan's Review focus. Fixes go through a fresh implementer at the tier of the task that owns the code, then a re-review (Haiku 5.5 for small fixes).
