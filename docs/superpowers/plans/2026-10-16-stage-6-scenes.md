# Stage 6 scenes implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not begin implementation until the user approves this plan.

**Goal:** A project holds several scenes. The agent picks one with `scene` on every tool and adds, duplicates, removes and reorders them with scene ops. The studio shows them as tabs. A render joins the picked scenes into one clip or writes one per scene, and the layered export writes a compound clip per scene, placed back to back on one Final Cut timeline.

**Architecture:**
- **Core:** a scene reference (id or 1-based position) is resolved once per call. `ProjectPatch.scene` names the scene that `sceneSet` and the stop ops act on. Scene ops join the `ops` list, and `invertPatch` learns them, so studio undo covers scene edits.
- **Render:** `planExport` plans one pass per (scene, layer). With `join`, each scene's flattened pass writes a part, and the parts are joined without re-encoding into `all.mp4`. The FCPXML writer already handles several scenes; it gains the `join` switch and per-scene asset names.
- **Studio:** the active scene is studio state kept in the URL. Every studio patch carries its id, and undo steps remember which scene to show.

**Tech Stack:** TypeScript, Zod 4, React, MapLibre GL, Playwright with Chrome, ffmpeg (concat demuxer), Vitest, the MCP SDK.

**Spec:** [Mapper design](../specs/2026-10-13-mapper-local-agent-design.md): Project file, MCP tools (the `scene?` rule, the render row and the scene ops), Studio and server (scene tabs), Rendering (output folder), FCPXML, Testing, and the revisions at the top. Also read `AGENTS.md` and `docs/plan.md`. The decisions made while brainstorming this stage are in "Stage 6 decisions" below. Where they differ from the spec they replace it, and Task 11 copies them into the spec.

## Stage 6 decisions

- **Scene references.** `scene` is a scene id or a 1-based position. Without it, a call uses scene 1. On a project with more than one scene, every result names the scene it touched, as `Scene 2 of 2 · Sail`.
- **Patches.** `ProjectPatch` gains `scene?`. It's resolved to an id once, before any op runs. `sceneSet` and the stop, leg and via ops act on that scene, even if a scene op in the same patch moves it. A stop op after an op that removed it fails.
- **Scene ops** (op indexes are 0-based, like the stop ops):
  - `add_scene { index?, name?, copyLookFrom?, id? }`
    - Inserts an empty scene at `index` (default: the end), named `Scene N` (N is its new position).
    - Copies `look` and `timing` from `copyLookFrom` (a scene reference; default: the scene before the new one, or the one after it at index 0).
    - From that scene's camera it copies `mode`, `easing` and `follow`, never `start` or `end`.
    - `id` is optional; the studio always sends one.
  - `duplicate_scene { id, newId? }`: a deep copy placed right after the original, named `<name> copy`. Its stops get fresh ids.
  - `remove_scene { id }`: the last scene can't be removed.
  - `move_scene { id, index }`
  - `restore_scene { index, scene }`: puts a whole scene back, ids included. Studio undo uses it. Tool descriptions don't mention it.
- **Undo** covers every studio scene edit, delete included. Undoing a delete restores the whole scene. Undo and redo switch to the tab the step was made on.
- **Render arguments.**
  - `scenes?: (id | position)[]` picks scenes. The default is all of them. They're always rendered in film order, and duplicates are rejected.
  - `join?: boolean` (default true) joins them into one clip; false writes one file per scene.
  - `range` is in seconds on the joined timeline. With `join: false` it's allowed only when one scene is picked.
  - CLI: `--scenes 1,3` and `--each`.
- **The cut between scenes is a hard cut**, joined without re-encoding. Transitions are added in Final Cut.
- **Output folder:**

  | | `join: true` | `join: false` |
  |---|---|---|
  | Flattened | `all.mp4` / `all.mov` | `01-<scene-slug>.mp4` / `.mov`, `02-…` |
  | Preview | `preview.mp4` | `01-<scene-slug>-preview.mp4` |
  | Layers | `01-<scene-slug>/map.mov`, `route.mov`, `signs.mov` | same |
  | FCPXML | compound clips plus a project timeline | compound clips only |

  The two-digit prefix is the scene's film position. A one-scene project's layer folder is now named after its scene, not the project. New projects name their scene after the project, so it's usually the same name.
- **Validation:** errors block a render only in a picked scene. An unpicked empty scene doesn't stop it.
- **Credit:** the union over the rendered scenes only.
- **FCPXML:** asset names become `<scene> · Map`, `<scene> · Route` and `<scene> · Signs`.
- **Studio tabs:**
  - A strip across the top of the stage, with one tab per scene showing its name and length.
  - `+` adds a scene after the active one, with its look, and switches to it.
  - Each tab has a menu with Rename, Duplicate, Move left, Move right and Delete. Delete doesn't ask first, because undo restores the scene.
  - The active scene is in the URL as `?scene=<id>`.
- **Stage 4 deferral, done here:**
  - The studio keys the selected leg by its stop pair.
  - It sends index-based edits (`update_leg`, `insert_via`, `update_via`, `remove_via`) with the base version, so a stale index is refused with a 409 and nothing changes.
- **Not in this stage:** the open items from Stage 4 and Stage 5 (flight bow, Baltic skerries, the pale `aloftandaway` style, white signs on `monochrome`, the badge under a sign, fontnik, thin assertions). The Opus re-review of the Stage 5 render and terrain path runs on `main` before this branch starts (see Starting point).

## Global constraints

- Coordinates are `[lng, lat]` (GeoJSON order) everywhere in the public interface.
- `core` imports nothing else from the package and has no DOM, filesystem or network imports.
- Every render carries the map credit for what it shows. Satellite uses EOxCloudless **2016** only (CC BY 4.0).
- **Clean-room:** no Map Animator code, themes, icons, sign art, UI text or file format. **Public repo:** nothing private.
- **Project files stay schema version 2.** Scenes are already in the format. Every existing file loads unchanged, and new projects still start with one scene.
- Every camera state is a pure function of the frame number. Each scene has its own timeline starting at frame 0.
- Defaults for new projects: 3840×2160, 25 fps, 16:9.
- FCPXML stays version 1.11 and validates against `FCPXMLv1_11.dtd` from the installed Final Cut Pro.
- Run `npm test` and `npm run test:e2e` one after the other, never together. CLI unit tests rebuild `dist`.
- **Any e2e failure, network or not:** save the full output to `/tmp/stage6-e2e-<YYYYMMDD-HHmmss>.log` before rerunning, and name the file in the report. (Stage 5 left one unexplained `MAPPER_NET` failure with no output kept.)

## Review focus

1. **One-scene projects.** A project with one scene, and every version 1 file, must plan, render and preview as before. Two things change: the layer folder takes the scene's slug, and the asset names gain the scene name. Test: Task 5, "a one-scene project plans as before".
2. **The join at the cut.** Separately encoded H.264 parts (VideoToolbox, or libx264 as the fallback) must join into a file whose frame timestamps rise by exactly one frame duration across the cut: no dropped, doubled or stretched frame. Test: Task 10, "the joined clip has even frame timing across the cut".
3. **The agent and the studio on different scenes.**
   - When the agent edits scene 2 while the user is on scene 1, the studio stays on scene 1. Its history is cleared as for any outside change.
   - When the agent moves scenes around, the studio stays on the same scene, found by id.
   - Test: Task 8, "an agent move keeps the active tab on the same scene". Task 9, "an agent edit to another scene clears history and keeps the tab".
4. **Duplicate and empty scene names.**
   - Two scenes both called "Day 1" get folders `01-day-1` and `02-day-1` and distinct FCPXML ids.
   - A scene with an empty name gets the slug `scene`, not `project`.
   - Test: Task 5, "same-named scenes get distinct folders". Task 6, "same-named scenes stay distinct".
5. **A cancelled or failed joined render.** Parts already finished are kept, and listed in the manifest and in `render_status` as finished scene clips. No half-joined `all.mp4` is left under the final name. Test: Task 7, "cancel before the join keeps the scene parts".

---

## Starting point

- **Before Task 1, outside this plan:** run an Opus whole-branch-style review of the Stage 5 render and terrain path on `main`: `src/studio/stage/MapStage.ts`, `terrain-internals.ts`, `overlay.ts`, `themes.ts`, `src/studio/render-mode.ts` and `src/render/*`. Stage 5's final review ran on Sonnet. Fixes land on `main` first.
- **Branch:** `stage-6-scenes` in the worktree `.claude/worktrees/stage-6-scenes`, from `main` at `c63f382` or later.
- **Baseline:** `npm test` passes 760 tests.

## Files

| File | Responsibility |
|---|---|
| `src/core/scenes.ts` (new) | `SceneRefSchema`, `resolveScene`, `sceneLabel`, scene ops |
| `src/core/patch.ts` | `ProjectPatch.scene`, scene ops in `ops`, `setStops` takes `scene` |
| `src/core/undo.ts` | `invertPatch` for `scene` and the scene ops |
| `src/core/gpx.ts`, `src/core/validate.ts` | `importGpx` takes `scene`; fix strings name the scene |
| `src/mcp/tools.ts`, `src/cli/main.ts` | `scene` on tools, results that name scenes, `scenes`/`join` on render |
| `src/render/preview.ts` | Previews of any scene |
| `src/render/export-plan.ts`, `export-types.ts` | Scene picking, joined ranges, paths, joins |
| `src/render/render.ts`, `manifest.ts` | Running the joins, manifest offsets, disk estimate, credit of rendered scenes |
| `src/render/fcpxml.ts`, `publish.ts` | `join` switch, per-scene asset names |
| `src/studio/edit/SceneTabs.tsx` (new), `App.tsx`, `Stage.tsx`, `RouteEditor.ts`, `LegsPanel.tsx`, `api.ts`, `history.ts`, `edit.css` | Tabs, active scene, scene-aware undo, stop-pair selection, conditional index edits |
| `test/fixtures/projects.ts` | `twoScenes()` |
| `skills/mapper/SKILL.md`, `README.md`, `docs/plan.md`, spec | Docs |

---

### Task 1: Scene references and scene-targeted patches

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Create: `src/core/scenes.ts`, `test/core/scenes.test.ts`
- Modify: `src/core/patch.ts`, `src/core/gpx.ts`, `src/core/validate.ts` (the `resolvedName` fix string), `src/core/index.ts`
- Test: `test/core/patch.test.ts`, `test/core/gpx.test.ts`, `test/core/validate.test.ts`

**Interfaces:**
- Produces:
  - `SceneRefSchema = z.union([z.string().min(1), z.number().int().min(1)])` and `type SceneRef = string | number`.
  - `resolveScene(project: Project, ref?: SceneRef): { scene: Scene; index: number }`:
    - A string is matched against scene ids, and a number is a 1-based position. Without `ref` it returns scene 1.
    - An unknown reference throws `ProjectError([{ path: ['scene'], message }])`. The message lists every scene, e.g. `no scene 3; the scenes are 1 "Drive" (id …), 2 "Sail" (id …)`.
  - `sceneLabel(project: Project, index: number): string` gives `Scene 2 of 2 · Sail`. An empty name shows as `Untitled`.
  - `ProjectPatchSchema` gains `scene: SceneRefSchema.optional()`.
  - `applyPatch` resolves `patch.scene` once, then applies `sceneSet` and the stop, leg and via ops to that scene. It looks the scene up by id before each op, because Task 2's scene ops can move it.
  - `setStops(project, { scene?, stops, legMode?, replace? })` and `importGpx(project, imported, { scene?, legMode?, symbol? })` act on the given scene and leave the others untouched.
  - The `zoom-above-max` fix string uses the scene's real index (`scenes[1].camera.resolvedStart`), not `scenes[0]`.

- [ ] **Step 1: Write the failing tests:**
  - In `scenes.test.ts`:
    - `resolves a scene by id and by position`
    - `defaults to the first scene`
    - `an unknown reference lists the scenes` (path `['scene']`, and the message holds both names)
    - `position 0 is rejected by the schema`
    - `sceneLabel names the position and count`
  - In `patch.test.ts`:
    - `sceneSet and ops act on the chosen scene` (a two-scene project: change scene 2's theme and update a stop in it, and scene 1 is deep-equal to before)
    - `a stop id from another scene fails` (`update_stop` with scene 1's stop id while `scene: 2`, path `['ops', 0, 'id']`)
  - `setStops replaces only the chosen scene`
  - `importGpx writes only the chosen scene`
  - `zoom fix string names the scene's index`
- [ ] **Step 2: Run** `npx vitest run test/core`. Expected: FAIL.
- [ ] **Step 3: Implement it.** Use `projectWithScenes(n)` in the test (a local helper, or add it to `test/fixtures/projects.ts` next to `sceneOf`) to build projects with several scenes.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat: patches and stop setters target a scene by id or position"`

### Task 2: Scene ops

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Modify: `src/core/scenes.ts` (the op logic), `src/core/patch.ts` (op schemas and dispatch)
- Test: `test/core/scenes.test.ts`

**Interfaces:**
- Consumes: `resolveScene` (Task 1).
- Produces these members of `StopOp`'s union (rename the type to `PatchOp`, and keep `StopOp` as an alias for the stop, leg and via ops):
  - `{ op: 'add_scene', index?: number, name?: string, copyLookFrom?: SceneRef, id?: string (uuid) }`
  - `{ op: 'duplicate_scene', id: string, newId?: string (uuid) }`
  - `{ op: 'remove_scene', id: string }`
  - `{ op: 'move_scene', id: string, index: number }`
  - `{ op: 'restore_scene', index: number, scene: Scene }` (validated with `SceneSchema`)
  - `newSceneId()`: `crypto.randomUUID()`.

**Rules:**
- `add_scene`:
  - `index` may be from 0 to `scenes.length`; the default is `scenes.length`.
  - The default name is `Scene ${index + 1}`. Stops and legs start empty.
  - `look` and `timing` are deep-copied from `copyLookFrom`, which defaults to the scene at `index - 1`, or at 0 when `index` is 0.
  - `camera` is `{ mode, easing, follow? }` of that scene.
  - An `id` already in use fails at `['ops', i, 'id']`.
- `duplicate_scene`:
  - Inserted at the original's index + 1, named `${name} copy`.
  - The id is `newId ?? newSceneId()`, and every stop gets `newStopId()`. Legs are copied as they are; they're addressed by index, not by stop id.
- `remove_scene` on the only scene fails with `a project needs at least one scene; add another before removing this one`.
- `move_scene`: `index` may be from 0 to `scenes.length - 1`.
- `restore_scene`: `index` may be from 0 to `scenes.length`. A duplicate id fails through the schema's existing check.
- **Unknown ids** fail at `['ops', i, 'id']` with `unknown scene id '…'`.
- **Stop ops after their scene was removed** fail at `['ops', i]` with `scene '…' was removed earlier in this patch`.

- [ ] **Step 1: Write the failing tests:**
  - `add_scene copies look and timing but not the shots`
  - `add_scene at index 0 copies the scene after it`
  - `add_scene takes a given id; a used id fails`
  - `duplicate_scene gives fresh scene and stop ids`
  - `cannot remove the last scene`
  - `move_scene reorders; stop ops still hit the chosen scene` (one patch: `scene: <id of scene 1>`, `move_scene` it to index 1, then `update_stop` on it, and the change lands on the moved scene)
  - `a stop op after its scene was removed fails`
  - `restore_scene puts a removed scene back with its ids`
  - `a scene patch is all or nothing` (a valid `add_scene` followed by a bad `move_scene` leaves the input unchanged and throws)
- [ ] **Step 2: Run** `npx vitest run test/core/scenes.test.ts`. Expected: FAIL. **Step 3: Implement it.** **Step 4:** `npm test` and `npm run typecheck` PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat: add, duplicate, remove, move and restore scenes"`

### Task 3: Undo for scene edits

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Modify: `src/core/undo.ts`
- Test: `test/core/undo.test.ts`

**Interfaces:**
- Consumes: Task 1 (`patch.scene`), Task 2 (scene ops).
- Produces: `invertPatch(before, patch)` supports:
  - `scene`, which the inverse carries as the resolved scene **id**, never a position.
  - `sceneSet` on that scene.
  - The existing stop ops on that scene.
  - The scene ops:
    - `add_scene` with an `id`: the inverse is `remove_scene { id }`. Without an `id`, it throws `invertPatch needs add_scene to carry an id`.
    - `duplicate_scene` with `newId`: the inverse is `remove_scene { id: newId }`. Without `newId`, it throws.
    - `remove_scene`: the inverse is `restore_scene { index: old index, scene: the removed scene }`.
    - `restore_scene`: the inverse is `remove_scene { id: scene.id }`.
    - `move_scene`: the inverse is `move_scene { id, index: old index }`.
  - The inverse of a mixed patch undoes the ops last to first, as today. `sceneSet`'s inverse is applied after the ops' inverses.

- [ ] **Step 1: Write the failing tests.** Each one checks `applyPatch(applyPatch(before, p), invertPatch(before, p))` deep-equals `before`, ignoring `updatedAt`:
  - `undoes a sceneSet on scene 2`
  - `undoes a via edit on scene 2` (the inverse carries scene 2's id even when the patch named it by position)
  - `undoes add_scene with an id`
  - `undoes duplicate_scene with a newId`
  - `undoes remove_scene, restoring ids and position`
  - `undoes move_scene`
  - `undoes a rename then a move in one patch`
  - `refuses add_scene without an id`
- [ ] **Step 2: Run** `npx vitest run test/core/undo.test.ts`. Expected: FAIL. **Step 3: Implement it.** **Step 4:** `npm test` PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat: undo for scene edits"`

### Task 4: `scene` on the tools, and results that name scenes

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Modify: `src/mcp/tools.ts`, `src/render/preview.ts`
- Test: `test/mcp/tools.test.ts`, `test/cli/cli.test.ts`

**Interfaces:**
- Consumes: `SceneRefSchema`, `resolveScene`, `sceneLabel` (Task 1).
- Produces:
  - **Tool inputs:**
    - `scene: SceneRefSchema.optional()` on `set_stops`, `import_gpx`, `preview_frame` and `preview_contact_sheet`.
    - `update_project` already gets it through `ProjectPatchSchema.shape`.
    - The parameter's description: `Scene id, or its 1-based position. Default: the first scene`.
  - **Previews:**
    - `previewFrame({ folder, at, width?, scene? })` and `contactSheet({ folder, count?, width?, scene? })` show that scene.
    - `frameCaption(project, scene, timeline, frame)` takes the scene.
    - On a project with more than one scene, preview files are named `scene<position>-frame-<n>.png` and `scene<position>-contact-<stamp>.png`. One-scene projects keep today's names.
  - **`projectResult`:**
    - On a project with more than one scene, the summary opens with `<project>: 2 scenes, <joined seconds> s joined (<frames> frames), <w>×<h>.` Each scene's block is then headed `Scene 2 of 2 · Sail (id <id>)`, followed by today's lines. One-scene summaries are unchanged.
    - Each `data.scenes[i]` gains `position` (1-based) and `startSeconds` (its start in a join of every scene).
  - **Write results** (`set_stops`, `import_gpx`, `update_project`):
    - On a project with more than one scene, the summary's first line is `Changed <sceneLabel>.` For a patch with only scene ops, it's `Scenes: 1 Drive, 2 Sail.`
    - `data.scene` is `{ id, position }`.
  - **Descriptions:**
    - `get_project` says the scenes are in `project.scenes`, in film order, and drops the `scenes[0]` wording.
    - `update_project` describes `scene` and the four public scene ops (not `restore_scene`).
    - Every scene-aware tool says `scene` defaults to the first.

- [ ] **Step 1: Write the failing tests:**
  - `set_stops with scene 2 leaves scene 1 alone, and the summary names scene 2`
  - `update_project adds a scene and the summary lists the scenes`
  - `get_project heads each scene and gives the joined length`
  - `a one-scene summary is unchanged` (snapshot of today's text for `greekIslands()`)
  - `an unknown scene is a tool error that lists the scenes`
  - `preview_frame takes a scene` (unit test with the preview module mocked, as the existing tool tests do)
  - In `cli.test.ts`: `mapper set-stops --json with scene 2`
- [ ] **Step 2: Run the tests.** Expected: FAIL. **Step 3: Implement it.** **Step 4:** `npm test` and `npm run typecheck` PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat: tools pick a scene, and results name the scene they changed"`

### Task 5: Planning a render of several scenes

**Model:** Opus 5.5 (`opus`). Frame maths across scenes, and the paths every later task relies on.

**Files:**
- Modify: `src/render/export-plan.ts`, `src/render/export-types.ts`
- Test: `test/render/export-plan.test.ts`

**Interfaces:**
- Consumes: `resolveScene` (Task 1).
- Produces:
  - `planExport(project, { seaPaths, layers?, codec?, range?, scenes?: SceneRef[], join?: boolean })`.
  - `PlannedScene` gains:
    - `position` (1-based in the project).
    - `slug`: `slug(scene.name)`, falling back to `scene` (give `slug` a fallback parameter).
    - `offsetFrame`: where the scene's rendered frames start in the joined output, 0 with `join: false`.
  - `ExportPlan` gains:
    - `join: boolean`
    - `joins: { request: 'all' | 'preview'; path: string; kind: MediaKind; parts: string[] }[]`. `parts` are relative paths in film order; there is one entry per joined flattened request, and none when only one scene is rendered.
  - `RenderPass.path`:
    - Layers: `NN-<slug>/<layer>.mov`, where `NN` is the two-digit **position**.
    - Flattened, one scene: `all.<ext>` / `preview.mp4` with `join`, `NN-<slug>.<ext>` / `NN-<slug>-preview.mp4` without.
    - Flattened, several scenes joined: each scene writes `NN-<slug>.part.<ext>` (and `NN-<slug>-preview.part.mp4`), listed in `joins`.
  - **Pass order:** scene by scene in film order, and within a scene in today's layer order.
  - `pickedSceneIndexes(project, scenes?): number[]` (exported for Task 7's validation).

**Rules:**
- **Picking:** `scenes` entries resolve through `resolveScene`. An unknown entry throws a `RenderError` with the scene list as its fix. A duplicate (the same scene twice, by id or position) throws `Each scene may be picked only once.` An empty list throws `Pick at least one scene.` The order given doesn't matter; plans are in film order.
- **Range:** with `join: false` and more than one scene picked, a `range` throws `RenderError('A range needs one scene, or a joined render.', 'Pick one scene with scenes, or leave join on.')`. Otherwise the range is applied to the rendered timeline:

```
starts[i] = Σ totalFrames of picked scenes before i
[F, T)    = frameRange(range, Σ totalFrames, fps)        // the existing function
scene i:  from = max(F, starts[i]) - starts[i]
          to   = min(T, starts[i] + total[i]) - starts[i]
          kept only when to > from
          offsetFrame = max(F, starts[i]) - F
```

- Scenes with no frames in the range are left out of `scenes` and `passes`. A single scene in the range is planned like a one-scene render, with no join.

- [ ] **Step 1: Write the failing tests** (two blank scenes of 50 and 75 frames at 25 fps; build them with `stopsAt` and set `timing` to give exact frame counts):
  - `a one-scene project plans as before` (`all.mp4`; with layers `01-<scene-slug>/map.mov`; no `joins`)
  - `two scenes joined write parts and one join` (paths `01-drive.part.mp4` and `02-sail.part.mp4`, the join `all.mp4`, offsets 0 and 50)
  - `join false writes one clip per scene` (`01-drive.mp4`, `02-sail.mp4`, no `joins`)
  - `layers go in a folder per scene` (`01-drive/map.mov` … `02-sail/signs.mov`, and `fcpxml: true`)
  - `picks scenes in film order whatever order they are given` (`[2, 1]` plans Drive then Sail)
  - `rejects a duplicate pick, by id and position`
  - `a range across the cut` (`{ from: 1, to: 3 }`: Drive `[25, 50)` at offset 0, Sail `[0, 25)` at offset 25)
  - `a range inside one scene plans that scene alone with no join` (`{ from: 2.2, to: 2.8 }`: only Sail, written to `all.mp4`)
  - `a range with join false and two scenes is refused`
  - `same-named scenes get distinct folders` (`01-day-1`, `02-day-1`)
  - `an empty scene name gets the slug scene`
- [ ] **Step 2: Run** `npx vitest run test/render/export-plan.test.ts`. Expected: FAIL. **Step 3: Implement it.** **Step 4:** `npm test` and `npm run typecheck` PASS. (`render.ts` still compiles: it passes no `scenes` or `join`, so every scene is joined. Task 7 runs the joins.)
- [ ] **Step 5: Commit:** `git commit -m "feat: plan renders of picked scenes, joined or one per scene"`

### Task 6: FCPXML for several scenes

**Model:** Haiku 5.5 (`haiku`).

**Files:**
- Modify: `src/render/fcpxml.ts`, `src/render/export-types.ts` (`FcpxmlInput.join`), `src/render/publish.ts`
- Test: `test/render/fcpxml.test.ts`, `test/e2e/fcpxml.test.ts`

**Interfaces:**
- Consumes: `ExportPlan.join` (Task 5).
- Produces:
  - `FcpxmlInput.join: boolean`. With `false`, the event holds only the `ref-clip`s, with no `<project>`.
  - The asset `name` is `${scene.name} · Map` (`· Route`, `· Signs`). It's `Untitled · Map` when the name is empty.
  - `publishFcpxml({ dir, project, scenes, join, signal?, dtdPath? })`. `project.scenes` must already be only the rendered scenes, so the credit is their union (Task 7 passes them).

- [ ] **Step 1: Write the failing tests:**
  - `join false writes compound clips and no project`
  - `asset names carry the scene name`
  - `same-named scenes stay distinct` (two scenes named "Day 1": distinct `media` and `asset` ids, two `ref-clip`s in the project)
  - In the e2e DTD test: `a join-false two-scene document validates`
- [ ] **Step 2: Run** `npx vitest run test/render/fcpxml.test.ts`. Expected: FAIL. **Step 3: Implement it.** **Step 4:** `npm test` PASS, and `npx vitest run --project e2e test/e2e/fcpxml.test.ts` PASS (it skips if Final Cut isn't installed).
- [ ] **Step 5: Commit:** `git commit -m "feat: FCPXML without a timeline for separate scenes; scene names on assets"`

### Task 7: Rendering joined and separate scenes

**Model:** Opus 5.5 (`opus`). The render pipeline, cancellation and what's left on disk.

**Files:**
- Modify: `src/render/render.ts`, `src/render/manifest.ts`, `src/render/jobs.ts` (the args pass through), `src/mcp/tools.ts` (the `render` tool, `doneSummary`, `leftover`), `src/cli/main.ts` (`mapper render`)
- Test: `test/render/manifest.test.ts`, `test/render/disk-estimate.test.ts`, `test/mcp/tools.test.ts`, `test/cli/cli.test.ts`, `test/e2e/render.test.ts`

**Interfaces:**
- Consumes: `planExport`, `ExportPlan.joins`, `PlannedScene.offsetFrame`, `pickedSceneIndexes` (Task 5); `publishFcpxml` with `join` (Task 6).
- Produces:
  - **Arguments:** `RenderArgs` gains `scenes?: SceneRef[]`, `join?: boolean`, and a test hook `h264Encoder?: H264Encoder` that's used in place of `pickH264Encoder()`. The `render` tool takes the first two:
    - `scenes`: `Scenes to render, by id or 1-based position; default all. Always rendered in film order`.
    - `join`: `Default true: one clip with the scenes back to back. false: one file per scene`.
  - **CLI:** `mapper render --scenes <comma list> --each`. A list item made only of digits is a position; anything else is an id. Update the `render` usage and help text.
  - **Validation:** `assertRenderable(project, seaPaths, picked: number[])`. Errors whose path starts with `['scenes', i]` block the render only when `i` is picked. Errors without a scene path always block.
  - **Joins:** after every pass, each entry of `plan.joins` runs `joinSegments({ parts, out, codec })`. Its parts are deleted once its join succeeds. The joined output is added to `RenderResult.outputs` and the manifest as a completed output with `request` `all` or `preview`, `sceneId: 'joined'`, and the summed frames, segments and recoveries.
  - **Cancel or failure before a join:** the parts stay. They are listed as finished outputs, and `leftover` labels them `clip of <scene name>`.
  - **Manifest:**
    - `scenes[i]` gains `position` and `offsetFrame`.
    - The manifest gains `join: boolean`.
    - `credit` is `joinCredit(projectCredit({ scenes: rendered scenes }, 'written'))`.
    - `totalFrames` is the rendered frames: the sum of the scenes' ranges.
    - Stage 1's legacy fields (`codec`, `range`, `segments`, `recoveries`) stay for a flattened render of one scene only. `range` is `{ fromFrame, toFrame }` of that scene.
  - **Disk estimate:** `estimateDiskBytes(passes, size, joins = [])` adds `max(largest pass, Σ parts of each join)` instead of the largest pass alone.
  - **Results:** `RenderResult` gains `sceneStarts: { id: string; name: string; position: number; seconds: number }[]`. With a join, `doneSummary` adds one line per scene, `Scene 2 · Sail starts at 00:00:13:00`, using `formatTimecode`.
  - **Progress:** it keeps naming the active scene and layer.

- [ ] **Step 1: Write the failing tests:**
  - `manifest records join, positions and offsets`
  - `credit covers only the rendered scenes` (a satellite scene left out adds no satellite line)
  - `disk estimate counts the joined copy`
  - `an error in an unpicked scene doesn't block the render` (unit test on `assertRenderable`)
  - `render tool passes scenes and join through`
  - `mapper render --scenes 1,s_x --each parses positions and ids`
  - In `render.test.ts` (e2e, `blank`, `output.height: 1080`, a short `timing`):
    - `joins two scenes into all.mp4` (ffprobe frame count = the sum, and no `.part` files left)
    - `join false writes 01- and 02- clips`
    - `cancel before the join keeps the scene parts` (cancel through `signal` in the second scene's pass: the first scene's part is on disk and listed in the manifest, and there's no `all.mp4`)
- [ ] **Step 2: Run** `npm test`, then `npm run test:e2e -- test/e2e/render.test.ts`. Expected: FAIL. **Step 3: Implement it.** **Step 4:** both PASS, and `npm run typecheck` PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat: render picked scenes, joined into one clip or one file each"`

### Task 8: Studio scene tabs

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Create: `src/studio/edit/SceneTabs.tsx`
- Modify: `src/studio/edit/App.tsx`, `Stage.tsx` (passes `sceneId` to `MapStage.load`), `RouteEditor.ts` (`sync(project, sceneId)`, no `scenes[0]`), `api.ts`, `edit.css`
- Test: `test/e2e/studio.test.ts`

**Interfaces:**
- Consumes: the scene ops (Task 2), `ProjectPatch.scene` (Task 1).
- Produces:
  - In `api.ts`: `sceneParam(): string | undefined` and `setSceneParam(id: string)` (uses `history.replaceState`, keeping the project key and token).
  - In `App`:
    - `activeSceneId` state: the URL's scene if it exists, else scene 1's.
    - `edit()` adds `scene: activeSceneId` to every patch that has `sceneSet` or stop, leg or via ops. Scene-op patches get no `scene`.
  - **The tab strip** goes above the stage (`role="tablist"`). Each tab (`role="tab"`, `data-testid="scene-tab"`) shows `<name or Untitled> · <seconds> s`.
    - The strip scrolls sideways when the tabs don't fit.
    - `+` (`data-testid="scene-add"`, `aria-label="Add a scene"`) sends `add_scene { index: active + 1, copyLookFrom: activeId, id: newSceneId() }` and switches to the new scene once it's saved.
    - Each tab has a `⋯` button (`aria-label="Scene menu"`), and right-clicking a tab opens the same menu (`role="menu"`) with these items:
      - `Rename`: an inline text field. Enter saves through `sceneSet { name }`; Escape or an empty name cancels.
      - `Duplicate`: `duplicate_scene` with `newId`; switches to the copy.
      - `Move left` / `Move right`: `move_scene`. Turned off at the ends.
      - `Delete`: `remove_scene`. Turned off when there's one scene. Afterwards the studio shows the scene now at that position, or the last one.
  - **Undo labels:**
    - `Add a scene`
    - `Rename <old> to <new>`
    - `Duplicate <name>`
    - `Move <name> left` / `Move <name> right`
    - `Delete <name>`
  - **Switching tabs** resets the frame to 0, turns free view off, and clears the selected leg and any open point menu.
  - **Lost active scene:** if a project arrives without the active scene, the studio switches to the scene now at the old position (or the last) and shows the notice `That scene was removed. Showing <name>.`.

- [ ] **Step 1: Write the failing tests** (Playwright, `blank`, a `twoScenes()` fixture; add it to `test/fixtures/projects.ts`: "Drive", a three-stop land route, and "Sail", the `greekIslands()` stops):
  - `tabs list the scenes in order with their lengths`
  - `switching tabs shows that scene's stops` (count `.stop-handle`s, and check the legs panel's leg names)
  - `edits go to the active scene` (drag a stop on Sail; the project on disk changed only Sail)
  - `add, rename, duplicate, move and delete a scene`
  - `reload keeps the active scene`
  - `an agent move keeps the active tab on the same scene` (`move_scene` through the store while on Sail; Sail stays active)
  - `the agent removing the active scene switches tabs with a notice`
  - `an empty scene shows the add-stops message`
- [ ] **Step 2: Run** `npm run build` then `npx vitest run --project e2e test/e2e/studio.test.ts`. Expected: FAIL. **Step 3: Implement it.** **Step 4:** PASS, and `npm run typecheck` PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat: studio scene tabs"`

### Task 9: Undo across scenes, and safe index edits

**Model:** Opus 5.5 (`opus`). Undo, the edit queue and the conditional writes interact.

**Files:**
- Modify: `src/studio/edit/history.ts`, `App.tsx`, `RouteEditor.ts`, `LegsPanel.tsx`, `Stage.tsx`
- Test: `test/studio/history.test.ts`, `test/e2e/studio.test.ts`, `test/e2e/route-editing.test.ts`

**Interfaces:**
- Consumes: Task 3's `invertPatch`, and Task 8's `activeSceneId` and tab switching.
- Produces:
  - `Entry` gains `sceneBefore: string` and `sceneAfter: string`: the active scene when the edit was made, and the scene to show after it (the new scene for add and duplicate, the neighbour for delete, otherwise the same).
  - **After a step:** undo switches to `sceneBefore` and redo to `sceneAfter`, when that scene exists. The switch happens once the step is saved.
  - **Leg selection** is held as `{ from: string; to: string }` (stop ids). The index is worked out from the active scene's stops. If the pair is no longer adjacent, nothing is selected.
  - **Conditional index edits:** `edit()` sends the patch conditionally (`queue.run(…, { conditional: true })`) when it holds any of `update_leg`, `insert_via`, `update_via` or `remove_via`.
    - A 409 on such an edit saves nothing. The studio shows `The route changed while you were editing. Try again.`, and `onEdit` resolves `false`, so a dragged via handle goes back (the existing path).
    - Stop drags and `sceneSet` edits stay last-write-wins.

- [ ] **Step 1: Write the failing tests:**
  - `history.test.ts`:
    - `an entry keeps the scenes to show before and after`
  - E2E:
    - `undo of a via move on another tab switches back to it` (move a via on Drive, switch to Sail, undo: Drive is active and the via is back)
    - `undo of delete restores the scene in its place`
    - `redo of add shows the new scene`
    - `an agent edit to another scene clears history and keeps the tab`
    - `the selected leg follows its stops when the agent inserts a stop before it`
    - `a via drag after an unseen agent write is refused and the handle goes back` (hold the studio's WebSocket messages with Playwright's `routeWebSocket` (or close the socket), write a via change through the store, then drag a via: a 409 notice appears, the file keeps the agent's version, and the handle is back where the agent put it once the socket resumes)
- [ ] **Step 2: Run** `npm run build`, then the tests. Expected: FAIL. **Step 3: Implement it.** **Step 4:** PASS, and `npm test` and `npm run typecheck` PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat: undo across scenes; leg selection by stops; stale index edits refused"`

### Task 10: End to end with two scenes

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Create: `test/e2e/scenes.test.ts`
- Modify: `test/e2e/helpers.ts` (an ffprobe helper for frame timestamps, if none exists)

**Tests** (offline on `blank` unless marked; 1080p, short timings):
- **`the joined clip has even frame timing across the cut`:** a joined H.264 render of `twoScenes()`. `ffprobe -show_frames -select_streams v` gives `pkt_dts_time` values. Every step equals `den/num` within 1 µs, the frame count is the sum of the scenes, and the duration is that sum ÷ fps. Run it once with the picked encoder and once with `h264Encoder: 'libx264'` (Task 7's test hook).
- **`a layered two-scene export places the scenes back to back`:**
  - The DTD validates it (skipped without Final Cut).
  - Two `<media>` elements, named `<project> · Drive` and `<project> · Sail`.
  - The project spine has two `ref-clip`s at offsets `0s` and Drive's duration.
  - Each compound clip has its own arrival markers, from frame 0 of that scene.
  - ffprobe on each scene's three layers gives that scene's frame count.
- **`a range across the cut renders the end of one scene and the start of the next`:** the frame count matches the plan, and the manifest's offsets match.
- **`an unpicked empty scene doesn't block a render`:** add an empty scene, render `scenes: [1, 2]`, and it succeeds. Rendering every scene fails with the empty scene's `stops` error.
- **`MCP: add a scene, fill it, preview it and render joined`:** with the MCP SDK client, run `update_project` `add_scene` → `set_stops` with `scene: 2` → `preview_contact_sheet` with `scene: 2` → `render` → poll `render_status`. The summary lists both scenes' start times.
- **`MAPPER_NET`: `scenes in different styles join cleanly`:** scene 1 `aloftandaway`, scene 2 `satellite`. The joined render has both credits in the manifest, and a frame from each scene differs in its mean colour.

- [ ] **Step 1: Write the tests.** **Step 2:** run `npm run test:e2e` and then `MAPPER_NET=1 npm run test:e2e`. PASS. (Save the output of any failure as in Global constraints.)
- [ ] **Step 3: Commit:** `git commit -m "test: two scenes end to end"`

### Checkpoint: Final Cut import

The controller renders a layered two-scene export at 1080p with `MAPPER_NET=1` into `/tmp/stage6-fcp/`. The project has two scenes: "Drive", a short land route in `aloftandaway`, and "Sail", `greekIslands()` as a sea route in `aloftandaway`. The controller gives the user the FCPXML path, and the user opens it in Final Cut Pro 12.4.

Expected:
- An event named `Mapper` holds two compound clips, `<project> · Drive` and `<project> · Sail`, and a project with the two clips back to back on one timeline.
- Inside each compound clip, map is on the spine, with route and signs on lanes 1 and 2. The roles are `Map.Base`, `Map.Route` and `Map.Signs`, and there's a marker at each arrival.

This is a planned stop, so execution pauses here even under subagent-driven development. Problems go back to Task 6 or 7 as a fix round. Once the user confirms, Stage 2's outstanding Final Cut import check is cleared too.

### Task 11: Docs

**Model:** Haiku 5.5 (`haiku`).

**Files:**
- Modify: `skills/mapper/SKILL.md`, `README.md`, `docs/plan.md`, `docs/superpowers/specs/2026-10-13-mapper-local-agent-design.md`

**Changes:**
- **SKILL.md:**
  - A "Scenes" section:
    - When to split a trip (the film cuts away between parts of it).
    - `scene` on tools (id or 1-based position, default the first).
    - The four public scene ops, and that a new scene copies the look of the scene before it.
    - Calling `preview_contact_sheet` once per scene before rendering.
    - `scenes` and `join` on `render`, with the output folder table.
  - Replace "Stops, legs, look, camera and timing live in `project.scenes[0]`" with the per-scene wording.
  - Remove "One scene per project".
- **Spec:**
  - Add "**Revision, 2026-10-16 (stage 6 decisions):**" with the bullets from "Stage 6 decisions".
  - Update:
    - The MCP tools table: the `render` row becomes `scenes?`, `join?`, `layers?`, `codec?`, `range?`.
    - The scene ops list: `id?`, `newId?`, `restore_scene`, and the camera-copy rule.
    - The Output folder paragraph.
    - The FCPXML bullet on `'each'`, which becomes `join: false`.
    - The Studio scene-tabs bullet.
- **`docs/plan.md`:** mark stage 6 `(built)`. Note that the Final Cut import check from Stage 2 passed on the date of the checkpoint.
- **README:** a "Scenes" paragraph. Remove "Not yet: several scenes per project" and "One scene per project for now".

- [ ] **Step 1: Make the edits.** **Step 2: Commit:** `git commit -m "docs: stage 6 scenes"`

### Final review

Run the whole-branch review with Opus 5.5 (`opus`) against this plan and the spec. If Opus fails twice with an API error, as in Stage 5, stop and tell the user rather than dropping to Sonnet. Then run `npm test`, `MAPPER_NET=1 npm run test:e2e` (one after the other) and `npm run typecheck`. Finally, render the checkpoint project joined at 1080p as a flattened MP4 and watch the cut by eye.
