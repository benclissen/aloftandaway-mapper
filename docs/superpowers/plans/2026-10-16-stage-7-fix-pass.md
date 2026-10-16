# Stage 7 fix pass implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not begin implementation until the user approves this plan.

**Goal:** Clear what Stages 4–6 left open: the licence line, vehicle drawing on turns and tilts, silent terrain frames, the render-path minors, the `MAPPER_NET` flake, three look problems, the flight-bow wording, and the Stage 6 polish and test gaps. Each item ends fixed with a test, or parked with a reason the user agreed to.

**Architecture:** No new subsystems. One new channel: a render collects **warnings** (strings) from its pages and its clean-up, and reports them in the result, the manifest, the tool summaries and the CLI. Everything else is a local fix in the file that owns it.

**Tech Stack:** TypeScript, Zod 4, React, MapLibre GL 6.14.0, Playwright with Chrome, ffmpeg, Vitest, the MCP SDK.

**Spec:** [Mapper design](../specs/2026-10-13-mapper-local-agent-design.md), with its revisions at the top. Also read `AGENTS.md` and `docs/plan.md`. The decisions below were made while brainstorming this stage. Where they differ from the spec they replace it, and Task 12 copies them into the spec.

## Stage 7 decisions

- **Scope:** items 1–10 and 12–18 from the stage brief, plus a stress check for the corrupt capture found while debugging the flake. **The Baltic skerries (item 11) become Stage 8**, "Sea routes against OpenFreeMap water". That needs vector tiles decoded in Node, land rebuilt from clipped tile polygons, and network in a router that is pure and offline today. That's a stage of its own.
- **Final Cut check 9 stays pending.** The user will test end to end, including the import, after the last task (see "Final review").
- **Burned satellite credit** keeps EOX's wording and adds the licence:
  `Sentinel-2 cloudless 2016 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016), CC BY 4.0`
- **Flight bow:** keep the 15% minimum (`AIR_BOW`). Fix the wording: air legs "follow the great circle, bowed toward the nearer pole so even short flights curve (at least 15% of their length)".
- **A terrain frame that never settles** doesn't fail the render. It becomes a warning that names the frames.
- **Turning symbols** (plane, helicopter, arrow) take their angle from the line as drawn on screen, so tilt doesn't throw them off. **The helicopter** is mirrored top to bottom when its on-screen direction points west, so the rotor stays on top.
- **Look:**
  - `aloftandaway` gets palette B (blue-grey sea, light land).
  - `monochrome` gets a grey sea and near-white land.
  - Every sign in every style gets an edge: a soft shadow plus a hairline.
  - A sign sits high enough to clear the scene's vehicle. With a plain dot, it stays at today's 16 px.
- **The `MAPPER_NET` flake** was reproduced (21 failures in 200 cold-cache runs, saved under `/tmp/flake-probe/`). Its cause: the test diffs two independently loaded pages and counts every changed pixel as credit. In the failing runs, satellite and terrain tile seams came out 1 colour level apart between the two pages. That's invisible, and it doesn't misalign layers, so the product doesn't change. The test changes instead.
- **The corrupt capture.** One page in about 400 showed a 6×8 px solid block and a 9×5 px white hole over a sign letter.
  - 600 repeat captures of one loaded page were all identical, so screenshotting isn't the cause. Page load is.
  - The suspect is Chrome's GPU glyph cache, shared by the pages in one browser.
  - Task 8 measures it. The fix is a CPU-backed overlay canvas, adopted only if it costs ≤ 5% render speed. Otherwise the task stops and asks.

## Global constraints

- Coordinates are `[lng, lat]` (GeoJSON order) everywhere in the public interface.
- `core` imports nothing else from the package and has no DOM, filesystem or network imports.
- Every render carries the map credit for what it shows. Satellite uses EOxCloudless **2016** only (CC BY 4.0).
- **Clean-room:** no Map Animator code, themes, icons, sign art, UI text or file format. **Public repo:** nothing private.
- **Project files stay schema version 2.** Every existing file loads unchanged, including ones with blank scene names.
- Every camera state and overlay drawing is a pure function of the frame number. No state carries from one frame to the next, because layer passes render frames on separate pages.
- Defaults for new projects: 3840×2160, 25 fps, 16:9.
- FCPXML stays version 1.11 and validates against `FCPXMLv1_11.dtd` from the installed Final Cut Pro.
- Run `npm test` and `npm run test:e2e` one after the other, never together. CLI unit tests rebuild `dist`.
- **Any e2e failure, network or not:** save the full output to `/tmp/stage7-e2e-<YYYYMMDD-HHmmss>.log` before rerunning, and name the file in the report.
- From Task 1 on, `npm run typecheck` covers `test/`. Every task leaves it passing.

## Review focus

1. **Warnings across layer passes.** A layered export renders map, route and signs on separate pages. A frame that fails to settle on any of them must be reported once, by frame number, not once per pass. Test: Task 3, "warnings from several passes are merged by frame".
2. **A zero-length step on screen.** At a pause, at the end of the route, or when the look-ahead point projects onto the head, the on-screen vector is zero and the angle is undefined. The symbol must keep the map-based angle, not spin or vanish. Test: Task 6, "a zero-length screen step keeps the map heading".
3. **Old files with blank scene names** must still load, render and export, named `Scene N`. Only new input is refused. Test: Task 9, "a file with a blank scene name loads and exports as Scene N".
4. **A scene that mixes vehicles** (a `dot` leg and a badge leg) uses the largest lift for all its signs, and `validate_project`'s sign-overlap check uses the same lift as the drawing. Test: Task 7, "sign overlap measures with the scene's lift".
5. **A clean render prints nothing new.** With no warnings, summaries, the CLI and the manifest look as they do today: no empty "Warnings" line. Manifests written before this stage, without `warnings`, still read. Test: Task 3, "a clean render has no warnings line" and "an old manifest without warnings reads".

---

## Starting point

- **Branch:** `stage-7-fix-pass` in the worktree `.claude/worktrees/stage-7-fix-pass`, from `main` at `7b19918` or later.
- **Baseline:** `npm test` passes 844 tests, and `MAPPER_NET=1 npm run test:e2e` passes 161.
- **Reproduction kit:** `/tmp/flake-probe/probe.mts` (two pages, diff) and `capture-repeat.mts` (one page, repeated captures). They import from the main checkout by absolute path. Copy what Task 8 needs into `bench/`; don't import from `/tmp`.

## Files

| File | Responsibility |
|---|---|
| `tsconfig.test.json` (new), `package.json` | Type-check `test/`; pin `maplibre-gl` |
| `src/core/patch.ts`, `undo.ts`, `scenes.ts`, `src/mcp/tools.ts`, `src/studio/edit/history.ts` | One scene-op list; `sceneTitle`; blank-name refusal; summary lines |
| `src/core/credit.ts` | The licence on the burned line |
| `src/core/symbols.ts`, `src/studio/stage/overlay.ts`, `MapStage.ts` | On-screen angle, helicopter mirroring, sign edge, sign lift |
| `src/core/signs.ts`, `src/core/validate.ts` | `signLift`; overlap measured with it |
| `src/studio/stage/themes.ts` | `aloftandaway` and `monochrome` palettes |
| `src/studio/render-mode.ts`, `src/render/page.ts`, `render-pass.ts`, `render.ts`, `manifest.ts`, `preview.ts`, `src/cli/main.ts` | Warnings; style-load and terrain timeouts; source-aware fix text; join order |
| `src/studio/edit/Menu.tsx` (new), `PointMenu.tsx`, `SceneTabs.tsx`, `App.tsx`, `edit.css` | Shared menu; tab fixes |
| `bench/capture-stress.ts` (new) | Corrupt-capture stress check |
| `test/e2e/helpers.ts`, `test/e2e/look.test.ts` | Stubbed tiles; the deterministic credit test |
| `README.md`, `skills/mapper/SKILL.md`, `docs/plan.md`, spec | Docs |

---

### Task 1: Type-check the tests; one scene-op list

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Create: `tsconfig.test.json`
- Modify: `package.json` (the `typecheck` script), `src/core/patch.ts`, `src/core/undo.ts`, `src/core/index.ts`, `src/mcp/tools.ts`, `src/studio/edit/history.ts`, `src/studio/edit/App.tsx`
- Test: the eight test files with type errors today (`test/studio/history.test.ts` ×6, `test/render/publish.test.ts`, `test/render/fcpxml.test.ts`, `test/server/store.test.ts`, `test/render/render-cancel.test.ts`, `test/e2e/studio.test.ts`, `test/e2e/fcpxml.test.ts`), `test/core/patch.test.ts`

**Interfaces:**
- Produces:
  - `SCENE_OP_NAMES: readonly ['add_scene', 'duplicate_scene', 'remove_scene', 'move_scene', 'restore_scene']`.
  - `isSceneOp(op: { op: string }): op is SceneOp`.
  - Both are in `src/core/patch.ts` and exported from `core/index.ts`. The four copies (patch.ts, undo.ts, tools.ts's `endsWith('_scene')`, history.ts's `SCENE_OPS`) are deleted and import these.

- [ ] **Step 1:** Add `tsconfig.test.json`, extending `tsconfig.base.json`.
  - It includes `test/**/*.ts` and `test/**/*.tsx`, with `noEmit`, `allowImportingTsExtensions`, DOM libs, `jsx: react-jsx`, `moduleResolution: bundler` and types `node` and `vite/client`.
  - Append `&& tsc -p tsconfig.test.json` to `typecheck`.
- [ ] **Step 2:** Run `npm run typecheck`. Expected: FAIL with about 14 errors in `test/`, among them the `history.test.ts` mocks missing `seaPaths`. If anything also fails in `src/` under this config, fix the config, not `src/`.
- [ ] **Step 3:** Fix the test errors. Fix the types only; behaviour doesn't change.
- [ ] **Step 4:** Write the failing test `SCENE_OP_NAMES matches the scene op schema` in `patch.test.ts`. It compares the list with the `op` literals of `SceneOpSchema`'s options. Then add the export and replace the four copies.
- [ ] **Step 5:** `npm test` and `npm run typecheck` PASS.
- [ ] **Step 6: Commit:** `git commit -m "chore: type-check the tests; one scene-op list"`

### Task 2: The licence on the burned credit; a credit test that can't flake

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Modify: `src/core/credit.ts:4`, `test/e2e/helpers.ts`, `test/e2e/look.test.ts`
- Test: `test/core/credit.test.ts`, `test/e2e/look.test.ts`

**Interfaces:**
- Produces: `openRenderPage(..., { stubTiles?: boolean })`. With `stubTiles`, the page's context answers requests as follows:
  - `**/tiles/satellite/**`: one solid-colour 256 px PNG, `#5a6b4f`.
  - `**/tiles/terrain/**`: `flatTerrainTile()`.
  - `**/tiles/planet/**`: status 204.
  - Glyphs and fonts are still served. This needs no network.

- [ ] **Step 1: Write the failing tests:**
  - `credit.test.ts`: `the burned satellite line carries the licence`. `SATELLITE_CREDIT` equals the string in "Stage 7 decisions". Update the existing literal at L22.
  - `look.test.ts`, moved out of the `MAPPER_NET` block into an offline `describe`:
    - `burned credit fits a 16:9 frame`
    - `burned credit fits a 9:16 frame`
  - Both render `alpine()` as satellite with terrain, with `stubTiles`, burned versus description. They keep today's assertions (right margin, left edge ≥ `CREDIT.margin`, bottom, three lines, top).
  - Both add: **every changed pixel lies inside the credit box**, meaning y ≥ `height − margin − 2·lineHeight − 20` and x ≥ the measured left edge. Any other changed pixel fails, with its coordinates in the message.
  - The 9:16 case is the narrowest frame (1080 wide), so it proves the longest line fits.
- [ ] **Step 2:** Run `npx vitest run test/core/credit.test.ts`. Expected: FAIL. Then `npm run build` and `npx vitest run --project e2e test/e2e/look.test.ts`. Expected: the new tests fail until `stubTiles` exists.
- [ ] **Step 3:** Change the constant and add `stubTiles`.
- [ ] **Step 4:** Run both. Expected: PASS. Run the two e2e tests 20 times in a loop: 20/20 PASS.
- [ ] **Step 5: Commit:** `git commit -m "fix: the burned satellite credit carries CC BY 4.0; the credit test stubs its tiles"`

### Task 3: Render warnings, and terrain frames that never settle

**Model:** Opus 5.5 (`opus`). Render pipeline and page/Node plumbing.

**Files:**
- Modify: `src/studio/stage/MapStage.ts` (`settleOnTerrain`, `showFrame`), `src/studio/render-mode.ts`, `src/render/page.ts`, `src/render/render-pass.ts`, `src/render/render.ts`, `src/render/manifest.ts`, `src/render/jobs.ts`, `src/render/preview.ts`, `src/mcp/tools.ts` (`doneSummary`, `statusSummary`, the preview results), `src/cli/main.ts`
- Test: `test/render/warnings.test.ts` (new), `test/render/manifest.test.ts`, `test/mcp/tools.test.ts`, `test/e2e/render.test.ts`

**Interfaces:**
- Produces:
  - `MapStage.showFrame` resolves `{ settled: boolean }`. `settled` is false when the terrain loop used all `MAX_TERRAIN_SETTLES` placements. The `console.warn` is removed.
  - `MapperPage.renderFrame(n): Promise<{ settled: boolean }>` and `RenderPage.renderFrame(n): Promise<{ settled: boolean }>`.
  - In `src/render/warnings.ts` (new):
    - `type RenderWarnings = { unsettled: number[]; other: string[] }`
    - `mergeWarnings(a: RenderWarnings, b: RenderWarnings): RenderWarnings` takes the frame union, sorted and unique, and appends `other`.
    - `describeWarnings(w: RenderWarnings, scene?: string): string[]` gives one line for the unsettled frames:
      `Frames 12, 13 and 40: the camera height over terrain hadn't settled, so these frames may differ slightly between renders and between layers.`
      - At most 10 frame numbers, then `and N more`.
      - Then each `other` line.
      - It returns `[]` when both are empty.
  - Frame numbers are per scene, so the scene's label prefixes the line on multi-scene projects.
  - `RenderResult.warnings: string[]` and `ExportManifest.warnings?: string[]` (written only when non-empty). The render status gets the same field.
  - `doneSummary` and `statusSummary` end with `Warnings:` and one line per warning, only when there are any. The CLI prints the same lines to stderr.
  - `preview_frame` and `preview_contact_sheet` results add the same line when a previewed frame didn't settle.
  - Task 5 adds `other` lines through `mergeWarnings`.

- [ ] **Step 1: Write the failing tests:**
  - `warnings.test.ts`:
    - `warnings from several passes are merged by frame`
    - `more than ten frames are summed up`
    - `no warnings describe as nothing`
  - `manifest.test.ts`:
    - `the manifest lists warnings`
    - `an old manifest without warnings reads`
  - `tools.test.ts`:
    - `a clean render has no warnings line`
    - `a render with unsettled frames lists them`
  - E2E (`render.test.ts`): `a terrain frame that never settles is reported`. Add the test-only `RenderPageOptions.forceUnsettledAt?: number` (in `src/core/protocol.ts`, next to `faultAtFrame`). It makes that frame report `settled: false`. Assert the result's `warnings` and the manifest's.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4:** `npm test`, `npm run typecheck` and `npm run build && npx vitest run --project e2e test/e2e/render.test.ts` PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat: renders report warnings; unsettled terrain frames are named"`

### Task 4: Render-path minors

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Modify: `src/studio/stage/MapStage.ts:218-222` (style load), `src/render/render-pass.ts` (step budget, `load` in `step`), `src/render/preview.ts:189`, `src/render/page.ts:7-19` (fix text), `package.json` and `package-lock.json`
- Test: `test/mcp/errors.test.ts` (the fix-text tests, next to the assertion at :27), `test/e2e/preview-recovery.test.ts:101`, `test/e2e/render.test.ts` (the style timeout), `test/studio/terrain-internals.test.ts`

**Interfaces:**
- Produces:
  - **Style load:** it rejects after `STYLE_TIMEOUT_MS = 60_000` with `${MAP_DATA_ERROR} the map style did not load within 60 s.` It also rejects on the map's `error` event while loading. The Node side runs `page.load` inside `step()` in `render-pass.ts` and in `preview.ts`.
  - **Terrain budget:** a scene with terrain (`usesElevation`) gives `renderFrame` a step budget of `TERRAIN_FRAME_TIMEOUT_MS = (MAX_TERRAIN_SETTLES + 2) * 60_000 + 10_000`. Its comment says this is so the page's own 60 s idle timeout fires first, with the clearer message. Other frames keep `STEP_TIMEOUT_MS`.
  - **Fix text:** `mapDataFix(message: string): string` picks the fix by the failing URL in the message:
    - `/tiles/satellite/`: `Check the internet connection. Satellite imagery comes from tiles.maps.eox.at, and Mapper caches it after the first load.`
    - `/tiles/terrain/`: `Check the internet connection. Terrain comes from the elevation tiles on s3.amazonaws.com, and Mapper caches them after the first load.`
    - Anything else: today's OpenFreeMap text.
  - **MapLibre:** `"maplibre-gl": "6.14.0"`, with no caret. Run `npm install --save-exact maplibre-gl@6.14.0` so the lockfile agrees.

- [ ] **Step 1: Write the failing tests:**
  - `the fix names the satellite source`
  - `the fix names the terrain source`
  - `the fix names OpenFreeMap otherwise`
  - `maplibre-gl is pinned exactly`, in `terrain-internals.test.ts`. It reads `package.json`, and the version matches `/^\d+\.\d+\.\d+$/`.
  - `a style that never loads fails the load with the map-data error`. This is an e2e test: route the style's tile JSON or glyph request to never answer, and assert a rejection naming the style within the timeout. Use the test-only `RenderPageOptions.styleTimeoutMs?: number`, set to 2000.
  - Update the two literal assertions to the OpenFreeMap text.
- [ ] **Step 2:** Run them. Expected: FAIL. **Step 3:** Implement. **Step 4:** `npm test`, `npm run typecheck` and the touched e2e files PASS.
- [ ] **Step 5: Commit:** `git commit -m "fix: style loads time out; terrain frames get a full budget; fix text names the source; pin MapLibre"`

### Task 5: Join, then forget the parts, then delete them

**Model:** Opus 5.5 (`opus`). Recovery logic.

**Files:**
- Modify: `src/render/render-pass.ts:219` and `:238-251` (`joinParts` and the segment join), `src/render/render.ts:239-244` and `:309-320`
- Test: `test/render/render-join.test.ts` (new, modelled on the `slow-ffmpeg` fake in `test/render/render-cancel.test.ts:74-110`)

**Interfaces:**
- Consumes: Task 3's `mergeWarnings` and `RenderResult.warnings`.
- Produces:
  - `joinParts` no longer deletes anything.
  - After a successful join, `render.ts` first records the joined output and writes the manifest without the parts. Only then does it remove them with `removeParts(paths: string[]): Promise<string | undefined>`, which returns a warning line on failure instead of throwing:
    `Couldn't delete 2 scene parts after joining them: 01-drive.mp4, 02-sail.mp4 (EACCES). They're not needed; delete them yourself.`
  - The segment join inside a pass follows the same order. If segments never appear in the manifest, only the throw-to-warning change applies there.
  - Removal goes through a test hook next to `h264Encoder`, `removeFile?: (path: string) => Promise<void>`, so a test can make it fail.

- [ ] **Step 1: Write the failing tests:**
  - `the manifest stops listing the parts before they're deleted`: the hook records the manifest's outputs at the moment of each delete, and they don't include the part.
  - `a failed part delete is a warning, not a failure`: status `done`, the joined clip is listed, and the warning names the files.
  - `a failed scene join keeps the scene clips`: the fake ffmpeg fails the concat. The manifest is `failed`, both scene parts are kept and listed as outputs, and the error says the scene clips were kept.
- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement. **Step 4:** `npm test` and `npm run typecheck` PASS.
- [ ] **Step 5: Commit:** `git commit -m "fix: a join forgets its parts before deleting them; a failed delete is a warning"`

### Task 6: Turning symbols follow the line on screen; the helicopter stays upright

**Model:** Opus 5.5 (`opus`). Projection maths.

**Files:**
- Modify: `src/core/symbols.ts`, `src/studio/stage/overlay.ts:100-150` (`drawVehicle`) and `OverlayArgs`, `src/studio/stage/MapStage.ts:440-458` (`drawOverlay`)
- Test: `test/core/symbols.test.ts`, `test/studio/overlay.test.ts:82-91`, `test/e2e/look.test.ts`

**Interfaces:**
- Produces:
  - `screenAngle(from: [number, number], to: [number, number]): number | undefined`, in `core/symbols.ts`. It returns degrees clockwise from screen-up, in [0, 360), using `atan2(dx, -dy)`. It returns `undefined` when the two points are under 0.01 px apart.
  - `turnPose(angle: number, facing: 'right' | 'north-east' | 'up' | 'front', legFlipped: boolean): { rotate: number; mirrorY: boolean }`, also in `core/symbols.ts`:
    - `rotate = angle + TURN_OFFSET[facing]`. `TURN_OFFSET` moves into core with today's values.
    - `mirrorY` is only ever true for a `right`-facing drawing (the helicopter).
    - It's true when `sin(angle) < −sin(15°)` (the line points west on screen).
    - When `|sin(angle)| ≤ sin(15°)` (a nearly vertical line), it's `legFlipped`, so north–south legs don't flicker.
  - `OverlayArgs.screenAngle?: number` replaces the use of `bearing` for turning symbols.
  - `MapStage.drawOverlay` projects `state.head.at` and a point 4 layout px further along the route. It converts that to a route distance at the current zoom, uses `pointAt(route, distance + d)`, and uses the point behind at the very end. It passes `screenAngle(head, ahead)`.
  - When `screenAngle` is undefined, the overlay falls back to `heading − bearing`, as today.
  - `drawVehicle` applies `rotate`, then `ctx.scale(1, -1)` when `mirrorY`.

- [ ] **Step 1: Write the failing tests:**
  - `symbols.test.ts`:
    - `screen angle of a step east is 90`
    - `a zero-length screen step has no angle`
    - `a westbound helicopter is mirrored, not upside down`: angle 270 gives `{ rotate: 180, mirrorY: true }`
    - `an eastbound helicopter is not mirrored`
    - `a nearly vertical line takes the leg's facing`
    - `planes and arrows are never mirrored`
  - `overlay.test.ts`:
    - `a turning symbol uses the screen angle when given`
    - `a zero-length screen step keeps the map heading`
    - Update the helicopter rotation assertions.
  - E2E (`look.test.ts`, offline with `stubTiles` from Task 2): `a plane on a tilted shot points along its line`. Set pitch 60 and bearing 30 on a `plane` leg, and render a mid-leg frame. Add the test aid `MapperPage.lastScreenAngle(): number | undefined`, which returns the angle the last overlay draw used. Assert it's within 2° of `screenAngle` between `mapper.project()` of two route points 1 km either side of the head.
- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement. **Step 4:** `npm test`, `npm run typecheck` and the e2e file PASS. Refresh the `vehicle-badge*` goldens with `UPDATE_GOLDENS=1` only if a turning symbol in them changed, and say which in the report.
- [ ] **Step 5: Commit:** `git commit -m "fix: turning symbols follow the line on screen; the helicopter stays upright"`

### Task 7: Look: palettes, sign edge, sign lift

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Modify: `src/studio/stage/themes.ts` (`aloftandaway` at :133, `monochrome` at :318), `src/studio/stage/overlay.ts` (`drawTag`, `TAG_STYLE`; the badge and icon sizes move to core), `src/core/signs.ts`, `src/core/symbols.ts`, `src/core/validate.ts:41-87`
- Test: `test/core/signs.test.ts`, `test/core/validate.test.ts`, `test/studio/overlay.test.ts`, `test/studio/themes.test.ts` (or wherever palettes are tested), the e2e goldens

**Interfaces:**
- Consumes: Task 6's changes to `overlay.ts`. This task runs after Task 6.
- Produces:
  - **`aloftandaway` palette.** These replace today's values:

    | Key | Value |
    |---|---|
    | `water` | `#b7c8d3` |
    | `land` | `#e9ecee` |
    | `wood`, `grass`, `park` | `#d9dfdc` |
    | `sand` | `#e4e6e3` |
    | `rock` | `#dde1e4` |
    | `builtUp` | `#dfe3e6` |
    | `ice` | `#f3f5f6` |
    | `landLine` | `rgba(10, 36, 52, 0.3)` |
    | `labelWater` | `rgba(10, 36, 52, 0.6)` |
    | `halo` | `rgba(233, 236, 238, 0.85)` |

    The rest are unchanged. Update the theme's doc comment: "cool greys on a blue-grey sea".
  - **`monochrome` palette:**

    | Key | Value |
    |---|---|
    | `water` | `#d6d6d6` |
    | `land` | `#f4f4f4` |
    | `wood` | `#e6e6e6` |
    | `grass` | `#e8e8e8` |
    | `park` | `#e6e6e6` |
    | `sand` | `#eeeeee` |
    | `rock` | `#e9e9e9` |
    | `builtUp` | `#ececec` |
    | `ice` | `#fafafa` |
    | `halo` | `#f4f4f4` |
    | `roadCasing` | `#d8d8d8` |
  - **Sign edge, every style.**
    - `drawTag` builds the box and pointer as one closed path.
    - It fills that path with a shadow of `rgba(10, 36, 52, 0.28)`, blur 8 and offset (0, 2) in layout px, scaled by `pixelRatio`.
    - It then clears the shadow and strokes the same path with 1 layout px of `rgba(10, 36, 52, 0.22)`.
    - The fill colour is unchanged.
  - **Sign lift.**
    - In `core/symbols.ts`: `SYMBOL_SIZES = { dotRadius: 6, badgeRadius: 22, badgeRing: 3, iconSize: 26, iconHalo: 6 }`. `overlay.ts` imports these instead of its own constants.
    - `vehicleRadius(symbol: SymbolKind, style: SymbolStyle): number`:
      - `dot` and `none`: the dot radius.
      - `badge` and `badge-line`: `badgeRadius + badgeRing` (25).
      - `icon`: `iconSize / 2 + iconHalo / 2` (16).
    - In `core/signs.ts`, `signLift(scene: Scene): number` is `max(SIGN_TAG.lift, 6 + max vehicleRadius over the symbols the scene draws)`. Those symbols are `look.symbol` plus every leg's `symbol` override, with `look.symbolStyle ?? 'badge'`.
    - Results: badge 31, icon 22, dot only 16.
    - `signBox(px, text, lift = SIGN_TAG.lift)`. `drawTag` and `signOverlaps` both pass `signLift(scene)`.

- [ ] **Step 1: Write the failing tests:**
  - `signs.test.ts`:
    - `a badge scene lifts signs to 31 px`
    - `an icon scene lifts signs to 22 px`
    - `a dot scene keeps 16 px`
    - `a scene with a dot leg and a badge leg uses 31 px`
  - `validate.test.ts`: `sign overlap measures with the scene's lift`. Two stops whose signs overlap only at a lift of 31.
  - `overlay.test.ts`:
    - `a sign is filled with a shadow and stroked with a hairline`, using the mock context's call log.
    - `a sign sits clear of the badge`
  - Palette tests: `aloftandaway has a blue-grey sea` and `monochrome's sea is grey`. Both assert `water`, `land` and that `water` is darker than `land`.
- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement.
- [ ] **Step 4:**
  - `npm test` and `npm run typecheck` PASS.
  - Run `npm run build`, then `UPDATE_GOLDENS=1 npm run test:e2e`, then `MAPPER_NET=1 npm run test:e2e`.
  - List every golden that changed and why: sign edge, lift or palette.
  - Then run `npx tsx scripts/review-sheets.ts /tmp/stage7-sheets`.
- [ ] **Step 5: Commit:** `git commit -m "feat: aloftandaway blue-grey sea, monochrome grey sea, sign edge, signs clear the vehicle"`

### Checkpoint: look

The controller shows the user these from Task 7: `/tmp/stage7-sheets/styles.png`, `/tmp/stage7-sheets/icons.png`, and before/after crops of two changed goldens. This is a planned stop. Changes go back to Task 7 as a fix round.

### Task 8: Corrupt capture stress check

**Model:** Opus 5.5 (`opus`). Render and GPU pipeline.

**Files:**
- Create: `bench/capture-stress.ts`, plus a `bench:capture` script in `package.json`
- Maybe modify: `src/studio/stage/MapStage.ts` or wherever the overlay canvas's 2D context is created
- Doc: `docs/render-speed.md`

**What it does:**
- `bench/capture-stress.ts [--loads N] [--cpu-overlay]`.
- It repeats the pattern that showed the glitch:
  - Start a server with a fresh tile cache every 10 iterations.
  - In one browser, open two pages at 1920×1080 on `alpine()` as satellite with terrain, burned and description.
  - Render frame 0, capture, and diff the two.
- Any pixel outside the credit box that differs by more than 8 in a channel counts as a glitch. That's well above the ±1 seam noise.
- It saves both PNGs and the diff for each glitch under `/tmp/stage7-capture-stress/`, and prints `glitches: G of N loads`.
- `--cpu-overlay` sets the test-only `RenderPageOptions.cpuOverlay?: boolean`, which creates the overlay's 2D context with `{ willReadFrequently: true }`. That keeps the overlay off the GPU.

**Steps:**
- [ ] **Step 1:** Write the script. Run `MAPPER_NET=1 npm run bench:capture -- --loads 1000` on today's code. Record G.
- [ ] **Step 2: Decide by G:**
  - **G = 0:** don't change product code. Park the item in `docs/render-speed.md` under "Known capture glitch". Record the one sighting and the 1,000 clean loads, the date, and Chrome's version. Go to Step 4.
  - **G ≥ 1:**
    - Run it again with `--cpu-overlay` for 1,000 loads.
    - Run `npm run bench:render` with and without the CPU overlay.
    - If the CPU overlay gives G = 0 and costs ≤ 5% clip fps at 4K, make it the default: the overlay context is always created with `willReadFrequently: true`, and the bench flag is removed.
    - Otherwise **stop and report to the user** with both G values, both fps figures and sample diffs, and wait.
- [ ] **Step 3:** If the default changed, `npm test`, `npm run typecheck` and `MAPPER_NET=1 npm run test:e2e` PASS. Record the numbers in `docs/render-speed.md`.
- [ ] **Step 4: Commit:** `git commit -m "bench: capture stress check"`, or `"fix: draw the overlay on the CPU so captures can't corrupt"`.

### Task 9: Scene names and multi-scene summaries

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Modify:
  - `src/core/scenes.ts` (`sceneTitle`; `sceneLabel` uses it; `add_scene` and `duplicate_scene` names)
  - `src/core/patch.ts:77` and the `sceneSet` path
  - `src/render/fcpxml.ts:115` and `:130`
  - `src/mcp/tools.ts:136-138`, `:199`, `:393` and `:409`
  - `src/studio/edit/SceneTabs.tsx:179` and `src/studio/edit/App.tsx:119` and `:415`
- Test: `test/core/scenes.test.ts`, `test/core/patch.test.ts`, `test/render/fcpxml.test.ts`, `test/mcp/tools.test.ts`

**Interfaces:**
- Produces:
  - `sceneTitle(project: Project, index: number): string` is the trimmed name, or `Scene ${index + 1}` when it's blank. Every `|| 'Untitled'` in the files above becomes `sceneTitle`, and so do the FCPXML compound clip and asset names.
  - **New input is refused:**
    - A blank or whitespace-only `add_scene.name` fails at `['ops', i, 'name']`.
    - A blank `sceneSet.name` fails at `['sceneSet', 'name']`.
    - The message is `a scene name can't be blank`.
    - Names are stored trimmed.
  - `SceneSchema.name` stays `z.string()`, so old files still load.
  - **Multi-scene summaries:** the per-scene line drops the `${project.name}: ` prefix. A single-scene summary is unchanged.

- [ ] **Step 1: Write the failing tests:**
  - `a blank name shows as Scene N`
  - `a whitespace name is refused on add_scene`
  - `a whitespace name is refused on sceneSet`
  - `names are stored trimmed`
  - `a file with a blank scene name loads and exports as Scene N`: the compound is `Trip · Scene 2`, and the assets are `Scene 2 · Map`, and so on.
  - `each scene block starts with its counts, not the project name`: the project name appears only on the opening line.
  - `a one-scene summary is unchanged`
- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement. **Step 4:** `npm test` and `npm run typecheck` PASS.
- [ ] **Step 5: Commit:** `git commit -m "fix: blank scene names are refused and shown as Scene N; scene summaries drop the project name"`

### Task 10: Studio scene tabs

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Create: `src/studio/edit/Menu.tsx`
- Modify: `src/studio/edit/PointMenu.tsx`, `SceneTabs.tsx`, `App.tsx:248`, `edit.css:92-99`
- Test: `test/e2e/studio.test.ts` (the `scene tabs` block, from line 682)

**Interfaces:**
- Produces:
  - `Menu({ at, onClose, keepOpenFor?, children })` in `Menu.tsx`.
    - It owns the edge clamping (`EDGE = 8`), first-button focus, Escape and outside-mousedown closing, and the `point-menu`/`role="menu"` wrapper.
    - `keepOpenFor` is a CSS selector whose mousedown doesn't close it (`.scene-more`).
    - `useMenuChoice(onClose)` returns `choose(action)`. `swallowNextClick` moves here too.
    - `PointMenu` and `SceneMenu` keep only their items.
  - **Tab length:** `seconds` is no longer rounded. The tab reads `{label} · {seconds.toFixed(1)} s`, matching the tool summary, so a 0.4 s scene reads `0.4 s`.
  - **Inactive tabs:** text `#c4c6cb`, background `rgba(255, 255, 255, 0.04)`. The `.scene-more` button gets the same text colour.
  - **Rename:** blur commits the trimmed name when it's non-blank and changed. Escape still cancels.
  - **Stale state:** an effect clears `menu` and `renaming` when their scene id is no longer in `scenes`.
  - **Keys:** Home and End select the first and last tab, with `preventDefault` and the same refocus as the arrow keys.

- [ ] **Step 1: Write the failing e2e tests:**
  - `a short scene shows tenths of a second`
  - `blur keeps a rename`
  - `escape still cancels a rename`
  - `undo of a delete doesn't reopen its menu or rename`: open the menu, delete, undo; no menu and no rename field.
  - `Home and End pick the first and last tab`
  - `inactive tab text has at least 7:1 contrast with the bar`, from computed styles.
  - Update the `'Drive · 13 s'` and `'Sail · 14 s'` assertions to the one-decimal text.
- [ ] **Step 2:** `npm run build`, then run the block. Expected: FAIL. **Step 3:** Implement. **Step 4:** The block, `npm test` and `npm run typecheck` PASS.
- [ ] **Step 5: Commit:** `git commit -m "fix: scene tabs show tenths, keep a rename on blur, forget deleted scenes, take Home and End; one Menu"`

### Task 11: Test gaps

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Test: `test/render/export-plan.test.ts:242-272`, `test/server/server.test.ts`, `test/e2e/studio.test.ts`
- Modify: product code only if a test finds a bug. If one does, stop and report before fixing it.

**Tests:**
- `export-plan.test.ts` uses the existing two-scene fixture, where the cut is at 2 s (frame 50):
  - `a range ending exactly at the cut renders only the first scene`: `to: 2` gives one pass for scene 1, frames 0–49, and no empty pass for scene 2.
  - `a range starting exactly at the cut renders only the second scene`: `from: 2` gives one pass for scene 2 from its frame 0.
- `server.test.ts`:
  - `a stale update_leg is refused with 409 and nothing changes`
  - `a stale insert_via is refused with 409 and nothing changes`
  - Each sends the op with an old base version after another write. Assert 409, `ROUTE_CHANGED`, and the file unchanged.
- `studio.test.ts`: `a transport change after an unseen agent write is refused`. Use the `routeWebSocket` pattern from Stage 6 Task 9 on the legs panel's transport picker (`update_leg`). Assert the notice, and that the file keeps the agent's version.

- [ ] **Step 1:** Write the tests. **Step 2:** Run them. They should pass on today's code: they pin behaviour that exists. A failure is a bug; report it. **Step 3:** `npm test` and `npm run typecheck` PASS.
- [ ] **Step 4: Commit:** `git commit -m "test: ranges at a cut; stale leg and via edits"`

### Task 12: Docs and the spec revision

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Modify: `README.md:73`, `skills/mapper/SKILL.md:69` and `:106-111`, `docs/plan.md`, `docs/render-speed.md` (only if Task 8 didn't already), `docs/superpowers/specs/2026-10-13-mapper-local-agent-design.md` (`:43`, `:168-169`, `:365`, `:651`, the credit text, the Build stages list)

**Changes:**
- **Flight-bow wording**, in the README, SKILL.md and spec `:43` and `:365`: "Air legs follow the great circle, bowed toward the nearer pole so even short flights curve (at least 15% of their length)." Keep `:651`'s "great-circle arcs" only if it names the test fixture; otherwise say "flight arcs".
- **Spec success criterion 3:** "…gives a compound clip per scene with map, route and signs on separate lanes, with a marker at each arrival."
- **SKILL.md `add_scene`:** "`copyLookFrom` is a scene id or a 1-based position (unlike `index`, which is 0-based)."
- **Spec:**
  - Add "**Revision, 2026-10-16 (stage 7 decisions):**" with the bullets from "Stage 7 decisions" and the interfaces that change behaviour: warnings, `signLift`, `sceneTitle`, the blank-name refusal, the screen-angle rule, the source-aware fix text and the pinned MapLibre version.
  - Update the burned satellite credit in the stage 5 revision (`:74`) to end with `, CC BY 4.0`.
  - Add stages 7 and 8 to Build stages.
- **`docs/plan.md`:**
  - Add row 7, **Fix pass** (built), with Done when "Every open item from stages 4–6 is fixed with a test or parked with a reason".
  - Add row 8, **Sea routes against OpenFreeMap water** (planned), with Done when "A route through the Stockholm archipelago stays off every island the basemap draws".
  - Leave the Stage 6 note as it is. The Final Cut import check stays pending.
- **SKILL.md:** one line saying a render may finish with warnings, and what the unsettled-terrain one means for the user: re-render, or lower the pitch.

- [ ] **Step 1:** Make the edits. **Step 2:** Run `grep -rn "great-circle" README.md skills docs/superpowers/specs`. Only the new wording is left. **Step 3: Commit:** `git commit -m "docs: stage 7 fix pass"`

### Final review

- **Review:** run the whole-branch review with Opus 5.5 (`opus`) against this plan and the spec. If Opus fails twice with an API error, stop and tell the user rather than dropping to Sonnet.
- **Suite:** then run `npm test`, `MAPPER_NET=1 npm run test:e2e` (one after the other) and `npm run typecheck`.
- **Hand over:** the user's end-to-end test.
  - The controller renders a two-scene layered export at 1080p with `MAPPER_NET=1` into `/tmp/stage7-e2e-check/`. Scene 1, "Drive", is `aloftandaway` with a `helicopter` leg flown west on a tilted shot. Scene 2, "Sail", is `greekIslands()` on `monochrome` with a badge vehicle.
  - It also writes a flattened MP4 of the same project.
  - The user watches the MP4 and imports the FCPXML into Final Cut Pro 12.4 (check 9 in `docs/final-cut-export.md`).
- **After the user's check:**
  - If the import works, mark check 9 and Stage 2's outstanding import check as passed in `docs/plan.md` and `docs/final-cut-export.md`, with the date.
  - If it fails, the failure becomes a fix round before merge.
