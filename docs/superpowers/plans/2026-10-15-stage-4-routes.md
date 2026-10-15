# Stage 4 routes implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not begin implementation until the user approves this plan.

**Goal:** Sea legs that route around land, air legs drawn as bowed great-circle arcs, a working follow camera, `import_gpx`, and the remaining `validate_project` warnings. Done when a cruise route stays at sea (Athens → Mykonos and Barcelona → Marseille) and a landlocked pair falls back cleanly with a warning.

**Architecture:** `core` gains a land-data decoder, a water grid, an A* sea router, air arcs, GPX parsing and the follow camera, all pure. Sea routing needs the land data, so only Node routes. `src/server/paths.ts` resolves every sea leg's path through a cache in `.mapper/paths.json` and hands the result (`SeaPaths`, keyed by a hash of the leg's inputs) to `buildRoute(scene, seaPaths)`. The MCP tools, preview, render, the render page and the studio all receive the same `SeaPaths` next to the project, so they draw the same path. Validation stays pure: it reads each path's status.

**Tech Stack:** TypeScript, Zod 4, React, MapLibre GL, Vite, Playwright with Chrome, Vitest, fast-xml-parser, Natural Earth 1:10m (public domain).

**Spec:** [Mapper design](../specs/2026-10-13-mapper-local-agent-design.md): Core › Routing, Camera, Validation, Getting stops in, MCP tools, Testing, and the revisions at the top. Also read `AGENTS.md` and `docs/plan.md`. The decisions made while brainstorming this stage are in "Stage 4 decisions" below. Task 15 copies them into the spec.

## Stage 4 decisions

- **Land data** ships in the repo as `data/land-10m.bin` (about 1.6 MB). It's built by `scripts/build-land.ts` from Natural Earth v5.1.2 `ne_10m_land` plus `ne_10m_minor_islands`, at 1e-4° precision. The water grid is never shipped; it's rasterised at runtime for each pair of points.
- **Air legs** are great-circle arcs with a bow toward the nearer pole (north at the equator). The bow is sized so each arc's visible curve is at least 15% of its chord. Via points split the leg into arcs that meet at corners.
- **`camera.follow.lookAhead` is in seconds**: the camera aims where the symbol will be that many seconds later. Defaults: `{ zoom: fitted zoom + 3, capped at the theme's maximum; orient: 'north'; lookAhead: 1; smoothing: 0.5 }`.
- **`import_gpx`** also takes `legMode?` (default `'line'`) and `symbol?`, as `set_stops` does.
- **`validateProject(project, { seaPaths? })`.** Sea checks run only when `seaPaths` is given.
- **Deferred to stage 6:** positional via drag index and index-based leg selection.

## Global constraints

- Coordinates are `[lng, lat]` (GeoJSON order) everywhere in the public interface.
- `core` imports nothing else from the package and has no DOM, filesystem or network imports. `fast-xml-parser` is allowed in core: it's pure JS.
- Computed leg paths live in `.mapper/paths.json`, never in `mapper.json`. Cache writes are atomic (`src/server/atomic.ts`).
- Every camera state is a pure function of the frame number. Frame `n` is the same however it's reached.
- The project file schema doesn't change. `schemaVersion` stays 2.
- Defaults for new projects: 3840×2160, 25 fps, 16:9.
- Every render carries the map credit (`MAP_CREDIT`).
- **Clean-room:** no Map Animator code, assets, UI text or file format. **Public repo:** nothing private. Natural Earth is public domain. Credit it in `data/README.md`.
- Downloads are untrusted data. The build script writes them into a new, empty temp folder and only reads them as JSON.
- Run `npm test` and `npm run test:e2e` one after the other, never together. CLI unit tests rebuild `dist`.

## Review focus

1. **A via point on land in a sea leg.** The route must still pass through it, and `crossesLand` must be set so validation warns. It must not fall back or throw. Test: Task 3, "visits a via point on land and reports crossesLand".
2. **Sea legs across the antimeridian.** Suva → Apia must route continuously, with no jump across the world, and buildRoute must line the cached path up with the scene's unwrapped stops. Tests: Task 3, "routes Suva to Apia across 180°"; Task 5, "places a cached sea path on the scene's unwrapped longitudes".
3. **A stale or broken cache.** A `paths.json` from an older router or land version, truncated JSON, or a missing `.mapper` folder must reroute, never crash. Test: Task 6, "ignores a cache from another router version" and "rebuilds a corrupt cache".
4. **An outside write while the studio is open.** The broadcast after the agent adds a sea leg must carry that leg's path, or the studio draws it as a line until the next edit. Test: Task 8, "broadcasts seaPaths for a sea leg added from outside".
5. **GPX files from real devices.** GPX 1.0 and 1.1 namespaces, `<extensions>` with prefixed tags, `<ele>` and `<time>`, several `<trkseg>`s, and unnamed points. Test: Task 11, "reads a GPX 1.0 file with extensions and several segments".

---

## Starting point

Branch `stage-4-routes` in the worktree `.claude/worktrees/stage-4-routes`, from `main` at `457937a`. Baseline: `npm test` passes 551 tests.

## Files

| File | Responsibility |
|---|---|
| `scripts/build-land.ts` (new), `data/land-10m.bin` (new), `data/README.md` (new) | Build and ship the land data |
| `src/core/land.ts` (new) | Encode and decode the land binary; `LandSource` index with `ringsIn` and `isLand` |
| `src/core/water.ts` (new) | Water grid: conservative rasterising, coast cost, snapping, segment checks |
| `src/core/curve.ts` (new) | Catmull-Rom and chain sampling, moved out of `route.ts` |
| `src/core/sea.ts` (new) | `routeSea`, `seaLegKey`, `SeaPath`, `ROUTER_VERSION` |
| `src/core/air.ts` (new) | `airPath`: bowed great-circle arcs |
| `src/core/route.ts` | `buildRoute(scene, seaPaths?)`: sea and air legs, `drawnAs`, `sea` status |
| `src/core/camera.ts` | Follow camera, `resolveFollow`, `projectToLayout` |
| `src/core/signs.ts` (new) | Sign tag metrics shared by the overlay and validation; `signBox` |
| `src/core/validate.ts` | New warnings, `seaPaths` option |
| `src/core/gpx.ts` (new) | `parseGpx`, `gpxToStops`, `importGpx` |
| `src/core/protocol.ts` | `seaPaths` on `ServerMessage`, `PatchResponse` and `RenderPageOptions` |
| `src/server/land.ts` (new), `src/server/paths.ts` (new) | Load the land data once; resolve and cache sea paths |
| `src/server/server.ts` | `seaPaths` in GET, patch and WebSocket answers |
| `src/mcp/tools.ts` | Paths in every result, `import_gpx`, leg summary lines |
| `src/render/render.ts`, `render-pass.ts`, `preview.ts`, `export-plan.ts`, `page.ts`, `src/studio/render-mode.ts` | Pass one `SeaPaths` snapshot through planning and every page load |
| `src/studio/stage/MapStage.ts`, `src/studio/edit/App.tsx`, `Stage.tsx`, `api.ts`, `LegsPanel.tsx` | Draw resolved paths; sea notes |
| `src/cli/doctor.ts` | Land data check |
| `skills/mapper/SKILL.md`, `docs/plan.md`, spec, `README.md` | Docs |

---

### Task 1: Land data

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Create: `src/core/land.ts`, `scripts/build-land.ts`, `data/land-10m.bin`, `data/README.md`, `test/core/land.test.ts`
- Modify: `src/core/index.ts`, `package.json` (script `build:land`: `tsx scripts/build-land.ts`), `tsconfig.bench.json` (include `scripts`)

**Interfaces:**
- Produces:
  - `LAND_FORMAT = 1`
  - `encodeLand(version: string, rings: LngLat[][]): Uint8Array`
  - `decodeLand(bytes: Uint8Array): LandData`, where `LandData = { version: string; rings: Float64Array[] }`. Each ring is flat Mercator `[x0, y0, x1, y1, …]` (`toXY`), implicitly closed.
  - `landIndex(data: LandData): LandSource`
  - `interface LandSource { version: string; ringsIn(minX: number, minY: number, maxX: number, maxY: number): Float64Array[]; isLand(at: LngLat): boolean }`
    - `ringsIn` takes a Mercator box whose x may lie outside 0–1 (unwrapped). It returns every ring whose bounding box meets the box, shifted by whole worlds (±1 in x) so it overlaps. A ring may come back twice, shifted.
    - `isLand` uses even-odd point-in-polygon over the rings, with any longitude (wrapped internally). It must answer in well under 1 ms for points in Europe, so index the edges by latitude band or similar.

**Binary format:** bytes 0–3 are ASCII `MLND`. Byte 4 is `LAND_FORMAT`. Byte 5 is the length `n` of the version string, then `n` bytes of UTF-8 version. After that comes a varint stream:
- the ring count
- for each ring, its point count, then zigzag varint deltas of `round(lng × 1e4)` and `round(lat × 1e4)`, each from the previous point of that ring (the first from 0)

The encoder drops a ring's duplicated closing point. The decoder clamps latitudes to ±85.0511 before `toXY`, because Antarctica reaches −90. The version string for the shipped file is `ne-10m-5.1.2`.

- [ ] **Step 1: Write the failing tests** in `test/core/land.test.ts`
  - `round-trips rings within 1e-4°`: encode two small rings and decode them. Same version and ring count, and every decoded point (converted back with `toLngLat`) is within 0.6e-4° of the input.
  - `rejects bytes without the MLND header`: `decodeLand(new Uint8Array([1,2,3,4,5,6]))` throws `/not a Mapper land file/`.
  - `reads the shipped file`: decode `data/land-10m.bin` (read with `fs` in the test). The version is `ne-10m-5.1.2`, it has more than 9,000 rings, and the file is under 2.5 MB.
  - `knows land from sea`: with `landIndex` over the shipped file, `isLand` is true for Athens `[23.7275, 37.9838]`, Mykonos town `[25.3289, 37.4467]`, Bern `[7.4474, 46.948]` and Lake Geneva `[6.6, 46.45]` (lakes are land). It's false for the sea off Piraeus `[23.60, 37.93]`, the open Aegean `[25.0, 37.0]` and the Caspian `[51, 42]`.
  - `finds rings across the antimeridian`: `ringsIn` for a box around Fiji with x from `toXY([177, 0])[0]` to `toXY([182, 0])[0]` includes rings shifted by +1, with x values above 1.
- [ ] **Step 2: Run** `npx vitest run test/core/land.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `src/core/land.ts`.**
- [ ] **Step 4: Write `scripts/build-land.ts`:**
  1. Make a new empty folder with `fs.mkdtemp(os.tmpdir() + '/mapper-land-')`.
  2. Download `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_land.geojson` and `…/ne_10m_minor_islands.geojson` into it.
  3. `JSON.parse` both. Take every outer and inner ring of every Polygon and MultiPolygon.
  4. `encodeLand('ne-10m-5.1.2', rings)`, write `data/land-10m.bin`, and print the size.
  5. Delete the temp folder.
- [ ] **Step 5: Run `npm run build:land`** and check the file is about 1.6 MB.
- [ ] **Step 6: Write `data/README.md`:** the source (Natural Earth v5.1.2, the two layers and the URL), "public domain, no permission needed", the precision (1e-4°, about 11 m), the format (pointing to `src/core/land.ts`), and how to rebuild it.
- [ ] **Step 7: Run** `npx vitest run test/core/land.test.ts`, then `npm run typecheck`. Expected: PASS.
- [ ] **Step 8: Commit:** `git commit -m "feat: Natural Earth land data and its decoder"`

### Task 2: Water grid

**Model:** Opus 5.5 (`opus`). The rasterising and its edge cases decide whether routes stay off land.

**Files:**
- Create: `src/core/water.ts`, `test/core/water.test.ts`
- Modify: `src/core/index.ts`

**Interfaces:**
- Consumes: `LandSource` (Task 1).
- Produces:
  - `interface Box { minX: number; minY: number; maxX: number; maxY: number }` (Mercator, x may be unwrapped)
  - `interface WaterGrid { x0: number; y0: number; cell: number; cols: number; rows: number; land: Uint8Array; cost: Float32Array }`. Row-major. `(x0, y0)` is the box's min corner. `land[i] = 1` for land. `cost[i]` is the step multiplier for water cells.
  - `waterGrid(land: LandSource, box: Box, longSide = 1024): WaterGrid`. The cells are square, `cell = max(width, height) / longSide`.
  - `cellAt(grid, xy: XY): number | undefined` (the cell index, or undefined outside the grid) and `cellCentre(grid, index: number): XY`
  - `snapToWater(grid, xy: XY, maxKm: number): number | undefined`: the nearest water cell by centre distance, within `maxKm` (converted to Mercator at `xy`'s latitude: `km / (40075.017 × cos φ)`). Undefined if there's none.
  - `firstLandOnSegment(grid, a: XY, b: XY): XY | undefined`: samples every quarter cell and returns the first sample in a land cell.

**Rules:**
- **Conservative land:** a cell is land when its centre is inside land (even-odd scanline at cell-centre rows) or any land edge passes through it (walk each clipped edge across cells). That way a water cell has no land in it.
- **Clipping:** clip each ring from `ringsIn` to the box with Sutherland–Hodgman before filling, so a continent-sized ring costs only its local edges.
- **Coast cost:** with a 3-4 chamfer distance from land in cells, a cell within 1 cell costs 3, within 2 cells costs 2, within 3 cells costs 1.5, and open water costs 1. Land cells cost `Infinity`.

- [ ] **Step 1: Write the failing tests** in `test/core/water.test.ts`. Use a synthetic `LandSource` from `landIndex(decodeLand(encodeLand('t', rings)))`, plus the shipped file for one realistic case.
  - `marks a square island and its edge cells as land`: a 1°×1° island in a 4°×4° box at 256 cells. Every cell whose centre is inside the island is land. Every cell the island's outline crosses is land. Cells two or more cells outside the outline are water.
  - `fills a ring with a hole as land around water`: an annulus. The hole's centre cell is water.
  - `costs more next to the coast`: a water cell touching land costs 3, and one 10 cells away costs 1.
  - `snaps an inland point to the nearest water within the limit`: a point 0.1° inside the island's edge snaps to a water cell just outside. With `maxKm: 1` it returns undefined.
  - `finds land on a segment`: a segment across the island returns a point inside it, and one along open water returns undefined.
  - `works on unwrapped boxes`: a box spanning x 0.99–1.02 over Fiji (shipped file) marks Viti Levu `[178.0, -17.8]` as land, at its unwrapped x.
- [ ] **Step 2: Run** `npx vitest run test/core/water.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `src/core/water.ts`.**
- [ ] **Step 4: Run** the test and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat: water grid for sea routing"`

### Task 3: Sea router

**Model:** Opus 5.5 (`opus`). Search, smoothing that stays off land, and knots that line up with via points.

**Files:**
- Create: `src/core/curve.ts`, `src/core/sea.ts`, `test/core/sea.test.ts`
- Modify: `src/core/route.ts` (import the curve functions from `curve.ts`, no behaviour change), `src/core/index.ts`

**Interfaces:**
- Consumes: `waterGrid`, `snapToWater`, `firstLandOnSegment`, `cellCentre`, `cellAt` (Task 2); `LandSource` (Task 1).
- Produces:
  - `curve.ts`: `sampleChain(controls: { at: LngLat; sharp: boolean }[]): { xy: XY[]; at: number[] }` and `SAMPLES_PER_SPAN`, moved unchanged from `route.ts`. Also `curveThrough(points: XY[], samplesPerSpan?: number): XY[]`.
  - `ROUTER_VERSION = 1` and `MAX_SNAP_KM = 30`
  - `interface SeaPath { status: 'ok' | 'fallback'; reason?: string; path: LngLat[]; knots: number[]; crossesLand?: LngLat }`. With `ok`, `path` is unwrapped from `from`'s longitude: `path[0]` is exactly `from`, `path[knots[i + 1]]` is exactly via `i` (unwrapped), the last point is exactly `to` (unwrapped), and `knots.length === via.length + 2`. With `fallback`, `path` and `knots` are `[]`. `crossesLand` is wrapped to ±180.
  - `type SeaPaths = Record<string, SeaPath>`
  - `seaLegKey(from: LngLat, to: LngLat, via: ViaPoint[]): string`: 16 hex characters of FNV-1a 64 over `JSON.stringify([ROUTER_VERSION, from, to, via.map(v => [v.at, v.sharp === true])])`.
  - `routeSea(from: LngLat, to: LngLat, via: ViaPoint[], land: LandSource): SeaPath`

**Algorithm:**
1. Unwrap the controls (`from`, each via, `to`) in order.
2. For each consecutive pair, build `waterGrid` over the pair's box, grown on every side by `max(0.5 × the box's larger side, 0.5 / 360)`.
3. Snap both ends with `snapToWater(…, MAX_SNAP_KM)`. If an end is beyond the limit, fall back with the reason `The start stop is more than 30 km from the sea`, `The end stop …` or `Via point N …` (N counts from 1).
4. Search with A* on 8 neighbours. A step costs its Mercator length × the mean `cost` of its two cells. The heuristic is octile distance.
5. If no path is found, retry once with the margin tripled. Then fall back with `No sea route found between <the start stop | via point N> and <via point N | the end stop>`.
6. **Simplify** each pair's cell path by string pulling: from each kept point, keep the furthest later point that `firstLandOnSegment` says is reachable.
7. **Assemble** one point list per leg: the stop (or via), its snapped cell centre if that differs (the connector), the simplified water points, and so on, ending at `to`. Remember the index of each control.
8. **Smooth** with `curveThrough` over runs split at sharp vias, the way `sampleChain` splits at sharp points. A smooth via is curved through.
   - A span that touches land (`firstLandOnSegment` on its samples) goes back to its straight segment.
   - A connector span from a stop to its snapped cell is always straight and never counts as land.
9. **crossesLand:** sample the final path. The first land hit outside the stop connectors sets `crossesLand`. A connector to a via on land does count.
10. **Identical points:** if `from`, `to` and all vias are the same point, the result is `ok` with `path: [from, to]`.

- [ ] **Step 1: Move the curve functions** to `src/core/curve.ts`. Run `npx vitest run test/core/route.test.ts`. Expected: PASS, unchanged.
- [ ] **Step 2: Write the failing tests** in `test/core/sea.test.ts`, with the shipped land loaded once.
  - Helper `atSeaBetweenConnectors(path)`: find the first and last indices whose point isn't land (`isLand`). Assert that the stretch from `path[0]` to the first water point is under 30 km (haversine), and the same at the end. Then sample every 200 m between those two indices and expect `isLand` false at every sample.
  - `keeps Athens to Mykonos at sea`: `routeSea([23.7275, 37.9838], [25.3289, 37.4467], [], land)` gives status `ok`, `atSeaBetweenConnectors` holds, and the path is under 1.6 × the haversine distance.
  - `keeps Barcelona to Marseille at sea`: `[2.1734, 41.3851]` → `[5.3698, 43.2965]`, with the same checks.
  - `falls back for a landlocked pair`: Bern `[7.4474, 46.948]` → Prague `[14.4378, 50.0755]` gives `{ status: 'fallback', reason: 'The start stop is more than 30 km from the sea', path: [], knots: [] }`.
  - `passes through via points at their knots`: Piraeus `[23.6466, 37.942]` → Rhodes `[28.2278, 36.451]` with a via at `[26.0, 36.3]`. `path[knots[1]]` equals the via, `knots` has length 3, and the path is at sea.
  - `keeps a sharp via as a corner`: the same leg with the via marked sharp. The heading change across `knots[1]` is over 20°. Without `sharp`, the heading change between the samples either side of the knot is under 5°.
  - `visits a via point on land and reports crossesLand`: a via on Naxos `[25.45, 37.05]` gives status `ok`, `path[knots[1]]` equals the via, and `crossesLand` is defined.
  - `routes Suva to Apia across 180°`: `[178.4419, -18.1416]` → `[-171.7513, -13.8333]` gives `ok`. Consecutive points differ by under 1° of longitude, and the last point is `[-171.7513 + 360, -13.8333]`.
  - `returns a two-point path for identical ends`.
  - `routes Barcelona to Marseille in under 1.5 s` (performance.now).
  - `seaLegKey is stable and input-sensitive`: the same inputs give the same 16-hex key, and toggling a via's `sharp` changes it.
- [ ] **Step 3: Run** `npx vitest run test/core/sea.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement `src/core/sea.ts`.**
- [ ] **Step 5: Run** `npx vitest run test/core` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit:** `git commit -m "feat: sea router with A*, smoothing that stays off land, and forced via points"`

### Task 4: Air arcs

**Model:** Opus 5.5 (`opus`). Spherical maths and antimeridian handling.

**Files:**
- Create: `src/core/air.ts`, `test/core/air.test.ts`
- Modify: `src/core/index.ts`

**Interfaces:**
- Produces:
  - `AIR_SAMPLES = 64` and `AIR_BOW = 0.15`
  - `airPath(controls: LngLat[]): { path: LngLat[]; knots: number[] }`. The controls are unwrapped and in order. The path is unwrapped and continuous, `path[knots[i]]` is exactly `controls[i]`, and `knots.length === controls.length`.

**Each arc from A to B:**
1. Sample the great circle `g(t)` by slerp on unit vectors (`AIR_SAMPLES` spans), unwrapped against A. Clamp latitudes with `clampLat`.
2. In Mercator, let `L` be the chord length and `n` the unit normal to the chord pointing toward the nearer pole (decided by the chord midpoint's latitude; north when it's ≥ 0; north is −y).
3. `s` is the signed offset of `g(0.5)` from the chord along `n`.
4. The point at `t` is `g(t) + n · max(0, AIR_BOW·L − s) · sin(πt)`.

Coincident ends give `[A, A]`.

- [ ] **Step 1: Write the failing tests:**
  - `starts and ends exactly on the controls`
  - `bows a short northern flight north`: Athens → Santorini. The midpoint's Mercator offset from the chord toward −y is at least 0.15 × the chord length (within 1%).
  - `bows a southern flight south`: Sydney → Auckland.
  - `adds no bow to a long arc that already curves enough`: London `[-0.45, 51.47]` → Los Angeles `[-118.41, 33.94]`. The midpoint equals the pure great-circle midpoint within 1e-9.
  - `crosses the antimeridian continuously`: Suva → Apia. Consecutive longitudes differ by under 2°.
  - `puts knots on via points`: three controls give knots `[0, 64, 128]`.
- [ ] **Step 2: Run** `npx vitest run test/core/air.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run** the test and the typecheck. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat: bowed great-circle arcs for air legs"`

### Task 5: Sea and air legs in `buildRoute`

**Model:** Opus 5.5 (`opus`). `route.ts` invariants (knots, unwrapping, chains) that the studio depends on.

**Files:**
- Modify: `src/core/route.ts`, `src/core/validate.ts`, `test/core/route.test.ts`, `test/core/validate.test.ts`, and `src/studio/edit/LegsPanel.tsx` (it reads `notAvailable` today; switch it to `leg.sea?.status === 'pending'` with the same text, so it still compiles. Task 8 sets the final text.)

**Interfaces:**
- Consumes: `SeaPaths`, `seaLegKey` (Task 3); `airPath` (Task 4); `sampleChain` (Task 3's `curve.ts`).
- Produces:
  - `buildRoute(scene: Scene, seaPaths?: SeaPaths): Route`
  - `RouteLeg.drawnAs: 'line' | 'sea' | 'air'`. `notAvailable` is removed.
  - `RouteLeg.sea?: { status: 'ok' | 'fallback' | 'pending'; reason?: string; crossesLand?: LngLat }` on every sea leg. It's `pending` when `seaPaths` has no entry for the leg's key.
  - `validateProject(project: Project, opts?: { seaPaths?: SeaPaths })`

**Rules:**
- **Sea leg, `ok`:** shift the cached path by whole turns (360°) so `path[0][0]` equals the unwrapped start stop's longitude, then build `xy`, `cum` and `length` from it. `drawnAs` is `'sea'`. Use the cached `knots`.
- **Sea leg, `fallback` or `pending`:** drawn as today (a straight chain through its controls). `drawnAs` is `'line'`.
- **Air leg:** `airPath` of `[start, ...via, end]` (unwrapped). `drawnAs` is `'air'`.
- The unwrapping that follows (`prevLng`) continues from each leg's actual end, so later legs stay continuous.
- **Validation:** `validateProject` passes `opts.seaPaths` to `buildRoute`, and drops the `not-available-yet` warnings for sea and air legs. The follow and other warnings stay.

- [ ] **Step 1: Update the existing tests** that assert `notAvailable` to assert `drawnAs` and `sea.status === 'pending'` instead.
- [ ] **Step 2: Write the failing tests** in `route.test.ts`:
  - `draws a sea leg from its cached path`: build the `SeaPaths` with `routeSea` for Piraeus → Mykonos. The leg has `drawnAs: 'sea'`, the same point count as the cached path, and knots equal to the cache's.
  - `places a cached sea path on the scene's unwrapped longitudes`: a three-stop scene `[170, -17] → [178.44, -18.14] (line) → [-171.75, -13.83] (sea)`, with a hand-made `SeaPath` whose longitudes start at 178.44. Leg 1's first point equals leg 0's last point exactly, and its last longitude is 188.25.
  - `draws a sea leg without a cached path as a pending line`
  - `draws a fallback sea leg as a line and keeps its reason`
  - `draws an air leg as an arc with knots at its via points`
  - `nearestOnLeg on a sea leg gives an insertIndex between the right knots`
- [ ] **Step 3: Run** `npx vitest run test/core`. Expected: the new tests FAIL.
- [ ] **Step 4: Implement it.**
- [ ] **Step 5: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit:** `git commit -m "feat: buildRoute draws sea legs from resolved paths and air legs as arcs"`

### Task 6: Land loading and the path cache

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Create: `src/server/land.ts`, `src/server/paths.ts`, `test/server/paths.test.ts`
- Modify: `src/cli/doctor.ts`, `test/cli/doctor.test.ts`

**Interfaces:**
- Consumes: `decodeLand`, `landIndex` (Task 1); `routeSea`, `seaLegKey`, `ROUTER_VERSION`, `SeaPaths` (Task 3).
- Produces:
  - `LAND_FILE: URL = new URL('../../data/land-10m.bin', import.meta.url)`. This resolves from both `src/server` and `dist/server`.
  - `loadLand(): Promise<LandSource>`. Memoised per process. A missing or bad file throws `StoreError` with the fix `Reinstall Mapper, or run npm run build:land in its folder.`
  - `resolveSeaPaths(folder: string, project: Project, opts?: { land?: LandSource }): Promise<SeaPaths>`. Returns an entry for every sea leg in every scene, keyed by `seaLegKey`. `opts.land` is for tests.
  - `PATHS_FILE = path.join('.mapper', 'paths.json')`

**Cache file:** `{ "version": 1, "router": ROUTER_VERSION, "land": "<land version>", "paths": { "<key>": SeaPath & { "usedAt": "<ISO>" } } }`.
- If the file is missing, unreadable, or has a different `version`, `router` or `land`, start from empty.
- Write (atomically, creating `.mapper/`) only when at least one leg was routed. Then refresh `usedAt` on every key this project uses, and keep the newest 500 entries by `usedAt`.
- Calls for the same folder run one after another (a promise chain per folder), so two concurrent calls never both route the same leg or lose each other's entries.
- The returned `SeaPaths` omit `usedAt`.

- [ ] **Step 1: Write the failing tests** in `test/server/paths.test.ts`, using a temp folder and a synthetic `LandSource` (an island between two sea stops) so they run fast:
  - `routes a sea leg and writes the cache`
  - `reads a cached path without routing again` (spy on routing by counting `ringsIn` calls on the land source)
  - `ignores a cache from another router version`
  - `rebuilds a corrupt cache` (the file holds `{"version":`)
  - `keeps the newest 500 entries`
  - `serialises concurrent calls for one folder` (two parallel calls route each leg once, and both get every key)
  - `returns nothing for a project without sea legs, and writes no file`
- [ ] **Step 2: Add the doctor check** `Land data`. It's OK when `loadLand()` resolves, with detail `ne-10m-5.1.2, N rings`. Otherwise it fails with the fix above. Add a test.
- [ ] **Step 3: Run** `npx vitest run test/server/paths.test.ts test/cli/doctor.test.ts`. Expected: FAIL first, then PASS after implementing.
- [ ] **Step 4: Commit:** `git commit -m "feat: cache resolved sea paths in .mapper/paths.json"`

### Task 7: Sea paths in the MCP tools, preview and render

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Modify:
  - `src/core/protocol.ts` (`RenderPageOptions.seaPaths?: SeaPaths`)
  - `src/studio/render-mode.ts` (pass `seaPaths` to `MapStage.load`)
  - `src/studio/stage/MapStage.ts` (`load(project, sceneId?, seaPaths?)` builds the route with them)
  - `src/render/page.ts`, `render-pass.ts`, `render.ts`, `preview.ts`, `export-plan.ts`
  - `src/mcp/tools.ts`
- Test: `test/render/export-plan.test.ts`, `test/mcp/tools.test.ts`

**Interfaces:**
- Consumes: `resolveSeaPaths` (Task 6); `buildRoute(scene, seaPaths)` and `validateProject(project, { seaPaths })` (Task 5).
- Produces:
  - `MapStage.load(project: Project, sceneId?: string, seaPaths?: SeaPaths): Promise<void>`
  - `planExport(…)` takes `seaPaths: SeaPaths` (it changes arrival frames)
  - `projectResult(project, seaPaths)` in `tools.ts`

**Rules:**
- **Render:** resolves the paths once when the job starts, after loading the project snapshot. It uses that object for validation, planning and every `page.load`, so the page's frame count matches the plan's.
- **Preview:** resolves before each preview.
- **MCP:** every tool that returns `projectResult` resolves first.
- **`legLine` in summaries:** a sea or air leg always gets a line, with `sea route`, `sea route failed: <reason>`, `sea route crosses land near [lng, lat]` or `flight arc` added to its parts.

- [ ] **Step 1: Write the failing tests:**
  - `export-plan.test.ts`: `arrival frames follow the sea path's length` (a plan with real `SeaPaths` for a sea leg differs from one without, and matches `buildTimeline(scene, fps, buildRoute(scene, seaPaths))`).
  - `tools.test.ts`: `set_stops with legMode sea reports the sea route` (summary contains `sea route`; `data.validation` has no `not-available-yet`); `a landlocked sea leg reports the fallback` (Bern → Prague; summary contains `sea route failed: The start stop is more than 30 km from the sea`).
- [ ] **Step 2: Run** `npx vitest run test/render test/mcp`. Expected: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat: resolved sea paths in tools, preview and render"`

### Task 8: Sea paths in the server and studio

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Modify: `src/core/protocol.ts`, `src/server/server.ts`, `src/studio/edit/api.ts`, `App.tsx`, `Stage.tsx`, `LegsPanel.tsx`
- Test: `test/server/server.test.ts`

**Interfaces:**
- Consumes: `resolveSeaPaths` (Task 6); `MapStage.load(project, sceneId, seaPaths)` (Task 7).
- Produces:
  - `ServerMessage = { type: 'project'; project: Project; seaPaths: SeaPaths; origin?: string }`
  - `PatchResponse` gains `seaPaths: SeaPaths`
  - `GET /api/projects/:key` answers `{ project, seaPaths }`

**Rules:**
- **Server:** resolves paths before every answer and broadcast, including the WebSocket's first message and file-watch reloads. If resolving throws, it sends `{}` (sea legs draw as pending lines) and logs the error once per project.
- **Studio:** keeps `seaPaths` next to `project` in state, replaced with each message or response, and passes them to `buildRoute` and `MapStage.load`.
- **LegsPanel notes:**
  - `fallback` shows `No sea route found: {reason}. Drawn as a line.`
  - `pending` shows `Finding a sea route…`
  - `ok` shows nothing.
  - "Drawn as a plain line for now." is gone.

- [ ] **Step 1: Write the failing tests** in `server.test.ts`:
  - `GET answers with seaPaths`
  - `a patch answer carries seaPaths for a new sea leg`
  - `broadcasts seaPaths for a sea leg added from outside` (write through `mutateProject`, then await the WebSocket message)
  - `sends empty seaPaths when the land data can't load` (inject a failing land loader through the server's existing options object; add `land?: () => Promise<LandSource>` to it)
- [ ] **Step 2: Run** `npx vitest run test/server/server.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat: server and studio carry resolved sea paths"`

### Task 9: Follow camera

**Model:** Opus 5.5 (`opus`). Smoothing that stays pure per frame.

**Files:**
- Modify: `src/core/camera.ts`, `src/core/validate.ts` (drop the follow `not-available-yet` warning; check a stored `follow.zoom` against the theme's maximum, path `['camera', 'follow', 'zoom']`), `src/mcp/tools.ts` (add `camera.resolvedFollow` to each scene's result when `mode` is `follow`), `test/core/camera.test.ts`, `test/core/validate.test.ts`

**Interfaces:**
- Produces:
  - `interface FollowSettings { zoom: number; orient: 'north' | 'heading'; lookAhead: number; smoothing: number }`
  - `resolveFollow(scene: Scene, aspect: Aspect, route: Route): FollowSettings`. This is `camera.follow` if set. Otherwise the defaults: zoom is `min(fitShot(route.bounds, aspect).zoom + 3, THEME_MAX_ZOOM[look.theme])`, orient `'north'`, lookAhead 1, smoothing 0.5.
  - `cameraAt(…)` with `mode: 'follow'` returns `{ center, zoom: follow.zoom, bearing, pitch: start?.pitch ?? 0 }`

**The follow track:**
- **Target for frame `f`:** the centre is `timeline.stateAt(f + round(lookAhead × fps)).head.at` (`stateAt` clamps to the last frame). The bearing is that frame's `head.heading` with `orient: 'heading'`, otherwise 0.
- **Holds:** frames before `travelStartFrame` use the target of `travelStartFrame`. Frames after `travelEndFrame` use the target of `travelEndFrame`.
- **Smoothing:** smooth the Mercator centre and the bearing, unwrapped across frames. `ω = 1 / smoothing` per second and `dt = 1 / fps`. Run the exact critically damped step forward from frame 0 (starting at the target with v = 0), then backward over the forward result from the last frame (starting at the forward value with v = 0). With `smoothing: 0`, use the targets as they are. Normalise the bearing at the end.

```
step(x, v, target, dt, ω):
  e = exp(−ω·dt); d = x − target; k = v + ω·d
  x' = target + (d + k·dt)·e
  v' = (v − ω·k·dt)·e
```

- **Memoising:** keep the track in a `WeakMap<Timeline, { key: string; track }>`. The key is `JSON.stringify([scene.camera, aspect, scene.look.theme])`, recomputed when it differs.

- [ ] **Step 1: Write the failing tests** in `camera.test.ts` (replace `follow acts as glide`):
  - `follow is the same frame however it's reached` (frames read forwards, backwards, and from a fresh timeline give identical shots)
  - `smoothing 0 centres on the look-ahead point` (lookAhead 0: the centre equals `head.at`; lookAhead 1: it equals the head 25 frames later at 25 fps)
  - `holds before and after travel`
  - `orient heading turns the bearing with the route` (on an L-shaped route the bearing goes from about 90 to about 180)
  - `smoothing settles on the stop during a long pause` (the centre at the middle of a long pause is within 1e-6 of the stop)
  - `resolves default follow settings` (the zoom is the fitted zoom + 3 for `blank`, and capped at 14 for `paper`)
  - `follow on a single-stop or zero-length route returns finite values`
- [ ] **Step 2: Write the validate tests:** `follow.zoom above the theme maximum warns` and `follow no longer warns as unavailable`.
- [ ] **Step 3: Run** `npx vitest run test/core`. Expected: FAIL.
- [ ] **Step 4: Implement it.**
- [ ] **Step 5: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit:** `git commit -m "feat: follow camera with look-ahead and zero-lag critically damped smoothing"`

### Task 10: Validation warnings

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Create: `src/core/signs.ts`
- Modify: `src/core/validate.ts`, `src/core/camera.ts` (`projectToLayout`), `src/studio/stage/overlay.ts` (import the metrics from core; drawing unchanged), `test/core/validate.test.ts`, `test/core/camera.test.ts`

**Interfaces:**
- Produces:
  - `SIGN_TAG = { fontPx: 26, padX: 16, padY: 10, lineHeight: 26, lift: 16, pointer: 10, pointerHalfWidth: 8, radius: 6 }`, moved from `overlay.ts`. `SIGN_FONT` stays in the overlay.
  - `signBox(px: [number, number], text: string): { left: number; top: number; right: number; bottom: number }`. The width is estimated as `text.length × 0.6 × fontPx + 2 × padX`. The box sits centred above the dot, as `drawTag` places it.
  - `projectToLayout(shot: Shot, aspect: Aspect, at: LngLat): [number, number]`. Layout px. Mercator offset × `TILE_SIZE · 2^zoom`, rotated by the bearing, around the layout centre. Pitch is ignored. `at` is unwrapped against the shot centre.

**Warnings** (in this order after the existing ones, per leg and then per stop):

- **`sea-fallback`**, path `['legs', i, 'mode']`
  - message: `${legName(i)} has no sea route: ${reason}`
  - fix: `Add via points over open water with insert_via to guide it, move the stop nearer the coast, or set the leg's mode to 'line' with update_leg. It is drawn as a straight line until then.`
- **`sea-crosses-land`**, path `['legs', i, 'via']`
  - message: `${legName(i)}'s sea route crosses land near [${lng}, ${lat}]` (4 decimal places)
  - fix: `Move or add via points with update_via or insert_via so the route stays over water; a via point on land pulls the route ashore.`
- **`sign-overlap`**, path `['stops', j, 'label']`, where `j` is the later stop
  - message: `The ${nameA} and ${nameB} signs overlap at ${timecode}`
  - fix: `Give one a shorter label with update_stop, set one stop's sign to 'none', or move the camera closer so the stops sit further apart.`
  - **How it's checked:** for each stop with a sign, at its arrival frame plus the fade (`SIGN_FADE_SECONDS × fps`, rounded), take every sign visible on that frame (opacity > 0) at `cameraAt` and test each pair's `signBox` for intersection. Report each pair once, at its first frame.

- [ ] **Step 1: Write the failing tests:**
  - `projectToLayout puts the shot centre at the layout centre, and east of it to the right`
  - `warns when a sea leg falls back` (a `SeaPaths` entry with `fallback`)
  - `warns when a sea route crosses land`
  - `warns once when two signs overlap` (two stops 1 km apart with long labels, fixed camera at zoom 5)
  - `does not warn for signs far apart` (greekIslands)
  - `skips sea checks without seaPaths`
  - `greekIslands() and pacific() still validate clean`
- [ ] **Step 2: Run** `npx vitest run test/core`. Expected: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat: warnings for sea fallbacks, sea routes over land and overlapping signs"`

### Task 11: GPX parsing and conversion

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Create: `src/core/gpx.ts`, `test/core/gpx.test.ts`, and fixtures in `test/fixtures/gpx/`, written by hand:
  - `track.gpx`: GPX 1.1, one track with two segments, and three named waypoints near it plus one 10 km off
  - `routes.gpx`: one `<rte>`, no track
  - `multi.gpx`: two named tracks
  - `gpx10.gpx`: the GPX 1.0 namespace, `<ele>`, `<time>`, and `<extensions>` with `gpxtpx:` tags
  - `waypoints-only.gpx`
- Modify: `package.json` (move `fast-xml-parser` to `dependencies`), `src/core/index.ts`

**Interfaces:**
- Produces:
  - `interface Gpx { lines: { kind: 'track' | 'route'; name?: string; points: LngLat[] }[]; waypoints: { name: string; at: LngLat }[] }`. Track segments are joined in order. Waypoints without a name are dropped.
  - `class GpxError extends Error { fix: string }`
  - `parseGpx(text: string): Gpx`. Uses `XMLParser` with `processEntities: false`, `ignoreAttributes: false`, and namespace prefixes removed. Reads `lat`/`lon` attributes into `[lon, lat]`.
  - `gpxToStops(gpx: Gpx, opts: { track?: number | string; stops?: 'waypoints' | 'ends' }): { stops: { name: string; at: LngLat }[]; via: ViaPoint[][]; line?: { kind: 'track' | 'route'; name?: string }; skipped: { name: string; km: number }[] }`
  - `importGpx(project: Project, imported: ReturnType<typeof gpxToStops>, opts: { legMode?: LegMode; symbol?: SymbolKind }): Project`. Calls `setStops` (replace) with `legMode ?? 'line'` and the symbol on every stop except the last, then sets each leg's `via`. It returns `parseProject` of the result.

**Rules:**
- **Choosing the line:** `track` is a 1-based index or a name, over tracks first and then routes. By default it's the first track, or the first route if there are no tracks.
  - An unknown track gives a `GpxError` listing the names and the count.
  - A file with neither tracks nor routes: `'waypoints'` uses the waypoints in file order with no via points, and `'ends'` throws `This GPX file has no track or route.` with the fix `Pass stops: 'waypoints', or choose a file with a track.`
- **`'ends'`:** two stops at the line's first and last points. Each is named after a waypoint within 1 km, otherwise `${line name or 'Track'} start` / `… end`.
- **`'waypoints'`:**
  - Project each waypoint onto the line (its nearest point). Keep those within 2 km, ordered by distance along the line. The others go into `skipped` with their distance in km (1 decimal place).
  - With fewer than 2 kept, throw with the fix `Use stops: 'ends', or add named waypoints along the track.`
  - The line before the first stop and after the last is dropped.
- **Via points:** Douglas–Peucker in Mercator over the line between two stops, ends excluded. The tolerance starts at `0.002 ×` the larger side of that stretch's box and doubles until there are at most 100 via points. All are curved, not sharp.

- [ ] **Step 1: Write the failing tests:**
  - `reads tracks, routes and named waypoints`
  - `reads a GPX 1.0 file with extensions and several segments`
  - `joins track segments in order`
  - `picks a track by index or name, and lists the names for an unknown one`
  - `ends mode makes two stops named after nearby waypoints`
  - `waypoints mode orders stops along the line and skips far waypoints`
  - `caps via points at 100 per leg and keeps the shape`
  - `waypoints-only file: waypoints mode uses file order, ends mode throws`
  - `rejects text that isn't GPX` (`<html>` → `GpxError`)
  - `importGpx replaces the stops and sets via points and legMode`
- [ ] **Step 2: Run** `npx vitest run test/core/gpx.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run** the test and the typecheck. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat: GPX parsing and conversion to stops and via points"`

### Task 12: `import_gpx` tool

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Modify: `src/mcp/tools.ts`, `test/mcp/tools.test.ts`, `test/cli/cli.test.ts`

**Interfaces:**
- Consumes: `parseGpx`, `gpxToStops`, `importGpx`, `GpxError` (Task 11); `projectResult` and `resolveSeaPaths` (Task 7).
- Produces: the tool `import_gpx`, with input `{ folder, path, track?: number | string, stops?: 'waypoints' | 'ends', legMode?: LegMode, symbol?: SymbolKind }`. The CLI command `import-gpx` comes from the tool list automatically.

**Rules:**
- `path` must be absolute, end in `.gpx` (any case) and be at most 20 MB. Each failure is a tool error with a fix.
- `GpxError` becomes a tool error carrying its fix.
- The result is `projectResult`, plus `data.import = { line, stops: n, skipped }` and a first summary line such as `Imported 4 stops from track "Coast walk"; skipped 1 waypoint more than 2 km from the track (Lighthouse, 10.2 km).`
- Description:
  > Read a local GPX file into the scene's stops, replacing them. stops: 'ends' (default) makes a stop at the start and end of the track; 'waypoints' makes a stop of each named waypoint within 2 km of it. The track between stops becomes simplified via points. track picks a track or route by 1-based index or name. legMode (default 'line') and symbol set every leg. path and folder must be absolute.

- [ ] **Step 1: Write the failing tests:**
  - `tools.test.ts`: `import_gpx imports a track with waypoints`, `import_gpx rejects a relative path`, `import_gpx rejects a non-GPX extension`, and `import_gpx turns a GpxError into a tool error with its fix`
  - `cli.test.ts`: `mapper import-gpx --json works`
- [ ] **Step 2: Run** `npx vitest run test/mcp test/cli`. Expected: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat: import_gpx tool and CLI command"`

### Task 13: Stage 3 minors

**Model:** Haiku 5.5 (`haiku`).

**Files:**
- Modify: `src/mcp/tools.ts` (stop lines and the render status summary), `src/studio/edit/RouteEditor.ts`, `src/render/render.ts`, and the matching tests

**Changes:**
- **Sharp stops in summaries:** a sharp stop's summary line ends in ` · sharp`. Test in `tools.test.ts`.
- **`RouteEditor.ts`:** delete the stale first doc comment above `HIT_PX` ("Half the side of the box, in layout px…"). Keep "Half the click hit box, in screen px."
- **`rollingProgress`:** reset the window (keep only the newest sample) when `active.sceneId` or `active.layer` changes, so a page switch doesn't skew fps.
  - When the export has more than one layer, the `render_status` summary says `Frame 120 of 900 (all layers)`.
  - Tests in `test/render` for the reset, and in `tools.test.ts` for the wording.

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Implement the changes.**
- [ ] **Step 3: Run** `npm test`. Expected: PASS.
- [ ] **Step 4: Commit:** `git commit -m "fix: stage 3 minors (sharp stops in summaries, progress window per layer)"`

### Task 14: End-to-end tests and a sea golden frame

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Create: `test/e2e/routes.test.ts`, `test/e2e/golden/sea-<frame>.png`
- Modify: `test/fixtures/projects.ts` (add `cruise()`: the greekIslands stops with every leg `sea`, theme `blank`), `test/e2e/stage.test.ts` (add the sea golden)

**Tests:**
- `MCP: create, set_stops with sea legs, validate, preview` uses the MCP SDK client like `mcp.test.ts`:
  - Piraeus → Mykonos → Santorini, `legMode: 'sea'`
  - no sea warnings
  - `preview_frame` returns a PNG
  - `.mapper/paths.json` exists with 2 entries
- `MCP: import_gpx then validate` uses `test/fixtures/gpx/track.gpx`.
- `studio draws the routed sea leg`:
  - Open the studio on `cruise()`. The edit route source's coordinates for leg 0 have the same length as `buildRoute(scene, seaPaths).legs[0].path`.
  - Making leg 0 landlocked (via a patch moving the stops to Bern and Prague) shows the note `No sea route found: The start stop is more than 30 km from the sea. Drawn as a line.`
- `render page frame count matches the plan for sea legs`.
- **Golden:** `cruise()` at its last frame, compared like the other goldens. Generate it with `UPDATE_GOLDENS=1` and look at it before committing. The line must visibly go around the islands.

- [ ] **Step 1: Write the tests.**
- [ ] **Step 2: Run** `UPDATE_GOLDENS=1 npm run test:e2e -- test/e2e/stage.test.ts`, then read the PNG and check the line stays at sea.
- [ ] **Step 3: Run** `npm run test:e2e`. Expected: PASS.
- [ ] **Step 4: Commit:** `git commit -m "test: sea routes end to end, with a golden frame"`

### Task 15: Docs

**Model:** Haiku 5.5 (`haiku`).

**Files:**
- Modify: `skills/mapper/SKILL.md`, `docs/plan.md`, `docs/superpowers/specs/2026-10-13-mapper-local-agent-design.md`, `README.md`

**Changes:**
- **SKILL.md:**
  - Replace "no GPX import yet" with an `import_gpx` step.
  - Add to "Shaping routes": sea legs route around land; if validation says a sea route failed or crosses land, add via points over open water. Air legs draw as flight arcs.
  - Add the follow camera: `camera.mode: 'follow'` and `camera.follow { zoom, orient, lookAhead (seconds), smoothing }`.
- **`docs/plan.md`:** mark stage 4 `(built)`.
- **Spec:** add "**Revision, 2026-10-15 (stage 4 decisions):**" after the stage 3 revision, with the bullets from "Stage 4 decisions" above. Update the Validation section to describe the overlap estimate, and the Camera section to say `lookAhead` is in seconds.
- **README:** one paragraph on sea routing, air arcs, follow and GPX, plus the Natural Earth credit with a link to `data/README.md`.

- [ ] **Step 1: Make the edits.**
- [ ] **Step 2: Commit:** `git commit -m "docs: stage 4 routes"`

### Final review

Run the whole-branch review with Opus 5.5 (`opus`) against this plan and the spec. Then run `npm test` and `npm run test:e2e` (one after the other) and `npm run typecheck`, and check one real render of `cruise()` at 1080p by eye.
