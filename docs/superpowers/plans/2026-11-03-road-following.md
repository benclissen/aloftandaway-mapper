# Road-following land legs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `land` legs follow real roads, cycle routes or footpaths, routed by the public FOSSGIS OSRM server and cached per project.

**Architecture:** Pure path building lives in `src/core/road.ts`. Road paths travel to `buildRoute` in the existing `SeaPaths` lookup under `road:` keys, beside sea paths and `track:` entries. A new OSRM client (`src/server/roads.ts`) and cache resolver (`src/server/road-paths.ts`) fill them. `resolvePaths` merges sea and road paths for every caller.

**Tech Stack:** TypeScript (Node 26), Vitest, React studio, MapLibre. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-03-road-following-design.md`

## Global Constraints

- Branch `feat/road-following`. Commit after each task, ending messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `src/core` stays pure: no `fs`, `path`, `http`, `maplibre-gl`, `react`, `ws` (`test/core/purity.test.ts`).
- Coordinates are `[lng, lat]` everywhere.
- Public repo: no keys, no private URLs. Clean-room rules in `AGENTS.md` apply.
- Default router template: `https://routing.openstreetmap.de/routed-{profile}/route/v1/driving`, overridden by `MAPPER_ROAD_ROUTER`.
- At most 1 request a second per process; 15 s timeout; `User-Agent: ${USER_AGENT} (+https://github.com/benclissen/aloftandaway-mapper)` where `USER_AGENT` comes from `src/server/tiles.ts`.
- Simplify tolerance 3 m; stop-far threshold 0.5 km; offline retry 60 s (`OFFLINE_MS`); no-route retry 24 h; cache keeps the newest 200 entries.
- Unit and e2e tests never reach the real router unless `MAPPER_NET=1`.
- Written credit line, exact: `Road routes: OSRM on OpenStreetMap data, routing.openstreetmap.de (FOSSGIS)`.
- Run `npm run typecheck` and `npm test` before each commit. Don't run `npm test` and `npm run test:e2e` at the same time.

## Review Focus

1. **A port stop placed on the water.** The router snaps it to the nearest road, possibly 1 km or more away. Expect an `ok` route with a long join and a `road-stop-far` warning, never a fallback. Test: Task 1 `roadPath keeps a far stop as a join`, Task 3 `warns road-stop-far once per stop`.
2. **A route that passes the same place twice** (an out-and-back walk with a via at the far end). Via knots must be found in travel order, not at the first nearby vertex. Test: Task 1 `roadPath finds via knots in order on an out-and-back route`.
3. **Dragging via points quickly in the studio.** Several resolves queue up. Requests must stay 1 s apart, and each must answer its own call. Test: Task 4 `spaces requests at least minIntervalMs apart`.
4. **A corrupt or old `roads.json`** after a crash or upgrade. It is dropped and rebuilt, never thrown. Test: Task 5 `drops a corrupt or other-version cache`.
5. **Changing the project's default transport (`look.symbol`) from car to walk.** Every land leg without its own symbol must reroute on foot. Test: Task 1 `roadLegsOf follows look.symbol`.

---

### Task 1: Core road paths (`src/core/road.ts`)

**Model:** opus (geometry: knots, unwrapping, segment-wise simplification)

**Files:**
- Create: `src/core/road.ts`
- Modify: `src/core/sea.ts:83-93` (export the hash), `src/core/index.ts` (export `road.js`)
- Test: `test/core/road.test.ts`

**Interfaces:**
- Consumes: `simplify(xy: XY[], tolerance: number): number[]` from `src/core/gpx.ts`. Also `toXY`, `toLngLat`, `unwrapLng`, `haversineKm` from `geo.ts`, `kmPerUnit` from `water.ts`, and `SeaPath`, `SeaPaths` from `sea.ts`.
- Produces:
  - `type RoadProfile = 'car' | 'bike' | 'foot'`
  - `const ROAD_VERSION = 1`, `const ROAD_SIMPLIFY_M = 3`, `const ROAD_STOP_FAR_KM = 0.5`
  - `const ROAD_OFFLINE = "the road router couldn't be reached"`, `const NO_ROAD_ROUTE = 'there is no road route between its stops'`
  - `roadProfile(symbol: SymbolKind): RoadProfile | undefined`
  - `legProfile(leg: { mode: LegMode; symbol?: SymbolKind }, look: { symbol: SymbolKind }): RoadProfile | undefined`, which is undefined unless `mode === 'land'`
  - `roadLegKey(profile: RoadProfile, from: LngLat, to: LngLat, via: ViaPoint[]): string`, giving `road:` plus 16 hex digits
  - `interface RoadLeg { profile: RoadProfile; from: LngLat; to: LngLat; via: LngLat[] }`
  - `roadLegsOf(project: Project): Map<string, RoadLeg>`, covering scenes and contexts
  - `interface OsrmAnswer { code: string; routes?: { geometry: { coordinates: LngLat[] } }[]; waypoints?: { location: LngLat }[] }`
  - `roadPath(answer: OsrmAnswer, from: LngLat, to: LngLat, via: LngLat[]): SeaPath`, which returns `status: 'ok'` with `stopGapKm` set
  - `fnv1a64(text: string): string` (exported from `sea.ts`; `seaLegKey` now calls it)

- [ ] **Step 1: Write the failing tests** in `test/core/road.test.ts`:
  - `roadProfile maps every symbol`: `walk` gives `foot`, `bike` gives `bike`; `train`, `tram` and `cable-car` give `undefined`; every other entry of `SYMBOLS` gives `car`.
  - `legProfile is undefined off land`: `{ mode: 'line', symbol: 'car' }` gives `undefined`; `{ mode: 'land' }` with look `walk` gives `foot`; a leg symbol beats the look.
  - `roadLegKey changes with each input and ignores sharp`: the key starts with `road:` and matches `/^road:[0-9a-f]{16}$/`. Changing the profile, from, to or a via `at` changes it. Toggling a via's `sharp` doesn't.
  - `roadLegsOf follows look.symbol`: a scene with one `land` leg and no leg symbol yields a car key for look `car`. Changing the look to `walk` yields a different key with profile `foot`. A context `land` leg is included, using the scene's look. `line` and `sea` legs are not included.
  - `roadPath adds joins and pins the stops`: from `[0, 0]`, to `[0.01, 0]`, geometry `[[0, 0.001], [0.005, 0.001], [0.01, 0.001]]`. Expect `path[0]` to equal from and `path.at(-1)` to equal to, `knots` to be `[0, path.length - 1]`, and both `stopGapKm` values to be about 0.111 (to 2 decimals).
  - `roadPath keeps a far stop as a join`: from is 1.2 km off the first geometry point. Expect `status 'ok'` and `stopGapKm[0] > 1.1`.
  - `roadPath finds via knots in order on an out-and-back route`: geometry A, B, C, B', A' (B' equals B), with via waypoints at C and then at B'. Expect via knots to be strictly increasing and the second to point at B', not B.
  - `roadPath simplifies but keeps a hairpin`: 200 collinear points 1 m apart reduce to ≤ 4 points, while a hairpin 20 m wide keeps its apex.
  - `roadPath unwraps across 180°`: from `[179.999, 0]`, geometry `[[179.999, 0.0001], [-179.999, 0.0001]]`, to `[-179.999, 0]`. Expect consecutive longitudes to differ by < 1.
  - `roadPath zero length`: from equals to and the geometry is one point. Expect `path.length ≥ 2` and knots `[0, path.length - 1]`.

- [ ] **Step 2: Run** `npx vitest run test/core/road.test.ts`. Expected: FAIL, because the module doesn't exist.

- [ ] **Step 3: Implement.** In `sea.ts`, move the FNV loop into an exported `fnv1a64`; `seaLegKey` hashes the same text as before, so existing sea keys don't change. Write `road.ts`:
  - `roadLegKey` hashes `JSON.stringify([ROAD_VERSION, profile, from, to, via.map((v) => v.at)])`.
  - `roadPath` builds `[from, ...geometry, to]`, unwrapping each longitude from the one before (starting at `from[0]`). Each waypoint's knot is found by searching forward from the previous knot for the nearest vertex, so the stops are the first and last points. It simplifies each stretch between consecutive knots separately with `simplify` at `ROAD_SIMPLIFY_M / (kmPerUnit(lat) * 1000)` Mercator units, so knots always survive. Non-knot points are rounded to 1e-6°. `stopGapKm` is the `haversineKm` from each stop to the first or last geometry point.

- [ ] **Step 4: Run** `npx vitest run test/core/road.test.ts test/core/sea.test.ts test/core/purity.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** `feat: road path building in core`.

---

### Task 2: Road legs in `buildRoute`

**Model:** opus (the chaining loop in `buildRoute`)

**Files:**
- Modify: `src/core/route.ts` (the `RouteLeg` type, the `buildRoute` chain loop, a new `roadLeg(i)`)
- Test: `test/core/route.test.ts`

**Interfaces:**
- Consumes: `legProfile`, `roadLegKey` and `RoadProfile` from Task 1.
- Produces: `RouteLeg.road?: { status: 'ok' | 'pending' | 'fallback'; profile: RoadProfile; reason?: string; unverified?: 'offline'; stopGapKm?: [number, number] }`. A road leg keeps `drawnAs: 'line'` and `mode: 'land'`.

- [ ] **Step 1: Write the failing tests** in `test/core/route.test.ts`:
  - `a routed road leg follows its path and stands alone`: the scene is line, land(car), line. `seaPaths` holds an `ok` road path for leg 1 under `roadLegKey`. Expect leg 1's path to equal the cached path (shifted onto the unwrapped start) with `road.status 'ok'`. Leg 0's last point should be stop 1 exactly, and its shape should equal leg 0 of a scene where leg 1 is `air`, which proves the chain ends at stop 1.
  - `an unrouted road leg curves as today`: the same scene with no road entry. Expect leg paths deep-equal to the same scene with leg 1's mode set to `line`, and `road.status 'pending'`.
  - `a fallback road leg curves as today with its reason`: the entry is `{ status: 'fallback', reason: ROAD_OFFLINE, unverified: 'offline', path: [], knots: [] }`. Expect `road` to be `{ status: 'fallback', profile: 'car', reason: ROAD_OFFLINE, unverified: 'offline' }`.
  - `a land leg on train still chains and has no road`: expect `road` to be undefined and the path unchanged from today.
  - `via knots come from the road path`: a cached path with knots `[0, 7, 12]` and one via. Expect `knots` to be `[0, 7, 12]` and `path[7]` to be the cached point, not the via's `at`.
  - `nearestOnLeg inserts via points in order on a road leg`: a click near point 10 gives `insertIndex 1`.

- [ ] **Step 2: Run** `npx vitest run test/core/route.test.ts`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement.** In the loop, a leg is a road leg when `legProfile(spec, scene.look)` is set and `seaPaths?.[key]?.status === 'ok'`. Such a leg is handled like the `seaLeg` branch: it is its own chain, and the `curves()` test must treat it as not curving. Every other land leg chains as today. `roadLeg(i)` shifts the cached path by whole turns onto `start` and sets `path[0] = start` and the last point to the unwrapped end stop. It doesn't overwrite via knots. After chains are built, tag every land leg that has a profile with `road`. Tag it `pending` when there is no entry, and copy `reason` and `unverified` on a fallback. Update existing tests that deep-equal whole `RouteLeg` objects for land legs so they expect the new `road` tag.

- [ ] **Step 4: Run** `npx vitest run test/core`. Expected: PASS.

- [ ] **Step 5: Commit** `feat: draw land legs along cached road paths`.

---

### Task 3: Warnings, credit and tool text

**Model:** sonnet

**Files:**
- Modify: `src/core/validate.ts` (after the sea checks, around lines 315-334), `src/core/credit.ts` (`hasSeaLeg`, `sceneCredit`), `src/render/warnings.ts`, `src/render/render.ts:221`, `src/render/preview.ts:261,336`, `src/mcp/tools.ts:110-128` (`legLine`)
- Test: `test/core/validate.test.ts`, `test/core/credit.test.ts`, `test/render/warnings.test.ts`, `test/mcp/tools.test.ts`

**Interfaces:**
- Consumes: `RouteLeg.road` from Task 2; `ROAD_STOP_FAR_KM`, `ROAD_OFFLINE`, `NO_ROAD_ROUTE` and `legProfile` from Task 1.
- Produces:
  - `hasRoadLeg(scene): boolean`
  - `ROAD_CREDIT_WRITTEN`
  - `roadWarningLines(scene: Scene, seaPaths: SeaPaths, label?: string): string[]`

- [ ] **Step 1: Write the failing tests:**
  - **validate**:
    - `road-offline`: the message is `Leg 2 (A → B) couldn't be routed along roads, because the road router couldn't be reached. It's drawn as a curve.`, with path `['scenes', i, 'legs', 1]` and fix `Mapper tries again by itself; check the internet connection.`
    - `road-no-route`: the message is `Leg 2 (A → B) has no road route between its stops. It's drawn as a curve.` and the fix is `Move a stop onto a road with update_stop, or set the leg's mode to line.`
    - `warns road-stop-far once per stop`: for two road legs sharing stop B with gaps 0.8 and 1.2, expect one warning for B, `B is 1.2 km from the nearest road, so the route joins it in a straight line.` (path `['scenes', i, 'stops', 1]`). Expect no warning at 0.4 km.
    - A `pending` road leg gives no warning.
    - Use the existing `legName` and `nameOf` helpers, so the exact leg wording follows the file's own convention. Adjust the expected strings to it if they differ.
  - **credit**: `blank` with a car `land` leg includes `MAP_CREDIT`. The written form includes `ROAD_CREDIT_WRITTEN` and the burned form doesn't. A `land` leg on `train` adds nothing.
  - **warnings**: `roadWarningLines` gives `Leg 2: no road route was found (the road router couldn't be reached), so it's drawn as a curve.` for an offline fallback, and the no-route equivalent with `NO_ROAD_ROUTE`. It gives `[]` for ok or pending, and applies the `label` prefix the way `seaWarningLines` does.
  - **tools**: `legLine` shows `road route (car)`, `road route pending`, or `road route failed: <reason>`.

- [ ] **Step 2: Run** the four test files. Expected: FAIL.

- [ ] **Step 3: Implement.** `hasRoadLeg` mirrors `hasSeaLeg`, using `legProfile(leg, scene.look) !== undefined`. `sceneCredit` adds the map credit for `hasSeaLeg || hasRoadLeg`, and in `written` form appends `ROAD_CREDIT_WRITTEN` when `hasRoadLeg`. `render.ts` and `preview.ts` concatenate `roadWarningLines` after `seaWarningLines`.

- [ ] **Step 4: Run** `npx vitest run test/core test/render test/mcp`. Expected: PASS.

- [ ] **Step 5: Commit** `feat: road warnings, credit and tool text`.

---

### Task 4: OSRM client (`src/server/roads.ts`)

**Model:** sonnet

**Files:**
- Create: `src/server/roads.ts`
- Test: `test/server/roads.test.ts`

**Interfaces:**
- Consumes: `OsrmAnswer` and `RoadProfile` (Task 1); `USER_AGENT` from `src/server/tiles.ts`; `OFFLINE_MS` from `src/server/sea-water.ts`.
- Produces:
  - `DEFAULT_ROAD_ROUTER`
  - `ROAD_USER_AGENT`
  - `type RoadReply = { kind: 'ok'; answer: OsrmAnswer } | { kind: 'no-route' } | { kind: 'offline' }`
  - `interface RoadRouter { route(profile: RoadProfile, points: LngLat[]): Promise<RoadReply> }`
  - `createRoadRouter(opts?: { url?: string; fetch?: typeof fetch; minIntervalMs?: number; timeoutMs?: number; offlineMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> }): RoadRouter`
  - `roadRouter(): RoadRouter`, the process singleton built from `process.env.MAPPER_ROAD_ROUTER || DEFAULT_ROAD_ROUTER`

- [ ] **Step 1: Write the failing tests** (all with a fake `fetch`, a fake clock and `sleep`):
  - `builds the request`: profile `foot` and points `[[25.4325, 36.348], [25.3756, 36.4614]]` request `https://routing.openstreetmap.de/routed-foot/route/v1/driving/25.4325,36.348;25.3756,36.4614?overview=full&geometries=geojson&steps=false`. The `User-Agent` is `ROAD_USER_AGENT`, which contains `+https://github.com/benclissen/aloftandaway-mapper`. Longitudes outside ±180 are wrapped in the request.
  - `reads Ok, NoRoute and NoSegment`: HTTP 200 with `Ok` and a route gives `ok`. HTTP 400 with `NoRoute` or `NoSegment` gives `no-route`. HTTP 200 with `Ok` but no routes gives `offline`.
  - `treats 429, 5xx, bad JSON, a thrown fetch and a timeout as offline`.
  - `stays offline for offlineMs`: after one offline reply, the next call within 60 s returns `offline` without calling `fetch`. After 60 s it calls again.
  - `spaces requests at least minIntervalMs apart`: three concurrent calls give fetch start times ≥ 1000 ms apart in call order, and each resolves with its own answer.

- [ ] **Step 2: Run** `npx vitest run test/server/roads.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** a promise-chained queue: each request waits for the previous one to finish and for `minIntervalMs` since that one started. Use an `AbortController` timeout. `ROAD_USER_AGENT` is `${USER_AGENT} (+https://github.com/benclissen/aloftandaway-mapper)`.

- [ ] **Step 4: Run** the test again. Expected: PASS.

- [ ] **Step 5: Commit** `feat: OSRM road router client`.

---

### Task 5: Road path cache and `resolvePaths`

**Model:** sonnet

**Files:**
- Create: `src/server/road-paths.ts`
- Modify: `src/server/atomic.ts` (receives `inOrder`, moved from `paths.ts:150-162`), `src/server/paths.ts` (imports `inOrder`; adds `resolvePaths`), `src/mcp/tools.ts:57,195,699`, `src/render/render.ts:16,168`, `src/render/preview.ts:20,197` (switch to `resolvePaths`)
- Test: `test/server/road-paths.test.ts`

**Interfaces:**
- Consumes: `roadLegsOf`, `roadPath`, `ROAD_OFFLINE` and `NO_ROAD_ROUTE` (Task 1); `RoadRouter` and `roadRouter` (Task 4); `writeFileAtomic` and `inOrder` (atomic.ts); `RETRY_MS` (paths.ts).
- Produces:
  - `ROADS_FILE = path.join('.mapper', 'roads.json')`
  - `ROAD_CACHE_VERSION = 1`
  - `NO_ROUTE_RETRY_MS = 86_400_000`
  - `resolveRoadPaths(folder: string, project: Project, opts?: { router?: RoadRouter; now?: () => number }): Promise<SeaPaths>`
  - `resolvePaths(folder: string, project: Project, opts?: ResolveOptions & { router?: RoadRouter }): Promise<SeaPaths>`, which returns `{ ...sea, ...road }`

- [ ] **Step 1: Write the failing tests** (temporary folder, fake `RoadRouter`, fake clock):
  - `routes a road leg once and reuses it`: the first call calls the router once and writes `roads.json` as `{ version: 1, paths: { [key]: { status: 'ok', …, usedAt } } }`. The second call doesn't call the router.
  - `an ok route never expires`: one year later, still no router call.
  - `offline is retried after a minute`: the entry is a fallback with `reason: ROAD_OFFLINE`, `unverified: 'offline'` and `retryAt` = done + 60 s. A call at +59 s doesn't route; a call at +61 s does.
  - `no-route is retried after a day`: `reason: NO_ROAD_ROUTE`, no `unverified`, `retryAt` = done + 24 h.
  - `drops a corrupt or other-version cache`: garbage, `{ version: 2 }` and a malformed entry are all rerouted without throwing.
  - `keeps the newest 200 entries`.
  - `answers when the cache can't be written`: the folder's `.mapper` is a file. Routes still come back, and the error is logged once.
  - `sends stops and via points in order`: the router gets `[from, ...via, to]`.
  - `resolvePaths merges sea, track and road entries`: a project with one sea leg and one car leg, with `water: undefined` and a fake land source as in `test/server/paths.test.ts`. Expect both keys present.

- [ ] **Step 2: Run** `npx vitest run test/server/road-paths.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**, following `resolveSeaPaths` in shape: a memo keyed by the file stamp, `wellKept` validation of entries, atomic write only when something was routed, `usedAt` refreshed on the legs in use, and per-folder `inOrder`. Moving `inOrder` to `atomic.ts` doesn't change its behaviour. Switch the three callers to `resolvePaths`.

- [ ] **Step 4: Run** `npm run typecheck && npx vitest run test/server test/mcp test/render`. Expected: PASS.

- [ ] **Step 5: Commit** `feat: cache road paths per project`.

---

### Task 6: Studio server, test isolation and end-to-end

**Model:** sonnet

**Files:**
- Modify: `src/server/server.ts:26,190-193,305-340` (adds the `roadRouter?: RoadRouter` server option; resolves roads beside sea paths), `vitest.config.ts`
- Create: `test/helpers/fake-osrm.ts`, `test/e2e/roads.test.ts`
- Test: `test/server/server.test.ts`

**Interfaces:**
- Consumes: `resolveRoadPaths` and `roadLegsOf` (Tasks 1 and 5); `RoadRouter` and `createRoadRouter` (Task 4).
- Produces: `startFakeOsrm(answer: (profile: string, points: LngLat[]) => { status: number; body: unknown }): Promise<{ url: string; requests: string[]; close(): Promise<void> }>`, where `url` is a template containing `{profile}`.

- [ ] **Step 1: Isolate tests from the real router.** In `vitest.config.ts`, add `MAPPER_ROAD_ROUTER: 'http://127.0.0.1:9/{profile}'` to the `offline` env, and give the e2e project `env: process.env.MAPPER_NET ? {} : { MAPPER_ROAD_ROUTER: 'http://127.0.0.1:9/{profile}' }`. Run `npm test` and confirm no request leaves the machine. Unit tests with land legs may now show road-offline warnings: update only expectations that list warnings, and leave route geometry untouched (Task 2 keeps it).

- [ ] **Step 2: Write the failing tests:**
  - **server.test.ts**:
    - `pushes road paths to the studio`: a project with a car leg and a fake router. The project message's `seaPaths` holds the `road:` key with `status 'ok'`.
    - `a road failure doesn't break sea paths`: a router that throws gives offline fallback entries for road keys, and sea entries are still present.
    - `retries an offline road leg`: with `retryMs` small, the router is called again and the new path is pushed.
  - **e2e/roads.test.ts** (fake OSRM through `MAPPER_ROAD_ROUTER`):
    - `validate_project` on a car leg reports no road warnings, and `.mapper/roads.json` exists.
    - A preview frame renders.
    - With the fake answering 503, `validate_project` reports `road-offline`.

- [ ] **Step 3: Implement.**
  - The early return becomes `seaLegsOf(project).size === 0 && roadLegsOf(project).size === 0 && !hasTrack`.
  - Sea work keeps its own failure path.
  - Road work is `resolveRoadPaths(entry.folder, project, { router: opts.roadRouter ?? roadRouter(), now: opts.now })` in its own try/catch, which falls back to `{ status: 'fallback', reason: ROAD_OFFLINE, unverified: 'offline', path: [], knots: [] }` for each road key.
  - Both run inside the same `resolving` promise. Merge them as `{ ...sea, ...road }`. `retriesSoon` already covers `unverified: 'offline'`.

- [ ] **Step 4: Run** `npm test`, then `npm run test:e2e`. Expected: PASS, with goldens unchanged.

- [ ] **Step 5: Commit** `feat: route road legs in the studio server`.

---

### Task 7: Studio notes and point menu

**Model:** sonnet

**Files:**
- Modify: `src/studio/edit/labels.ts`, `src/studio/edit/LegsPanel.tsx:46-115`, `src/studio/edit/PointMenu.tsx`, `src/studio/edit/App.tsx` (where `PointMenu` is rendered)
- Test: `test/studio/labels.test.ts`, `test/e2e/route-editing.test.ts`

**Interfaces:**
- Consumes: `RouteLeg.road` (Task 2); `legProfile`, `ROAD_OFFLINE`, `NO_ROAD_ROUTE` and `ROAD_STOP_FAR_KM` (Task 1).
- Produces:
  - `roadNote(road: RouteLeg['road']): string | undefined`
  - a `PointMenu` prop `canSharpen: boolean`

- [ ] **Step 1: Write the failing tests:**
  - **labels.test.ts**: `roadNote` gives:
    - an offline fallback: `Couldn't reach the road router, so it's drawn as a curve. Mapper tries again by itself.`
    - no route: `No road route between these stops, so it's drawn as a curve.`
    - `ok` with a gap of 1.2: `A stop is 1.2 km from the nearest road.`
    - `ok` with gaps ≤ 0.5, or `pending`: `undefined`
  - **route-editing e2e**: right-clicking a via point on a car `land` leg opens the menu without `point-menu-sharp` and with `point-menu-remove`. On a `line` leg both are shown.

- [ ] **Step 2: Run** them. Expected: FAIL.

- [ ] **Step 3: Implement.** `LegsPanel` shows `roadNote(route.legs[i]?.road)` in the same element and style as `trackNote`. `App` passes `canSharpen={!(target.kind === 'via' && legProfile(scene.legs[target.leg] ?? { mode: 'line' }, scene.look))}`. `PointMenu` renders the sharp item only when `canSharpen` is true.

- [ ] **Step 4: Run** `npx vitest run test/studio` and `npx vitest run --project e2e test/e2e/route-editing.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** `feat: road notes and no sharp on road via points in the studio`.

---

### Task 8: Docs and the network check

**Model:** haiku

**Files:**
- Modify: `docs/superpowers/specs/2026-10-13-mapper-local-agent-design.md` (a revision note at the top, plus the `land` line under Core, around line 706), `skills/mapper/SKILL.md`, `README.md`
- Test: `test/server/roads.test.ts` (adds a network test)

- [ ] **Step 1: Add** `test.skipIf(!process.env.MAPPER_NET)('routes Athinios to Oia by car', …)`, which calls `createRoadRouter()` for car with `[[25.4325, 36.348], [25.3756, 36.4614]]`, runs it through `roadPath`, and checks the length is between 20 and 27 km by summed `haversineKm`.

- [ ] **Step 2: Run** `MAPPER_NET=1 npx vitest run test/server/roads.test.ts -t Athinios`. Expected: PASS.

- [ ] **Step 3: Write the docs.**
  - The main spec gets `**Revision, 2026-11-03 (road following):** land legs follow roads; see 2026-11-03-road-following-design.md.`, and the `land` bullet is replaced with a two-sentence summary.
  - `SKILL.md` gets a "Road legs" section: land legs follow roads, cycle routes or footpaths by transport; via points are must-pass points; `line` mode gives a hand-drawn curve; `sharp` is ignored; and it lists the `road-offline`, `road-no-route` and `road-stop-far` warnings with what to do about each.
  - `README.md` documents `MAPPER_ROAD_ROUTER` and says that road leg stop and via coordinates are sent to FOSSGIS.

- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.

- [ ] **Step 5: Commit** `docs: road-following land legs`.

---

## Finish

Have Opus do a whole-branch review. Then `npm run build`, so the MCP server uses the new `dist`. Then Ben's hand check: open the Santorini map in the studio, confirm the port-to-Oia leg follows the road, drag a via point onto another road, and render a short clip.
