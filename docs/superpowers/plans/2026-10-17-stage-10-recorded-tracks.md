# Stage 10 recorded tracks and exact length implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not begin implementation until the user approves this plan.

**Goal:** A recorded GPS or AIS track draws as it was logged, with a stop wherever it stood still. A scene can be given an exact length that holds when its pauses change.

**Architecture:**
- **Leg mode:** a new `track` leg mode points at a recorded track by id.
- **Storage:** the points live in `tracks/<id>.json` in the project folder. They are thinned once at import and never stored in `mapper.json`.
- **Transport:** the server sends them to the studio and the render page in the existing `seaPaths` channel, under `track:<id>` keys.
- **Cutting:** `buildRoute` cuts each leg's stretch from the track by finding its stops along it. So stops can be added, removed or dragged without stored indices going stale.
- **Exact length:** `timing.length` fixes a scene's length, and `travel` is worked out from it.

**Tech Stack:** TypeScript, Zod 4, React, MapLibre GL 6.14.0, Playwright with Chrome, ffmpeg, Vitest, the MCP SDK.

**Spec:** [Mapper design](../specs/2026-10-13-mapper-local-agent-design.md), with its revisions at the top. Also read `AGENTS.md` and `docs/plan.md` (the "Parked: real ship tracks (AIS)" section). The decisions below come from the Stage 10 brainstorm. Where they differ from the spec they replace it, and Task 9 copies them into the spec.

## Stage 10 decisions

**1. A recorded track is drawn as logged.**
- **What it is:** a leg with `mode: 'track'` and `track: '<id>'` follows the recorded points between its two stops. Its two ends are pinned to the stops.
- **What doesn't apply:** the sea router never runs on it, and it takes no via points.
- **Timing:** it is distance only, like every other leg. Recorded times are used only to find stops, and they aren't stored.

**2. Tracks live in `tracks/`, next to `mapper.json`.**
- **Why not `mapper.json`:** every tool returns the whole project to the agent, so thousands of points there would flood its context.
- **Why not `.mapper/`:** that folder is cache you can delete, and a track is source data.
- **File:** `tracks/<id>.json` is `{"version":1,"name"?:string,"points":[[lng,lat],…]}`. It is compact JSON with coordinates rounded to 6 decimals.
- **Id:** `id` is the first 12 hex characters of the SHA-256 of that text. Re-importing the same file gives the same id and doesn't write a second copy.
- **Lifetime:** a file is written when it's missing or its text isn't exactly the text its id stands for, so importing again repairs a damaged file. An intact file is left alone. Mapper never deletes them, because another scene may use the same file.

**3. Thinned once, at import.**
- **Stays:** each stay's points collapse to one point at the stay's centre.
- **Thinning:** Douglas-Peucker in Mercator, starting at a 10 m tolerance (taken at the track's mean latitude). The tolerance doubles until at most `MAX_TRACK_POINTS = 10_000` points remain.
- **Kept points:** the first point, the last point and each stay's point are always kept.

**4. Stops come from where the track stood still** (`stops: 'stays'`, the default when every point has a time).
- **What a stay is:** a maximal run of consecutive points, all within `STAY_RADIUS_KM = 1` of the run's first point. Its time span must be at least `minStayMinutes` (default 120).
- **Order:** points are sorted by time first (a stable sort).
- **Start and end:** the track's first and last points are stops too, unless a stay already covers them.
- **Names:** a stop is named after a GPX waypoint within 1 km. Otherwise it's `Stop N` (1-based, in travel order).
- **Output:** the tool returns each stop's arrival and departure times, so the agent can name the stops from the itinerary.
- **`stops: 'ends'`:** gives just the first and last points, named `<track name> start` and `<track name> end` (`Track` when unnamed), as `import_gpx` does.

**5. Each leg's stretch is found, not stored.** For leg *i* of track T in `buildRoute`:
- **Start index:** if leg *i − 1* is a track leg of T, the start index `s` is where that leg ended. Otherwise `s` is found by the same search as the end, from index 0, for stop *i*.
- **End index:** among the points from `s + 1` on, take the first run of consecutive points within `TRACK_NEAR_KM = 2` of stop *i + 1*, and the point in that run nearest to it.
- **When the track starts inside the end stop's circle** (the run is under way at `s + 1`, because the stops are close): if point `s` is within `SAME_PLACE_KM = 0.5` of stop *i + 1*, the track hasn't left, so the end is in the next run, or in this run when there's no other. Otherwise this run is taken if its nearest point to stop *i + 1* is closer than half the distance from point `s` to it; if not, it competes with the next run and the nearer wins. A loop from a stop back to it follows the whole loop, even with a parked logger's jitter at both ends or a stop dragged a little. A loop whose way out dips back within 2 km of its end stop is still cut at the dip.
- **Validation:** `same-place` isn't raised for two stops with a track leg between them.
- **When no run is near:** the end is the nearest point from `s + 1` on, and the gap is reported.
- **The path:** `[stop i, points s+1 … e−1, stop i+1]`, unwrapped in travel order like every other leg.
- **Why this works:** "first run" handles a ship that calls at the same port twice, and a cruise that ends where it started. Not ending in the run a leg starts in, while the track is still within 0.5 km, handles a day loop with only two stops.

**6. Adding or removing a stop keeps the track.**
- **The rule:** a new leg from a to b is a track leg of T, with no via points, when both the old leg leaving a and the old leg arriving at b are track legs of T. That covers inserting a stop on a track leg (both are the same old leg) and removing a stop between two parts of T. It also inherits `symbol` when both old legs have the same one.
- **Otherwise:** a new leg that would inherit mode `track` without a common track becomes `line`.
- **Dragging:** dragging a stop moves the cut.

**7. A transport alone doesn't take a leg off its track.** On a `track` leg, `update_leg { symbol }` without `mode` keeps `mode: 'track'`. `applyPatch` and `invertPatch` agree on this.

**8. Schema version 3.**
- **What's new:** `LegMode` gains `track`, `Leg` gains `track?: string` (`/^[0-9a-f]{12}$/`), and `Timing` gains `length?: number` (> 0).
- **Track rules:** a `track` leg must have `track` set and an empty `via`. Either one missing is a schema issue with a plain message. `track` may stay on a leg of another mode, so the studio can switch back to it without losing anything.
- **Upgrading:** going from v2 to v3 only changes `schemaVersion`. A v1 file goes to v2, then to v3. Files are written as v3 on their next save.
- **Inputs:** `set_stops`, `import_gpx` and `StopInput.legMode` take every mode except `track`.

**9. Tracks ride in `seaPaths`.**
- **The entry:** the server adds `track:<id>` → `{ status: 'ok', path: points, knots: [] }` for each track the project uses, read from `tracks/`.
- **Why:** every route consumer (studio, render page, preview, validation, tool results) already receives `seaPaths`, so no new plumbing is needed through 15 files. The type's doc comment says it also carries tracks.
- **Keys can't collide:** sea keys are 16 hex characters, and track keys start with `track:`.
- **A missing track:** a missing or unreadable file has no entry. Its leg is drawn as a straight line and flagged.

**10. Exact length holds.**
- **Setting it:** `sceneSet: { timing: { length: 8 } }` fixes the scene at 8 s, and `null` clears it.
- **How travel is worked out:** while it's set, `travel = length − holdStart − holdEnd − Σ pause`. The timeline uses that value, and `applyPatch`/`setStops` write it back into `timing.travel` so the file reads true.
- **When it doesn't fit:** if the holds and pauses add up to more than the length, the schema refuses the project. That catches a patch and a hand edit alike.
- **Frames:** the scene renders `round(length × fps)` frames, so 8 s at 25 fps is 200 frames.

## Global constraints

- Coordinates are `[lng, lat]` (GeoJSON order) everywhere in the public interface.
- `core` imports nothing else from the package and has no DOM, filesystem, network or `node:` imports (`test/core/purity.test.ts`). SHA-256 for track ids is in `src/server/tracks.ts`.
- **No data-source connectors:** `import_track` reads a local file the agent gives it. Nothing in this repo fetches AIS or any other trip data.
- **Fixtures:** test tracks are synthetic, made by a seeded generator. Commit no real AIS or GPS logs.
- **Clean-room:** no Map Animator code, themes, icons, sign art, UI text or file format. **Public repo:** nothing private.
- Every render carries the map credit. Track legs don't change the credit rules.
- `paths.json` cache version and `ROUTER_VERSION` don't change.
- Defaults for new projects: 3840×2160, 25 fps, 16:9.
- Tests never touch the network unless `MAPPER_NET` is set.
- Run `npm test` and `npm run test:e2e` one after the other, never together.
- **Any e2e failure:** save the full output to `/tmp/stage10-e2e-<YYYYMMDD-HHmmss>.log` before rerunning, and name the file in the report.
- Every task leaves `npm test` and `npm run typecheck` passing.
- Tool descriptions stay under the caps that `test/mcp/tools.test.ts` checks: 600 characters, or 900 for `update_project`.

## Review focus

1. **A track across the antimeridian** (a Pacific crossing). The line stays continuous with no streak across the map, and the head moves smoothly. Test: Task 4, `a track leg across 180° is continuous`.
2. **Changing the transport on a track leg.** The studio's transport picker may send `{ symbol }` alone; the leg must stay on its track either way. Undo must restore exactly what was there. Test: Task 4, `a symbol alone keeps a track leg on its track`, and the undo round trip.
3. **Fixing a wrong stop.** Remove a false stay, then insert a missed port call. Every leg stays on the track and the line doesn't jump. Test: Task 4, `remove then insert keeps every leg on the track`.
4. **Messy input.** A CSV with unsorted times, duplicate rows, a few bad rows, or times on only some rows, and a GPX with `<time>` on some points only. Bad rows are skipped and counted. Missing times mean `stays` is refused with a clear fix. It never crashes and never finds a stay from half the data. Tests: Task 3.
5. **A missing or corrupt track file.** Validation gives `track-missing` and the render refuses. The studio shows the leg as a straight line with a note, and nothing throws. Tests: Tasks 4 and 5.

---

## Starting point

- **Branch:** `stage-10-recorded-tracks` in the worktree `.claude/worktrees/stage-10-recorded-tracks`, from `main` at `0b9d83c` or later.
- **Baseline:** `npm test` passes about 1,028 tests and `MAPPER_NET=1 npm run test:e2e` passes 175. Record the exact counts before Task 1.
- **Order:**
  - Run 1, then 2. Both touch the schema and `patch.ts`.
  - Task 3 depends on nothing and can run alongside them.
  - Task 4 needs 1 and 3. Task 5 needs 3 and 4. Task 6 needs 5.
  - Task 7 needs 4 and 5. Task 8 needs 2, 6 and 7. Task 9 comes last.

## Files

| File | Responsibility |
|---|---|
| `src/core/schema.ts`, `src/core/migrate.ts` | v3: `track` mode, `Leg.track`, `Timing.length`, the v2 → v3 upgrade |
| `src/core/timeline.ts`, `src/core/patch.ts` | `sceneTravel`, `fitLength`, track-aware `syncLegs`, `importTrack` |
| `src/core/track.ts` (new) | Parse a CSV track, find stays, thin, cut a leg's stretch |
| `src/core/gpx.ts` | `<time>` on track points |
| `src/core/route.ts`, `src/core/validate.ts`, `src/core/undo.ts` | Track legs in the route, `track-missing`/`track-stop-far`, symbol-only undo |
| `src/server/tracks.ts` (new), `src/server/paths.ts`, `src/server/server.ts` | Write and read track files; put them in `seaPaths` |
| `src/mcp/tools.ts` | `import_track`; the track and length lines in tool results |
| `src/studio/edit/labels.ts`, `LegsPanel.tsx`, `RouteEditor.ts` | Recorded-track option, notes, no via editing on track legs |
| `test/fixtures/tracks.ts` (new) | Seeded synthetic tracks (CSV and GPX text) |
| `test/e2e/track.test.ts` (new), `test/e2e/golden/track-mid.png`, `bench/render-speed.ts`, `docs/render-speed.md` | End to end, golden frame, speed |
| `README.md`, `skills/mapper/SKILL.md`, `AGENTS.md`, `docs/plan.md`, spec | Docs |

---

### Task 1: Schema version 3

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Modify: `src/core/schema.ts` (`LegModeSchema`, `LegSchema`, `TimingSchema`, `ProjectSchema` superRefine, `StopInputSchema`, `SCHEMA_VERSION`, `parseProject`), `src/core/migrate.ts`, `src/core/index.ts`, `src/studio/edit/labels.ts` (`MODE_LABELS.track = 'Recorded track'`, which the typecheck forces), `src/mcp/tools.ts` (the `legMode` inputs of `set_stops` and `import_gpx`)
- Test: `test/core/schema.test.ts`, `test/core/migrate.test.ts`

**Interfaces:**
- Produces:
  - `LegMode` includes `'track'`.
  - `Leg.track?: string`.
  - `Timing.length?: number`.
  - `SCHEMA_VERSION = 3`.
  - `InputLegModeSchema = LegModeSchema.exclude(['track'])`, exported, used by `StopInputSchema.legMode`, `setStops`'s `legMode` and both tools' `legMode` inputs.
  - `TRACK_ID = /^[0-9a-f]{12}$/`, exported.
  - `upgradeV2(json: unknown): unknown` in `migrate.ts`.

- [ ] **Step 1: Write the failing tests.**
  - **`a track leg needs a track id`:** `{ mode: 'track', via: [] }` fails with the message `a recorded track leg needs a track; import one with import_track`, at path `scenes.0.legs.0.track`.
  - **`a track leg has no via points`:** `{ mode: 'track', track: 'abcdef012345', via: [{ at: [1, 2] }] }` fails with `a recorded track leg can't have via points; remove them or change the mode`.
  - **`track may stay on a line leg`:** `{ mode: 'line', track: 'abcdef012345', via: [] }` parses.
  - **`a track id is 12 hex characters`:** `'ABC'` fails.
  - **`timing.length must be positive`:** `length: 0` fails, and `length: 8` parses.
  - **`set_stops refuses legMode track`:** `StopInputSchema` with `legMode: 'track'` fails.
  - **`migrate.test.ts`, `a v2 file opens as v3`:** a v2 fixture parses with `schemaVersion: 3` and is otherwise deep-equal. A v1 fixture ends as v3. A `schemaVersion: 4` file still gets the "newer version of Mapper" message.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement decision 8. `parseProject` changes as follows:
  - v1: `upgradeV2(upgradeV1(...))`.
  - v2: `upgradeV2(json)`, which sets `schemaVersion: 3` on a shallow copy.
  - Then everything parses with `ProjectSchema`.
  - Update the `parseProject` doc comment.
- [ ] **Step 4:** Fix every existing test that asserts `schemaVersion: 2` on a saved or created project. Run `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat: schema v3 with track legs and timing.length"`

### Task 2: Exact length

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Modify: `src/core/schema.ts` (superRefine), `src/core/timeline.ts`, `src/core/validate.ts:150-163`, `src/core/patch.ts` (`applyPatch`, `setStops`), `src/mcp/tools.ts` (summary line near `:141`, the `update_project` description)
- Test: `test/core/timeline.test.ts`, `test/core/patch.test.ts`, `test/core/validate.test.ts`, `test/mcp/tools.test.ts`

**Interfaces:**
- Produces: `sceneTravel(scene: Scene): number` in `timeline.ts`. It returns `max(0, length − holdStart − holdEnd − Σ pause)` when `timing.length` is set, and `timing.travel` otherwise. It's exported from `core/index.ts`.
- Produces: `fitLength(project: Project): Project` in `patch.ts`. It sets `timing.travel = sceneTravel(scene)`, rounded to 1e-6, on every scene with a length.

- [ ] **Step 1: Write the failing tests.**
  - **`timeline.test.ts`:**
    - **`length 8 at 25 fps is 200 frames`:** holds 1 and 2 plus two pauses of 1.5 give `sceneTravel` 2 and `totalFrames` 200.
    - **`length 8 at 30000/1001 is 240 frames`.**
    - **`a stale travel is ignored`:** with `length: 8`, stored `travel: 99` still gives 200 frames.
  - **`patch.test.ts`:**
    - **`length holds when a pause changes`:** set `length: 8`, then `update_stop { pause: 3 }`. `travel` goes down by the change and the timeline is still 200 frames.
    - **`a pause that overruns the length is refused`:** holds 1+2 and length 4, then a pause of 2. `applyPatch` throws a `ProjectError` at `scenes.0.timing.length` with the message `the holds and pauses add up to 5 s, more than the length of 4 s. Shorten them, or clear timing.length with null`.
    - **`null clears the length`:** `sceneSet: { timing: { length: null } }` removes it, and `travel` keeps its last value.
    - **`setStops refits the length`:** replacing stops that have pauses refits `travel`.
  - **`validate.test.ts`, `short-leg on a fixed-length scene says raise timing.length`:** the fix starts `Raise timing.length`.
  - **`tools.test.ts`, `the summary marks a fixed length`:** the scene line contains `8.0 s (200 frames, fixed length)`. A scene without a length is unchanged.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement decision 10.
  - **Schema:** the superRefine adds the overrun issue. Format numbers with `+x.toFixed(3)`.
  - **Timeline:** `buildTimeline` and validation's `legSeconds` call use `sceneTravel`.
  - **Patches:** `applyPatch` and `setStops` return `fitLength(parseProject(work))`.
  - **`update_project` description:** add `timing.length fixes the scene's length in seconds and works out travel; null clears it.` Trim other words so it stays under 900.
- [ ] **Step 4:** `npm test` and `npm run typecheck` PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat: timing.length fixes a scene's length"`

### Task 3: Reading tracks and finding stays

**Model:** Opus 5.5 (`opus`). The stay finder and thinning are the hardest maths in the stage.

**Files:**
- Create: `src/core/track.ts`, `test/core/track.test.ts`, `test/fixtures/tracks.ts`
- Modify: `src/core/gpx.ts` (`GpxLine.times`, `pointsOf`), `src/core/index.ts`
- Test: `test/core/track.test.ts`, `test/core/gpx.test.ts`

**Interfaces:**
- Produces, all in `src/core/track.ts`:
  - `interface RecordedTrack { name?: string; points: LngLat[]; times?: number[] }`. `times` holds milliseconds and is present only when every point has one.
  - `class TrackError extends Error { fix: string }`.
  - `parseTrackCsv(text: string): RecordedTrack & { skippedRows: number }`.
    - **Header:** required, case-insensitive, comma-separated. Longitude is `lng`, `lon` or `longitude`; latitude is `lat` or `latitude`; time (optional) is `time` or `timestamp`.
    - **Time values:** ISO 8601 with `Z` or an offset, or a number of Unix seconds (milliseconds if it's above 1e11).
    - **Bad rows:** skipped and counted. That covers a blank or unparsable coordinate, `|lat| > 85.0511` and `|lng| > 180`.
    - **Partial times:** if any kept row has no time or a bad one, `times` is dropped.
  - `recordedFromGpx(line: GpxLine): RecordedTrack`.
  - `interface Stay { start: number; end: number; at: LngLat; arrive: number; depart: number }`. `start` and `end` are indices, inclusive.
  - `findStays(track: RecordedTrack, minStayMs: number): Stay[]`. It needs `times`, works on the time-sorted points, and uses `STAY_RADIUS_KM = 1`. `at` is the centroid of the run.
  - `interface TrackImport { stops: { name: string; at: LngLat; arrive?: string; depart?: string }[]; points: LngLat[]; recorded: number; stays: number }`. `points` are thinned, with stays collapsed. `arrive` and `depart` are ISO strings.
  - `trackToStops(track: RecordedTrack, opts: { stops: 'stays' | 'ends'; minStayMinutes: number; waypoints?: { name: string; at: LngLat }[] }): TrackImport`.
  - `thinTrack(points: LngLat[], keep: ReadonlySet<number>, max?: number): LngLat[]`. `MAX_TRACK_POINTS = 10_000`.
  - `MAX_TRACK_POINTS`, `STAY_RADIUS_KM` and `TRACK_NEAR_KM = 2` are exported.
- Produces: `test/fixtures/tracks.ts`, with `syntheticCruise(opts?: { seed?: number }): { csv: string; gpx: string; ports: LngLat[] }`. It's a seeded LCG with no `Math.random`. One sample per minute; at each stay, ±200 m jitter for its length:

  | Part | Place | Length |
  |---|---|---|
  | Start port | `[23.62, 37.94]` | 3 h |
  | Sailing | to `[25.33, 37.45]` | 10 h, with ±100 m noise |
  | Port | `[25.33, 37.45]` | 8 h |
  | Short stop | mid-route | 30 min |
  | End port | `[25.43, 36.42]` | 2 h, where the track ends |

- [ ] **Step 1: Write the failing tests.**
  - **CSV parsing:**
    - **`parses lng,lat,time CSV in any column order`.**
    - **`skips bad rows and counts them`:** a blank coordinate, lat 91 and `abc` give `skippedRows` 3.
    - **`drops times when any row lacks one`.**
    - **`reads Unix seconds and ISO times alike`.**
    - **`a CSV without lng and lat columns is refused`:** a `TrackError` with fix `The first row must name the columns: lng, lat and optionally time.`
  - **Stays:**
    - **`finds the stays in a synthetic cruise`:** gives 3 stays (start port, port, end port). Each `at` is within 0.3 km of its port. The 30-minute stop isn't one at 120 minutes, and is one at `minStayMinutes: 20`.
    - **`unsorted times find the same stays`:** shuffled rows give the same stays.
    - **`a gap in the log at one place is a stay`:** two points 50 m apart, 3 h apart in time.
  - **Stops from a track:**
    - **`stays become stops`:** 3 stops named `Stop 1`, `Stop 2`, `Stop 3`, with `arrive` and `depart` set. There is no extra start stop, because the track begins inside a stay.
    - **`a waypoint names a stop`:** a waypoint 0.5 km from the port names it.
    - **`ends mode`:** gives `Track start` and `Track end`, or the track's name.
    - **`stays without times is refused`:** a `TrackError` with fix `Pass stops: 'ends', or use a file with a time for every point.`
  - **Thinning:**
    - **`thinning keeps stays and ends and caps the count`:** 50,000 noisy points give at most 10,000. Indices in `keep` survive.
    - **`a straight run collapses`:** 1,000 collinear points give 2.
  - **GPX:** `gpx.test.ts`, `reads track point times`. All points with `<time>` set `times`. One point without it leaves `times` undefined.
  - **Speed:** `finds stays in 200,000 points within 3 s`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement decisions 3 and 4.
  - **Stay finder:** greedy, left to right. From a run's first point, extend while each point is within 1 km of it. A run lasting at least `minStayMs` is a stay, and the search continues after it. Otherwise move on one point. Keep it fast enough for the speed test, and say how in a comment.
  - **Collapse, then thin:** collapse each stay to one point first, then thin with `keep` holding the first point, the last point and each stay's point.
  - **Thinning tolerance:** in Mercator units, 10 m divided by the Mercator scale at the mean latitude.
- [ ] **Step 4:** `npm test` and `npm run typecheck` PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat: read recorded tracks, find stays, thin"`

### Task 4: Track legs in the route, patches and validation

**Model:** Opus 5.5 (`opus`). This changes how routes are built and how legs survive edits.

**Files:**
- Modify: `src/core/track.ts` (`cutTrack`, `trackKey`), `src/core/route.ts` (`RouteLeg`, `buildRoute`), `src/core/sea.ts` (the `SeaPaths` doc comment), `src/core/patch.ts` (`syncLegs`, the `update_leg` apply, `importTrack`), `src/core/undo.ts` (`invertOp` `update_leg`), `src/core/validate.ts`
- Test: `test/core/route.test.ts`, `test/core/patch.test.ts`, `test/core/undo.test.ts`, `test/core/validate.test.ts`

**Interfaces:**
- Consumes: `TRACK_NEAR_KM` from Task 3; `Leg.track` from Task 1.
- Produces:
  - `trackKey(id: string): string`, returning `` `track:${id}` ``.
  - `cutTrack(points: LngLat[], from: LngLat, to: LngLat, start?: number): { start: number; end: number; gapKm: [number, number] }`. It implements decision 5; with `start` given, `from` isn't searched.
- Produces: `RouteLeg.drawnAs` gains `'track'`, and `RouteLeg.track?: { status: 'ok' | 'missing'; id: string; stopGapKm?: [number, number] }`. A track leg has `knots: [0, path.length - 1]`. A missing track is drawn as a straight line from stop to stop, with `drawnAs: 'line'`.
- Produces: `importTrack(project: Project, args: { scene?: SceneRef; stops: { name: string; at: LngLat }[]; track: string; symbol?: SymbolKind }): Project` in `patch.ts`. It replaces the scene's stops, and every leg becomes `{ mode: 'track', track, via: [], symbol? }`, refit by `fitLength`.
- Produces validation codes:
  - `track-missing` is an error at `['legs', i]`:
    - message: `` `${legName(i)} uses the recorded track ${id}, but tracks/${id}.json is missing or unreadable.` ``
    - fix: `Put the file back, or run import_track again.`
  - `track-stop-far` is a warning at `['stops', j]`:
    - message: `` `${nameOf(j)} is ${km} km from the recorded track of ${legName(i)}, so the line jumps to it.` ``
    - fix: `Move the stop onto the track, or check the stops are in travel order.`
  - Both run only when `seaPaths` is passed, like the sea checks.

- [ ] **Step 1: Write the failing tests** (`route.test.ts`). Each passes the track in `seaPaths[trackKey(id)]`.
  - **`a track leg follows its points`:** the path's interior equals the track's points between the cuts, and its ends equal the stops.
  - **`two legs on one track share the cut`:** leg 2 starts where leg 1 ended.
  - **`a port called at twice cuts at the first call`.**
  - **`a cruise that ends where it began cuts at the end`.**
  - **`a stop far from the track reports the gap`:** `stopGapKm[1]` is above 2.
  - **`a missing track draws a straight line`:** `track.status` is `'missing'` and the path has 2 points.
  - **`a track leg across 180° is continuous`:** no step in unwrapped longitude is above 1°.
- [ ] **Step 2: Write the failing patch and undo tests.**
  - **`remove then insert keeps every leg on the track`** (`patch.test.ts`): import a 4-stop track, `remove_stop` the 2nd, then `insert_stop` a new stop at index 1. Every leg is `{ mode: 'track', track: id, via: [] }` and keeps the shared symbol.
  - **`a new leg next to a track leg of another kind is a line`:** removing a stop between a track leg and a sea leg gives `line`.
  - **`a symbol alone keeps a track leg on its track`:** `update_leg { symbol: 'cruise-ship' }` keeps the mode `track`.
  - **`undo of a symbol change on a track leg`** (`undo.test.ts`): the round trip gives back the exact leg.
- [ ] **Step 3: Write the failing validation tests.**
  - **`track-missing is an error`:** it's in `errors`, not `warnings`, so `assertRenderable` refuses the render.
  - **`track-stop-far names the stop and the gap`.**
  - **`no sea warnings on a track leg`.**
- [ ] **Step 4:** Run them. Expected: FAIL.
- [ ] **Step 5:** Implement decisions 5, 6, 7 and 9.
  - **`buildRoute`:** a track leg is a chain on its own, like sea and air. It unwraps each point from the previous one.
  - **`syncLegs`:** apply decision 6 before the existing precedence, and never return mode `track` without a common track.
  - **`legLine` in `tools.ts`:** add `recorded track` and `recorded track file missing`.
- [ ] **Step 6:** `npm test` and `npm run typecheck` PASS.
- [ ] **Step 7: Commit:** `git commit -m "feat: track legs follow their recorded track"`

### Task 5: Track files on disk and on the wire

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Create: `src/server/tracks.ts`, `test/server/tracks.test.ts`
- Modify: `src/server/paths.ts` (`resolveSeaPaths`), `src/server/server.ts:307-338` (`seaPathsFor`'s short-circuit and `failed`)
- Test: `test/server/tracks.test.ts`, `test/server/paths.test.ts`, `test/server/server.test.ts`

**Interfaces:**
- Consumes: `trackKey` from Task 4.
- Produces, all in `src/server/tracks.ts`:
  - `TRACKS_DIR = 'tracks'`.
  - `writeTrack(folder: string, track: { name?: string; points: LngLat[] }): Promise<string>`. It returns the id and writes `tracks/<id>.json` with `writeFileAtomic`, only if the file is missing.
  - `readTrackPaths(folder: string, project: Project): Promise<SeaPaths>`. It covers every track id a `track` leg uses, memoised by path, mtime and size. A file that is missing, isn't JSON, isn't version 1, or has fewer than 2 valid points gets no entry, and is logged once per path.
- Changes: `resolveSeaPaths` returns `{ ...await readTrackPaths(folder, project), ...sea }`, so tracks come back even when there are no sea legs. `seaPathsFor` skips only when the project has neither sea nor track legs. Its `failed` result includes the tracks too.

- [ ] **Step 1: Write the failing tests.**
  - **`the same points give the same id and one file`:** writing twice gives one file and equal ids. The id matches `TRACK_ID`.
  - **`a track file is compact with 6 decimals`.**
  - **`readTrackPaths reads the tracks a project uses`:** keyed by `trackKey(id)`, with `status: 'ok'`, `path` equal to the points, and `knots` `[]`.
  - **`a corrupt or missing track file has no entry`:** for invalid JSON, `version: 2`, one point, and no file.
  - **`resolveSeaPaths returns tracks with no sea legs`** (`paths.test.ts`).
  - **`the studio gets tracks when the land data is missing`** (`server.test.ts`, with `land` throwing): the WebSocket message has the track entry, and the sea legs fall back as today.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Hash with `node:crypto` `createHash('sha256')` over the exact file text.
- [ ] **Step 4:** `npm test` and `npm run typecheck` PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat: store recorded tracks in tracks/ and send them with the routes"`

### Task 6: The `import_track` tool

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Modify: `src/mcp/tools.ts` (a new tool after `import_gpx`; `readTrackFile` next to `readGpxFile`)
- Test: `test/mcp/tools.test.ts` (the tool list and a `describe('import_track')` block), `test/cli/cli.test.ts`

**Interfaces:**
- Consumes: `parseTrackCsv`, `recordedFromGpx`, `trackToStops` and `TrackError` (Task 3); `writeTrack` (Task 5); `importTrack` (Task 4).
- Produces the tool `import_track`. Its input is `{ folder, scene?, path, track?, stops?: 'stays' | 'ends', minStayMinutes?: number (int ≥ 1, default 120), symbol? }`.
  - **`path`:** absolute, `.gpx` or `.csv`, at most 20 MB.
  - **`track`:** GPX only, the same as in `import_gpx`.
  - **`stops`:** defaults to `stays` when the track has times, and to `ends` otherwise.
- **Result:** `data.import = { track: id, file: 'tracks/<id>.json', recorded, points, skippedRows, stops: [{ name, at, arrive?, depart? }] }`, plus the usual project result.
- **Summary note:** `` `Imported a recorded track: ${recorded} points kept as ${points}, ${n} stops (${stays} stays of ${minStayMinutes} min or more).` `` In `ends` mode the bracket says instead `first and last points` when `ends` was asked for, or why no stays were looked for: `no stays looked for: N of the track's times can't be read` or `no stays looked for: not every point has a time`. `track` with a CSV is refused.
- **Description** (under 600 characters): `Read a recorded GPS or AIS track from a local .gpx or .csv (lng,lat,time columns) into the scene's stops, replacing them. Legs follow the recorded points exactly; the track is kept in tracks/ in the project folder. stops: 'stays' (default when every point has a time) puts a stop wherever the track stayed within 1 km for minStayMinutes (default 120); 'ends' uses the first and last points. Stops come back with arrival and departure times; rename them with update_stop. symbol sets every leg. path and folder must be absolute.`

- [ ] **Step 1: Write the failing tests.**
  - **`lists the tools`:** `import_track` comes after `import_gpx`.
  - **`import_track imports a CSV cruise`:** with `syntheticCruise().csv` written to a temp file, there are 3 stops, every leg is a track leg, `tracks/<id>.json` exists, and `data.import.stops[1].arrive` is an ISO time.
  - **`import_track reads a GPX`:** with `syntheticCruise().gpx`.
  - **`import_track ends mode`:** with no times, it defaults to `ends`.
  - **`import_track refuses stays without times`:** `ToolError` with the Task 3 fix.
  - **`import_track refuses another extension`:** `.txt`.
  - **`importing twice reuses the track file`.**
  - **`cli.test.ts`, `mapper import-track`:** runs and prints the summary.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Write the track file before `mutateProject`, so the project never names a file that isn't there. Map `TrackError` and `GpxError` to `ToolError`.
- [ ] **Step 4:** `npm test` and `npm run typecheck` PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat: import_track tool"`

### Task 7: Track legs in the studio

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Modify: `src/studio/edit/LegsPanel.tsx:89-114`, `src/studio/edit/RouteEditor.ts` (`onMapClick` `:179-207`, `syncVias` `:243-274`, Delete `:340`), `src/studio/edit/App.tsx:510-526` (point menu)
- Test: `test/studio/` (follow the pattern of the existing legs-panel and route-editor tests)

- [ ] **Step 1: Write the failing tests.**
  - **`Recorded track is offered only on a leg with a track`.**
  - **`choosing Recorded track sends mode and an empty via`:** `update_leg { mode: 'track', via: [] }`.
  - **`leaving a track leg keeps its track`:** choosing Line sends `{ mode: 'line' }` only.
  - **`a track leg shows no via handles and a click adds none`.**
  - **`a missing track shows a note`:** the text is `Its recorded track file is missing, so it's drawn as a straight line.`
  - **`a far stop shows a note`:** the text is `A stop is ${km} km from the recorded track.`
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Dragging a stop stays allowed, because it moves the cut (decision 5).
- [ ] **Step 4:** `npm test` and `npm run typecheck` PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat: studio shows recorded-track legs read-only"`

### Task 8: End to end, golden frame and speed

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Create: `test/e2e/track.test.ts`, `test/e2e/golden/track-mid.png` (via `UPDATE_GOLDENS=1`)
- Modify: `bench/render-speed.ts`, `docs/render-speed.md`

- [ ] **Step 1: Write the e2e tests.** None of them need the network: they use the `blank` theme.
  - **`import_track then preview draws the recorded line`:** run the CLI `import-track` on `syntheticCruise().csv`, then `preview_frame` at progress 0.5, compared against `golden/track-mid.png`.
  - **`a fixed-length scene renders exactly its frames`:** with `timing.length: 4` at 25 fps, render 1080p and use `ffprobe -count_frames` on `all.mp4`, giving `nb_read_frames` 100. Then set a stop pause of 1 s and render again, still giving 100.
  - **`render refuses a missing track`:** delete the track file, and the render fails naming `track-missing`.
- [ ] **Step 2:** `UPDATE_GOLDENS=1 npm run test:e2e -- track`, then look at `track-mid.png` and check the line follows the zigzag. Then `npm run test:e2e`. Expected: all PASS.
- [ ] **Step 3: Bench.** Add a `track-10k` case to `bench/render-speed.ts`: one track leg of 10,000 points, compared with the existing plain line case. Run `npm run bench:render` and record both in `docs/render-speed.md`.
  - **If frame time is more than 10% above the plain line case,** stop and report. The remedy is a lower `MAX_TRACK_POINTS`, which is the user's decision.
- [ ] **Step 4: Commit:** `git commit -m "test: recorded track and exact length end to end; track render speed"`

### Task 9: Docs and the spec revision

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Modify: `docs/plan.md`, `docs/superpowers/specs/2026-10-13-mapper-local-agent-design.md`, `README.md`, `skills/mapper/SKILL.md`, `AGENTS.md`

- [ ] **Step 1:** In `docs/plan.md`, add row 10 after row 9:

  `| 10 | **Recorded tracks and exact length** (built): \`import_track\` reads a GPX or CSV track, puts a stop wherever it stood still, and draws \`track\` legs along the recorded points, kept in \`tracks/\`. Project files are schema version 3. A scene can hold an exact length (\`timing.length\`) that stays put when pauses change | A recorded cruise track renders along its logged path with a stop at each port call, and a scene set to 4 s at 25 fps renders exactly 100 frames |`

  - **"Out of scope for now":** remove "render-to-exact-length".
  - **AIS section:** add a line that `import_track` and the `track` mode are built (Stage 10), and that buying historical data stays parked.
- [ ] **Step 2:** Update the spec:
  - Add "**Revision, 2026-10-17 (stage 10 decisions):**" with decisions 1–10, one bullet each.
  - Project file: v3, `Leg.track`, `Timing.length`, `tracks/`.
  - Tools table: `import_track`.
  - Non-goals: drop render-to-exact-length, and say AIS purchase is still parked.
  - "Build stages": add stage 10.
- [ ] **Step 3:** `SKILL.md`:
  - When to use `import_track` (a recorded log, kept exactly) and when to use `import_gpx` (a planned route to reshape).
  - Writing a `lng,lat,time` CSV from data the agent fetched.
  - Naming stops from the returned times.
  - Fixing a missed or false stop with `insert_stop`/`remove_stop`.
  - `timing.length`.
- [ ] **Step 4:** README: features and the project folder (`tracks/`). `AGENTS.md`'s no-connectors rule becomes: "Mapper takes stops through `set_stops`, a local GPX file through `import_gpx`, or a local recorded track through `import_track`."
- [ ] **Step 5: Commit:** `git commit -m "docs: stage 10 recorded tracks and exact length"`

### Final review

- **Review:** run the whole-branch review with Opus 5.5 (`opus`) against this plan and the spec, with the "Review focus" list. If Opus fails twice with an API error, stop and tell the user rather than dropping to Sonnet.
- **Suite:** then `npm test`, `MAPPER_NET=1 npm run test:e2e` (one after the other) and `npm run typecheck`.
- **PR:** push and open a PR against `main`. Then the Sol review loop:
  - Codex `gpt-6.1-sol` (reasoning high, review role) reviews the full diff and posts its findings as PR comments labelled **blocking** or **nit**. It edits no files.
  - Fix the blocking findings, push, and reply to each comment.
  - If a fix was substantial, run another Sol round with the earlier findings and replies. Stop after 3 rounds at most.
- **Hand over:** a short check for the user.
  - Import a real phone GPX log from a past trip (kept outside the repo). The stops land on the places you stopped, and the line follows the roads you took.
  - Ask the agent to remove one stop and add another on the track. The line stays on the recorded path.
  - Set a scene to 8 s and render it. Final Cut shows 00:00:08:00 at 25p.
- **Then ask:** "Can I merge it once review is complete, or do you want to run a final test first?"
