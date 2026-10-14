# Stage 2 Final Cut export implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This document is for review. Do not begin implementation until the user approves it.

**Goal:** Export a version 1 Mapper project as three aligned ProRes layers and a Final Cut Pro compound clip with roles and arrival markers, optionally accompanied by an H.264 preview.

**Architecture:** Adapt the current project to one internal scene render input. Run the existing deterministic frame loop once per requested layer, then pass an ordered array of completed scene exports to a pure FCPXML writer. Keep scene-local frame numbers, media paths, and resource identifiers separate so Stage 6 can supply several scenes without replacing the layer renderer or XML writer.

**Tech Stack:** Existing TypeScript, Zod, MapLibre, Canvas 2D, Playwright/Chrome, CDP PNG capture, ffmpeg `prores_ks`, Vitest, pngjs and pixelmatch. FCPXML 1.11, installed Apple DTD, and `xmllint`. Add `fast-xml-parser` as a development dependency for portable structural XML assertions.

**Spec:** [Mapper design, revised 2026-10-14](../specs/2026-10-13-mapper-local-agent-design.md), especially Rendering, FCPXML, Testing, and build stages 2, 3 and 6. Also read `AGENTS.md`, `docs/plan.md`, and `docs/render-speed.md`.

## Global constraints

- "Node 22 or newer."
- "Google Chrome, or Playwright's Chromium as a fallback."
- "ffmpeg with `prores_ks` (for ProRes 4444 with alpha)."
- "macOS is the primary target. Linux should work for everything except the Final Cut checks."
- "Nothing is hosted. Everything runs on the user's machine."
- "Coordinates" are "`[lng, lat]` in WGS84 (GeoJSON order)".
- Defaults: "3840×2160, 25 fps, 16:9".
- "Every output is tagged Rec.709 (`-color_primaries bt709 -color_trc bt709 -colorspace bt709`), with a frame rate of exactly `num/den`."
- "FCPXML version 1.11". Validate against `FCPXMLv1_11.dtd` from the installed Final Cut Pro bundle. Skip this check explicitly when Final Cut is absent.
- Stage 2: "One scene, as in version 1." Schema version 2 and the version 1 upgrade belong to Stage 3. Several scenes, scene tools, tabs, and public scene selection belong to Stage 6.
- "Every render must carry the map credit (OpenStreetMap contributors, OpenMapTiles, OpenFreeMap), burned in or in the description." Use the existing `MAP_CREDIT` constant.
- Keep `core` free of DOM, filesystem and network imports. Keep current security checks, tile caching, snapshot semantics and render-job serialization.
- Keep the clean-room rules in `AGENTS.md`. No proprietary assets, connectors, private trip data or credentials.
- Run `npm test` and `npm run test:e2e` sequentially. Unit CLI tests rebuild `dist`.

---

## Starting point and scope decisions

Stage 1 was verified on 2026-10-14 at `174233c0baf326071b9dbf0068efd065cd4a3735`: `npm test` passed 341 tests; `npm run test:e2e` passed 54 with 2 skipped. The branch was fast-forwarded into `main` and pushed. The working repository is `aloftandaway-mapper`, not the separate T3 `travel-map` scaffold.

The existing renderer already has snapshot loading, backpressure, exact frame ranges, bounded page recovery, segment concatenation and cancellation. Extend those behaviours instead of making a second frame loop. `docs/render-speed.md` records the approved CDP PNG capture decision, including a successful alpha benchmark. Keep that pipeline and layout-size/device-scale arrangement. The spec's raw RGBA/WebSocket transport is superseded by that measured Stage 1 decision.

Public interface decisions for this stage:

- Preserve an omitted `layers` as `['all']`, preserving Stage 1 callers and `result.video`. The new documented Final Cut command explicitly requests `['map', 'route', 'signs']`.
- `layers?: ('map' | 'route' | 'signs' | 'preview' | 'all')[]`. Reject empty lists, duplicates and unknown names. Normalize execution order to map, route, signs, all, preview.
- `codec` continues to control only the legacy `all` output, defaulting to ProRes. Isolated layers require ProRes; reject `codec: 'h264'` with any of map/route/signs. `preview` always means H.264. Reject `all` together with `preview` to avoid duplicate composites. `preview` alone is supported.
- Generate FCPXML when all three isolated layers are requested and completed. A subset is a valid layer render, but has no FCPXML. Explain this in CLI help and MCP descriptions.
- `range` keeps its current seconds-to-frame semantics. All passes share the same `[fromFrame, toFrame)`. Captured source frames retain their original timing; encoded clips start at zero. Include only arrivals inside that half-open range and subtract `fromFrame` for markers.
- Layer files go under `01-<project-slug>/`. The one scene uses the project id and name internally. XML compound name follows the specified `<project> · <scene>` rule, even when both names match.
- Optional `preview.mp4`, `<project-slug>.fcpxml` and `manifest.json` sit at the render root. Legacy `all.mov`/`all.mp4` remain at the root.
- No public `scene` or `scenes` arguments, no project migration, no route editing, no terrain implementation or new looks. Do not delete map sources when hiding layers; later terrain work must be able to retain its data.

## Files and boundaries

| File | Responsibility |
|---|---|
| `src/core/protocol.ts` | Shared `RenderLayer` union and serializable render-page options, without Node/DOM imports |
| `src/render/export-plan.ts` | Version 1 adapter, normalized pass list, frame ranges and safe output names |
| `src/render/export-types.ts` | Internal scene input, completed asset and result contracts |
| `src/studio/stage/MapStage.ts` | Layer visibility with unchanged timeline and camera |
| `src/studio/stage/overlay.ts` | Route dots, signs and map credit drawn according to the selected pass |
| `src/studio/render-mode.ts`, `src/render/page.ts`, `src/render/capture.ts` | Carry layer selection and preserve transparency through capture |
| `src/render/encode.ts` | Explicit 422 HQ/4444 selection and existing H.264 support |
| `src/render/render-pass.ts` | Extracted recoverable single-pass frame loop |
| `src/render/render.ts` | Snapshot, pass orchestration, disk budget, aggregate progress and result |
| `src/render/manifest.ts` | Atomic progress/completion manifest with per-scene/per-layer records |
| `src/render/fcpxml.ts` | Pure XML serialization from completed scene exports |
| `src/render/fcpxml-validation.ts` | Locate installed DTD and run local `xmllint` |
| `src/render/jobs.ts` | Job result/progress types and finished outputs on cancellation |
| `src/mcp/tools.ts`, `src/cli/main.ts` | Layer options and readable output paths |
| `src/cli/doctor.ts` | Optional DTD/xmllint diagnostics |
| `test/render/*.test.ts`, `test/e2e/*.test.ts` | Unit contracts, real alpha/encoding checks, recovery and integration |
| `README.md`, `skills/mapper/SKILL.md`, `docs/final-cut-export.md` | User commands, credits, import and acceptance record |

No unrelated restructuring of the studio or store. Start implementation on a Stage 2 branch from the verified `main` only after approval.

## Shared contracts

Task 1 creates these definitions; all later tasks use these exact names. `Project`, `Output`, `Fps`, `Stop` and `Timeline` refer to existing core exports.

```ts
// src/core/protocol.ts
export type RenderLayer = 'map' | 'route' | 'signs' | 'all'
export interface RenderPageOptions {
  layer?: RenderLayer
  faultAtFrame?: number
  faultAfterRenderFrame?: number
}

// src/render/export-types.ts
export type LayerRequest = RenderLayer | 'preview'
export type MediaKind = 'prores-hq' | 'prores-4444' | 'h264'
export interface SceneRenderInput {
  id: string
  name: string
  output: Output
  credit: Project['credit']
  content: Pick<Project, 'timing' | 'stops' | 'legs' | 'look' | 'camera'>
}
export interface ExportMarker { frame: number; value: string }
export interface SceneExport {
  id: string
  name: string
  frames: number
  sourceRange: { fromFrame: number; toFrame: number }
  layers: { map: string; route: string; signs: string } // absolute paths
  markers: ExportMarker[] // clip-local whole frames
}
export interface RenderPass {
  sceneId: string
  layer: RenderLayer
  kind: MediaKind
  path: string // relative to the render directory
  fromFrame: number
  toFrame: number
}
export interface CompletedPass extends RenderPass {
  frames: number
  segments: number
  recoveries: number
}
export interface ExportPlan {
  scenes: SceneRenderInput[]
  passes: RenderPass[]
  fcpxml: boolean
}
export interface FcpxmlInput {
  projectName: string
  output: Output
  credit: Project['credit']
  scenes: SceneExport[]
}
```

The FCPXML input always uses an array. Its implementation must iterate over every item and allocate document-wide resource ids. Test two synthetic scene exports now. The version 1 adapter alone guarantees a one-element input today. Stage 6 will replace that adapter and expose scene selection; it will not have to invent a new XML data model. The layer renderer accepts one `SceneRenderInput` at a time and contains no first-scene assumptions.

`toPageProject(scene: SceneRenderInput): Project` is a temporary boundary adapter for the existing browser/core APIs. It restores version 1 metadata using `id`, `name`, `schemaVersion: 1`, and fixed valid ISO timestamps. Those timestamps are not render inputs and must not affect the snapshot hash. The top-level original project hash remains the manifest's provenance. Stage 3 can replace this browser adapter without changing the XML writer.

## Task 1: Define export planning and scene boundaries

**Model:** Sonnet 5.5 (`sonnet`), as required by `AGENTS.md` for bounded multi-file work.

**Files:** Create `src/render/export-types.ts`, `src/render/export-plan.ts`, `test/render/export-plan.test.ts`. Modify `src/core/protocol.ts` and `src/core/index.ts` to export shared types. Keep `src/core/schema.ts` unchanged.

**Interfaces:** Produce `adaptV1Scene(project: Project): SceneRenderInput`, `toPageProject(scene: SceneRenderInput): Project`, `slug(value: string): string`, `planExport(project: Project, args: { layers?: LayerRequest[]; codec?: Codec; range?: { from: number; to: number } }): ExportPlan`, and `sceneMarkers(stops: Stop[], arrivals: Timeline['arrivals'], range: { fromFrame: number; toFrame: number }): ExportMarker[]`. Consume existing `frameRange`, `buildRoute`, and `buildTimeline`.

- [ ] Write tests including the following cases. Import `greekIslands` from `test/fixtures/projects.ts`.

```ts
test('adapts a v1 project without changing its schema', () => {
  const project = greekIslands()
  const before = structuredClone(project)
  const plan = planExport(project, { layers: ['map', 'route', 'signs'] })
  expect(plan.scenes).toHaveLength(1)
  expect(plan.scenes[0].id).toBe(project.id)
  expect(plan.passes.map(p => [p.layer, p.kind, p.path])).toEqual([
    ['map', 'prores-hq', '01-greek-islands/map.mov'],
    ['route', 'prores-4444', '01-greek-islands/route.mov'],
    ['signs', 'prores-4444', '01-greek-islands/signs.mov'],
  ])
  expect(plan.fcpxml).toBe(true)
  expect(project).toEqual(before)
  expect(toPageProject(plan.scenes[0]).schemaVersion).toBe(1)
})
test('rebases only arrivals inside the requested range', () => {
  const p = greekIslands()
  const arrivals = [
    { stopId: p.stops[0].id, index: 0, frame: 24, seconds: .96 },
    { stopId: p.stops[1].id, index: 1, frame: 25, seconds: 1 },
    { stopId: p.stops[2].id, index: 2, frame: 49, seconds: 1.96 },
    { stopId: p.stops[3].id, index: 3, frame: 50, seconds: 2 },
  ]
  expect(sceneMarkers(p.stops, arrivals, { fromFrame: 25, toFrame: 50 })
    .map(m => m.frame)).toEqual([0, 24])
})
```

- [ ] Run `npm test -- test/render/export-plan.test.ts`. Expect failure for missing exports.
- [ ] Implement the contracts above. Build one timeline from the scene content via `toPageProject`. Reuse `frameRange` without changing its boundary behaviour. If importing it from `render.ts` introduces a cycle, move it unchanged into `export-plan.ts` and re-export from `render.ts` for existing callers.

```ts
export function adaptV1Scene(p: Project): SceneRenderInput {
  return { id: p.id, name: p.name, output: p.output, credit: p.credit,
    content: { timing: p.timing, stops: p.stops, legs: p.legs,
      look: p.look, camera: p.camera } }
}
export function slug(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 80).replace(/-$/, '') || 'project'
}
// Within sceneMarkers, after filtering range boundaries:
const value = stop.label ?? (stop.day !== undefined
  ? `Day ${stop.day} · ${stop.name}` : stop.name)
const marker = { frame: arrival.frame - range.fromFrame, value }
```

- [ ] Add table tests for legacy defaults, H.264/all, preview-only, full layers plus preview, partial exports, duplicate/empty/unknown layers, H.264 rejection for isolated passes, unsafe names, non-Latin fallback and fractional rates. Verify marker labels prefer explicit `label`, then day/name, then name, including XML punctuation.
- [ ] Run `npm test -- test/render/export-plan.test.ts test/core/schema.test.ts` and `npm run typecheck`. Expect pass and no schema migration.
- [ ] Commit only these files: `git commit -m "feat: define layer export plans and scene inputs"` after explicitly staging them.

## Task 2: Render isolated layers and capture real transparency

**Model:** Opus 5.5 (`opus`), GPU/compositing work.

**Files:** Modify `src/studio/stage/MapStage.ts`, `src/studio/stage/overlay.ts`, `src/studio/render-mode.ts`, `src/render/page.ts`, `src/render/capture.ts`, `test/e2e/helpers.ts`. Create `test/e2e/layers.test.ts`.

**Interfaces:** `MapStageOptions.layer?: RenderLayer`; `OverlayArgs.layer?: RenderLayer`; extend `RenderPage.load(project, pixelRatio, opts: RenderPageOptions)` and the browser's `load` options with `layer`. Extend `capturePng` arguments with `transparent?: boolean`, default false. Extend `openRenderPage` options with `layer?: RenderLayer`; its existing `snapshot` retains the selected transparency mode.

- [ ] Add failing layer tests using `greekIslands`, `openRenderPage`, `snapshot`, `PNG.sync.read` and existing `pixelDiff`.

```ts
test('route has transparent background and visible geometry', async () => {
  const view = await openRenderPage(greekIslands(), 1, { layer: 'route' })
  try {
    const png = PNG.sync.read(await snapshot(view.page, 175))
    const alpha = Array.from(png.data).filter((_, i) => i % 4 === 3)
    expect(alpha[0]).toBe(0)
    expect(alpha.some(a => a === 255)).toBe(true)
    expect(alpha.some(a => a > 0 && a < 255)).toBe(true)
  } finally { await view.close() }
})
```

- [ ] Run `npm run test:e2e -- test/e2e/layers.test.ts`. Expect failure because the option has no effect yet.
- [ ] Partition drawing by pass. Base map layers remain visible for map/all. Route layers remain visible for route/all. Signs pass hides both sets, keeping the map alive for projection and the same camera calculation. Cache original basemap visibility on style load, restore original values when selecting map/all, and reapply pass visibility after route layers are rebuilt. Recreate the stage when its layer or pixel ratio changes so warm previews cannot inherit a route-only page. Default edit and preview pages to all.

```ts
const layer = args.layer ?? 'all'
const dots = layer === 'route' || layer === 'all'
const signs = layer === 'signs' || layer === 'all'
const credit = (layer === 'map' || layer === 'all') && project.credit === 'burned'
// Keep the existing clear/reset once, then run the existing drawing loops
// under dots/signs/credit respectively. Keep all current stop dots on route.
```

Keep existing stop-dot behaviour, including terminal dots. The route pass owns dots, the moving symbol, glow, outline and line. Signs owns only sign artwork/text. Credit belongs only to map/all. Do not change timing, camera or sign fade equations. Keep sources loaded; hiding a layer must never remove terrain data when Stage 5 adds it.

- [ ] Preserve page transparency with the benchmarked CDP call before capture. Set it on every capture so switching back to an opaque page clears the override. Keep CSS backgrounds transparent in render mode and hide the map canvas visually for signs only while still updating its projection.

```ts
await cdp.send('Emulation.setDefaultBackgroundColorOverride',
  args.transparent ? { color: { r: 0, g: 0, b: 0, a: 0 } } : {})
```

- [ ] Add a test-side source-over PNG compositor. For each pixel use `outA = srcA + dstA * (1 - srcA)` and unpremultiplied RGB `(srcRGB*srcA + dstRGB*dstA*(1-srcA))/outA`, rounding once per layer. Composite map, route, signs in order. Compare to all at frames 0, 175, 349 with existing pixelmatch threshold 0.1 and at most 0.5% differing pixels. Include glow, translucent signs, a sign mid-fade, fixed/glide camera, 1080p and one 4K frame, plus burned/description credit. Assert alpha 0 in empty signs frames and alpha 255 across map frames. Verify description credit is absent from map/all. Verify warm route→all and all→signs loads do not leak visibility.
- [ ] Add a `test.skipIf(process.env.MAPPER_NET !== '1')` case in `test/e2e/layers.test.ts` that changes the fixture theme to `paper`, captures map/route/signs/all at frame 175, and repeats the source-over comparison. It must exercise real tiles and remain separate from the offline blank-theme cases.
- [ ] Run `npm run test:e2e -- test/e2e/layers.test.ts test/e2e/stage.test.ts test/e2e/preview.test.ts`, then `npm run typecheck`. Existing goldens must pass without being refreshed to conceal a regression.
- [ ] Commit the listed files with `feat: render separate map route and signs passes`.

## Task 3: Encode alpha-preserving ProRes 4444

**Model:** Opus 5.5 (`opus`), colour and alpha pipeline.

**Files:** Modify `src/render/encode.ts`, `test/render/encode.test.ts`.

**Interfaces:** Extend `ffmpegArgs` with `proresProfile?: 'hq' | '4444'`, default `'hq'`. Keep public `Codec = 'prores' | 'h264'`. `MediaKind` maps to these encoding arguments inside the pass renderer.

- [ ] Add argument and real ffmpeg tests. Reuse current temporary-folder, `solidPng`, `Encoder` and `ffprobe` helpers.

```ts
test('4444 explicitly keeps alpha', () => {
  const args = ffmpegArgs({ codec: 'prores', proresProfile: '4444',
    width: 256, height: 144, fps: { num: 24000, den: 1001 }, out: '/tmp/route.mov' })
  expect(args.join(' ')).toContain('-profile:v 4')
  expect(args.join(' ')).toContain('-pix_fmt yuva444p10le')
  expect(args.join(' ')).toContain('-alpha_bits 16')
})
```

- [ ] Run `npm test -- test/render/encode.test.ts` and confirm the new case fails.
- [ ] Branch only ProRes codec arguments. Keep the existing colour filter and Rec.709 tags. Do not insert a format conversion that drops alpha.

```ts
const proresArgs = args.proresProfile === '4444'
  ? ['-c:v', 'prores_ks', '-profile:v', '4', '-vendor', 'apl0',
      '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16']
  : ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0',
      '-pix_fmt', 'yuv422p10le']
```

- [ ] Encode a 256×144 RGBA fixture with vertical bands of alpha 0, 128 and 255 and RGB `[217, 71, 43]`. Decode with ffmpeg to RGBA using the existing inverse BT.709 conversion. Assert center alpha values within 1 and nontransparent RGB within 3. Composite decoded pixels over white and black; compare to original RGBA composites within 4 per channel. This catches premultiplication errors that profile checks miss. Probe codec `prores`, profile `4444`, decoded pixel format with alpha, exact rational rate, frame count and colour tags. Do not require ffprobe to return `yuva444p10le`; ProRes decoding may expose 12-bit pixels.
- [ ] Test 25/1, 24000/1001 and 30000/1001 and lossless concatenation of two alpha segments. Keep existing HQ/H.264 tests.
- [ ] Run `npm test -- test/render/encode.test.ts`, then `npm run typecheck`. Commit with `feat: encode transparent layers as ProRes 4444`.

## Task 4: Generalize the recoverable pass loop and record completed layers

**Model:** Opus 5.5 (`opus`), concurrency and recovery.

**Files:** Create `src/render/render-pass.ts`, `src/render/manifest.ts`, `test/render/manifest.test.ts`, `test/e2e/layer-render.test.ts`. Modify `src/render/render.ts`, `src/render/jobs.ts`, `test/e2e/resilience.test.ts` and `test/e2e/render.test.ts`.

**Interfaces:** Produce `renderPass(args: { browser: Browser; scene: SceneRenderInput; pass: RenderPass; dir: string; signal?: AbortSignal; onFrame?: (completed: number) => void; faultAtFrame?: number; faultAfterRenderFrame?: number }): Promise<CompletedPass>`. Create `writeManifest(file: string, value: ExportManifest): Promise<void>`. Extend `RenderArgs` with `layers?: LayerRequest[]`; keep old fault hooks applied only to the first pass, and add test-only `faultLayer?: RenderLayer` to target recovery after map completion.

Keep `RenderResult`'s legacy fields, make `video?: string`, and add `outputs: CompletedPass[]`, `scenes: SceneExport[]`, `fcpxml?: string`, `preview?: string`. `frames` remains timeline duration in frames, not multiplied by pass count. `RenderProgress.frame/totalFrames` count completed frame-pass work across the export, with optional `sceneId` and `layer`. `outputs` paths in results must be absolute; plan/manifest paths remain relative. Define a separate result mapping type `CompletedOutput = Omit<CompletedPass, 'path'> & { path: string }` to document this distinction.

- [ ] Add a failing real export test using the existing temporary project pattern. Render a two-second range of the blank fixture with map/route/signs. Assert three expected files, exactly 50 frames each, HQ/4444/4444 profiles, shared source range, one project hash, no `all.mov`, and aggregate progress ending at 150/150. Add a legacy flattened test expecting unchanged `video` and `all.mov`.
- [ ] Run `npm run test:e2e -- test/e2e/layer-render.test.ts`. Expect new layer assertions to fail.
- [ ] Extract the existing frame-loop code into `renderPass`, preserving its timeout, PNG size validation, context-loss-after-capture check, one-frame backpressure and three-recovery cap. Use pass-local segment paths such as `route.part1.mov` and pass-local concat list files. Reload the same snapshot, scene and layer on recovery. Source-frame `n` increments only after a successful capture and write dispatch. Await the prior write before finishing any segment. Encoder failures abort; they are not mistaken for recoverable page errors. Keep Chrome lifetime at the orchestrator and page/context lifetime within the pass.

```ts
// renderProject orchestration after snapshot validation and plan creation:
for (const pass of plan.passes) {
  const scene = plan.scenes.find(s => s.id === pass.sceneId)
  if (!scene) throw new Error(`Missing scene ${pass.sceneId}`)
  const done = await renderPass({ browser, scene, pass, dir, signal,
    onFrame: n => report(baseCompleted + n) })
  completed.push(done)
  baseCompleted += done.frames
  await writeManifest(manifestPath, makeManifest('running'))
}
```

`report` and `makeManifest` are local closures in `renderProject`: `report(done: number)` emits the existing rolling progress plus active scene/layer; `makeManifest(status: ExportManifest['status'])` populates the following defined manifest. They must use the original in-memory project, never reread `mapper.json` between passes.

```ts
export interface ExportManifest {
  manifestVersion: 2
  mapperVersion: string
  projectId: string
  projectHash: string
  name: string
  output: Output
  frameSize: { width: number; height: number }
  credit: string
  creditPlacement: Project['credit']
  status: 'running' | 'done' | 'cancelled' | 'failed'
  scenes: { id: string; name: string; range: { fromFrame: number; toFrame: number } }[]
  outputs: CompletedPass[]
  totalFrames: number
  completedWorkFrames: number
  totalWorkFrames: number
  durationSeconds: number
  renderedAt: string
  renderFps: number
  chrome?: { channel: string; webgl: string }
  fcpxml?: string
  fcpxmlValidation?: 'passed' | 'skipped-no-fcp'
  error?: string
}
```

Retain legacy manifest fields `codec`, `range`, `segments`, `recoveries`, `cancelled`, and `framesDone` for all-only renders so existing consumers/tests remain valid. They can be optional fields on `ExportManifest`; multi-pass records use per-output counters. Initial manifest exists before rendering. Rewrite it after each completed layer and on terminal failure/cancellation, using a sibling temporary file followed by rename.

- [ ] Budget disk for every requested output, plus segment-join peak space. Keep current HQ/H.264 estimates; use a conservative 2 bytes/pixel/frame for 4444 with the existing 1.5 margin. Estimate final files plus the largest pass again for concat's temporary destination. Report required/free space and suggest reducing resolution/range. Do not suggest H.264 as a substitute for transparent layers.
- [ ] Expose completed output records in `RenderStatus` during running/cancelled/failed states via a new optional `onOutput?: (output: CompletedOutput) => void` callback on `RenderArgs`. Invoke only after successful finish/rename and manifest write. Job bookkeeping copies these records. Cancellation kills the active encoder and browser, preserves completed layers, marks the manifest cancelled, and publishes no FCPXML. Failed passes remain `.part` files and never appear in completed output records.
- [ ] Add recovery tests for route after map completion, capture-time context loss, failure on the first frame, and exhausted retries. Compare a recovered route to a clean route using decoded alpha and frame count. Cancel while signs is running and probe the finished map/route. Edit the on-disk project between map and route and verify every pass and marker uses the original snapshot/hash. Check a second queued job still waits. Test manifest rename failures and encoder failure cleanup using injected filesystem/process failures in unit tests.
- [ ] Run `npm test -- test/render/manifest.test.ts`, then `npm run test:e2e -- test/e2e/layer-render.test.ts test/e2e/resilience.test.ts test/e2e/render.test.ts`, then `npm run typecheck`. Commit with `feat: orchestrate recoverable layer exports`.

## Task 5: Write FCPXML from an ordered scene export list

**Model:** Opus 5.5 (`opus`), format design and frame maths.

**Files:** Create `src/render/fcpxml.ts`, `test/render/fcpxml.test.ts`. Modify `package.json` and `package-lock.json` for the test-only XML parser.

**Interfaces:** `frameTime(frames: number, fps: Fps): string`; `writeFcpxml(input: FcpxmlInput): string`. No browser or filesystem calls in this writer. Use Node's `pathToFileURL` for absolute media paths. Task 7 supplies completed `SceneExport[]`.

- [ ] Install the development XML parser with `npm install --save-dev fast-xml-parser`. Add tests with `XMLValidator.validate` and `XMLParser({ ignoreAttributes: false })`. Use independent fixture data, not the writer to generate expected XML.

```ts
test('uses exact fractional frame times', () => {
  expect(frameTime(1, { num: 24000, den: 1001 })).toBe('1001/24000s')
  expect(frameTime(48, { num: 24000, den: 1001 })).toBe('1001/500s')
  expect(frameTime(0, { num: 25, den: 1 })).toBe('0s')
})
```

Create two scene fixtures directly in this test with ids `a` and `b`, names `Drive` and `Sail`, durations 50 and 75 frames, three absolute `.mov` paths each, and arrival markers at frames 0 and 24. Both use the common output at 25 fps. Assert six assets, two media resources, unique ids, resolved references, two event browser refs, and two project refs at offsets `0s` and `2s`, with project duration `5s`. Repeat at 24000/1001 and with range-rebased markers.

- [ ] Run `npm test -- test/render/fcpxml.test.ts`. Expect missing writer failures.
- [ ] Implement rational times using BigInt multiplication and greatest-common-divisor reduction. Reject noninteger/negative/unsafe frame counts and invalid fps values before conversion. Use `0s` for zero. Validate each marker is an integer in `[0, scene.frames)`, scene ids are unique, paths are absolute, the scene list is nonempty, and each clip duration is positive. A malformed internal export must fail before emitting XML.

```ts
export function frameTime(frames: number, fps: Fps): string {
  if (!Number.isSafeInteger(frames) || frames < 0 ||
      !Number.isSafeInteger(fps.num) || fps.num <= 0 ||
      !Number.isSafeInteger(fps.den) || fps.den <= 0) {
    throw new RangeError('Frame time requires nonnegative integer frames and positive integer fps.')
  }
  if (frames === 0) return '0s'
  const n = BigInt(frames) * BigInt(fps.den)
  const d = BigInt(fps.num)
  let a = n, b = d
  while (b !== 0n) { const r = a % b; a = b; b = r }
  return d / a === 1n ? `${n / a}s` : `${n / a}/${d / a}s`
}
```

- [ ] Implement a small serializer with XML 1.0 character sanitization and escaping of `& < > " '`. Remove illegal control characters, preserve valid Unicode, and XML-escape the URL after `pathToFileURL(...).href`. Do not construct file URLs by string concatenation. Allocate resource ids sequentially across the document, not from scene names or unsanitized UUIDs.

The exact structural pattern below is validated by the installed v1.11 DTD. Assets contain `media-rep`; `<media>` belongs under `<resources>`, while event `ref-clip`s expose compound clips in the browser. There is no invented `alpha` XML attribute: alpha is in the 4444 media.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.11">
  <resources>
    <format id="r1" width="1920" height="1080" frameDuration="1/25s" colorSpace="1-1-1 (Rec. 709)"/>
    <asset id="r2" name="Map" start="0s" duration="2s" hasVideo="1" hasAudio="0" format="r1">
      <media-rep kind="original-media" src="file:///tmp/map.mov"/>
    </asset>
    <asset id="r3" name="Route" start="0s" duration="2s" hasVideo="1" hasAudio="0" format="r1">
      <media-rep kind="original-media" src="file:///tmp/route.mov"/>
    </asset>
    <asset id="r4" name="Signs" start="0s" duration="2s" hasVideo="1" hasAudio="0" format="r1">
      <media-rep kind="original-media" src="file:///tmp/signs.mov"/>
    </asset>
    <media id="r5" name="Trip · Drive">
      <sequence format="r1" duration="2s" tcStart="0s" tcFormat="NDF">
        <note>Credit text goes here only for description placement.</note>
        <spine>
          <asset-clip ref="r2" name="Map" offset="0s" start="0s" duration="2s" videoRole="Map.Base">
            <asset-clip ref="r3" name="Route" lane="1" offset="0s" start="0s" duration="2s" videoRole="Map.Route"/>
            <asset-clip ref="r4" name="Signs" lane="2" offset="0s" start="0s" duration="2s" videoRole="Map.Signs"/>
            <marker start="24/25s" duration="1/25s" value="Day 2 · Port"/>
          </asset-clip>
        </spine>
      </sequence>
    </media>
  </resources>
  <library>
    <event name="Mapper">
      <ref-clip ref="r5" name="Trip · Drive" start="0s" duration="2s"/>
      <project name="Trip">
        <sequence format="r1" duration="2s" tcStart="0s" tcFormat="NDF">
          <spine><ref-clip ref="r5" name="Trip · Drive" offset="0s" start="0s" duration="2s"/></spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
```

This is a structural example, not literal production output. Emit actual `MAP_CREDIT` in the sequence note only for description placement. Markers follow connected clips because the DTD specifies child ordering. Map sits on the primary spine; route/signs are connected to it on lanes 1 and 2. Each scene starts at zero inside its compound. Joined project offsets are accumulated integer frame counts converted only at serialization. Stage 2 always writes the joined project. Defer an `each` public mode to Stage 6.

- [ ] Test special characters and Unicode in project/scene/marker names and filenames, paths containing spaces/#/%/apostrophes, duplicate names with distinct ids, credit placement, all supported output aspects and rates, last-frame markers, zero-frame markers and out-of-range rejection. Assert no missing asset refs and no guessed standard-format name for custom dimensions.
- [ ] Run `npm test -- test/render/fcpxml.test.ts`, then `npm run typecheck`. Commit with `feat: serialize scene compounds and arrival markers to FCPXML`.

## Task 6: Validate XML with the installed Apple DTD

**Model:** Sonnet 5.5 (`sonnet`), bounded process integration.

**Files:** Create `src/render/fcpxml-validation.ts`, `test/render/fcpxml-validation.test.ts`, `test/e2e/fcpxml.test.ts`. Modify `src/cli/doctor.ts` and `test/cli/doctor.test.ts`.

**Interfaces:** `findFcpxmlDtd(appPath?: string): Promise<string | undefined>`; `validateFcpxml(file: string, options?: { dtdPath?: string }): Promise<'passed' | 'skipped-no-fcp'>`. The optional explicit path supports isolated tests; runtime defaults to the installed app.

- [ ] Add tests for missing app, readable v1.11 DTD, malformed XML, well-formed XML with a DTD-invalid child/attribute, missing `xmllint`, and a valid two-scene document from Task 5. Mock process execution only in unit tests. The e2e test must execute the real validator and skip with a clear reason only when the installed DTD is absent.
- [ ] Run `npm test -- test/render/fcpxml-validation.test.ts`. Expect missing-module failure.
- [ ] Locate the exact versioned resource below, with a second candidate under `Versions/Current/Resources`. Never silently substitute v1.14. Do not copy Apple's DTD into this public repository.

```ts
const dtd = path.join(appPath ?? '/Applications/Final Cut Pro.app',
  'Contents/Frameworks/Interchange.framework/Versions/A/Resources/FCPXMLv1_11.dtd')
await promisify(execFile)('xmllint', ['--nonet', '--noout', '--dtdvalid', dtd, file])
```

Return `'skipped-no-fcp'` if neither candidate is present. With an explicit `dtdPath`, missing/unreadable files are errors. If FCP/DTD exists but `xmllint` is missing, throw `EnvironmentError` with a concrete installation fix such as installing libxml2 and adding its bin directory to PATH. A validation failure is fatal for XML publication and includes stderr; completed videos remain available. Use argument arrays, never a shell command containing user paths.

- [ ] Extend `Probes` and doctor tests with DTD/xmllint availability. Report these as warnings for general Mapper use, because flattened rendering works without Final Cut. Explain skipped validation rather than claiming that the XML is validated. Do not make Final Cut a Linux runtime requirement.
- [ ] Run `npm test -- test/render/fcpxml-validation.test.ts test/cli/doctor.test.ts`, followed by `npm run test:e2e -- test/e2e/fcpxml.test.ts`. Expected on this Mac: DTD test runs and passes. Commit with `feat: validate FCPXML against the installed Apple DTD`.

## Task 7: Publish exports through render, MCP and CLI

**Model:** Sonnet 5.5 (`sonnet`), application integration.

**Files:** Modify `src/render/render.ts`, `src/render/jobs.ts`, `src/mcp/tools.ts`, `src/cli/main.ts`, `test/mcp/tools.test.ts`, `test/mcp/errors.test.ts`, `test/cli/cli.test.ts`, `test/e2e/mcp.test.ts`, `test/e2e/layer-render.test.ts`.

**Interfaces:** Use Task 1 `planExport` and `sceneMarkers`, Task 4 outputs/status, Task 5 `writeFcpxml` and Task 6 `validateFcpxml`. Extend CLI with `--layers map,route,signs[,preview]`. MCP accepts the same names as an array. Keep `render_status` and `cancel_render` job ids unchanged.

- [ ] Add failing API tests for layers, invalid combinations, unknown future `scenes` input, progress/result paths and cancellation outputs. Extend the existing MCP SDK e2e to render a two-second layered fixture and inspect the FCPXML and three media outputs.

```ts
// Schema shared by the render tool's input and its tests:
const layers = z.array(z.enum(['map', 'route', 'signs', 'all', 'preview']))
  .min(1).refine(xs => new Set(xs).size === xs.length,
    'Each layer may be requested only once').optional()
// Semantic combinations are also checked by planExport for direct callers.
```

- [ ] Run `npm test -- test/mcp/tools.test.ts test/mcp/errors.test.ts test/cli/cli.test.ts`. Expect missing-option or result failures.
- [ ] After every requested pass finishes, construct scene exports from the matching scene id and three completed layer records. Use original snapshot stops and timeline arrivals. Never emit references to a partial or nonexistent file. Write `<slug>.fcpxml.tmp`, run DTD validation, rename to `<slug>.fcpxml`, then publish final manifest/result. If validation fails, keep the XML as `.tmp` for diagnosis, mark the manifest failed and retain finished videos. If cancelled before publication, omit final XML. Add a cancellation check immediately before the final rename.

```ts
const xml = writeFcpxml({ projectName: snapshot.name,
  output: snapshot.output, credit: snapshot.credit, scenes: sceneExports })
await writeFile(xmlTemp, xml, 'utf8')
const validation = await validateFcpxml(xmlTemp)
if (signal?.aborted) throw new RenderCancelled()
await rename(xmlTemp, xmlFinal)
```

For subset and legacy exports, `scenes` in the result is empty because it contains only complete three-layer scene exports; manifest scene identity/ranges still exist. `outputs` always lists completed requested passes. `preview` is the absolute root-level preview path when requested. `video` remains the legacy all path only. Adjust text summaries to avoid printing `Video: undefined`; print FCPXML, each layer, preview if present, manifest, and required credit. Failed/cancelled summaries include retained outputs and the render directory.

- [ ] Parse CLI `--layers` as comma-separated names, trim whitespace and reject empty entries. Use the shared validation rules. Keep stdout as JSON and stderr as progress/summary. Include active layer in progress without changing the duration semantics. Keep SIGINT/SIGHUP cleanup and queue behaviour.
- [ ] Add real XML export tests for a range starting after frame zero, description notes, H.264 preview, and DTD failure preventing final XML publication. Probe all four outputs for matching frame counts and rates. Assert invalid options fail before browser launch or directory creation. Check all existing no-layer CLI and MCP calls still work.
- [ ] Run `npm test -- test/mcp/tools.test.ts test/mcp/errors.test.ts test/cli/cli.test.ts`, then `npm run test:e2e -- test/e2e/mcp.test.ts test/e2e/layer-render.test.ts test/e2e/fcpxml.test.ts`, then `npm run typecheck`. Commit with `feat: expose Final Cut layer export through CLI and MCP`.

## Task 8: Verify Final Cut import and document the workflow

**Model:** Opus 5.5 (`opus`) for the final whole-branch review; Sonnet 5.5 (`sonnet`) for documentation updates.

**Files:** Modify `README.md`, `skills/mapper/SKILL.md`; create `docs/final-cut-export.md`. Update `docs/plan.md` only after acceptance succeeds. Do not mark Stage 2 complete on automated checks alone if Final Cut import remains unverified.

**Interfaces:** Document these implemented calls, not future scene arguments.

```sh
mapper render /absolute/path/to/project --layers map,route,signs
mapper render /absolute/path/to/project --layers map,route,signs,preview
mapper render /absolute/path/to/project --layers map,route,signs --from 2 --to 4
mapper render /absolute/path/to/project --codec h264
```

```json
{"folder":"/absolute/path/to/project","layers":["map","route","signs","preview"],"range":{"from":0,"to":2}}
```

- [ ] Add the commands, output tree, roles, credit instructions, range marker semantics, retained outputs on cancellation, partial-layer limitations, and explicit one-scene support to the README/Mapper skill and export guide. Explain that moving the render folder after export can require relinking in Final Cut because URLs are absolute. Keep map credit reminders even when the compound note contains it; the publishing description still needs the credit.
- [ ] Run `npm run typecheck`, then `npm test`, then `npm run test:e2e`, waiting for each to finish. Record counts and skips. Do not regenerate goldens unless a deliberate reviewed visual change requires it.
- [ ] Render a short synthetic 4K 25p project with map/route/signs/preview and description credit, then a 1080p 24000/1001 fixture with burned credit and a nonzero range start. Use only local synthetic trip data. Inspect ffprobe output and the real DTD validation result. Run the gated network layer comparison once with `MAPPER_NET=1 npm run test:e2e -- test/e2e/layers.test.ts`; this should cover the real paper basemap in addition to the blank automated fixtures. If network verification cannot run, record it as unverified, not passed.
- [ ] Import the exported XML into a disposable Final Cut test library. Verify the `Mapper` event contains the compound and project; the compound opens with map on the primary storyline, route above on lane 1, signs above on lane 2. Toggle layers to confirm real transparency, inspect pale/dark areas for alpha halos, check Rec.709 appearance against preview, and confirm roles `Map.Base`, `Map.Route`, `Map.Signs`.
- [ ] Check first/last/in-range arrival markers against the existing timeline's frame numbers. Verify fractional-rate duration and no one-frame end gap. Verify description credit appears in compound notes. Import the generated two-synthetic-scene XML fixture referencing real media to confirm unique resources and joined offsets, while keeping public project/tool support single-scene. This is an internal compatibility test for Stage 6, not a new product feature.
- [ ] Record commands, tool versions, exact pass/fail results, frame counts, validation result, Final Cut observations and any remaining limits in `docs/final-cut-export.md`. If UI automation cannot confirm the import, state that manual acceptance remains outstanding. Do not substitute DTD success for actual Final Cut acceptance.
- [ ] Request the required whole-branch review through the implementation workflow, address findings and rerun affected checks. Commit documentation with `docs: record Final Cut export workflow and acceptance`. Do not automatically merge Stage 2; present the implementation and verification results for review.

## Plan self-review

- Stage 2 requirements have tasks: pass separation and composite equivalence in Task 2; alpha/Rec.709/rates in Task 3; snapshot/recovery/cancellation/disk in Task 4; compounds/lanes/roles/markers/notes in Task 5; installed v1.11 DTD in Task 6; output publication and CLI/MCP in Task 7; actual Final Cut acceptance in Task 8.
- Multi-scene readiness is internal: a scene input per render pass, ordered scene exports for XML, unique resource ids, scene-local markers, cumulative integer-frame project offsets, and two-scene fixtures. Public scenes and schema version 2 remain in their specified stages.
- Existing flattened defaults and paths remain compatible. Layer selection and preview semantics are explicit design decisions for review, since the spec names `layers` without defining its shape or default.
- The benchmarked capture transport is retained, and its alpha handling is tested end to end rather than inferred from a codec name.
- DTD validation is local to the installed Final Cut bundle, never a network fetch or a copied proprietary resource. Portable XML structure tests still run when Final Cut is absent.
- Task models follow `AGENTS.md`. If the execution environment does not expose those models, report that limitation before selecting replacements; this planning session launches no implementation agents.
