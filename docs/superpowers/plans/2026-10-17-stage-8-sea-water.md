# Stage 8 sea routes against OpenFreeMap water: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not begin implementation until the user approves this plan.

**Goal:** Sea routes stay off every island the basemap draws. Today the router finds its way against Natural Earth 10m, which leaves out most of the islands in archipelagos and draws solid land over real channels. A route through the Stockholm archipelago can cross islands the map shows, and `validate_project` doesn't see it.

**Done when:** a route through the Stockholm archipelago stays off every island the basemap draws, with a test that proves it. `npm test`, `MAPPER_NET=1 npm run test:e2e` and `npm run typecheck` all pass.

**Architecture:** The router stays pure. `core` learns a second kind of land, **tile land**: land pixels per zoom-12 tile, which override the Natural Earth rings wherever a tile is loaded. The server fetches OpenFreeMap tiles through the existing tile cache, decodes their `water` layer, rasterises it with `core`, and runs the router in rounds. Each round loads the tiles along the route it just found, and the rounds stop when the route lies wholly on loaded tiles. Paths are cached as today. A route worked out without the tiles (offline, say) is marked unverified, retried later and reported.

**Tech Stack:** TypeScript, Zod 4, Vitest, MapLibre GL 6.14.0 (unchanged), `@mapbox/vector-tile` 3.0.0 and `pbf` 5.1.2 (newly direct; already installed through MapLibre).

**Spec:** [Mapper design](../specs/2026-10-13-mapper-local-agent-design.md), with its revisions at the top, especially stage 4 (land data, sea routing) and stage 7 (warnings). Also read `AGENTS.md` and `docs/plan.md`. The decisions below come from the Stage 8 brainstorm. Where they differ from the spec they replace it, and Task 10 copies them into the spec.

## What the brainstorm found

A throwaway prototype (today's router, with its water grid fed from zoom-12 tile pixels, run in rounds) was tried on real routes. Scripts and output are in `/tmp/stage8-probe/` (`scripts/route.mts`, `scripts/check14.mts`). Don't import from there.

| Route | Natural Earth: land crossed | Prototype: land crossed | z12 tiles | Rounds | Tiles fetched | Tiles on disk |
|---|---|---|---|---|---|---|
| Stockholm–Sandhamn | no route (fallback) | 0 | 36 | 4 | – | 3.1 s |
| Stockholm–Mariehamn | 28 km | 0 | 135 | 5 | 6.2 s | – |
| Stockholm–Helsinki | 21 km | 0 | 586 | 10 | ~20 s | 4.7 s |
| Bergen–Geiranger | 65 km | 0 | 233 | 4 | 9.2 s | – |
| Greek Islands, per leg | 0–2.9 km | 0 | 37–46 | 1–2 | 0.9–2.1 s | 0.6 s |

- Land crossed is sampled every 10 m against zoom-12 water, outside each leg's first and last 2 km.
- **Checked against zoom 14** (the deepest tiles OpenFreeMap serves) every 5 m:
  - Natural Earth's Stockholm–Mariehamn route crosses land in 81 places, about 30 km in all.
  - The prototype crosses land once, for 210 m: the connector to a Mariehamn stop placed in town rather than on the quay.
- **Zoom-12 tiles miss very little.** In a 5.5 km² box near Vaxholm, zoom 12 misses 5 of zoom 14's 61 islands, all smaller than 50 × 50 m. Zoom 11 misses 18 and zoom 10 misses 26.
- **200 m fine cells close the real sounds** (Oxdjupet, Vaxholm). The stop then "snaps" to water 25 km away, and its straight connector crosses islands without a warning. 50 m cells keep them open.
- **Natural Earth alone at 50 m** takes 145–280 ms a route, against 50–100 ms at 200 m.
- **The water layer is small.** It averages 1.5 KB of a zoom-12 tile's ~9 KB (up to ~30 KB in cities). Decoding it takes about 1 ms a tile.

## Stage 8 decisions

- **Data source: OpenFreeMap's own vector tiles, zoom 12, `water` layer** (candidate (a) in the brief).
  - It's the data the basemap draws, from the same planet build, so the route and the map agree.
  - It carries the same credit every render already carries, and needs no new download.
  - **(b), Natural Earth plus land added from the tiles,** is rejected. It can add land but can never remove Natural Earth's false land, and Natural Earth draws solid land over the real Stockholm fairways (Stockholm–Sandhamn has no route on it at all).
  - **(c), OSM land polygons from osmdata.openstreetmap.de,** is rejected. They're only offered as one 928 MB worldwide download; the 24 MB simplified set is for low zooms. They'd also come from a different date than the basemap.
- **Water is exactly what the basemap paints as water.** That's every feature in the `water` layer except `brunnel: tunnel`, the same filter as the style's `water` layer.
  - Lakes, rivers and docks count, so a sea leg may follow a river to a port, or cross a lake that joins the sea.
  - A lake that doesn't join the sea stays unreachable, as today, because a stop snaps only to water that connects to the other end.
- **Natural Earth stays as the base.** It covers everywhere no tile is loaded: open ocean, and anywhere the rounds didn't reach. Inside a loaded tile, only the tile counts. `data/land-10m.bin` is unchanged.
- **Tile pixels:** 512 per side at zoom 12, about 10 m at 60° N and 19 m at the equator. A pixel is water when its centre lies inside a water feature (even-odd per feature, OR across features).
- **Grid cells read pixels conservatively.** A fully covered cell is land when any land pixel overlaps it, and all-land (`solid`) when every overlapping pixel is land. A cell partly covered by tiles is land when its ring result says land or any tile pixel is land.
- **Fine cells drop from 200 m to 50 m** (`FINE_KM = 0.05`). A tight stretch too long for one 2048-cell fine grid is cut into pieces, so cells never grow past 50 m.
- **Rounds.** The router runs; the server loads every zoom-12 tile within 2 km of the route, then runs it again. It stops when the route needs no tile it doesn't have.
  - At most 12 rounds.
  - A tile is loaded only when Natural Earth land lies within 20 km of it (the **coast filter**), so ocean crossings fetch tiles only near the coasts.
  - Every leg starts from no tiles. The set of tiles a route uses is then a function of its inputs and the planet build alone, and doesn't depend on what an earlier leg or route happened to load. Tile *bytes* still come from memory or disk when they're there.
- **OpenFreeMap's download rules** (openfreemap.org, read 2026-10-17): each download at most 3,000 tiles or 50 MB, at most 4 requests at once, and a User-Agent that names the app.
  - Router fetches use at most 4 requests at once.
  - One `resolveSeaPaths` call may fetch at most 2,500 new tiles. Past that, the legs still to route are routed without tiles and marked unverified (see below), and the next call carries on.
  - Every upstream request, studio map views included, sends `User-Agent: aloftandaway-mapper/<package version>`.
- **Determinism.**
  - A routed leg is cached in `.mapper/paths.json` and never routed again until its stops, via points or `ROUTER_VERSION` change. The studio, previews and renders all read that one entry, so they agree.
  - A new planet build doesn't re-route anything; new legs use the build current when they're routed. The entry records the build.
- **`ROUTER_VERSION` becomes 3.** Bump it whenever the routing code or its parameters change (cell sizes, rounds, buffer, coast filter), or the way water is read from tiles changes (zoom, pixels, the feature filter). A new planet build is not a reason. Bumping it drops every cached path, because the version is in each leg's key and in the cache file.
- **Offline or cold.**
  - If the tiles can't be had (no network, OpenFreeMap down, the budget used up, or 12 rounds without settling), the leg is routed with the tiles it did get, on Natural Earth elsewhere.
  - It is then **unverified**. The path says why (`unverified: 'offline' | 'budget' | 'unsettled'`), and the cache keeps it with a retry time 60 seconds on.
  - Any later call after that time routes it again. A studio left open on such a project retries every 60 seconds and pushes the new path when it arrives.
  - `validate_project` warns (`sea-unverified`), and a render that uses an unverified path finishes with a warning (Stage 7's channel).
  - Nothing hangs: tile requests keep the proxy's 30-second timeout and retries.
- **Validation uses the router's own land.** `crossesLand` is already worked out inside the router against the same grids, so it sees the tile land too. New warnings:
  - `sea-unverified`, worded by reason.
  - `sea-stop-far`: a stop more than 2 km from the water its route starts or ends in. That's how a route that couldn't reach the stop hides a long straight line across land, as in the 200 m prototype.
- **Credit.** A route drawn from OpenStreetMap data is a produced work under ODbL, so it needs the credit. Every style but `blank` already burns in `© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap`. **A `blank` scene with a sea leg now carries that map credit too**, burned in or written. A `blank` scene with no sea leg and no terrain still needs none.
- **New dependencies:**
  - `@mapbox/vector-tile` 3.0.0 (BSD-3-Clause) and `pbf` 5.1.2 (BSD-3-Clause) become direct dependencies, pinned to the versions `maplibre-gl` 6.14.0 already installs. `@mapbox/point-geometry` 1.1.0 (ISC) comes with them.
  - `@maplibre/vt-pbf` 4.3.2 (MIT, also already installed) becomes a pinned dev dependency, to build synthetic tiles in tests.
  - The install grows by nothing.
- **Test fixtures.** A script fetches the tiles the fixture routes need, keeps only their `water` layer, and commits them under `test/fixtures/sea-tiles/`.
  - Each layer is copied byte for byte out of the tile's protobuf, with no re-encoding.
  - That's about 300 tiles at about 1.5 KB each.
  - It's ODbL data, so the folder gets a README with the attribution and licence.
- **Tests never touch the network** unless `MAPPER_NET` is set. A new `MAPPER_TILE_UPSTREAM` setting points the tile cache at another server. Vitest sets it to an address that refuses connections (`http://127.0.0.1:9`), and tests that need tiles start a local fake that serves the fixtures.

## Global constraints

- Coordinates are `[lng, lat]` (GeoJSON order) everywhere in the public interface.
- `core` imports nothing else from the package and has no DOM, filesystem or network imports (`test/core/purity.test.ts`). MVT decoding lives in `server`; rasterising decoded rings lives in `core`.
- Every render carries the map credit for what it shows. Satellite uses EOxCloudless **2016** only.
- **Clean-room:** no Map Animator code, themes, icons, sign art, UI text or file format. **Public repo:** nothing private. The User-Agent names the app and its version only.
- **No data-source connectors.** Fetching basemap tiles for routing is map data, like the studio's own tiles. It is not trip data.
- Project files stay schema version 2. `paths.json` gets a new cache version; an old file is simply dropped.
- Defaults for new projects: 3840×2160, 25 fps, 16:9.
- Run `npm test` and `npm run test:e2e` one after the other, never together.
- **Any e2e failure, network or not:** save the full output to `/tmp/stage8-e2e-<YYYYMMDD-HHmmss>.log` before rerunning, and name the file in the report.
- Every task leaves `npm test` and `npm run typecheck` passing.

## Review focus

1. **Determinism.** One leg, routed twice with the same inputs and planet build, gives the same path. That holds whether the second run starts with an empty tile cache or with a memory cache full of unrelated tiles. Test: Task 4, "a warm cache of unrelated tiles doesn't change the route".
2. **Coverage seams.** A grid cell half on a loaded tile and half off it. A tile column across the antimeridian. Tile rows at the top and bottom of the Mercator square. None of them may open water where either source says land. Test: Task 2, "a cell across the coverage edge keeps the ring land" and "tile x wraps across 180°".
3. **Studio, preview and render agree.** A cached path that isn't unverified is never routed again. An unverified path that gets fixed reaches an open studio without an edit. Tests: Task 5, "a verified entry is never re-routed" and "an open studio gets the upgraded path".
4. **Offline behaves.** With no network, sea legs still come back routed (on Natural Earth), flagged unverified. Nothing waits past the request timeouts. A project isn't re-routed more than once a minute. Test: Task 5, "offline routes come back unverified and aren't retried within a minute".
5. **OpenFreeMap's rules.** At most 4 router requests at once. A User-Agent on every request. At most 2,500 new tiles per resolve. Test: Task 4, "router fetches stay within OpenFreeMap's download rules".
6. **The done-when proof is independent.** The Stockholm test checks the path against the tiles' own polygons (point in polygon on the decoded zoom-14 geometry), not against the router's pixels. Test: Task 7.

---

## Starting point

- **Branch:** `stage-8-sea-water` in the worktree `.claude/worktrees/stage-8-sea-water`, from `main` at `6a7c4cb` or later.
- **Baseline:** `npm test` passes 913 tests; `MAPPER_NET=1 npm run test:e2e` passes 173.

## Files

| File | Responsibility |
|---|---|
| `src/core/land.ts` | `TileLand`, `LandTile`, `rasteriseTile`, `withTiles` |
| `src/core/water.ts` | Tile pixels override the rings in `waterGridAt` |
| `src/core/coverage.ts` (new) | `tilesNear`: the tiles a route needs |
| `src/core/sea.ts` | 50 m fine cells, split fine grids, smooth joins, `unverified`, `stopGapKm`, `ROUTER_VERSION = 3` |
| `src/core/validate.ts`, `src/core/credit.ts` | `sea-unverified`, `sea-stop-far`; the map credit for `blank` with a sea leg |
| `src/server/tiles.ts` | A shared tile store under the proxy; User-Agent; download-rule limits |
| `src/server/sea-water.ts` (new) | Decode the `water` layer, keep tile pixels in memory, route in rounds |
| `src/server/paths.ts`, `src/server/server.ts` | Unverified entries, retries, pushing upgrades to the studio; `MAPPER_TILE_UPSTREAM` |
| `src/render/render.ts`, `src/render/preview.ts`, `src/mcp/tools.ts`, `src/cli/doctor.ts` | Warnings for unverified paths; a doctor line |
| `scripts/build-sea-fixtures.ts` (new), `test/fixtures/sea-tiles/` (new) | Water-only fixture tiles |
| `test/helpers/fake-tiles.ts` (new), `vitest.config.ts` | A local fake upstream; no network in tests |
| `bench/sea-route.ts` (new), `package.json` | `npm run bench:sea`; dependencies |
| `README.md`, `skills/mapper/SKILL.md`, `data/README.md`, `docs/plan.md`, spec | Docs |

---

### Task 1: One tile store, the User-Agent, no network in tests

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Modify: `src/server/tiles.ts`, `src/server/server.ts` (`getServer`, `startServer` options), `vitest.config.ts`, `package.json` (dependencies)
- Create: `test/helpers/fake-tiles.ts`
- Test: `test/server/tiles.test.ts`

**Interfaces:**
- Produces, in `src/server/tiles.ts`:
  - `createTileStore(opts: { cacheDir: string; upstream?: string; retryDelaysMs?: number[] }): TileStore`.
  - `TileStore.get(subpath: string, opts?: { use: 'view' | 'download' }): Promise<{ status: number; body: Buffer; contentType?: string }>`. This is today's `obtain` (disk cache, in-flight sharing, retries).
    - `'view'` (the proxy) keeps today's 6 requests at once.
    - `'download'` (the router) has its own limit of 4. Both share the disk cache and the in-flight map.
  - `TileStore.planetBuild(): Promise<string>`: the build segment of the TileJSON's tile URL, for example `20261011_080001_pt`. It reads the cached TileJSON (24 h, as today).
  - `tileStore(opts)`: one store per `(cacheDir, upstream)` in a process, so the proxy and the router share one.
  - `createTileProxy` is rebuilt on `tileStore`. Its behaviour and tests don't change.
  - `USER_AGENT = 'aloftandaway-mapper/' + <package.json version>`, sent on every upstream fetch.
- Produces, in `server.ts`: `getServer()` and the router read `MAPPER_TILE_UPSTREAM` (default OpenFreeMap) as the proxy's `upstream`.
- Produces, in `test/helpers/fake-tiles.ts`: `startFakeTiles(dir: string): Promise<{ url: string; requests: string[]; inFlightMax: number; close(): Promise<void> }>`. It serves `planet` (a TileJSON whose tile URL is `<url>/planet/<build>/{z}/{x}/{y}.pbf`) and `planet/<build>/z/x/y.pbf` from `dir/<build>/z/x/y.pbf` (204 when missing). It records each request and its User-Agent, and the most requests it had open at once.
- `vitest.config.ts`: both projects set `env.MAPPER_TILE_UPSTREAM = 'http://127.0.0.1:9'` unless `MAPPER_NET` is set.
- `package.json`: add `"@mapbox/vector-tile": "3.0.0"` and `"pbf": "5.1.2"` to dependencies, and `"@maplibre/vt-pbf": "4.3.2"` to devDependencies, exact versions. `npm ls` shows them deduped with `maplibre-gl`'s.

- [ ] **Step 1: Write the failing tests** in `tiles.test.ts`:
  - `every upstream request sends the Mapper User-Agent` (view and download)
  - `download use opens at most 4 requests at once` (ask for 12 tiles from a slow fake; `inFlightMax` is 4)
  - `view and download share the disk cache and one in-flight fetch`
  - `planetBuild reads the build from the TileJSON`
- [ ] **Step 2:** Run `npx vitest run test/server/tiles.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Keep the proxy's `ALLOWED` paths and its error replies exactly as they are.
- [ ] **Step 4:** `npm test` and `npm run typecheck` PASS. Run `npm ls @mapbox/vector-tile pbf @maplibre/vt-pbf` and paste the output into the report.
- [ ] **Step 5: Commit:** `git commit -m "feat: one tile store for the proxy and the router; Mapper User-Agent; tests stay offline"`

### Task 2: Tile land in core

**Model:** Opus 5.5 (`opus`). Rasterising and the coverage maths.

**Files:**
- Modify: `src/core/land.ts`, `src/core/water.ts`, `src/core/index.ts`
- Test: `test/core/tile-land.test.ts` (new), `test/core/water.test.ts`

**Interfaces:**
- Produces, in `src/core/land.ts`:
  - `WATER_ZOOM = 12` and `TILE_PIXELS = 512`.
  - `interface TileFeature { rings: { x: number; y: number }[][] }`, in tile units (0 to `extent`), y down. Ring orientation doesn't matter.
  - `interface LandTile { landIn(c0: number, r0: number, c1: number, r1: number): number }`: the number of land pixels in the inclusive pixel rectangle, clamped to the tile.
  - `rasteriseTile(features: TileFeature[], extent: number, pixels = TILE_PIXELS): LandTile`.
    - A pixel is water when its centre is inside any feature (even-odd within a feature, OR across features). Geometry outside the tile square (the buffer) is ignored.
    - Storage: one bit per pixel, plus land counts per 8 × 8 block in a summed-area table, so `landIn` touches only the rectangle's edge blocks bit by bit. That's about 50 KB a tile.
    - `allLand()` and `allWater()` constants for empty and full tiles.
  - `interface TileLand { zoom: number; pixels: number; tile(x: number, y: number): LandTile | undefined }`. `x` is wrapped into 0 to 2^zoom − 1 by the implementation; `y` outside the square gives undefined.
  - `LandSource` gains `tiles?: TileLand`.
  - `withTiles(base: LandSource, tiles: TileLand, version: string): LandSource` keeps `ringsIn` and answers `isLand` from a loaded tile's pixel, falling back to `base.isLand`.
- Produces, in `src/core/water.ts`: `waterGridAt` overlays `land.tiles` after rasterising the rings and before `coastCost`, by the rules in "Stage 8 decisions":
  - Fully covered cell: land = any land pixel overlaps it; `solid` = every overlapping pixel is land.
  - Partly covered cell: land = ring land OR any tile land pixel; `solid` = ring solid AND every covered pixel is land.
  - Uncovered cell: unchanged.
  - A pixel overlaps a cell when their squares overlap with positive area.

- [ ] **Step 1: Write the failing tests** in `tile-land.test.ts`:
  - `a pixel is water when its centre is in a water feature`
  - `a hole in a water feature is land` (an island)
  - `overlapping water features are still water` (OR, not even-odd across features)
  - `geometry in the tile buffer is ignored`
  - `landIn counts match a brute-force count` (random rectangles over a random mask, 200 cases)
  - `an island one pixel wide closes the cell it is in`
  - `a cell across the coverage edge keeps the ring land` (ring land in the uncovered half, tile water in the covered half: the cell is land, and not solid)
  - `tile x wraps across 180°` (a grid at x 0.999 to 1.001 reads tiles 4095 and 0)
  - `rows above and below the Mercator square have no tiles`
  - `with no tiles the grid is exactly today's` (the existing `water.test.ts` cases, run once more through `withTiles` with an empty `TileLand`, give identical masks)
- [ ] **Step 2:** Run `npx vitest run test/core/tile-land.test.ts test/core/water.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. `test/core/purity.test.ts` still passes.
- [ ] **Step 4:** `npm test` and `npm run typecheck` PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat(core): tile land overrides Natural Earth in the water grid"`

### Task 3: The router at 50 m; the tiles a route needs

**Model:** Opus 5.5 (`opus`). Routing maths.

**Files:**
- Modify: `src/core/sea.ts`, `src/core/index.ts`
- Create: `src/core/coverage.ts`
- Test: `test/core/sea.test.ts`, `test/core/coverage.test.ts` (new)

**Interfaces:**
- Produces, in `src/core/sea.ts`:
  - `ROUTER_VERSION = 3`, with a comment saying when to bump it (the "Stage 8 decisions" rule).
  - `FINE_KM = 0.05`.
  - Long tight stretches cut into several fine grids, so the fine cell never exceeds `FINE_KM` because of `MAX_FINE_SIDE`. Pieces overlap by `FINE_MARGIN` coarse cells and join on a shared water point.
  - `SeaPath` gains:
    - `unverified?: 'offline' | 'budget' | 'unsettled'`. The router never sets it; the server does.
    - `stopGapKm?: [number, number]`: the straight distance from each stop to the water point its route starts or ends at. It's 0 when the stop is in water.
- Produces, in `src/core/coverage.ts`:
  - `tilesNear(path: LngLat[], opts: { zoom: number; bufferKm: number; coast?: LandSource; coastKm?: number }): string[]`.
    - Returns the tile keys `"x/y"` (x wrapped) that lie within `bufferKm` of the polyline, sorted.
    - With `coast`, it keeps only tiles whose square, grown by `coastKm`, meets one of `coast`'s rings.
    - The polyline is sampled at no more than `bufferKm / 2` spacing, with `bufferKm` converted at each sample's latitude.
- **Joins without kinks.** The prototype's 50 m route has small hooks where a fine piece meets an open stretch (visible near Vaxholm in the brainstorm frames). The joins must not double back.

- [ ] **Step 1: Write the failing tests:**
  - `coverage.test.ts`:
    - `tilesNear covers every tile within the buffer` (brute force over a small polyline)
    - `tilesNear wraps x at 180°`
    - `the coast filter drops open-ocean tiles` (a mid-Atlantic segment gives none; one off Southampton gives some)
  - `sea.test.ts`:
    - Every existing test still passes on Natural Earth alone. `routes Barcelona to Marseille in under 1.5 s` keeps its bound.
    - `a 150 m channel stays open at 50 m cells` (synthetic tile land: two islands with a 150 m gap between the stops; the route goes through the gap and `stopGapKm` is under 0.1)
    - `a long tight stretch keeps 50 m cells` (a synthetic 120 km channel 200 m wide: routed, and never on land)
    - `routes don't double back` (on every `ports` leg and the Greek legs, no two consecutive 100 m steps outside connectors and via points turn by more than 120°)
    - `stopGapKm is the distance to the first water point`
- [ ] **Step 2:** Run `npx vitest run test/core/sea.test.ts test/core/coverage.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Keep the public behaviour of `routeSea` (knots exactly on controls, fallback reasons) unchanged.
- [ ] **Step 4:** `npm test` and `npm run typecheck` PASS. Report the timings of the `ports` legs at 200 m and at 50 m.
- [ ] **Step 5: Commit:** `git commit -m "feat(core): 50 m fine cells, split fine grids, smooth joins; tilesNear; router version 3"`

### Task 4: Routing against OpenFreeMap water, in rounds

**Model:** Opus 5.5 (`opus`). The data pipeline, determinism and budgets.

**Files:**
- Create: `src/server/sea-water.ts`
- Test: `test/server/sea-water.test.ts` (new)

**Interfaces:**
- Consumes: `tileStore` (Task 1), `rasteriseTile`, `withTiles`, `tilesNear` (Tasks 2–3), `routeSea`.
- Produces, in `src/server/sea-water.ts`:
  - `interface SeaBudget { tiles: number }`. One per `resolveSeaPaths` call; the default is 2,500 new fetches.
  - `createSeaWater(opts: { store: TileStore; maxRounds?: number; bufferKm?: number; coastKm?: number; cacheTiles?: number }): SeaWater`. Defaults: 12 rounds, 2 km buffer, 20 km coast filter, 1,500 tiles in memory (least recently used dropped).
  - `SeaWater.route(from: LngLat, to: LngLat, via: ViaPoint[], base: LandSource, budget: SeaBudget): Promise<SeaPath & { water: WaterNote }>`.
    - `WaterNote` is `{ build: string; tiles: number; rounds: number }` when verified, or `{ unverified: 'offline' | 'budget' | 'unsettled' }`.
  - `seaWater()`: the process's one instance, on `tileStore({ cacheDir: MAPPER_CACHE_DIR or ~/.cache/mapper, upstream: MAPPER_TILE_UPSTREAM })`.
  - `SEA_WATER_VERSION`: a string folded into the land version, such as `ofm-z12-p512-v1`.
- **Decoding:** `new VectorTile(new PbfReader(bytes)).layers.water`, skipping `brunnel === 'tunnel'`. A tile with no `water` layer (or a 204, or an empty body) is all land, unless Natural Earth says its centre is sea; then it's all water. Open-sea tiles normally carry an ocean polygon, so the second case is a safety net. Decoded pixels are kept by `build/z/x/y`.
- **The rounds:**
  1. Read the build (`store.planetBuild()`). On failure, return the Natural Earth route, `unverified: 'offline'`.
  2. `S = ∅`. Route on `base`. If that falls back, the seed polyline is the straight lines between the controls.
  3. Up to `maxRounds` times:
     - `need = tilesNear(path, { zoom: 12, bufferKm, coast: base, coastKm })` minus `S`. If it's empty, stop: verified.
     - Fetch `need` with `use: 'download'`, charging the budget. On a fetch failure or an empty budget, stop: route with `S`, `unverified: 'offline'` or `'budget'`.
     - `S ∪= need`; route on `withTiles(base, S)`.
  4. Rounds used up: `unverified: 'unsettled'`.

- [ ] **Step 1: Write the failing tests** with synthetic tiles built by `@maplibre/vt-pbf` and served by `startFakeTiles`:
  - `an island only the tiles have is avoided` (Natural Earth sea, a tile island across the straight line: the route goes round, and `crossesLand` is unset)
  - `a channel only the tiles have is used` (Natural Earth land across a channel the tiles show as water, at the tile's centre: the route goes through)
  - `the rounds stop when the route needs no new tile`
  - `a warm cache of unrelated tiles doesn't change the route` (route, load 200 other tiles into memory, route again on a fresh `SeaWater` and on the warm one: identical paths)
  - `router fetches stay within OpenFreeMap's download rules` (`inFlightMax` ≤ 4, the User-Agent on every request, and a budget of 10 stops at 10 with `unverified: 'budget'`)
  - `offline gives the Natural Earth route, unverified` (upstream refuses connections)
  - `a tunnel is not water`
  - `a tile with no water layer is land inland and water at sea`
- [ ] **Step 2:** Run `npx vitest run test/server/sea-water.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` and `npm run typecheck` PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat(server): route sea legs against OpenFreeMap water in rounds"`

### Task 5: Cache, retries, and the studio

**Model:** Opus 5.5 (`opus`). Caching, concurrency and recovery.

**Files:**
- Modify: `src/server/paths.ts`, `src/server/server.ts` (`seaPathsFor`, `reload`, the studio sockets), `src/mcp/tools.ts` (only if a signature changes)
- Test: `test/server/paths.test.ts`, `test/server/server.test.ts`

**Interfaces:**
- Produces, in `paths.ts`:
  - `resolveSeaPaths(folder, project, opts: { land?: LandSource; water?: SeaWater; now?: () => number })`, still returning `SeaPaths`.
  - Legs route through `water.route` with one `SeaBudget` per call. A test may pass `water: undefined` to route on `land` alone, as today.
  - `CACHE_VERSION = 2`. `land` in the file is `<base version>+<SEA_WATER_VERSION>`.
  - Entries keep `water` (the `WaterNote`). An unverified entry also keeps `retryAt` (an ISO time 60 s on).
  - A verified entry is used as is. An unverified entry is used until `retryAt`; the first call after that routes it again and saves the result.
- Produces, in `server.ts`:
  - While a studio socket is open on a project whose current paths include an unverified one, the server calls `seaPathsFor` every 60 s.
  - When any path changes, it sends the studio a `project` message, with no `origin`, so undo history isn't cleared for nothing. Check the studio: a message with the same `updatedAt` and new `seaPaths` must update the drawn route without clearing undo. If it would clear undo, add an `origin: 'paths'` that the studio treats as its own; describe the change in the report.
  - Timers stop when the last socket for the project closes, and on `close()`.

- [ ] **Step 1: Write the failing tests:**
  - `paths.test.ts`:
    - `a verified entry is never re-routed` (a second resolve with a `water` that throws if called)
    - `offline routes come back unverified and aren't retried within a minute` (fake clock: calls at 0 s and 30 s route once; a call at 61 s routes again)
    - `an upgraded entry replaces the unverified one`
    - `a cache file from router version 2 is dropped`
    - `one resolve shares one budget across legs`
  - `server.test.ts`:
    - `an open studio gets the upgraded path` (a fake `SeaWater` that's offline, then online; the socket receives new `seaPaths` within one retry period, using the fake clock or a short period option)
    - `the retry timer stops when the studio closes`
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Keep `inOrder` (one resolve at a time per folder).
- [ ] **Step 4:** `npm test` and `npm run typecheck` PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat(server): unverified sea paths are retried and reach an open studio"`

### Task 6: Fixture tiles

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Create: `scripts/build-sea-fixtures.ts`, `test/fixtures/sea-tiles/README.md`, `test/fixtures/sea-tiles/<build>/12/...` and `.../14/...`
- Modify: `package.json` (`build:sea-fixtures` script), `data/README.md` (one paragraph pointing to the fixtures)

**Behaviour:**
- `npm run build:sea-fixtures` routes the fixture legs with the real `SeaWater`, through a recording store, on live OpenFreeMap. It writes every zoom-12 tile used, plus every zoom-14 tile within 300 m of each final path.
  - Each tile is written as its `water` layer only, copied byte for byte out of the tile's protobuf (repeated field 3, the message whose name is `water`). That's a valid MVT with one layer.
  - It also writes `test/fixtures/sea-tiles/manifest.json`: the build, the legs and their stops, and the tile counts.
- **Fixture legs:**
  - Stockholm, Stadsgården quay `[18.087, 59.317]` → Sandhamn harbour `[18.9105, 59.288]`.
  - Stockholm, Stadsgården → Mariehamn, Västra hamnen `[19.925, 60.0935]`.
  - The three `greekIslands()` legs.
  - Check each stop lies within 150 m of zoom-14 water and adjust it to the quay if not. Record the final coordinates in the manifest and in Task 7.
- **The README** says what the files are, how they're built, and their licence: OpenStreetMap data, ODbL 1.0, © OpenStreetMap contributors, via OpenMapTiles and OpenFreeMap. Link the ODbL text.
- **Budget:** the folder stays under 1 MB. If it doesn't, stop and report the size.

- [ ] **Step 1:** Write the script. **Step 2:** Run it with network. **Step 3:** Check the size and the manifest.
- [ ] **Step 4:** `git add` the folder. `npm test` and `npm run typecheck` PASS.
- [ ] **Step 5: Commit:** `git commit -m "test: water-only OpenFreeMap fixture tiles for the archipelago and Greek routes"`

### Task 7: The Stockholm proof and the regression check

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Create: `test/server/archipelago.test.ts`
- Modify: `test/e2e/routes.test.ts`, `test/e2e/mcp.test.ts` (fake upstream for any sea leg)
- Test: those files

**Tests:**
- `archipelago.test.ts` (unit, offline), with `startFakeTiles` serving the fixtures:
  - **`Stockholm to Sandhamn stays off every island the basemap draws`.**
    - Route with `seaWater` on the fixtures. Expect `ok`, verified, no `crossesLand`, and both `stopGapKm` under 0.15.
    - Then sample the whole drawn path every 5 m. Skip only the first and last `stopGapKm` + 20 m.
    - Check each sample by point in polygon against the decoded **zoom-14** fixture geometry: even-odd per feature, OR across features, tunnels excluded, written in the test and not taken from `rasteriseTile`.
    - Expect no sample on land. On failure, print the first ten land samples.
  - **`Stockholm to Mariehamn stays off every island the basemap draws`**: the same.
  - **`Natural Earth alone crosses the archipelago`**: the same check on the Natural Earth route for Stockholm–Mariehamn finds land. This proves the check can fail.
  - **`greekIslands sea legs keep their shape and stay at sea`**:
    - Each leg is verified, with no `crossesLand`, and its zoom-12 point-in-polygon check is clean.
    - Its length is within 10% of the Natural Earth route's.
    - The midpoint of each leg is within 15 km of the Natural Earth route's midpoint.
- `routes.test.ts` and `mcp.test.ts`: the MCP child gets `MAPPER_TILE_UPSTREAM` pointing at a fake serving the fixtures. Existing assertions hold; update any that pin path lengths, and say which in the report.
- `routes.test.ts`, inside the `MAPPER_NET` block: **`a live Stockholm–Mariehamn route stays off zoom-14 islands`**. The same check, with zoom-14 tiles fetched live through the tile store.

- [ ] **Step 1:** Write the tests. **Step 2:** `npx vitest run test/server/archipelago.test.ts`. Expected: PASS on Tasks 2–6. A failure is a bug; report it before changing anything.
- [ ] **Step 3:** `npm run build`, then the e2e files, with and without `MAPPER_NET=1`. PASS.
- [ ] **Step 4: Commit:** `git commit -m "test: Stockholm archipelago routes stay off every island; Greek Islands regression"`

### Checkpoint: before/after frames

The controller renders, at 1920 px, `preview_frame` at progress 1 for Stockholm–Mariehamn (whole route, and the fixed Vaxholm shot: centre `[18.36, 59.43]`, zoom 10.9) and `greekIslands()` as sea legs. They go into `/tmp/stage8-check/`, next to the brainstorm frames in `/tmp/stage8-probe/out/jpg/`. Show the user the pairs. Carry on only when they agree.

### Task 8: Validation, credit, render warnings, doctor

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Modify: `src/core/validate.ts`, `src/core/credit.ts`, `src/render/render.ts`, `src/render/preview.ts`, `src/render/warnings.ts`, `src/mcp/tools.ts`, `src/cli/doctor.ts`
- Test: `test/core/validate.test.ts`, `test/core/credit.test.ts`, `test/render/warnings.test.ts`, `test/cli/doctor.test.ts`, `test/mcp/tools.test.ts`

**Interfaces and wording:**
- `sea-unverified` (warning, path `['legs', i]`):
  - `offline`: "Leg 2's sea route was checked against Natural Earth only, because OpenFreeMap couldn't be reached. It may cross small islands." Fix: "Reconnect to the internet; Mapper routes the leg again by itself within a minute. Then validate again."
  - `budget`: "…because the project needed more map tiles at once than Mapper fetches in one go." Fix: "Validate again in a minute; Mapper carries on where it stopped."
  - `unsettled`: "…because the route kept finding new islands." Fix: "Add a via point over open water with insert_via to steer it."
- `sea-stop-far` (warning, path `['stops', k]`): "Stockholm is 4.2 km from the water its sea route starts in, so the line crosses land to reach it." Fix: "Move the stop to the quay with update_stop, or add a via point at the harbour mouth with insert_via." The threshold is 2 km, from `stopGapKm`.
- `sceneCredit`: a `blank` scene with any `sea` leg includes `MAP_CREDIT`, burned in and written.
- **Render:** each unverified path in a picked scene adds one warning line: `Leg 2: the sea route was checked against Natural Earth only (OpenFreeMap couldn't be reached), so it may cross small islands.` Scene labels as Stage 7's warnings use them. `preview_frame` and `preview_contact_sheet` show it too.
- **Doctor:** a `Sea water` line. It's OK when the TileJSON can be read through the tile store, and the detail names the build. When it can't, it's a warning, not a failure: "OpenFreeMap couldn't be reached; sea routes will be checked against Natural Earth only until it can."

- [ ] **Step 1: Write the failing tests:** one per warning and reason, `a blank scene with a sea leg carries the map credit`, `a blank scene without a sea leg still has no credit`, `an unverified path adds one render warning per leg`, `a clean render still has no warnings line`, and the doctor line, online and offline.
- [ ] **Step 2:** Run them. Expected: FAIL. **Step 3:** Implement. **Step 4:** `npm test` and `npm run typecheck` PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat: sea-unverified and sea-stop-far warnings; map credit for blank sea scenes; render and doctor lines"`

### Task 9: Bench

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Create: `bench/sea-route.ts`
- Modify: `package.json` (`bench:sea`), `docs/render-speed.md` (a "Sea routing" section)

**Behaviour:**
- `npm run bench:sea` routes the five brainstorm routes (Stockholm–Sandhamn, Stockholm–Mariehamn, Stockholm–Helsinki, Bergen–Geiranger, Piraeus–Mykonos) in three passes:
  - cold: an empty temp cache dir, live OpenFreeMap;
  - disk: the same cache dir, a fresh process state;
  - memory: the same `SeaWater` again.
- It prints tiles, rounds and seconds per route and pass. Without network it says so and exits 0.
- **Budgets:**
  - Stockholm–Mariehamn from disk ≤ 6 s; Stockholm–Helsinki from disk ≤ 10 s on the user's Mac.
  - If either is over, profile it (rounds against routing against decoding) and report before tuning.
  - Tuning `bufferKm` or `maxRounds` is a `ROUTER_VERSION`-level change only before release, so it's free in this branch.

- [ ] **Step 1:** Write the bench. **Step 2:** Run it with network; paste the table into `docs/render-speed.md` with the date and machine.
- [ ] **Step 3: Commit:** `git commit -m "bench: sea routing cold, from disk and from memory"`

### Task 10: Docs and the spec revision

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Modify: `README.md` (`:69-78`), `skills/mapper/SKILL.md` (`:63-67`, `:80`, `:331-332`), `data/README.md`, `docs/plan.md` (row 8), `docs/superpowers/specs/2026-10-13-mapper-local-agent-design.md` (top revisions, "Routing", "Validation", "Error handling summary", "Testing", "Build stages")

**Changes:**
- **README and SKILL.md:**
  - Sea legs route over the water the basemap draws: OpenFreeMap tiles near the coast, Natural Earth on the open sea.
  - The first route through an archipelago fetches map tiles and can take several seconds, up to about 20 s for a long one; after that it's cached.
  - Offline, a route is checked against Natural Earth only and flagged `sea-unverified` until Mapper can reach OpenFreeMap.
  - The new warnings. A stop belongs on the quay, not in the town centre.
  - `blank` with a sea leg carries the map credit (SKILL.md `:331`).
- **`data/README.md`:** a "Sea water" section with the source, zoom, pixel rule, feature filter, the download rules followed, the User-Agent, and the credit. Natural Earth's section says it is now the base for open water.
- **`docs/plan.md`:** row 8 becomes (built), with what was built in the row's words.
- **Spec:**
  - Add "**Revision, 2026-10-17 (stage 8 decisions):**" with the bullets from "Stage 8 decisions".
  - Rewrite the `sea` bullet in "Routing" for tile land, rounds and 50 m cells.
  - Add `sea-unverified` and `sea-stop-far` to "Validation".
  - Add "OpenFreeMap unreachable → Natural Earth route, flagged, retried" to the error table.
  - Add the archipelago proof to "Testing".
  - Mark stage 8 (built) in "Build stages".

- [ ] **Step 1:** Make the edits. **Step 2:** `grep -rn "Natural Earth" README.md skills docs/superpowers/specs`. Each hit describes the base or open water correctly. **Step 3: Commit:** `git commit -m "docs: stage 8 sea routes against OpenFreeMap water"`

### Final review

- **Review:** run the whole-branch review with Opus 5.5 (`opus`) against this plan and the spec, with the "Review focus" list. If Opus fails twice with an API error, stop and tell the user rather than dropping to Sonnet.
- **Suite:** then `npm test`, `MAPPER_NET=1 npm run test:e2e` (one after the other) and `npm run typecheck`.
- **Hand over:** the user's end-to-end test.
  - The controller makes a project in `/tmp/stage8-e2e-check/` with two scenes. "Archipelago" is Stockholm (Stadsgården) → Vaxholm → Sandhamn → Mariehamn as cruise-ship sea legs on `aloftandaway`, with a follow camera. "Islands" is `greekIslands()` as ferry sea legs on `blank`.
  - It renders a flattened 1080p MP4 with `MAPPER_NET=1`.
  - The user watches it for any line over an island, and checks the burned credit on the `blank` scene.
  - Then they open the studio offline (Wi-Fi off), add a via point, and see the `sea-unverified` warning. Wi-Fi back on, the warning clears within a minute without an edit.
- **After the user's check:** fix rounds before merge, if any.
