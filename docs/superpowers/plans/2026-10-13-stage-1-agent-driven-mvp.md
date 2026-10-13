# Stage 1: Agent-driven MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent creates a project from typed-in stops over MCP, checks a contact sheet, the user tweaks it in the local studio, and Mapper renders a flattened 4K 25p clip.

**Architecture:** One npm package with a `mapper` binary. Pure-TS `core` (schema, patching, routing, timeline, camera, validation) is shared by a Vite/React/MapLibre studio page and the Node side. A local HTTP/WebSocket server serves the studio, proxies and caches tiles, and syncs project edits. The renderer drives the studio's render mode in headless Chrome through Playwright, captures each frame as a PNG with the Chrome DevTools Protocol (chosen by the Task 1 benchmark), pipes it into ffmpeg, and runs as jobs behind MCP tools and CLI commands.

**Tech Stack:** TypeScript (strict, ESM), Node ≥ 22, Zod 4, MapLibre GL JS 5, React 19, Vite, Playwright, `ws`, ffmpeg, `@modelcontextprotocol/sdk`, Vitest, pixelmatch + pngjs.

**Spec:** `docs/superpowers/specs/2026-10-13-mapper-local-agent-design.md` (read it before any task). Build stages: `docs/plan.md`.

**Execution:** subagent-driven. Each task names its implementer's model, following the tiers in `AGENTS.md`. Task reviewers use the same tier, with Sonnet 5.5 as the minimum. Re-reviews of small fixes use Haiku 5.5, and the final whole-branch review uses Opus 5.5.

## Scope

In stage 1 (from the spec's build stages): core with `line` legs, the timeline, and `fixed` and `glide` cameras; studio preview, scrubbing, stop dragging and shot setting; the server; MCP tools and CLI; `mapper doctor`; the agent skill; a flattened render (ProRes 422 HQ or H.264); one built-in theme.

Deferred, and not to be built here:

- `import_gpx` (stage 3), and the `render` tool's `layers` input, layer passes and FCPXML (stage 2).
- Sea routing, `air` arcs, the follow camera, sign-overlap and sea-crossing warnings (stage 3). The schema accepts these values now. Stage 1 draws `sea`/`air` legs as `line`, treats `follow` as `glide`, and `validate_project` warns.
- Sign-offset dragging and via-point editing in the studio. The spec's `Stop` has no offset field yet. That goes to the user as a spec question for a later stage.
- `.mapper/paths.json` path caching. `line` legs cost nothing to compute.
- More themes, sign styles, transport symbols, terrain (stage 4). Every symbol other than `none` draws as a dot.

## Decisions this plan makes where the spec is open

1. **`output.height` is the frame's short side.** 9:16 at 2160 is 2160×3840, not 1215×2160. A literal height gives odd widths that 4:2:2 and 4:2:0 can't encode.
2. **Layout space.** Shot zoom, line width and sign sizes are defined against a *layout frame* whose short side is 1080 CSS px (16:9 → 1920×1080). Every view (studio, preview, render) lays the map out at layout size. MapLibre's `pixelRatio` option sets the real resolution: a 4K render uses `pixelRatio` 2 and a 960-wide preview uses 0.5. The studio scales the layout-size container to fit the window with a CSS `transform`. Framing, label density and tile zoom are then identical at every size, which is the spec's "preview and render match". This replaces the spec's "viewport = output size, device scale factor 1": the Playwright viewport is the layout size instead.
3. **Range input** for `render` is `{ from, to }` in seconds.
4. **Contact sheet `width`** is the width of the whole sheet (default 1920). Cells are laid out in a grid of `ceil(√count)` columns.
5. **Fixture places** are public ports only (Piraeus, Mykonos, Santorini, Rhodes, Suva, Apia). No Aloft & Away data.

## Global Constraints

- Public repo: no keys, tokens, internal URLs or Aloft & Away site/API details in code, fixtures or docs.
- Clean room: no Map Animator code, themes, icons, sign artwork, UI text or file format. Don't download its bundle or demo files into this repo. The `paper` theme and `tag` sign style are written from scratch. Don't copy OpenFreeMap's styles either.
- No trip-data connectors: stops arrive only through `set_stops` / `update_project`.
- Map credit, burned in by default, with exactly this text: `© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap`. No satellite source in stage 1.
- Coordinates are `[lng, lat]` in every public interface: schema, MCP tools, CLI, HTTP API.
- New-project defaults: `aspect '16:9'`, `height 2160` (3840×2160), `fps { num: 25, den: 1 }`.
- `package.json` `"engines": { "node": ">=22" }`, `"type": "module"`. TypeScript `strict: true`.
- `src/core` imports nothing outside `src/core` and no `node:` built-ins, DOM or network (test-enforced in Task 2).
- Dependency direction: `core` ← `studio`, `server` ← `render` ← `mcp` ← `cli`.
- In `mapper mcp`, stdout carries only MCP protocol. All logs go to stderr.
- The server binds `127.0.0.1` only. The tile proxy fetches only from `https://tiles.openfreemap.org`.
- Every tool and CLI command takes absolute folder paths and rejects relative ones.
- ProRes is `prores_ks -profile:v 3 -vendor apl0 -pix_fmt yuv422p10le`. Every output is tagged `-color_primaries bt709 -color_trc bt709 -colorspace bt709`, converted from RGB with `scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709` (ffmpeg 9 needs `setparams` before primaries and transfer are tagged), at a frame rate of exactly `num/den`.
- Commit messages are imperative sentences without prefixes, matching the existing history ("Add project schema"), and end with the `Co-Authored-By` trailer.

## Review Focus

1. **Two consecutive stops at the same place** (an overnight the agent didn't merge). The timeline, head heading and camera must stay finite (no `NaN`), the zero-length leg gets its 0.5 s minimum, and validation warns. Test: Task 5 `zero-length leg stays finite`.
2. **Stops either side of the antimeridian** (Suva → Apia). The line takes the 10° route across 180°, not the 350° one, and the fitted shot frames that short route. Tests: Task 4 `crosses the antimeridian the short way`, Task 6 `fits an antimeridian route`.
3. **Colour shift in the encode.** swscale defaults to the BT.601 matrix for RGB→YUV, so a BT.709-tagged file would show shifted colours in Final Cut. A solid (217, 71, 43) frame must decode back within ±3 per channel. Test: Task 13 `round-trips colour through BT.709`.
4. **Fractional frame rates** (30000/1001). Frame counts and arrival frames must come from cumulative boundaries without drift, and ffprobe must report `30000/1001`. Tests: Task 5 `29.97 fps boundaries`, Task 13 `tags 30000/1001`.
5. **The project changes during a render** (the user drags a stop in the studio mid-render). The render uses its starting snapshot, and the manifest records that snapshot's hash. Test: Task 13 `renders the starting snapshot`.

---

## File map

```
package.json, tsconfig.base.json, tsconfig.node.json, tsconfig.studio.json, vite.config.ts, vitest.config.ts
bench/render-speed.ts, bench/page.html          Task 1 benchmark (kept)
docs/render-speed.md                            Benchmark and final measurement results
src/core/
  schema.ts       Zod schema, types, defaults, frame/layout sizes, constants
  patch.ts        JSON Merge Patch, update ops, set_stops, leg syncing
  geo.ts          Mercator, unwrap, haversine, bearing
  route.ts        Leg routing (line), Route, pointAt, slicePath
  timeline.ts     Leg timing, Timeline, FrameState, timecode
  camera.ts       fitShot, resolveShots, cameraAt, van Wijk–Nuij
  validate.ts     validateProject
  protocol.ts     Studio ↔ server message types
  index.ts        Re-exports
src/server/
  store.ts        create/load/save/mutate project on disk, projectHash
  server.ts       HTTP + WS server, security, project API, file watch
  tiles.ts        Tile proxy with disk cache
src/studio/
  index.html, main.tsx
  stage/themes.ts, stage/MapStage.ts, stage/overlay.ts
  render-mode.ts
  edit/App.tsx, edit/Stage.tsx, edit/Scrubber.tsx, edit/ShotPanel.tsx, edit/api.ts, edit/edit.css
src/render/
  chrome.ts       Launch Chrome (fallback Chromium), WebGL info
  page.ts         RenderPage: Playwright page wrapper for window.mapper
  preview.ts      previewFrame, contactSheet
  encode.ts       ffmpegArgs, Encoder
  render.ts       renderProject (frame loop, segments, manifest)
  jobs.ts         Render job registry
src/mcp/tools.ts, src/mcp/server.ts
src/cli/main.ts, src/cli/doctor.ts
skills/mapper/SKILL.md
test/core/*.test.ts, test/server/*.test.ts, test/render/*.test.ts, test/mcp/*.test.ts, test/cli/*.test.ts
test/e2e/*.test.ts, test/e2e/golden/*.png
test/fixtures/projects.ts
```

Test projects in Vitest: `unit` (everything outside `test/e2e`, no Chrome or network) and `e2e` (`test/e2e`, needs a build, Chrome and ffmpeg; sequential, 180 s timeout). Network-dependent e2e tests run only when `MAPPER_NET=1`. Golden PNGs are refreshed with `UPDATE_GOLDENS=1`.

---

### Task 1: Scaffold and 4K render-speed benchmark

**Model:** Opus 5.5

The spec names render speed as the biggest risk, so it gets measured first. The benchmark runs on its own, without Mapper code. It answers four questions: does headless Chrome get the GPU, how fast does MapLibre settle a 4K frame, which readback and transfer path is fastest, and what is the encoder's ceiling.

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `tsconfig.node.json`, `.gitignore` (append), `bench/render-speed.ts`, `bench/page.html`, `docs/render-speed.md`

**Interfaces:**
- Produces: `npm run bench:render [-- --frames 100 --write]`; the launch args and capture method recorded in `docs/render-speed.md`, which Tasks 11 and 13 use.

- [ ] **Step 1: Scaffold the package.** `package.json`: name `mapper`, `"type": "module"`, `"bin": { "mapper": "dist/cli/main.js" }`, engines as in Global Constraints. Dependencies: `playwright`, `maplibre-gl`, `ws`. Dev dependencies: `typescript`, `tsx`, `@types/node`, `@types/ws`. Script: `"bench:render": "tsx bench/render-speed.ts"`. `tsconfig.base.json`: strict, ES2023, `skipLibCheck`. `tsconfig.node.json` extends it with `module`/`moduleResolution` `NodeNext` and `outDir dist`. Append `.mapper/`, `renders/`, `test-output/` to `.gitignore`. Run `npm install`. Expected: no errors.

- [ ] **Step 2: Write `bench/page.html`.** Loads `maplibre-gl` from `/node_modules/maplibre-gl/dist/`. Creates a map in a 1920×1080 CSS container with `pixelRatio` from the query string (2 → 3840×2160 canvas), `preserveDrawingBuffer: true`, `fadeDuration: 0`, `maxCanvasSize: [8192, 8192]`, `attributionControl: false` and style `https://tiles.openfreemap.org/styles/positron`. Benchmark only: the style is loaded at runtime, never copied into the repo. Adds a GeoJSON line source. Exposes `window.bench`:
  - `frame(i, n)`: `jumpTo` a glide from Piraeus `[23.6466, 37.942]` at zoom 6 to Rhodes `[28.2278, 36.451]` at zoom 8, then `setData` with the route sliced to `i/n`. Resolves on `idle` and returns ms.
  - `readPixelsGL()`: `gl.readPixels` into a reused `Uint8Array`. Returns ms.
  - `readComposite()`: `drawImage` the map canvas plus a 2D overlay canvas onto a composite canvas, then `getImageData`. Returns ms.
  - `sendWS(url)`: sends the last readback as a binary WebSocket message and resolves when `bufferedAmount` is 0.
  - `base64()`: returns the last readback as base64.
  - `webgl()`: returns `UNMASKED_RENDERER_WEBGL`.

- [ ] **Step 3: Write `bench/render-speed.ts`.** Starts a `node:http` static server on `127.0.0.1` for `bench/` and `node_modules/maplibre-gl/dist`, plus a `ws` endpoint that counts bytes. Measures, for `--frames N` (default 100):
  1. **GPU:** launch Chrome (`channel: 'chrome'`, headless) with each arg set: `[]`, `['--use-angle=metal']`, `['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']`. Record the WebGL renderer string for each and flag `SwiftShader`/`llvmpipe` as software.
  2. **Settle:** median, p95 and max of `frame()` for a cold pass and then a warm pass (same frames, browser HTTP cache), at `pixelRatio` 2 and at 1.
  3. **Readback:** median of `readPixelsGL` and of `readComposite` at 4K.
  4. **Transfer:** median of `sendWS` against `page.evaluate(base64)` + `Buffer.from(…, 'base64')`, and against CDP `Page.captureScreenshot({ format: 'png', optimizeForSpeed: true })` (readback and transfer in one).
  5. **Encode ceiling:** pipe one 3840×2160 RGBA buffer N times into ffmpeg with the Global Constraints colour flags for `prores_ks -profile:v 3`, `prores_videotoolbox -profile:v hq` and `h264_videotoolbox -b:v 40M`, writing to `test-output/bench/`. Record fps for each.
  6. **End to end:** warm pass at 4K: frame → best readback → best transfer → `prores_ks`, with frame *n+1* rendering while frame *n* encodes. Record fps.

  Print a markdown table of the results. With `--write`, also write it to `docs/render-speed.md` under `## Benchmark (Task 1)`, with the date, Chrome version, machine (`sysctl machdep.cpu.brand_string`) and the chosen launch args and capture method.

- [ ] **Step 4: Run it.** Run: `npm run bench:render -- --frames 100 --write`. Expected: a table with every row filled, and a non-software WebGL renderer for at least one arg set. If every arg set reports software rendering, stop here and report to the user.

- [ ] **Step 5: Checkpoint with the user.** Post the table. Decision rule, for end-to-end warm 4K fps:
  - **≥ 2 fps:** continue. A 60 s clip renders in under 13 minutes.
  - **0.5–2 fps:** continue, and list the dominant stage and the mitigation the spec names for it (CDP screencast, async readback, 1080p option).
  - **< 0.5 fps:** stop and wait for the user's decision before Task 2.

  Record the chosen launch args and capture method in `docs/render-speed.md`. Tasks 11 and 13 use them. The default, unless the numbers say otherwise, is composite readback (`readComposite`) plus WebSocket binary, the spec's design.

- [ ] **Step 6: Commit.**
```bash
git add package.json package-lock.json tsconfig.base.json tsconfig.node.json .gitignore bench docs/render-speed.md
git commit -m "Add scaffold and 4K render-speed benchmark"
```

---

### Task 2: Project schema

**Model:** Sonnet 5.5

**Files:**
- Create: `src/core/schema.ts`, `src/core/index.ts`, `vitest.config.ts`, `test/core/schema.test.ts`, `test/core/purity.test.ts`, `test/fixtures/projects.ts`
- Modify: `package.json` (add `zod`, `vitest`; scripts `test`, `typecheck`), `tsconfig.node.json`
- Create: `tsconfig.bench.json`

**Interfaces:**
- Produces (from `src/core/schema.ts`, re-exported by `src/core/index.ts`):
  - Types inferred from Zod: `LngLat`, `Fps`, `Output`, `Timing`, `Stop`, `Leg`, `LegMode`, `Look`, `SymbolKind`, `Shot`, `Camera`, `Project`, `StopInput`, `Aspect`.
  - `ProjectSchema`, `StopInputSchema`, `ShotSchema` (strict objects; unknown keys rejected).
  - `parseProject(json: unknown): Project`, which throws `ProjectError` (`issues: { path: (string|number)[]; message: string }[]`, message lists `path: message` lines).
  - `defaultProject(args: { id: string; name: string; now: string; output?: Partial<Output> }): Project`
  - `frameSize(output: Output): { width: number; height: number }`, `layoutSize(aspect: Aspect): { width: number; height: number }`, `outputScale(output: Output): number` (= `output.height / 1080`), `fpsValue(fps: Fps): number`
  - Constants: `ALLOWED_FPS`, `THEMES = ['paper', 'blank'] as const`, `type ThemeId = (typeof THEMES)[number]`, `THEME_MAX_ZOOM: Record<ThemeId, number> = { paper: 14, blank: 22 }`, `SIGN_STYLES = ['tag'] as const`, `MAP_CREDIT = '© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap'`
- `test/fixtures/projects.ts` produces:
  - `greekIslands(overrides?: Partial<Project>): Project`: Piraeus `[23.6466, 37.942]` terminal, Mykonos `[25.3289, 37.4467]`, Santorini `[25.4317, 36.4166]` pause 1, Rhodes `[28.2278, 36.451]` terminal; three `line` legs; `timing { holdStart: 1, travel: 10, holdEnd: 2 }`; theme `blank`; height 1080
  - `pacific(): Project`: Suva `[178.4419, -18.1416]` → Apia `[-171.7513, -13.8333]`
  - `stopsAt(points: LngLat[], overrides?: Partial<Project>): Project`: stops named `S0…Sn`, `line` legs, otherwise the same defaults as `greekIslands`
  - `emptyProject(): Project`: `defaultProject` with no stops

Schema rules beyond the spec's types: `lng ∈ [-180, 180]`, `lat ∈ [-85.0511, 85.0511]`; `stops` may be empty (a new project has none; validation reports fewer than two); `legs.length === max(0, stops.length - 1)`; stop ids unique; `fps` must be in `ALLOWED_FPS` = 24000/1001, 24/1, 25/1, 30000/1001, 30/1, 50/1, 60000/1001, 60/1; `timing` values ≥ 0; `line.width` 0.5–40; colours `#rrggbb`; `zoom` 0–22, `bearing` −180–180, `pitch` 0–60; `theme ∈ THEMES`, `signStyle ∈ SIGN_STYLES`.

Defaults: `timing { holdStart: 1, travel: 10, holdEnd: 2 }`; `look { theme: 'paper', labels: 'en', terrain: false, line: { color: '#d9472b', width: 4, dash: 'solid', outline: true, glow: false }, symbol: 'dot', signStyle: 'tag' }`; `camera { mode: 'glide', easing: 'smooth' }`; `credit: 'burned'`.

- [ ] **Step 1: Write the failing tests** in `test/core/schema.test.ts`:
```ts
test('default project is 4K 25p 16:9 and round-trips', () => {
  const p = defaultProject({ id: crypto.randomUUID(), name: 'Xcel', now: '2026-10-13T10:00:00Z' })
  expect(p.output).toEqual({ aspect: '16:9', height: 2160, fps: { num: 25, den: 1 } })
  expect(frameSize(p.output)).toEqual({ width: 3840, height: 2160 })
  expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
})
test('height is the short side', () => {
  expect(frameSize({ aspect: '9:16', height: 2160, fps: { num: 25, den: 1 } })).toEqual({ width: 2160, height: 3840 })
  expect(frameSize({ aspect: '4:5', height: 1080, fps: { num: 25, den: 1 } })).toEqual({ width: 1080, height: 1350 })
  expect(layoutSize('16:9')).toEqual({ width: 1920, height: 1080 })
})
test('rejects unknown keys with a path', () => {
  expect(() => parseProject({ ...greekIslands(), extra: 1 })).toThrow(ProjectError)
})
test('rejects legs out of step with stops', () => {
  const p = greekIslands(); p.legs.pop()
  expect(() => parseProject(p)).toThrow(/legs/)
})
test('rejects fps outside the allowed list', () => {
  expect(() => parseProject(greekIslands({ output: { aspect: '16:9', height: 1080, fps: { num: 7, den: 1 } } }))).toThrow(/output\.fps/)
})
test('rejects lat beyond Mercator range and duplicate stop ids', () => { /* lat 89 → /stops\.0\.at/; two stops id 'a' → /id/ */ })
```
`test/core/purity.test.ts`: read every file under `src/core`, and fail if any import specifier starts with `node:`, names `fs`, `path`, `http`, `maplibre-gl`, `react` or `ws`, or resolves outside `src/core`.

- [ ] **Step 2: Run tests to verify they fail.** Run: `npx vitest run --project unit test/core`. Expected: FAIL, cannot resolve `src/core/schema`.

- [ ] **Step 3: Implement `src/core/schema.ts` and `src/core/index.ts`** to the interface and rules above. `vitest.config.ts` defines the `unit` and `e2e` projects described in the file map. Point `tsconfig.node.json` at `src` (`rootDir: "src"`, include `src/**/*.ts`, exclude `src/studio`) so the build emits `dist/cli/main.js`. Move the benchmark into `tsconfig.bench.json` (`noEmit`, includes `bench`). Scripts: `"test": "vitest run --project unit"`, `"typecheck": "tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.bench.json"`.

- [ ] **Step 4: Run tests to verify they pass.** Run: `npm test && npm run typecheck`. Expected: PASS, no type errors.

- [ ] **Step 5: Commit.** `git add src/core test package.json package-lock.json vitest.config.ts && git commit -m "Add project schema"`

---

### Task 3: Patches, set_stops and leg syncing

**Model:** Sonnet 5.5

**Files:**
- Create: `src/core/patch.ts`, `test/core/patch.test.ts`

**Interfaces:**
- Consumes: Task 2 types and `parseProject`.
- Produces:
  - `type StopOp = { op: 'insert_stop'; index: number; stop: StopInput } | { op: 'update_stop'; id: string; changes: Partial<Omit<Stop, 'id'>> } | { op: 'remove_stop'; id: string } | { op: 'move_stop'; id: string; index: number } | { op: 'update_leg'; index: number; changes: Partial<Leg> }`
  - `interface ProjectPatch { set?: Record<string, unknown>; ops?: StopOp[] }` and `ProjectPatchSchema` (Zod)
  - `applyPatch(project: Project, patch: ProjectPatch): Project`: pure, all or nothing; throws `ProjectError`
  - `setStops(project: Project, args: { stops: StopInput[]; legMode?: LegMode; replace?: boolean }): Project`
  - `mergePatch(target: unknown, patch: unknown): unknown` (RFC 7396)
  - `newStopId(): string` (`s_` + 8 random base-36 chars, from `crypto.getRandomValues`)

Rules:
- `set` must not contain `stops`, `legs`, `schemaVersion`, `id` or `createdAt`. The error names the key and says to use `ops` or `set_stops`.
- Ops apply in order to a clone, then the result goes through `parseProject`. Any failure throws, and the input is untouched.
- **Leg syncing** (one rule for insert, remove and move): after stops change, rebuild legs pair by pair. If the old project had a leg from stop `a` to stop `b`, reuse it. Otherwise create `{ mode, via: [] }`, where `mode` is the new stop's `legMode` (insert/set_stops), else the old leg leaving `a`, else the old leg arriving at `b`, else `'line'`.
- `StopInput` → `Stop`: new id; `pause` defaults to 0, `sign` to `'always'`. `legMode` isn't stored on the stop; it sets the mode of the leg leaving that stop. `setStops` with `replace: false` appends the stops.

- [ ] **Step 1: Write the failing tests:**
```ts
const s = (name: string, at: LngLat = [0, 0]): StopInput => ({ name, at })
test('set_stops builds one leg per pair with per-stop legMode', () => {
  const p = setStops(emptyProject(), { stops: [s('A'), { ...s('B', [1, 1]), legMode: 'sea' }, s('C', [2, 2])], legMode: 'line' })
  expect(p.stops.map(x => x.name)).toEqual(['A', 'B', 'C'])
  expect(p.legs.map(l => l.mode)).toEqual(['line', 'sea'])
  expect(p.stops[0]).toMatchObject({ pause: 0, sign: 'always' })
})
test('set_stops replace:false appends', () => { /* 2 then 1 appended → 3 stops, 2 legs */ })
test('merge patch sets nested fields and null deletes optional ones', () => {
  const p = applyPatch(greekIslands(), { set: { look: { line: { color: '#000000' } }, camera: { start: null } } })
  expect(p.look.line.color).toBe('#000000'); expect(p.look.line.width).toBe(4); expect(p.camera.start).toBeUndefined()
})
test('set cannot touch stops', () => { expect(() => applyPatch(greekIslands(), { set: { stops: [] } })).toThrow(/set_stops|ops/) })
test('move_stop reuses legs whose endpoints survive', () => {
  // A→B line, B→C sea via [[1,1]], C→D line; move A to index 3 → B,C,D,A
  // legs[0] toEqual the old B→C leg (sea, via kept); legs[1] the old C→D leg; legs[2] toEqual { mode: 'line', via: [] }
})
test('remove_stop merges into a new leg with the previous mode', () => { /* A-(air)B-(sea)C → remove B → [{mode:'air', via:[]}] */ })
test('a failing op leaves the project unchanged', () => {
  const p = greekIslands(); const before = structuredClone(p)
  expect(() => applyPatch(p, { ops: [{ op: 'update_stop', id: p.stops[0].id, changes: { name: 'X' } }, { op: 'remove_stop', id: 'nope' }] })).toThrow(/nope/)
  expect(p).toEqual(before)
})
test('invalid result reports the Zod path', () => {
  expect(() => applyPatch(greekIslands(), { set: { output: { fps: { num: 7, den: 1 } } } })).toThrow(/output\.fps/)
})
```

- [ ] **Step 2: Run to verify they fail.** Run: `npx vitest run test/core/patch.test.ts`. Expected: FAIL, missing module.

- [ ] **Step 3: Implement `src/core/patch.ts`** to the interface and rules above.

- [ ] **Step 4: Run to verify they pass.** Run: `npm test`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -am "Add project patches and stop syncing"` (add the new files first).

---

### Task 4: Geometry and line routing

**Model:** Sonnet 5.5

**Files:**
- Create: `src/core/geo.ts`, `src/core/route.ts`, `test/core/route.test.ts`

**Interfaces:**
- Consumes: `Project`, `LngLat`, `LegMode`.
- Produces:
  - `geo.ts`: `type XY = [number, number]` (Mercator world units 0–1, x east, y south); `toXY(p: LngLat): XY`; `toLngLat(p: XY): LngLat`; `unwrapLng(prev: number, lng: number): number` (shifts by ±360 so `|lng − prev| ≤ 180`); `haversineKm(a: LngLat, b: LngLat): number`; `headingDeg(a: XY, b: XY): number` (clockwise from north, 0–360).
  - `route.ts`: `interface RouteLeg { mode: LegMode; drawnAs: 'line'; path: LngLat[]; xy: XY[]; cum: number[]; length: number; notAvailable?: boolean }`; `interface Route { legs: RouteLeg[]; length: number; bounds: [LngLat, LngLat] }` (south-west and north-east, longitudes unwrapped); `buildRoute(project: Project): Route`; `pointAt(route: Route, distance: number): { at: LngLat; heading: number; legIndex: number }`; `slicePath(route: Route, distance: number): LngLat[]`.

Algorithm: unwrap every point (stops and vias) in travel order against the previous one, starting from stop 0, so the whole route is continuous in longitude. `line` and `land` legs use centripetal Catmull–Rom (α = 0.5) in Mercator through `[from, ...via, to]`, with the end points extended by reflection (`P₋₁ = 2P₀ − P₁`) and 24 samples per span. Two points give a straight segment. `sea` and `air` are drawn the same way with `notAvailable: true`. Lengths are Euclidean in XY. `heading` for a zero-length leg is the previous non-zero heading, else 0.

- [ ] **Step 1: Write the failing tests:**
```ts
test('two-point line leg is straight with Mercator length', () => {
  const r = buildRoute(stopsAt([[0, 0], [90, 0]]))
  expect(r.length).toBeCloseTo(0.25, 6); expect(r.legs[0].path.at(-1)).toEqual([90, 0])
})
test('via points are passed through', () => { /* via [10,10] appears within 1e-9 in path */ })
test('crosses the antimeridian the short way', () => {
  const r = buildRoute(pacific())
  for (const [lng] of r.legs[0].path) expect(lng).toBeGreaterThanOrEqual(178.4); /* and ≤ 188.3 */
  expect(r.length).toBeLessThan(0.05)
  expect(r.bounds[1][0]).toBeCloseTo(188.2487, 3)
})
test('pointAt hits stops at leg boundaries and clamps', () => { /* pointAt(r, r.legs[0].length).at ≈ stop 1; pointAt(r, -1) = stop 0; pointAt(r, 99) = last stop */ })
test('slicePath ends exactly at the head', () => { /* last point of slicePath(r, d) equals pointAt(r, d).at */ })
test('sea leg is drawn as line and flagged', () => { /* mode sea → drawnAs 'line', notAvailable true */ })
test('zero-length leg has finite heading', () => { /* stops A, A, B → pointAt within leg 0 heading finite */ })
```

- [ ] **Step 2: Run to verify they fail.** Run: `npx vitest run test/core/route.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `src/core/geo.ts` and `src/core/route.ts`.**

- [ ] **Step 4: Run to verify they pass.** Run: `npm test`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "Add Mercator geometry and line routing"`

---

### Task 5: Timeline

**Model:** Sonnet 5.5

**Files:**
- Create: `src/core/timeline.ts`, `test/core/timeline.test.ts`

**Interfaces:**
- Consumes: `Project`, `Route`, `pointAt`.
- Produces:
  - `legSeconds(lengths: number[], travel: number): number[]`
  - `ease(kind: Camera['easing'], t: number): number`: `linear` is `t`; `smooth` is `t*t*(3-2*t)`
  - `SIGN_FADE_SECONDS = 0.4`
  - `interface FrameState { frame: number; distance: number; progress: number; travelT: number; head: { at: LngLat; heading: number }; signs: { stopId: string; opacity: number }[] }`
  - `interface Timeline { fps: Fps; totalFrames: number; durationSeconds: number; travelStartFrame: number; travelEndFrame: number; legFrames: { start: number; end: number }[]; arrivals: { stopId: string; index: number; frame: number; seconds: number }[]; stateAt(frame: number): FrameState }`
  - `buildTimeline(project: Project, route: Route): Timeline`
  - `formatTimecode(frame: number, fps: Fps): string`: `MM:SS:FF`, non-drop

`legSeconds` algorithm (the spec's 0.5 s minimum, with the total kept equal to `travel`):
```
n = lengths.length; if travel <= 0.5*n return n × [travel/n]
fixed = ∅
repeat:
  free = legs ∉ fixed; remaining = travel − 0.5·|fixed|; Lf = Σ lengths[free]
  s_i = Lf > 0 ? remaining·L_i/Lf : remaining/|free|   for i ∈ free
  newly = { i ∈ free : s_i < 0.5 }; if newly = ∅ break; fixed ∪= newly (they get 0.5)
```
Second boundaries in order: `holdStart`, then for each stop `i` the arrival at `i`, then its `pause[i]`, then leg `i`. Arrival 0 is at `holdStart`. The last stop's pause ends the travel section, and `holdEnd` follows. Each boundary converts to a frame with `round(seconds × num / den)`, from cumulative seconds and never by summing per-segment frames. `totalFrames = round(total × num/den)`. Within leg `i`: `t = (frame − start)/(end − start)`, and distance = leg start + `ease(camera.easing, t) × leg length`; when start = end, the head is at the leg's end. `travelT = clamp((frame − travelStartFrame)/(travelEndFrame − travelStartFrame), 0, 1)`. Signs: `always` is opacity 1; `on-arrival` ramps from 0 to 1 over `SIGN_FADE_SECONDS` starting at the arrival frame; `none` is omitted. `stateAt` clamps the frame to `[0, totalFrames − 1]`.

- [ ] **Step 1: Write the failing tests:**
```ts
test('legSeconds keeps the 0.5 s minimum and the total', () => {
  expect(legSeconds([1, 1, 98], 10)).toEqual([0.5, 0.5, 9])
  expect(legSeconds([1, 1], 10)).toEqual([5, 5])
  expect(legSeconds([1, 2, 3], 1)).toEqual([1/3, 1/3, 1/3])
})
test('25 fps totals and arrivals', () => {
  const p = greekIslands({ timing: { holdStart: 1, travel: 10, holdEnd: 2 } }) // Santorini pause 1
  const tl = buildTimeline(p, buildRoute(p))
  expect(tl.totalFrames).toBe(350); expect(tl.arrivals[0].frame).toBe(25); expect(tl.arrivals.at(-1)!.frame).toBe(300)
  expect(tl.travelEndFrame).toBe(300)
})
test('29.97 fps boundaries', () => {
  const p = stopsAt([[23.6466, 37.942], [25.3289, 37.4467]], { output: { aspect: '16:9', height: 1080, fps: { num: 30000, den: 1001 } } })
  const tl = buildTimeline(p, buildRoute(p))
  expect(tl.totalFrames).toBe(390); expect(tl.arrivals[0].frame).toBe(30); expect(tl.arrivals[1].frame).toBe(330)
  expect(formatTimecode(330, p.output.fps)).toBe('00:11:00')
})
test('head is at each stop on its arrival frame', () => { /* for each arrival, stateAt(frame).head.at ≈ stop.at within 1e-9 (unwrapped) */ })
test('on-arrival sign fades in over 0.4 s', () => { /* 25 fps: opacity 0 at arrival−1, 0 at arrival, 0.5 at arrival+5, 1 at arrival+10 */ })
test('zero-length leg stays finite', () => {
  const p = stopsAt([[25.33, 37.45], [25.33, 37.45], [25.43, 36.42]])
  const tl = buildTimeline(p, buildRoute(p))
  expect(tl.legFrames[0].end - tl.legFrames[0].start).toBe(Math.round(0.5 * 25))
  for (let f = 0; f < tl.totalFrames; f++) { const s = tl.stateAt(f); expect(Number.isFinite(s.distance) && Number.isFinite(s.head.heading) && Number.isFinite(s.travelT)).toBe(true) }
})
```

- [ ] **Step 2: Run to verify they fail.** Run: `npx vitest run test/core/timeline.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `src/core/timeline.ts`.**

- [ ] **Step 4: Run to verify they pass.** Run: `npm test`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "Add frame-exact timeline"`

---

### Task 6: Camera

**Model:** Opus 5.5

**Files:**
- Create: `src/core/camera.ts`, `test/core/camera.test.ts`

**Interfaces:**
- Consumes: `Project`, `Shot`, `Route`, `Timeline`, `layoutSize`, `ease`.
- Produces:
  - `TILE_SIZE = 512` (world size at zoom z = `512·2^z` layout px)
  - `fitShot(bounds: [LngLat, LngLat], aspect: Aspect, padding?: number): Shot` (padding is a fraction of each side, default 0.12; bearing 0, pitch 0; zoom clamped to 0–16; zero-size bounds give zoom 12)
  - `resolveShots(project: Project, route: Route): { start: Shot; end: Shot }` (missing shots are fitted to `route.bounds`)
  - `flyInterpolator(a: Shot, b: Shot, aspect: Aspect): (u: number) => Shot`
  - `cameraAt(project: Project, route: Route, timeline: Timeline, frame: number): Shot`

Behaviour: `fixed` uses `start` on every frame. `glide` returns `flyInterpolator(start, end)(ease(camera.easing, state.travelT))`, which holds at both ends. `follow` behaves as `glide` in stage 1. The fly path follows van Wijk & Nuij (2003) with ρ = 1.42, worked in Mercator world units with `w0` as the layout frame's larger side in world units at the start zoom. When the centres coincide, zoom interpolates linearly. Bearing takes the shortest angular path, and pitch interpolates linearly. Returned centres may be unwrapped longitudes, which MapLibre accepts.

- [ ] **Step 1: Write the failing tests:**
```ts
test('fitShot frames bounds with padding', () => {
  const s = fitShot([[23.6466, 36.4166], [28.2278, 37.942]], '16:9')
  // projecting both corners at s.zoom into a 1920×1080 frame lands inside [0.12, 0.88] of each axis, and one axis touches its padding within 1 px
})
test('fits an antimeridian route', () => {
  const p = pacific(); const { start } = resolveShots(p, buildRoute(p))
  expect(start.center[0]).toBeGreaterThan(178); expect(start.center[0]).toBeLessThan(189); expect(start.zoom).toBeGreaterThan(4)
})
test('glide holds at both ends and passes through endpoints', () => { /* cameraAt(0) == start, cameraAt(last) == end, cameraAt(travelStartFrame) == start */ })
test('fly interpolator: same centre zooms linearly', () => { /* a.zoom 4, b.zoom 8, same centre → u=0.5 zoom 6 */ })
test('bearing takes the short way', () => { /* 170 → -170 at u=0.5 is ±180 */ })
test('camera is a pure function of frame', () => {
  const seq = frames.map(f => cameraAt(p, r, tl, f)); const shuffled = [...frames].reverse().map(f => cameraAt(p, r, tl, f)).reverse()
  expect(shuffled).toEqual(seq)
})
```

- [ ] **Step 2: Run to verify they fail.** Run: `npx vitest run test/core/camera.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `src/core/camera.ts`.**

- [ ] **Step 4: Run to verify they pass.** Run: `npm test`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "Add fixed and glide cameras"`

---

### Task 7: Validation

**Model:** Haiku 5.5

**Files:**
- Create: `src/core/validate.ts`, `test/core/validate.test.ts`

**Interfaces:**
- Consumes: everything in core so far.
- Produces: `interface Issue { code: string; message: string; path?: (string|number)[]; fix?: string }`; `validateProject(project: Project): { errors: Issue[]; warnings: Issue[] }` (builds route and timeline itself; never throws for a schema-valid project).

Checks in stage 1. Codes are stable API, and every issue carries a `fix` sentence written for an agent:

| Code | Level | Condition |
|---|---|---|
| `too-few-stops` | error | `stops.length < 2` |
| `same-place` | warning | consecutive stops < 0.5 km apart (`haversineKm`); fix says merge them and use `pause` |
| `short-leg` | warning | a leg's seconds < 1 |
| `zoom-above-max` | warning | a resolved shot's zoom > `THEME_MAX_ZOOM[theme]` |
| `not-available-yet` | warning | `sea`/`air` leg (drawn as a line), `follow` camera, `terrain: true`, symbol other than `none`/`dot` |

- [ ] **Step 1: Write the failing tests:** one test per code that asserts the code appears at the right level with a `path` (for example `['stops', 1]` for `same-place`, `['legs', 0, 'mode']` for a sea leg), plus `greekIslands()` gives `{ errors: [], warnings: [] }` and an empty project gives exactly `too-few-stops`.

- [ ] **Step 2: Run to verify they fail.** Run: `npx vitest run test/core/validate.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `src/core/validate.ts`.** Also add `src/core/protocol.ts` with the studio↔server message types used in Task 9: `type ServerMessage = { type: 'project'; project: Project }` and `interface PatchRequest extends ProjectPatch {}`.

- [ ] **Step 4: Run to verify they pass.** Run: `npm test && npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "Add project validation"`

---

### Task 8: Project store

**Model:** Haiku 5.5

**Files:**
- Create: `src/server/store.ts`, `test/server/store.test.ts`

**Interfaces:**
- Consumes: `defaultProject`, `parseProject`, `Project`, `Output`.
- Produces:
  - `PROJECT_FILE = 'mapper.json'`
  - `class StoreError extends Error { fix: string }`
  - `assertAbsolute(folder: string): void`
  - `createProject(folder: string, name: string, output?: Partial<Output>): Promise<Project>`: creates the folder if missing; throws `StoreError` if `mapper.json` exists
  - `loadProject(folder: string): Promise<Project>`
  - `saveProject(folder: string, project: Project): Promise<Project>`: sets `updatedAt` to now; writes `mapper.json.<pid>.<rand>.tmp` with 2-space JSON and renames it into place
  - `mutateProject(folder: string, fn: (p: Project) => Project): Promise<Project>`: load, apply, save, serialised per folder within the process
  - `projectHash(project: Project): string`: sha256 hex of JSON with sorted keys, excluding `updatedAt`

- [ ] **Step 1: Write the failing tests** (temp dirs from `fs.mkdtemp`):
  - `creates and reloads a project in a folder with spaces and accents`: folder `<tmp>/Trips/Café Tour`; `loadProject` equals what `createProject` returned.
  - `rejects relative paths`: `createProject('trips/x', 'X')` rejects with `StoreError` whose `fix` mentions an absolute path.
  - `refuses to overwrite an existing project`.
  - `save is atomic and bumps updatedAt`: after save no `*.tmp` files remain, and `updatedAt` > the previous value.
  - `concurrent mutations serialise`: 20 parallel `mutateProject` calls each appending a stop via `setStops(replace:false)` give 20 stops.
  - `projectHash ignores updatedAt only`.

- [ ] **Step 2: Run to verify they fail.** Run: `npx vitest run test/server/store.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `src/server/store.ts`.**

- [ ] **Step 4: Run to verify they pass.** Run: `npm test`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "Add on-disk project store"`

---

### Task 9: Local server

**Model:** Sonnet 5.5

**Files:**
- Create: `src/server/server.ts`, `test/server/server.test.ts`
- Modify: `package.json` (add `ws` types if missing)

**Interfaces:**
- Consumes: store functions, `applyPatch`, `ServerMessage`, `PatchRequest`.
- Produces:
  - `startServer(opts: { studioDir: string; cacheDir: string; tileUpstream?: string }): Promise<MapperServer>`
  - `getServer(): Promise<MapperServer>`: process-wide singleton, starting on first use with `studioDir = <package>/dist/studio` and `cacheDir = $MAPPER_CACHE_DIR ?? ~/.cache/mapper`
  - `interface MapperServer { port: number; token: string; base: string /* http://127.0.0.1:<port>/<token>/ */; registerProject(folder: string): Promise<string /* project id */>; studioUrl(projectId: string, query?: Record<string, string>): string; close(): Promise<void> }`

Routes, all under `/<token>/` (anything else, or a wrong token, gets 404):
- `GET studio/*`: static files from `studioDir`, with `index.html` as fallback.
- `GET api/projects/:id` → `{ project }`.
- `POST api/projects/:id/patch` (JSON `PatchRequest`) → `{ project }`, or 400 `{ error: { message, path } }` with the file unchanged.
- WS `ws/projects/:id`: sends `{ type: 'project', project }` on connect, and again whenever `mapper.json` changes on disk.
- `GET tiles/*`: handled in Task 10. Return 404 until then.

Security: listen on `127.0.0.1` on port 0. For HTTP and WS upgrades alike, reject with 403 any request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`. The token is 32 random bytes, hex-encoded. Only registered ids resolve to folders, and no route accepts a path. File watch: `fs.watch` on the project *folder* (atomic renames replace the file), debounced 50 ms, reload, and broadcast only if `updatedAt` changed.

- [ ] **Step 1: Write the failing tests:**
  - `rejects a foreign Host header`: GET with `Host: evil.example:<port>` → 403; `Host: localhost:<port>` → 200.
  - `rejects a wrong token`: `/<other>/api/projects/<id>` → 404.
  - `unregistered project ids are 404`.
  - `patch applies and persists`: POST `{ ops: [{ op: 'update_stop', id, changes: { name: 'Pireas' } }] }` → 200; `loadProject` shows the new name.
  - `bad patch is 400 with a path and leaves the file unchanged`.
  - `pushes external edits over WebSocket`: connect, then `saveProject` from the test; receive a `project` message with the new name within 1000 ms.

- [ ] **Step 2: Run to verify they fail.** Run: `npx vitest run test/server/server.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `src/server/server.ts`.**

- [ ] **Step 4: Run to verify they pass.** Run: `npm test`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "Add local studio server with host and token checks"`

---

### Task 10: Tile proxy and disk cache

**Model:** Sonnet 5.5

**Files:**
- Create: `src/server/tiles.ts`, `test/server/tiles.test.ts`
- Modify: `src/server/server.ts` (mount at `tiles/`)

**Interfaces:**
- Consumes: `MapperServer` internals.
- Produces: `createTileProxy(opts: { cacheDir: string; upstream: string /* default https://tiles.openfreemap.org */; publicBase: () => string /* <server base>tiles/ */; maxConcurrent?: number /* 6 */; retries?: number /* 3 */ }): (subpath: string, res: ServerResponse) => Promise<void>`

Behaviour: `subpath` maps one-to-one onto the upstream path (`planet`, `planet/<ver>/<z>/<x>/<y>.pbf`, `fonts/<stack>/<range>.pbf`). It must match `^(planet(/[\w.-]+/\d+/\d+/\d+\.pbf)?|fonts/[^/]+/\d+-\d+\.pbf)$` after URL-decoding, or the proxy returns 400. That rules out path traversal and turning the proxy into an open relay. Cached copies live at `<cacheDir>/tiles/<subpath>`. The TileJSON (`planet`) is cached for 24 h and served with its `tiles` URLs rewritten to `publicBase()`. Everything else is cached forever. A semaphore caps upstream requests at `maxConcurrent`. Network errors and 5xx retry with backoff of 250 ms, 1 s and 4 s, then fail with 502. 4xx passes straight through and isn't cached. Files are written atomically. Responses carry upstream `Content-Type` and `Content-Encoding`.

- [ ] **Step 1: Write the failing tests** against a fake upstream (`node:http` on `127.0.0.1`, counting hits, with configurable failures):
  - `second request is served from disk`: two GETs, 1 upstream hit, identical bytes.
  - `rewrites TileJSON tile URLs to the local base`.
  - `rejects traversal`: `..%2F..%2Fetc%2Fpasswd` → 400 with 0 upstream hits.
  - `retries 5xx three times then 502`: upstream always 503 → 4 hits, 502.
  - `caps concurrency`: 20 parallel misses on a slow upstream → it never sees more than 6 in flight.
  - `does not cache 404`.

- [ ] **Step 2: Run to verify they fail.** Run: `npx vitest run test/server/tiles.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `src/server/tiles.ts` and mount it.**

- [ ] **Step 4: Run to verify they pass.** Run: `npm test`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "Add caching tile proxy"`

---

### Task 11: Map stage, theme and render mode

**Model:** Opus 5.5

The shared drawing code for the studio, previews and renders.

**Files:**
- Create: `src/render/capture.ts`, `src/studio/index.html`, `src/studio/main.tsx`, `src/studio/stage/themes.ts`, `src/studio/stage/MapStage.ts`, `src/studio/stage/overlay.ts`, `src/studio/render-mode.ts`, `vite.config.ts`, `tsconfig.studio.json`, `src/render/chrome.ts`, `test/e2e/stage.test.ts`, `test/e2e/helpers.ts`, `test/e2e/golden/*.png`
- Modify: `package.json` (add `react`, `react-dom`, `@fontsource/inter`, `vite`, `@vitejs/plugin-react`, `pixelmatch`, `pngjs`, types; scripts `build`, `test:e2e`)

**Interfaces:**
- Consumes: core (`buildRoute`, `buildTimeline`, `cameraAt`, `slicePath`, `layoutSize`, `MAP_CREDIT`), server `getServer`/`startServer`.
- Produces:
  - `buildStyle(theme: ThemeId, opts: { tileBase: string; labels: 'local' | 'en' }): StyleSpecification`. `paper` is a light, muted theme against the OpenMapTiles schema (layers drawn from `water`, `landcover`, `landuse`, `park`, `boundary` admin 2 and 4, `transportation` major roads only, `place` countries, cities and towns, and `water_name`; glyphs `Noto Sans Regular`/`Noto Sans Bold` from `<tileBase>fonts/{fontstack}/{range}.pbf`; no sprite). `blank` is a background layer only (`#e9e4da`), needs no network, and is used by tests. `labels: 'en'` uses `["coalesce", ["get", "name:en"], ["get", "name"]]`.
  - `class MapStage { constructor(container: HTMLElement, opts: { pixelRatio: number; interactive: boolean; tileBase: string }); load(project: Project): Promise<void>; readonly frameCount: number; readonly timeline: Timeline; showFrame(n: number, opts?: { camera?: boolean }): Promise<void>; composite(): HTMLCanvasElement; readonly map: maplibregl.Map; destroy(): void }`. The container is always `layoutSize(aspect)` CSS px. Map options: `pixelRatio`, `preserveDrawingBuffer: true`, `fadeDuration: 0`, `attributionControl: false`, `maxCanvasSize: [8192, 8192]`. `load` rebuilds the style only when theme or labels change. `showFrame` sets route data (`slicePath`) and the head point, `jumpTo(cameraAt(...))` unless `camera: false`, waits for `idle`, then redraws the overlay.
  - `drawOverlay(ctx: CanvasRenderingContext2D, args: { project: Project; state: FrameState; project2px: (p: LngLat) => [number, number]; pixelRatio: number }): void`. Draws stop dots (terminal stops 1.5× larger), `tag` signs for visible stops at their opacity, and the credit when `credit === 'burned'`. Sizes are in layout px × `pixelRatio`. `tag` design: a white rounded rectangle (radius 6, 92% opacity), Inter 600 at 26 px in `#1d2430`, padding 10/16, a 10 px pointer down to the dot, the label sitting 16 px above the dot. Credit: Inter 400 at 14 px, white at 85% with a 2 px dark shadow, 16 px from the bottom-right corner.
  - Route layers: the line follows `look.line` (`width` in layout px; dash `dashed` = `[2, 1.5]`, `dotted` = `[0.1, 1.6]` with round caps; `outline` adds a white line 2× as wide underneath; `glow` adds a 3× width, 40%-opacity, blurred line underneath). The head is a circle layer when `symbol !== 'none'`.
  - Render mode (`?mode=render`) sets `window.mapper: MapperPage`, with `interface MapperPage { ready: Promise<void>; load(project: Project, opts: { pixelRatio: number }): Promise<{ frameCount: number }>; frameCount: number; renderFrame(n: number): Promise<void> }`. `ready` resolves after `document.fonts.ready` and the Inter faces have loaded. The page has no capture code: Node captures frames over CDP (Task 12). The map container and overlay canvas sit at the top-left of the page with no margins or scrollbars, so a clip of `layoutSize` covers exactly the frame.
  - `src/render/capture.ts`: `capturePng(page: Page, args: { width: number; height: number; pixelRatio: number }): Promise<Buffer>`, using a cached CDP session and `Page.captureScreenshot({ format: 'png', optimizeForSpeed: true, clip: { x: 0, y: 0, width, height, scale: pixelRatio } })`, as in `bench/render-speed.ts`. `width` and `height` are the layout size.
  - `src/render/chrome.ts`: `launchBrowser(): Promise<{ browser: Browser; channel: 'chrome' | 'chromium'; webgl: string }>` with the launch args from `docs/render-speed.md`, trying `channel: 'chrome'` first and falling back to bundled Chromium.
  - Scripts: `"build": "tsc -p tsconfig.node.json && vite build"` (Vite `root: 'src/studio'`, `base: './'`, `outDir: '../../dist/studio'`), `"test:e2e": "npm run build && vitest run --project e2e"`.
  - `test/e2e/helpers.ts`: `openRenderPage(project: Project, pixelRatio: number): Promise<{ page: Page; close(): Promise<void> }>` (writes the project to a temp folder, registers it, opens render mode, calls `load`); `snapshot(page: Page, frame: number): Promise<Buffer>` (`renderFrame`, then `capturePng` from `src/render/capture.ts`); `pixelDiff(a: Buffer, b: Buffer): number` (count of differing pixels, pixelmatch threshold 0.1); `expectGolden(name: string, png: Buffer): void` (fails above 0.5% differing pixels; writes `test/e2e/golden/<name>.png` when `UPDATE_GOLDENS=1`).

- [ ] **Step 1: Write the failing e2e tests** in `test/e2e/stage.test.ts` (fixture `greekIslands()`, theme `blank`, no network):
```ts
test('render page loads and reports frame count', async () => {
  const { page } = await openRenderPage(greekIslands(), 0.5)
  expect(await page.evaluate(() => window.mapper.frameCount)).toBe(350)
})
test('golden frames', async () => { for (const f of [0, 175, 349]) expectGolden(`greek-${f}`, await snapshot(page, f)) })
test('frames are deterministic regardless of order', async () => {
  const a = await snapshot(page, 40); await snapshot(page, 10); const b = await snapshot(page, 40)
  expect(pixelDiff(a, b)).toBe(0)
})
test('4K canvas is 3840×2160 with pixelRatio 2', async () => { /* map canvas width/height attributes */ })
test('burned credit is drawn bottom-right', async () => { /* bottom-right 400×40 region of frame 0 differs from the same region with credit: 'description' */ })
test('paper theme draws water (MAPPER_NET only)', async () => { /* theme paper, pixel at sea near [25.0, 37.0] is bluish */ })
```

- [ ] **Step 2: Run to verify they fail.** Run: `npm run test:e2e -- test/e2e/stage.test.ts`. Expected: FAIL (build or page missing).

- [ ] **Step 3: Implement the stage, themes, overlay, render mode, Vite config and `chrome.ts`.** `main.tsx` imports `render-mode.ts` when `mode=render` and otherwise the edit app (a placeholder until Task 15). The server URL for render mode is `studioUrl(id, { mode: 'render' })`, and `tileBase` is `<server base>tiles/`.

- [ ] **Step 4: Create goldens and run again.** Run: `UPDATE_GOLDENS=1 npm run test:e2e -- test/e2e/stage.test.ts`, open the three PNGs and check them by eye (route drawn to the right point, signs readable, credit present), then `npm run test:e2e -- test/e2e/stage.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "Add map stage, paper theme and render mode"` (include the goldens).

---

### Task 12: Previews and contact sheets

**Model:** Sonnet 5.5

**Files:**
- Create: `src/render/page.ts`, `src/render/preview.ts`, `test/e2e/preview.test.ts`

**Interfaces:**
- Consumes: `launchBrowser`, `getServer`, `loadProject`, `MapperPage`, `formatTimecode`.
- Produces:
  - `class RenderPage { static open(args: { browser: Browser; projectId: string; aspect: Aspect }): Promise<RenderPage>; load(project: Project, pixelRatio: number): Promise<number /* frameCount */>; renderFrame(n: number): Promise<void>; capturePng(): Promise<Buffer> /* capture.ts at the loaded pixelRatio */; onCrash(cb: () => void): void; reload(): Promise<void>; close(): Promise<void> }`. The viewport is `layoutSize(aspect)`. Page `crash` and WebGL `webglcontextlost` (reported via `console`/`exposeFunction`) fire `onCrash`.
  - `type PreviewAt = { seconds: number } | { frame: number } | { progress: number }` and `PreviewAtSchema` (Zod; exactly one key).
  - `previewFrame(args: { folder: string; at: PreviewAt; width?: number /* 960 */ }): Promise<{ png: Buffer; path: string; frame: number; seconds: number }>`
  - `contactSheet(args: { folder: string; count?: number /* 9 */; width?: number /* 1920 */ }): Promise<{ png: Buffer; path: string; frames: { frame: number; seconds: number }[] }>`
  - `closePreviews(): Promise<void>`

Behaviour: a module-level warm browser and one `RenderPage` per aspect are reused between calls. Every call loads the project fresh from disk. `pixelRatio = width / layoutWidth`. The module exports `previewStats(): { browserLaunches: number; pageOpens: number }` for tests. `progress` maps to `round(progress × (totalFrames − 1))`, and seconds to `round(seconds × fps)`, clamped. Contact-sheet frames are `round(i × (total − 1)/(count − 1))`. The sheet is built in a second page with `setContent` of an HTML grid (`ceil(√count)` columns, cells `<img>` with captions `MM:SS:FF · f<frame>` plus the stop name when the frame is an arrival frame), then screenshotted. PNGs are saved to `<folder>/.mapper/previews/frame-<n>.png` and `contact-<timestamp>.png`.

- [ ] **Step 1: Write the failing tests:**
  - `preview at progress 0.5 is 960×540 PNG`: decode with pngjs and check the size; `frame` equals `round(0.5 × (total − 1))`.
  - `seconds and frame agree`: `{ seconds: 4 }` and `{ frame: 100 }` at 25 fps give identical PNG bytes.
  - `rejects two at keys`: `PreviewAtSchema.parse({ seconds: 1, frame: 2 })` throws.
  - `contact sheet is width 1920 with 9 frames`: PNG width 1920, `frames.length === 9`, first frame 0, last `total − 1`.
  - `second preview reuses the warm page`: after two previews, `previewStats()` is `{ browserLaunches: 1, pageOpens: 1 }`. Log both durations, but don't assert on time.

- [ ] **Step 2: Run to verify they fail.** Run: `npm run test:e2e -- test/e2e/preview.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `src/render/page.ts` and `src/render/preview.ts`.**

- [ ] **Step 4: Run to verify they pass.** Run: `npm run test:e2e -- test/e2e/preview.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "Add frame previews and contact sheets"`

---

### Task 13: Flattened render, encoder and jobs

**Model:** Opus 5.5

**Files:**
- Create: `src/render/encode.ts`, `src/render/render.ts`, `src/render/jobs.ts`, `test/render/encode.test.ts`, `test/e2e/render.test.ts`

**Interfaces:**
- Consumes: `RenderPage` (with `capturePng`), store, `validateProject`, `projectHash`, `frameSize`, `outputScale`, `MAP_CREDIT`.
- Produces:
  - `type Codec = 'prores' | 'h264'`
  - `ffmpegArgs(args: { codec: Codec; width: number; height: number; fps: Fps; out: string; h264Encoder?: 'h264_videotoolbox' | 'libx264' }): string[]`. Input `-f image2pipe -c:v png -framerate num/den -i pipe:0` (PNG frames from CDP); filter `scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709`; colour tags; `-r num/den`. ProRes: `-c:v prores_ks -profile:v 3 -vendor apl0 -pix_fmt yuv422p10le`. H.264: `-c:v h264_videotoolbox -b:v 40M` (libx264: `-crf 16 -preset medium`), `-pix_fmt yuv420p -tag:v avc1 -movflags +faststart`.
  - `class Encoder { static start(args: string[]): Encoder; write(frame: Buffer): Promise<void> /* resolves on drain */; finish(): Promise<void>; kill(): void }`. `finish` rejects with the last 20 lines of ffmpeg stderr on a non-zero exit.
  - `pickH264Encoder(): Promise<'h264_videotoolbox' | 'libx264'>` (parses `ffmpeg -hide_banner -encoders`, cached)
  - `interface RenderProgress { frame: number; totalFrames: number; fps: number; etaSeconds: number }`
  - `interface RenderResult { dir: string; video: string; manifest: string; frames: number; renderFps: number; projectHash: string }`
  - `renderProject(args: { folder: string; codec?: Codec /* 'prores' */; range?: { from: number; to: number }; onProgress?: (p: RenderProgress) => void; signal?: AbortSignal }): Promise<RenderResult>`
  - `jobs.ts`: `type JobState = 'running' | 'done' | 'failed' | 'cancelled'`; `interface RenderStatus { jobId: string; state: JobState; progress?: RenderProgress; result?: RenderResult; error?: string; dir?: string }`; `startRenderJob(args: Omit<Parameters<typeof renderProject>[0], 'onProgress' | 'signal'>): string`; `renderStatus(jobId: string): RenderStatus`; `cancelRender(jobId: string): Promise<RenderStatus>`. One render runs at a time per process, and later jobs queue (reported as `running` with no progress until they start).

`renderProject` steps: load the project once (the snapshot) and hash it. Validate, and if there are errors, throw them with fixes. Work out the frame range (seconds → `[floor(from·fps), ceil(to·fps))`, clamped). Check free disk with `fs.statfs` on the folder against an estimate of `frames × width × height × (prores ? 0.45 : 0.03) × 1.5` bytes, and throw with the needed GB if short. Create `renders/<YYYY-MM-DD-HHmmss>/`. Open a `RenderPage` in a fresh browser context at `pixelRatio = outputScale(output)`, and `load(snapshot)`. Then loop: `renderFrame(n)` and `capturePng()`, each under a 60 s timeout, check the PNG's IHDR width and height against `frameSize(output)`, and write it to the encoder. Frame *n+1* renders and captures while frame *n* is being written; at most one frame waits in Node. After the loop, finish the encoder and write `manifest.json`: `{ mapperVersion, projectId, projectHash, name, output, frameSize, codec, range: { fromFrame, toFrame }, totalFrames, durationSeconds, credit: MAP_CREDIT, creditPlacement, renderFps, chrome: { channel, webgl }, renderedAt }`. The output is `all.mov` (ProRes) or `all.mp4` (H.264). Aborting kills ffmpeg, closes the page, and leaves the folder with what exists. Progress fps is the rolling average over the last 25 frames.

- [ ] **Step 1: Write the failing tests.** `test/render/encode.test.ts` (needs ffmpeg, no Chrome; in the `unit` project because ffmpeg is a stated requirement):
```ts
test('prores args match the spec', () => {
  const a = ffmpegArgs({ codec: 'prores', width: 3840, height: 2160, fps: { num: 25, den: 1 }, out: '/x/all.mov' })
  expect(a.join(' ')).toContain('-c:v prores_ks -profile:v 3 -vendor apl0 -pix_fmt yuv422p10le')
  expect(a.join(' ')).toContain('-color_primaries bt709 -color_trc bt709 -colorspace bt709')
  expect(a.join(' ')).toContain('scale=out_color_matrix=bt709:out_range=tv')
})
test('round-trips colour through BT.709', async () => {
  // 10 PNG frames (pngjs) 256×144 of RGBA (217,71,43,255) → prores → decode first frame with
  // `ffmpeg -i out -frames:v 1 -vf scale=in_color_matrix=bt709:in_range=tv -f rawvideo -pix_fmt rgb24 -`
  // centre pixel within ±3 per channel; repeat for h264
})
test('tags 30000/1001', async () => { /* 30 frames at 30000/1001 → ffprobe r_frame_rate '30000/1001', nb_frames 30, color_space/transfer/primaries 'bt709' */ })
test('encoder failure surfaces ffmpeg stderr', async () => { /* out path in a missing dir → finish() rejects with text from stderr */ })
```
`test/e2e/render.test.ts` (fixture `greekIslands()`, `blank`, height 1080, written to a temp folder):
  - `renders a 2-second ProRes clip`: `range { from: 0, to: 2 }`; ffprobe shows `prores`, profile `HQ`, `yuv422p10le`, `1920x1080`, `25/1`, `nb_frames` 50, bt709 tags; manifest `credit === MAP_CREDIT`.
  - `renders H.264`: `codec 'h264'` gives `all.mp4`, `h264`, `yuv420p`.
  - `renders the starting snapshot`: start a job; once `progress.frame ≥ 5`, `mutateProject` to rename the project; when done, `manifest.projectHash` equals the hash taken before the job and `manifest.name` is the old name.
  - `cancel stops the job`: cancel at frame ≥ 3 → state `cancelled`, and no ffmpeg process remains (`pgrep -f <dir>` is empty).
  - `validation errors block the render`: a one-stop project rejects with `too-few-stops`.

- [ ] **Step 2: Run to verify they fail.** Run: `npx vitest run test/render/encode.test.ts && npm run test:e2e -- test/e2e/render.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `encode.ts`, `render.ts`, `jobs.ts`.**

- [ ] **Step 4: Run to verify they pass.** Run: `npm test && npm run test:e2e -- test/e2e/render.test.ts`. Expected: PASS.

- [ ] **Step 5: Measure the real pipeline at 4K.** Run a 10-second 4K 25p ProRes render of `greekIslands({ look: paper, output: default })` twice (cold, then warm cache) with a short script `bench/pipeline.ts` (`npm run bench:pipeline`). Append both `renderFps` values to `docs/render-speed.md` under `## Pipeline (Task 13)`, next to the Task 1 end-to-end figure. If warm fps is more than 25% below Task 1's end-to-end figure, report it to the user before Task 14.

- [ ] **Step 6: Commit.** `git commit -m "Add flattened ProRes and H.264 render with jobs"`

---

### Task 14: Render resilience

**Model:** Sonnet 5.5

**Files:**
- Modify: `src/render/render.ts`, `src/studio/render-mode.ts`
- Create: `test/e2e/resilience.test.ts`

**Interfaces:**
- Consumes: Task 13.
- Produces: `renderProject` gains internal segments. Manifest adds `segments: number`. Render mode's `load` opts gain `faultAtFrame?: number` (test hook: calls `WEBGL_lose_context.loseContext()` once when that frame is rendered; ignored when absent). `renderProject` args gain `faultAtFrame?: number`, passed through.

Behaviour: when the page crashes, the context is lost, `renderFrame` throws, or `capturePng` times out, the render finishes the current segment's encoder (`all.part<k>.mov`), reloads the page, re-`load`s the snapshot, and continues from the failed frame into a new segment. It allows at most 3 recoveries per render, then fails with the last error. At the end, if there is more than one segment, it joins them with `ffmpeg -f concat -safe 0 -i list.txt -c copy` into `all.mov`/`all.mp4` and deletes the parts. With a single segment, it writes straight to the final name.

- [ ] **Step 1: Write the failing test:** `recovers from a lost WebGL context`: render 2 s with `faultAtFrame: 20`; the output has exactly 50 frames, `manifest.segments === 2`, and no `*.part*` files remain.

- [ ] **Step 2: Run to verify it fails.** Run: `npm run test:e2e -- test/e2e/resilience.test.ts`. Expected: FAIL (render rejects at frame 20).

- [ ] **Step 3: Implement segments, recovery and concat.**

- [ ] **Step 4: Run to verify it passes.** Run: `npm run test:e2e -- test/e2e/resilience.test.ts test/e2e/render.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "Resume renders after a lost WebGL context"`

---

### Task 15: Studio edit mode

**Model:** Opus 5.5

**Files:**
- Create: `src/studio/edit/App.tsx`, `src/studio/edit/Stage.tsx`, `src/studio/edit/Scrubber.tsx`, `src/studio/edit/ShotPanel.tsx`, `src/studio/edit/api.ts`, `src/studio/edit/edit.css`, `test/e2e/studio.test.ts`
- Modify: `src/studio/main.tsx`

**Interfaces:**
- Consumes: `MapStage`, server routes from Task 9, `ProjectPatch`, `formatTimecode`.
- Produces: `api.ts`: `getProject(): Promise<Project>`, `patch(body: ProjectPatch): Promise<Project>`, `subscribe(onProject: (p: Project) => void): () => void` (the token and project id come from the page URL). `data-testid` hooks used by tests: `stage`, `scrubber`, `timecode`, `play`, `use-start`, `use-end`, `fit-shots`, `camera-mode`, `stop-marker-<id>`, `free-view`.

Behaviour (the spec's studio edit mode, nothing more):
- `Stage` renders `MapStage` at layout size inside a wrapper scaled with `transform: scale(fit)` and `transform-origin: 0 0` to fit the window. `pixelRatio = devicePixelRatio × fit`. Interactive.
- `Scrubber`: a range input over frames, play/pause playing at the project fps via `requestAnimationFrame` (playback may drop frames; it calls `showFrame` without awaiting idle), ticks at `timeline.arrivals` with stop names in their `title`, and a `MM:SS:FF` readout.
- Dragging a stop uses a `maplibregl.Marker({ draggable: true })` per stop. On `dragend` it calls `patch({ ops: [{ op: 'update_stop', id, changes: { at } }] })`, with `at` rounded to 5 decimals.
- Camera: any user pan or zoom detaches the camera from the timeline and shows "Free view". Scrubbing or playing re-attaches it. "Use this view as start shot" / "end shot" save `{ center, zoom, bearing, pitch }` from the map (layout zoom, so no conversion) via `set: { camera: { start } }`. "Fit to route" sets `camera: { start: null, end: null }`. A `fixed`/`glide` switcher sets `camera.mode`.
- An incoming WebSocket `project` message calls `MapStage.load` and keeps the current frame (clamped).
- Visual design: plain and quiet; the map is the focus. Use the frontend-design skill for the control bar and panel styling. Interface copy follows the writing-for-interfaces skill.

- [ ] **Step 1: Write the failing e2e tests** (open `studioUrl(id)` in Playwright at a 1280×800 viewport, fixture `blank`):
  - `scrubbing to an arrival tick shows its timecode`: set the range to Mykonos's arrival frame; `timecode` reads `formatTimecode(frame, fps)`.
  - `dragging a stop saves its new position in a scaled container`: drag `stop-marker-<Mykonos>` by (+120, +60) screen px; within 2 s, `loadProject` shows `at` equal (±1e-3) to `map.unproject` of the marker's new layout-space point, evaluated in the page. This catches CSS-transform mouse-mapping bugs.
  - `use this view as start shot saves the camera`: pan the map, click `use-start`; `camera.start.center` matches `map.getCenter()` within 1e-6, and `free-view` disappears after scrubbing.
  - `external edits appear live`: `mutateProject` renames a stop on disk; the marker's title updates within 1 s.

- [ ] **Step 2: Run to verify they fail.** Run: `npm run test:e2e -- test/e2e/studio.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement the edit app.**

- [ ] **Step 4: Run to verify they pass.** Run: `npm run test:e2e -- test/e2e/studio.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "Add studio edit mode with scrubbing, stop dragging and shots"`

---

### Task 16: MCP server

**Model:** Sonnet 5.5

**Files:**
- Create: `src/mcp/tools.ts`, `src/mcp/server.ts`, `test/mcp/tools.test.ts`, `test/e2e/mcp.test.ts`
- Modify: `package.json` (add `@modelcontextprotocol/sdk`; confirm the installed version accepts Zod 4 schemas, and if not, convert with the SDK's documented path and note it in the commit)

**Interfaces:**
- Consumes: store, `setStops`, `applyPatch`, `ProjectPatchSchema`, `StopInputSchema`, `validateProject`, `buildRoute`, `buildTimeline`, `previewFrame`, `contactSheet`, `getServer`, `startRenderJob`, `renderStatus`, `cancelRender`, `PreviewAtSchema`.
- Produces:
  - `class ToolError extends Error { fix: string }`
  - `interface ToolResult { summary: string; data: Record<string, unknown>; image?: Buffer }`
  - `interface ToolDef<I extends z.ZodObject> { name: string; description: string; input: I; run(input: z.infer<I>): Promise<ToolResult> }`
  - `TOOLS: ToolDef<any>[]`, with names in this order: `create_project`, `get_project`, `set_stops`, `update_project`, `validate_project`, `preview_frame`, `preview_contact_sheet`, `open_studio`, `render`, `render_status`, `cancel_render`
  - `createMcpServer(): McpServer`, `runStdio(): Promise<void>`

Inputs follow the spec's tool table, with Task decisions 3 and 4 and without `layers`/`import_gpx`. `render` input is `{ folder, codec?: 'prores' | 'h264', range?: { from, to } }`. Results:
- Project-changing tools return `data: { project, timeline: { durationSeconds, totalFrames, arrivals: [{ stopId, name, seconds, frame }] }, validation }`. The summary has one line per stop, `<i>. <name> [lng, lat] arrives MM:SS:FF`, then the error and warning counts and each issue's message.
- Preview tools return the PNG as MCP `image` content plus `data: { path, frame(s), seconds }`.
- `open_studio` returns `{ url }`.
- `render` returns `{ jobId, dir }`. `render_status` returns the `RenderStatus`, and its summary reads `Frame 812 of 1500 · 2.4 fps · about 4 min left`.

A `StoreError`, `ProjectError`, `ToolError` or validation failure becomes `isError: true` with the text `Error: <message>\nFix: <fix>`. Tool descriptions say when to use each tool, that coordinates are `[lng, lat]`, and that the agent should look at a contact sheet before rendering. Keep each under 400 characters and follow the writing-for-interfaces skill.

- [ ] **Step 1: Write the failing tests.** `test/mcp/tools.test.ts` uses the SDK `Client` with `InMemoryTransport` against `createMcpServer()` and a temp folder, without Chrome:
  - `lists the eleven stage-1 tools`.
  - `create → set_stops → get_project`: four stops typed in; `structuredContent.project.legs.length === 3`; the summary contains `Mykonos [25.3289, 37.4467]`.
  - `bad update returns a tool error with a fix and leaves the file unchanged`: `set: { output: { fps: { num: 7, den: 1 } } }` → `isError`, text contains `output.fps` and `Fix:`; `mapper.json` bytes unchanged.
  - `relative folder is rejected`.
  - `validate reports too-few-stops on a new project`.
  `test/e2e/mcp.test.ts` (spawns `node dist/cli/main.js mcp` with `StdioClientTransport`):
  - `agent flow end to end`: create in `<tmp>/Café Tour` → set_stops (4 stops) → update_project (`look.theme: 'blank'`, `output.height: 1080`) → validate (no errors) → preview_frame (image content) → preview_contact_sheet (image content) → open_studio (URL answers 200) → render `{ codec: 'h264', range: { from: 0, to: 2 } }` → poll render_status every 500 ms until `done` (≤ 120 s) → ffprobe `nb_frames` 50.
  - `stdout carries only protocol`: every stdout line of the child parses as JSON-RPC.

- [ ] **Step 2: Run to verify they fail.** Run: `npx vitest run test/mcp`. Expected: FAIL.

- [ ] **Step 3: Implement `src/mcp/tools.ts` and `src/mcp/server.ts`.** Add a minimal `src/cli/main.ts` that handles `mcp` only, so the e2e test can spawn it (Task 17 extends it).

- [ ] **Step 4: Run to verify they pass.** Run: `npm test && npm run test:e2e -- test/e2e/mcp.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "Add MCP server with stage-1 tools"`

---

### Task 17: CLI and doctor

**Model:** Sonnet 5.5

**Files:**
- Modify: `src/cli/main.ts`
- Create: `src/cli/doctor.ts`, `test/cli/cli.test.ts`, `test/cli/doctor.test.ts`

**Interfaces:**
- Consumes: `TOOLS`, `runStdio`, `getServer`, `renderProject`, `launchBrowser`.
- Produces:
  - Commands (parsed with `node:util` `parseArgs`): `mapper mcp`; `mapper studio <folder> [--no-open]` (registers the folder, prints the URL to stdout, runs `open <url>` on macOS unless `--no-open`, and keeps running until Ctrl-C); `mapper render <folder> [--codec prores|h264] [--from s] [--to s]` (progress lines on stderr, result JSON on stdout, exit 1 on failure); `mapper doctor`; and one command per tool, named with hyphens (`create-project`, `get-project`, `set-stops`, `update-project`, `validate-project`, `preview-frame`, `preview-contact-sheet`), taking `--json '<input>'` or `--json-file <path>`. Each prints `data` as JSON on stdout and the summary on stderr. Image results print their saved `path` rather than bytes. `mapper --help` lists every command.
  - `doctor.ts`: `interface Check { name: string; ok: boolean; level: 'error' | 'warn'; detail: string; fix?: string }`; `interface Probes { nodeVersion(): string; which(cmd: string): Promise<string | null>; ffmpegEncoders(): Promise<string>; chrome(): Promise<{ channel: 'chrome' | 'chromium'; webgl: string } | null>; freeBytes(dir: string): Promise<number> }`; `runDoctor(probes?: Probes): Promise<Check[]>`; `formatChecks(checks: Check[]): string`. Exit code 1 if any check at level `error` fails.

Checks and fixes:

| Check | Error when | Fix text |
|---|---|---|
| Node | major < 22 | `Install Node 22 or newer: brew install node` |
| ffmpeg | not found | `brew install ffmpeg` |
| ProRes encoder | `prores_ks` missing | `Install an ffmpeg build with prores_ks: brew reinstall ffmpeg` |
| H.264 encoder (warn) | neither `h264_videotoolbox` nor `libx264` | as above |
| Chrome | neither Chrome nor Playwright Chromium launches | `Install Google Chrome, or run: npx playwright install chromium` |
| WebGL (warn) | renderer matches `SwiftShader|llvmpipe|software` | `Chrome is rendering WebGL in software, so renders will be slow. Try 1080p.` |
| Disk (warn) | free < 20 GB in the cache dir's volume | `4K ProRes needs about 5.5 GB per minute.` |

- [ ] **Step 1: Write the failing tests:**
  - `doctor.test.ts`: all probes healthy → every check ok and exit code 0; `which('ffmpeg')` null → an `ffmpeg` check with `ok: false`, fix `brew install ffmpeg`, exit code 1; webgl `Google SwiftShader` → a warning, exit code 0.
  - `cli.test.ts` (spawns `node dist/cli/main.js`): `create-project --json` then `set-stops --json-file` then `validate-project` prints JSON with `errors: []`; `--help` lists `render` and `doctor`; an unknown command exits 2 with usage on stderr; a relative folder exits 1 with `Fix:` on stderr.

- [ ] **Step 2: Run to verify they fail.** Run: `npm run build && npx vitest run test/cli`. Expected: FAIL.

- [ ] **Step 3: Implement `src/cli/main.ts` and `src/cli/doctor.ts`.** Make `dist/cli/main.js` start with `#!/usr/bin/env node`.

- [ ] **Step 4: Run to verify they pass.** Run: `npm run build && npm test && node dist/cli/main.js doctor`. Expected: PASS, and on this Mac doctor reports every check ok.

- [ ] **Step 5: Commit.** `git commit -m "Add mapper CLI and doctor"`

---

### Task 18: Agent skill, docs and acceptance run

**Model:** Sonnet 5.5

**Files:**
- Create: `skills/mapper/SKILL.md`
- Modify: `AGENTS.md` (Commands section), `README.md` (Status, install and MCP setup), `docs/render-speed.md`

**Interfaces:**
- Consumes: the MCP tools and CLI.
- Produces: the documented workflow and the stage-1 acceptance evidence.

- [ ] **Step 1: Write `skills/mapper/SKILL.md`.** Frontmatter `name: mapper` and a description that triggers on requests for travel maps or route animations. Body:
  - The workflow, from the spec: fetch the trip data from wherever the user points (outside Mapper) → `create_project` → `set_stops` (travel order, sea days dropped, overnights merged into `pause`) → `validate_project` → `preview_contact_sheet` → tweak with `update_project` → `open_studio` and give the user the link → re-check the contact sheet after their edits → `render` → poll `render_status` → report output paths and the credit.
  - The rules from the spec's Agent skill section, plus `[lng, lat]` order and "never invent coordinates; look them up or ask".
  - Setup: Claude Code (`claude mcp add mapper -- node <abs path>/dist/cli/main.js mcp`), Claude Desktop (`claude_desktop_config.json` stdio entry), Codex (`~/.codex/config.toml` `[mcp_servers.mapper]`), Cursor (`.cursor/mcp.json`), plus `mapper doctor` first.
  - Run the unslop skill over the prose.

- [ ] **Step 2: Update `AGENTS.md` Commands and `README.md`.** `npm install`, `npm run build`, `npm test`, `npm run test:e2e`, `npm run bench:render`, `node dist/cli/main.js doctor`, `npm link` (puts `mapper` on PATH), and MCP registration. README Status: "Stage 1 (agent-driven MVP) built", with a link to the skill.

- [ ] **Step 3: Run the full suite.** Run: `npm run typecheck && npm test && MAPPER_NET=1 npm run test:e2e`. Expected: all PASS.

- [ ] **Step 4: Acceptance run with the user** (the stage's done-when, done for real):
  1. Register the MCP server in Claude Code and start a fresh session.
  2. The user asks: "Make a map from Piraeus to Mykonos, Santorini and Rhodes, 4K 25p", typing in the stops.
  3. The agent creates the project, sets the stops, validates, and shows a contact sheet.
  4. The agent opens the studio. The user drags at least one stop and sets a start or end shot. The agent re-checks the contact sheet and sees the change.
  5. The agent renders ProRes at the default 3840×2160 25p.
  6. Check: `ffprobe` shows `prores` HQ, 3840×2160, `25/1`, bt709 tags and the expected `nb_frames`. The clip plays in QuickTime and imports into Final Cut Pro, and the credit is visible bottom-right.

  Expected: every check passes. Record the render's `renderFps`, wall time and clip length in `docs/render-speed.md` under `## Acceptance (Task 18)`.

- [ ] **Step 5: Commit.**
```bash
git add skills AGENTS.md README.md docs/render-speed.md
git commit -m "Add Mapper agent skill and stage-1 docs"
```
