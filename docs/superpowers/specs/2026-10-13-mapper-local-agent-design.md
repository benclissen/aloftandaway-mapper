# Mapper: local, agent-driven design

Date: 2026-10-13
Status: approved; revised 2026-10-16

**Revision, 2026-10-14:** the studio gains hands-on route editing (waypoints,
curved/sharp points, transport per leg, map style, undo). The transport list
grows to about 20 and the map styles to 9. Projects gain scenes. These need
project file version 2, which upgrades version 1 files on load. The build
stages were reordered to fit.

**Revision, 2026-10-14 (output):** the default render is a flattened H.264 MP4
(`all.mp4`). Layered ProRes plus FCPXML for Final Cut Pro is optional, asked for
with `layers`; a flattened ProRes master is `codec: 'prores'`. `codec` applies
only to the flattened clip. The layers are always ProRes, and an explicit
`h264` codec with them is an error. The rendering and output sections below
describe the layered export unless they say otherwise.

**Revision, 2026-10-15 (stage 3 decisions):**

- Version 2 carries the full `SymbolKind` list now, so files migrate only
  once. Transports without their own drawing yet show as the dot. `ThemeId`
  stays `paper | blank` until stage 5 adds themes.
- The version 1 upgrade gives the one scene the project's id, so its id is
  stable across loads before the file is first saved as version 2.
- `update_project`'s `set` covers only `name`, `output` and `credit`;
  `sceneSet` covers the scene's `name`, `timing`, `look` and `camera`.
  `update_leg` takes `symbol: null` to clear a leg's transport.
- The curve runs smoothly through stops between neighbouring `line` or `land`
  legs, not just within a leg. A `sharp` stop or via point makes a corner.
- Studio: via handles show only for the selected leg. Click a leg's line or
  its row in the legs panel to select it; click the selected leg's line to
  insert a via point there. Escape deselects. A faint line shows the whole
  route in the studio (never in renders).
- Undo is kept in the studio. Each edit stores the inverse patch computed by
  `core`. Every patch carries the studio's client id and the server echoes it
  as the broadcast's `origin`; a broadcast from any other origin clears the
  history.

**Revision, 2026-10-15 (stage 4 decisions):**

- **Land data** ships in the repo as `data/land-10m.bin` (about 1.6 MB). It's built by `scripts/build-land.ts` from Natural Earth v5.1.2 `ne_10m_land` plus `ne_10m_minor_islands`, at 1e-4° precision. The water grid is never shipped; it's rasterised at runtime for each pair of points.
- **Air legs** follow the great circle, bowed toward the nearer pole (north at the equator) so even short flights curve (at least 15% of their length). Via points split the leg into arcs that meet at corners.
- **`camera.follow.lookAhead` is in seconds**: the camera aims where the symbol will be that many seconds later. Defaults: `{ zoom: fitted zoom + 3, capped at the theme's maximum; orient: 'north'; lookAhead: 1; smoothing: 0.5 }`.
- **`import_gpx`** also takes `legMode?` (default `'line'`) and `symbol?`, as `set_stops` does.
- **`validateProject(project, { seaPaths? })`.** Sea checks run only when `seaPaths` is given.
- **Deferred to stage 6:** positional via drag index and index-based leg selection.

**Revision, 2026-10-15 (stage 5 decisions):**

- **Brand source:** the Aloft & Away design system, kept outside this repo. It defines coral `#dc8376`, navy `#0a2434`, midnight `#1c1930`, sage `#bcc8a2`, sand `#867a5b`, page grey `#F4F4F4`, Plus Jakarta Sans, and Lucide icons. The palette and font names are public by the user's choice. Recoleta (the brand display font) is commercial and is not used or shipped.
- **Eleven styles:** `aloftandaway` (the series-map look, and the default for new projects), `aloftandaway-warm`, `paper`, `light`, `dark`, `nautical`, `atlas`, `outdoor`, `satellite`, `monochrome` and `blank`.
- **`paper` is unchanged.** It keeps exactly its old layers, with no minor roads. Minor roads are a palette switch that the other vector styles turn on.
- **Symbol styles:** `look.symbolStyle?: 'badge' | 'badge-line' | 'icon'`, default `badge`.
  - `badge` is a navy disc with a white ring and a white icon.
  - `badge-line` is the same disc in the line colour.
  - `icon` is a navy icon on a white halo.
  - `dot` keeps the old head look in every style, and `none` draws nothing.
- **Which way icons face:**
  - Side-view icons flip to face their direction. The flip is decided per leg: flipped when the leg's end is west of its start, so a loop flips once per leg and never mid-leg. A leg that ends due north or south of its start does not flip.
  - Plane, helicopter and arrow turn with the line.
  - Walk, train, tram, cable car, cruise ship and balloon stay upright.
- **Icons:** 14 from Lucide (ISC, `lucide-static` 1.57.0), plus six drawn for Mapper in the same style: campervan, coach, ferry, speedboat, balloon and arrow.
- **Signs:** only the existing `tag` style. Its font is Plus Jakarta Sans 600, in every style.
- **Map labels:** Plus Jakarta Sans in the two Aloft & Away styles, from glyphs built once and committed. Every other style keeps OpenFreeMap's Noto Sans.
- **Latin names in the Aloft & Away styles.** The committed glyphs cover Latin only, so those styles use Latin-script names: `labels: 'en'` tries name:en, then name:latin, then name; `local` tries name:latin, then name. Other styles keep Noto Sans and the old name logic.
- **New project defaults:** theme `aloftandaway`, line colour `#dc8376`, `symbolStyle` left unset (so `badge`).
- **Terrain:** `look.terrain: true` turns on 3D elevation (exaggeration 1.3) from AWS Terrain Tiles (Terrarium encoding). Hill shading is added in every style except `satellite`, whose elevation data includes the sea floor and would shade blotchily over imagery. `outdoor` always has hill shading, even with terrain off.
- **Terrain rendering cost:** frames with terrain take about 1.5 times as long (about 155 ms against 100 ms at 1080p). Stop dots, signs and the vehicle are drawn on top and are never hidden behind ridges.
- **Satellite:** the EOx `s2cloudless_3857` layer (2016), maximum zoom 14.
- **Tilt:** shot `pitch` (0 to 60, unchanged) and a new optional `camera.follow.pitch`.
- **Follow fields:** every `camera.follow` field becomes optional and is filled from defaults: `zoom` (as before), `orient: 'north'`, `lookAhead: 0.25`, `smoothing: 0.2`, `pitch: follow.pitch ?? camera.start.pitch ?? 0`. The aim point is capped at a quarter of the frame. With `orient: 'heading'` the bearing is smoothed three times more slowly than the position, so the turn at a stop happens mostly during its pause. This replaces the stage 4 defaults (lookAhead 1, smoothing 0.5).
- **Default glide** (no `camera.start`): opens on the first leg's fitted shot, capped at the style's maximum zoom. On a one-leg route, or when that fit is within 0.5 zoom of the whole route, it opens closer in on the first stop. It pulls out to the whole route over the first leg's travel, then holds. With an explicit `start`, the glide runs over the whole clip as before. A `fixed` camera with no start shows the whole route. This fixes the static default glide found in the stage 4 test.
- **Credit depends on the style.** `sceneCredit(scene, 'burned' | 'written')` lists the lines a scene needs. Burned in, the map credit always comes first, also for satellite. Satellite adds "Sentinel-2 cloudless 2016 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016), CC BY 4.0". Terrain adds "Terrain: USGS, Copernicus EU-DEM, NOAA ETOPO1 and others". The written form (FCPXML notes, render manifest, MCP tool text) carries the full EOxCloudless wording, with https://cloudless.eox.at and CC BY 4.0, and the full terrain attribution list. The strings are in `src/core/credit.ts`. `blank` without terrain has no credit.
- **Changes for existing projects:** a glide with no `start` opens on the first leg; follow has the look-ahead cap and slower heading turns; `terrain: true` projects render 3D (they were flat); non-dot symbols draw icons in place of the dot; sign text uses Plus Jakarta Sans.
- **Still parked:** the flight bow size and the Baltic skerries (taken up in stage 7; see below).

**Revision, 2026-10-16 (stage 6 decisions):**

- **Scene references.** `scene` is a scene id or a 1-based position. Without
  it, a call uses scene 1. On a project with more than one scene, every result
  names the scene it touched, as `Scene 2 of 2 · Sail`.
- **Patches.** `ProjectPatch` gains `scene?`, resolved to an id once, before
  any op runs. `sceneSet` and the stop, leg and via ops act on that scene, even
  if a scene op in the same patch moves it. A stop op after an op that removed
  it fails. `invertPatch` refuses (throws) a patch whose `sceneSet` or whose
  stop, leg or via ops target a scene that one of its ops removes.
- **Scene ops.** Op indexes are 0-based, like the stop ops.
  - `add_scene { index?, name?, copyLookFrom?, id? }` inserts an empty scene at
    `index` (default: the end), named `Scene N` (N is its new position). It
    copies `look` and `timing` from `copyLookFrom` (a scene reference; default:
    the scene before the new one, or the one after it at index 0). From that
    scene's camera it copies `mode`, `easing` and `follow`, never `start` or
    `end`. The studio always sends `id`.
  - `duplicate_scene { id, newId? }` is a deep copy placed right after the
    original, named `<name> copy`. Its stops get fresh ids.
  - `remove_scene { id }`. The last scene can't be removed.
  - `move_scene { id, index }`.
  - `restore_scene { index, scene }` puts a whole scene back, ids included.
    Studio undo uses it. Tool descriptions don't mention it.
- **Undo** covers every studio scene edit, delete included. Undoing a delete
  restores the whole scene. Undo and redo switch to the tab the step was made
  on. Redo of a duplicate restores the copy as saved (as `restore_scene`).
- **Render arguments.**
  - `scenes?` picks scenes by id or 1-based position. The default is all of
    them. They're always rendered in film order, and duplicates are rejected.
  - `join?` (default true) joins them into one clip. `false` writes one file
    per scene. `ExportPlan.join` is the requested setting, so a joined render
    whose range covers one scene still gets an FCPXML project.
  - `range` is in seconds on the joined timeline. With `join: false` it's
    allowed only when one scene is picked.
  - `render` results list each joined scene's start time, as
    `Scene 2 · Sail starts at 00:07:00` (MM:SS:FF).
  - CLI flags: `--scenes 1,3` and `--each` (`--each` is `join: false`).
- **The cut between scenes is a hard cut**, joined without re-encoding.
  Transitions are added in Final Cut.
- **Output folder:**

  | | `join: true` | `join: false` |
  |---|---|---|
  | Flattened | `all.mp4` / `all.mov` | `01-<scene-slug>.mp4` / `.mov`, `02-…` |
  | Preview | `preview.mp4` | `01-<scene-slug>-preview.mp4` |
  | Layers | `01-<scene-slug>/map.mov`, `route.mov`, `signs.mov` | same |
  | FCPXML | compound clips plus a project timeline | compound clips only |

  The two-digit prefix is the scene's film position. A one-scene project's
  layer folder is named after its scene, not the project.
- **Validation:** errors block a render only in a picked scene. An unpicked
  empty scene doesn't stop it.
- **Credit:** the union over the rendered scenes only.
- **FCPXML:** asset names become `<scene> · Map`, `<scene> · Route` and
  `<scene> · Signs`.
- **Studio tabs:**
  - A strip across the top of the stage, with one tab per scene showing its
    name and length.
  - `+` adds a scene after the active one, with its look, and switches to it.
  - Each tab has a menu: Rename, Duplicate, Move left, Move right and Delete.
    Delete doesn't ask first, because undo restores the scene.
  - The active scene is in the URL as `?scene=<id>`.
- **Stage 4 deferral, done here:**
  - The studio keys the selected leg by its stop pair.
  - It sends index-based edits (`update_leg`, `insert_via`, `update_via`,
    `remove_via`) with the base version, so a stale index is refused with a
    409 and nothing changes.
- **Not in this stage:** the open items from stages 4 and 5 (flight bow,
  Baltic skerries, the pale `aloftandaway` style, white signs on `monochrome`,
  the badge under a sign, fontnik, thin assertions) (taken up in stage 7; see below).

**Revision, 2026-10-16 (stage 7 decisions):**

- **Scope:** the open items from stages 4 to 6, each fixed with a test or
  parked with a reason. **The Baltic skerries become stage 8**, "Sea routes
  against OpenFreeMap water". That needs vector tiles decoded in Node, land
  rebuilt from clipped tile polygons, and network in a router that is pure and
  offline today, so it is a stage of its own.
- **Final Cut check 9 stays pending.** The Final Cut import of a layered
  export is still unchecked.
- **Burned satellite credit** keeps EOX's wording and adds the licence:
  `Sentinel-2 cloudless 2016 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016), CC BY 4.0`.
- **Flight bow:** the 15% minimum stays. Air legs follow the great circle,
  bowed toward the nearer pole so even short flights curve (at least 15% of
  their length).
- **Warnings.** A render can finish with warnings. `RenderResult.warnings`
  lists them. They show in the manifest, in the tool summaries (`render`,
  `render_status`, `preview_frame`, `preview_contact_sheet`) and on the CLI's
  stderr.
  - A terrain frame whose camera height never settles is now reported as a
    warning, where before it was only logged in the page. The render doesn't
    fail either way. The warning names the frames, as `Frames 12, 13 and
    40: the camera height over terrain hadn't settled, so these frames may
    differ slightly between renders and between layers.` (`Frame 7: … this
    frame …` for one). Past ten frames the rest are counted.
  - Frame numbers count from the start of each scene, as `preview_frame`
    counts them, not from the start of a ranged output file. On a project with
    several scenes the line starts with the scene label.
  - A failed delete of the parts of a joined render is also a warning.
- **Turning symbols** (plane, helicopter, arrow) take their angle from the
  line as drawn on screen, so tilt doesn't throw them off. The helicopter is
  mirrored top to bottom when its on-screen direction points west, so the rotor
  stays on top. Within 15 degrees of vertical on screen, the leg's own east or
  west facing decides, so a north-south leg doesn't flicker.
- **Look:**
  - `aloftandaway` gets a blue-grey sea and light land. `monochrome` gets a
    grey sea and near-white land.
  - Every sign in every style gets an edge: a soft shadow plus a hairline.
  - **`signLift(scene)`** is how far a sign's box sits above its stop:
    `max(16, r + pointer + 6)` px, where `pointer` is the sign's pointer
    height (10 px) and `r` is the largest vehicle radius among the scene's
    symbols (the look's and every leg's), other than `dot` and `none`. The
    pointer's tip clears the vehicle by 6 px. That gives 41 px for a badge and
    32 px for an icon. A scene with only a dot, or no symbol, stays at 16 px.
- **Scene names.** A blank or all-space name is refused, on `add_scene` and on
  `sceneSet`. Names are stored trimmed. Project files stay at version 2, and an
  older file with a blank name still loads. `sceneTitle(project, index)` (and
  `sceneTitleOf(name, index)`) gives the name to show: the trimmed name, or
  `Scene N`. Tool results, studio tabs and the FCPXML compound and asset names
  all use it. Undoing a rename of a blank-named scene restores `Scene N`.
- **Studio scene tabs** show the length to a tenth of a second (`13.0 s`),
  commit a rename when the field loses focus, and take Home and End to move to
  the first and last tab.
- **Map-data errors** name the failing source in their fix text: OpenFreeMap,
  EOX satellite or AWS terrain. A page gives up on its map style after 60
  seconds, and the load timeout around it is 70 seconds so that message
  arrives first.
- **MapLibre** is pinned to exactly 6.14.0 (`maplibre-gl`, no range), because
  the render depends on how it settles terrain.
- **Sync.** Two agent writes that land within the server's 50 ms reload
  debounce are merged into one reload, and the studio shows the final state.
- **The `MAPPER_NET` flake** was reproduced (21 failures in 200 cold-cache
  runs). The test diffed two independently loaded pages and counted every
  changed pixel as credit. In the failing runs, satellite and terrain tile
  seams came out 1 colour level apart between the two pages. That is
  invisible and doesn't misalign layers, so the product doesn't change. The
  test changes instead.
- **A rare corrupt capture** (one page in about 400 in a probe) is parked:
  it didn't reproduce in 3,000 loads. See "Known capture glitch" in
  `docs/render-speed.md`.

## Purpose

Mapper turns a trip into an animated map clip for a travel film. An AI agent
(Claude Code, Claude Desktop, Codex, Cursor or any other MCP client) builds the
map, checks its own work, takes tweaks, and renders files that drop straight
into Final Cut Pro.

A typical request is: "Make a map for the Celebrity Xcel series, first six
destinations, 4K 25p." The agent fetches the stops from wherever the user
points it (a website's API, a spreadsheet, a GPX file) and passes them to
Mapper. Then it plans the route and camera, shows the user a preview, applies their changes, and renders a
layered clip with an FCPXML file.

### Success criteria

1. An agent can go from a request to a rendered clip using only Mapper's MCP
   tools, with no hand-written project JSON.
2. The user can open a local preview, scrub it, and drag points, signs and
   camera shots, and the agent sees those edits.
3. Opening the exported FCPXML in Final Cut Pro gives a compound clip per
   scene with map, route and signs on separate lanes, with a marker at each
   arrival.
4. The preview and the final render come from the same code and match.
5. Nothing is hosted. Everything runs on the user's machine.

### Non-goals

- Hosting, accounts, analytics.
- A full manual editor. The studio does preview plus hands-on route editing
  (waypoints, curved/sharp points, transport per leg, map style, undo).
  Everything else (line styling, sign text, camera tuning, timing) goes
  through the agent.
- Editable Final Cut titles and render-to-exact-length (possible later).
- Photos on the map (on the symbol or at a stop), photo signs, and stats
  overlays such as speed and elevation (possible later).
- Browser-side video encoding. Rendering uses headless Chrome and ffmpeg.
- Connecting to any trip-data API. Mapper takes stops as input; fetching them
  is the agent's job.
- Real ship tracks from AIS data. Parked, see [docs/plan.md](../../plan.md#parked-real-ship-tracks-ais).
  The `Leg` type leaves room to add a recorded-track leg later without breaking project files.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Agent interface | MCP server (stdio) plus a CLI with the same commands, plus an agent skill | Works in every MCP client; scripts can use the CLI |
| Source of truth | One project file per map, on disk | Agent and human edit the same thing; easy to version |
| Rendering | Headless Chrome runs the studio page in render mode; frames go to ffmpeg | Preview and render share code |
| Output | Flattened H.264 MP4 by default; optional ProRes layers plus FCPXML, and an optional H.264 preview | One simple file by default; layers are what Final Cut handles best |
| Defaults | 3840×2160, 25 fps, 16:9 | The user's usual Final Cut format |
| Coordinates | `[lng, lat]` in WGS84 (GeoJSON order) | Agents and data sources speak lat/lng; Mercator maths stays internal |
| Trip data | Supplied by the agent as stops, or read from a GPX file | Mapper knows no data sources; the agent fetches data from wherever the user points it |

## Architecture

One npm package with a single `mapper` binary. Internal modules with one job each:

```
src/
├── core/      Schema, geometry, routing, timeline, camera, GPX parsing. Pure TS: no DOM, no fs, no network.
├── studio/    Vite + React + MapLibre page. Modes: edit, render.
├── server/    Local HTTP + WebSocket server: serves studio, reads/writes project, tile cache.
├── render/    Playwright + Chrome frame loop, ffmpeg encoding, FCPXML writer.
├── mcp/       MCP server exposing the tools below.
└── cli/       `mapper` commands: mcp, studio, render, doctor, and one per tool.
skills/mapper/SKILL.md   Agent workflow guide.
```

Dependency direction: `core` ← `studio`, `server` ← `render` ← `mcp`, `cli`.
`core` imports nothing else from the package.

### Runtime requirements

- Node 22 or newer.
- Google Chrome, or Playwright's Chromium as a fallback.
- ffmpeg with `prores_ks` (for ProRes 4444 with alpha).
- macOS is the primary target. Linux should work for everything except the
  Final Cut checks.

`mapper doctor` checks each of these, plus WebGL in headless Chrome and free
disk space. For anything missing it prints the fix.

## Project file

A project is a folder:

```
celebrity-xcel/
├── mapper.json         The project
├── renders/<timestamp>/  One folder per render
└── .mapper/            Cache (computed paths, preview frames); safe to delete
```

`mapper.json`, schema version 2 (validated with Zod; unknown keys rejected):

```ts
type LngLat = [number, number]

interface Project {
  schemaVersion: 2
  id: string                      // UUID
  name: string
  createdAt: string               // ISO 8601
  updatedAt: string
  output: {                       // shared by every scene
    aspect: '16:9' | '9:16' | '1:1' | '4:5'
    height: 1080 | 1440 | 2160    // width derived from aspect
    fps: { num: number; den: number } // 25/1, 24000/1001, 30000/1001, 30/1, 50/1, 60/1 …
  }
  credit: 'burned' | 'description' // map data credit placement
  scenes: Scene[]                 // at least 1, in film order
}

interface Scene {
  id: string                      // UUID
  name: string                    // e.g. "Drive to the port"
  timing: {
    holdStart: number             // seconds before the line starts
    travel: number                // seconds of line drawing, excluding pauses
    holdEnd: number               // seconds after the line finishes
  }
  stops: Stop[]                   // in travel order, at least 2
  legs: Leg[]                     // stops.length - 1, leg i joins stop i and i+1
  look: Look
  camera: Camera
}

interface Stop {
  id: string
  name: string                    // e.g. "Santorini"
  at: LngLat
  label?: string                  // sign text if different from name, e.g. "Day 3 · Santorini"
  pause: number                   // seconds the line waits here (0 for none)
  sign: 'always' | 'on-arrival' | 'none'
  terminal?: boolean              // start/end port styling
  sharp?: boolean                 // the line makes a corner here instead of curving through
  day?: number                    // itinerary day, used in marker names ("Day 3 · Santorini")
  ref?: string                    // free-form id the agent keeps, e.g. the source record's id
}

interface ViaPoint {
  at: LngLat
  sharp?: boolean                 // corner instead of curve
}

interface Leg {
  mode: 'sea' | 'air' | 'land' | 'line'
  via: ViaPoint[]                 // waypoints that shape the leg, in order (may be empty)
  symbol?: SymbolKind             // overrides look.symbol for this leg
}

type SymbolKind =
  | 'none' | 'dot' | 'arrow'
  | 'walk' | 'bike' | 'motorcycle' | 'scooter' | 'car' | 'campervan' | 'bus' | 'coach'
  | 'train' | 'tram' | 'cable-car'
  | 'ferry' | 'cruise-ship' | 'sailboat' | 'speedboat' | 'kayak'
  | 'plane' | 'helicopter' | 'balloon'

type ThemeId =
  | 'aloftandaway' | 'aloftandaway-warm' | 'paper' | 'light' | 'dark' | 'nautical'
  | 'atlas' | 'outdoor' | 'satellite' | 'monochrome' | 'blank'

interface Look {
  theme: ThemeId
  labels: 'local' | 'en'
  terrain: boolean
  line: { color: string; width: number; dash: 'solid' | 'dashed' | 'dotted'; outline: boolean; glow: boolean }
  symbol: SymbolKind
  symbolStyle?: 'badge' | 'badge-line' | 'icon'  // how the symbol is drawn; badge when unset
  signStyle: string               // built-in sign style id
}

interface Shot { center: LngLat; zoom: number; bearing: number; pitch: number }

interface Camera {
  mode: 'fixed' | 'glide' | 'follow'
  start?: Shot                    // fixed uses start; glide uses start → end
  end?: Shot
  follow?: { zoom?: number; orient?: 'north' | 'heading'; lookAhead?: number; smoothing?: number; pitch?: number }  // every field optional, filled from defaults
  easing: 'linear' | 'smooth'
}
```

**Version 1** (what stage 1 shipped) has the scene fields (`timing`, `stops`,
`legs`, `look`, `camera`) directly on the project, `via` as plain `LngLat[]`,
no `sharp` flags, and shorter symbol and theme lists. From stage 3, loading a
version 1 file upgrades it in memory: one scene named after the project, and
each via point becomes `{ at }`. It is saved as version 2 on the next write.
Old symbol names map to new ones (`ship` → `cruise-ship`).

Transports and themes are drawn and styled from scratch for Mapper. None
comes from Map Animator. Each transport has a default leg mode, used when the
studio or `set_stops` sets a transport without a mode: boats → `sea`; plane,
helicopter and balloon → `air`; everything else → `land`; `none`, `dot` and
`arrow` → `line`. Themes are generated by one parameterised style builder
over OpenFreeMap's schema, so adding a theme means adding a palette and a few
options, not a whole style file. `satellite` uses EOxCloudless 2016 only.

When a scene's `start`/`end` shots are missing, they are fitted to that
scene's route bounds for the output aspect.

Computed leg paths are cached in `.mapper/paths.json`, keyed by a hash of
the leg inputs. They are never stored in `mapper.json`.

Writes are atomic (write to a temp file, then rename) and bump `updatedAt`.
The server and the MCP tools both go through the same `core` load, patch and
save functions.

## Core

### Routing

Each leg becomes a polyline in `[lng, lat]`:

- **line**: a smooth curve (centripetal Catmull-Rom) through stop → via → stop.
  A `sharp` stop or via point splits the curve, so the two sides meet at a
  corner instead of curving through.
- **air**: follows the great circle, bowed toward the nearer pole so even
  short flights curve (at least 15% of their length). If `via` is given, arcs
  between each pair.
- **sea**: the shortest path over water. Natural Earth 1:10m land polygons
  (public domain) are rasterised into a coarse water grid around the leg's
  bounds, where any cell with some water in it is passable. A* finds the way
  on it; each stretch that passes near land is then routed again on a fine
  grid (about 200 m cells) over just that stretch, so narrow straits and
  harbours stay open while the line stays off land. Each stop snaps to the
  nearest water connected to the other end. The path is then simplified and
  smoothed with a check that the smoothed line still stays off land. `via` points are forced
  waypoints, and smoothing never rounds off a `sharp` one. If no path is found the leg falls back to `line`, and
  `validate_project` reports it.
- **land**: same as `line` for now. Road snapping is out of scope.

### Timeline

Times are whole frames at `output.fps`. Each scene has its own timeline
starting at frame 0. A joined render plays the scenes back to back.

- Total frames = `round((holdStart + travel + Σ pauses + holdEnd) × fps)`.
- `travel` is split across legs in proportion to each leg's length in
  Mercator units, with a minimum of 0.5 s per leg.
- Within a leg, progress follows the camera easing curve.
- The timeline gives, for any frame: line progress (distance along the whole
  route), symbol position and heading, which signs are visible, and the
  arrival frame of each stop. Arrival frames become the FCPXML markers.

### Camera

- **fixed**: `start` for every frame.
- **glide**: interpolates `start` → `end` across the travel section, using
  the van Wijk–Nuij zoom-and-pan curve so zoom and pan feel natural. Holds at
  each end.
- **follow**: centres ahead of the symbol by `lookAhead` seconds of travel.
  Bearing comes from the route heading when `orient = 'heading'`. Critically
  damped smoothing (`smoothing` from 0 to 1) is precomputed over the whole
  timeline, so any frame can be rendered on its own.

Every camera state is a pure function of the frame number. This is what
makes frame-by-frame rendering, resuming and golden tests possible.

### Validation

`validateProject(project)` returns `{ errors, warnings }`. Errors block a
render; warnings don't. It checks:

- Schema errors.
- `sea-crosses-land`: a sea leg whose path crosses land (sampled against the
  water grid). Sea checks run only when sea paths are given.
- `sea-fallback`: a sea leg that fell back to `line`.
- `sign-overlap`: estimated sign boxes overlapping at each stop arrival, from
  text size at the shot zoom.
- Camera zoom above the tile source's maximum zoom. This also checks
  `follow.zoom`. In follow mode the start and end zooms are not checked.
- Durations under one second per leg.
- Fewer than two stops in a scene.
- Two consecutive stops at the same place (an overnight that should be one
  stop with a pause).

## Getting stops in

Mapper doesn't connect to any data source. The agent gets the trip data
however the user tells it to, then hands Mapper the stops:

```ts
interface StopInput {
  name: string
  at: LngLat
  day?: number
  label?: string
  pause?: number                   // default 0
  sign?: Stop['sign']              // default 'always'
  terminal?: boolean
  ref?: string
  legMode?: Leg['mode']            // mode of the leg leaving this stop; defaults to the call's legMode
  symbol?: SymbolKind              // transport for the leg leaving this stop; sets legMode if that's missing
}
```

- `set_stops({ folder, scene?, stops, legMode?, replace? })` creates or
  replaces the scene's stops in travel order, and creates one leg per pair (`legMode` defaults to
  `line`). With `replace: false`, the stops are appended to the end instead.
- `import_gpx({ folder, scene?, path, track?, stops? })` reads a local GPX file.
  `stops: 'waypoints'` makes a stop of each named waypoint; `'ends'` (the
  default) uses the start and end only. The track between stops becomes
  `via` points, simplified.

The agent should pass stops already in travel order, with sea days dropped
and overnights merged. `validate_project` warns if it didn't.

## MCP tools

Every tool takes absolute paths. Every result has a short plain-text summary
plus structured content. Errors are returned as tool errors with a suggested
fix. Tools that work on one scene take `scene?` (its id, or its 1-based
position). Without it they use the first scene.

| Tool | Input | Result |
|---|---|---|
| `create_project` | `folder`, `name`, `output?` | Project summary |
| `get_project` | `folder` | Full project, with each scene's timeline summary (duration, arrival times) |
| `set_stops` | `folder`, `scene?`, `stops`, `legMode?`, `replace?` (default true) | Project summary and validation |
| `import_gpx` | `folder`, `scene?`, `path`, `track?`, `stops?` | Project summary and validation |
| `update_project` | `folder`, `scene?`, `set?` (JSON Merge Patch over the project's `name`, `output` and `credit`), `sceneSet?` (JSON Merge Patch over the scene's `name`, `timing`, `look` and `camera`), `ops?` (ops below) | Project summary and validation |
| `validate_project` | `folder` | Errors and warnings, per scene |
| `preview_frame` | `folder`, `scene?`, `at` (exactly one of `{ seconds }`, `{ frame }`, `{ progress }` where progress is 0–1), `width?` | PNG image |
| `preview_contact_sheet` | `folder`, `scene?`, `count?` (default 9), `width?` | One PNG grid with timestamps |
| `open_studio` | `folder` | Local URL |
| `render` | `folder`, `scenes?` (scene ids or positions; default all, in film order), `join?` (default true; false writes one file per scene), `layers?`, `codec?`, `range?` | Job id |
| `render_status` | `jobId` | Progress, ETA, output paths, or error |
| `cancel_render` | `jobId` | Final status |

`update_project` ops. Stop, leg and via ops act on the selected scene:

- Stops: `{ op: 'insert_stop', index, stop }`, `{ op: 'update_stop', id, changes }`,
  `{ op: 'remove_stop', id }`, `{ op: 'move_stop', id, index }`.
- Legs: `{ op: 'update_leg', index, changes }`. Setting `symbol` without
  `mode` also sets the transport's default mode.
- Via points: `{ op: 'insert_via', leg, index, point }`,
  `{ op: 'update_via', leg, index, changes }`, `{ op: 'remove_via', leg, index }`.
- Scenes: `{ op: 'add_scene', index?, name?, copyLookFrom?, id? }`,
  `{ op: 'duplicate_scene', id, newId? }`, `{ op: 'remove_scene', id }`,
  `{ op: 'move_scene', id, index }`, and `restore_scene { index, scene }`
  (studio undo only). A new scene starts empty. It copies the look and timing
  of `copyLookFrom` (default: the scene before it, or the one after it at index
  0), and the camera's `mode`, `easing` and `follow`, but never its `start` or
  `end` shots. The last scene can't be removed.

Legs are kept in step with stops automatically. A patch is applied in full
or not at all, and the result must pass schema validation.

Preview tools use the same headless page as rendering, at a reduced width
(default 960 px). The page is kept warm between calls.

## Studio and server

`mapper studio <folder>` (or `open_studio`) starts one local server per
Mapper process. It serves several projects.

- **Security**: binds `127.0.0.1` on a random free port. It rejects requests
  whose `Host` isn't `127.0.0.1:<port>` or `localhost:<port>`, which blocks
  DNS rebinding. Every URL carries a random session token, so other local web
  pages can't call it. Reads and writes are limited to registered project
  folders.
- **Sync**: the server watches `mapper.json`. When the file changes (from the
  agent or the CLI), connected studios reload the project over WebSocket.
  Edits made in the studio are sent to the server, which applies them as a
  patch through `core`. The last write wins, and `updatedAt` shows which
  write that was.
- **Tile cache**: map tiles, styles, fonts and terrain go through the server
  to a disk cache in `~/.cache/mapper/tiles`. Repeat previews and renders
  don't hit the upstream services again. Requests are throttled to stay
  within fair use.

Studio edit mode:

- The map preview is sized to the output aspect, with a play/scrub bar and
  arrival ticks.
- **Route editing** (stage 3):
  - Drag stops. Click the line to insert a via point there, drag it to
    reshape the leg, and remove it with Delete or its menu.
  - Switch a stop or via point between curved and sharp from its menu
    (or Alt-click).
  - A legs panel lists each leg, with a transport picker and a mode
    override (line, sea, air, land).
  - A map style picker.
  - Undo and redo (Cmd-Z, Shift-Cmd-Z) for studio edits. Each edit records
    its inverse patch. A change from outside the studio (the agent or the
    CLI) clears the undo history, so undo never overwrites the agent's work.
- Drag a sign to offset it.
- "Use this view as start/end shot" buttons, and a camera mode switcher.
- **Scene tabs** (stage 6): a strip above the stage with one tab per scene,
  showing its name and length. `+` adds a scene after the active one, with
  its look, and switches to it. Each tab's menu renames, duplicates, moves the
  scene left or right, or deletes it. Delete doesn't ask first, because undo
  restores the scene. The active scene is in the URL as `?scene=<id>`.
- No other editing UI. Line styling, sign text, timing and camera tuning go
  through the agent.

Studio render mode (`?mode=render&scene=<id>&layer=map|route|signs|all`):

- No UI chrome. Sets `window.mapper = { ready, renderFrame(n), frameCount }`.
- `renderFrame(n)` applies the timeline state for frame `n`. It resolves
  once MapLibre reports `loaded()` with every tile loaded and the frame
  painted.

## Rendering

1. Load and validate the project. Errors stop the render.
2. Start (or reuse) the server, and launch Chrome through Playwright
   (`channel: 'chrome'`, falling back to bundled Chromium). Set the viewport
   to the output size and the device scale factor to 1.
3. For each scene being rendered, and each layer, open render mode with that
   scene and layer and spawn ffmpeg reading
   raw RGBA from stdin. For each frame, call `renderFrame(n)`, read the
   pixels in the page, and stream them over the server's WebSocket to
   ffmpeg's stdin.
4. Layers:
   - **map**: basemap, terrain and labels, plus the credit lines the style
     needs when `credit = 'burned'` (see the stage 5 revision). Encoded as ProRes 422 HQ (`prores_ks -profile:v 3`).
   - **route**: a transparent background with every basemap layer hidden.
     Terrain stays loaded but invisible, so the line drapes correctly. Holds
     the line, symbol and start dot. Encoded as ProRes 4444
     (`-profile:v 4 -pix_fmt yuva444p10le`).
   - **signs**: a transparent canvas overlay with the signs and labels.
     Encoded as ProRes 4444.
   - **preview** (optional): every layer composited. Encoded as H.264
     (`h264_videotoolbox`, falling back to `libx264`).
5. Every output is tagged Rec.709 (`-color_primaries bt709 -color_trc bt709
   -colorspace bt709`), with a frame rate of exactly `num/den`.
6. Write the FCPXML and `manifest.json` (project hash, settings, durations,
   credit text, Mapper version).

**Resilience**

- Frames are deterministic. If the WebGL context is lost, or a tile fails
  after 3 retries with backoff, the page reloads and the render continues
  from the failed frame into a new segment. Segments are joined losslessly
  with ffmpeg's concat demuxer.
- Cancelling stops the job and keeps any finished layers.
- Free disk space is checked first, from an estimate of the bitrate of each output (H.264 for the default MP4, ProRes for layers).

**Output folder**: `renders/<YYYY-MM-DD-HHmmss>/`. By default it holds `all.mp4`
(or `all.mov` with `codec: 'prores'`) and `manifest.json`. With `join: false`
the flattened clip is one file per scene instead (`01-<scene-slug>.mp4`, and so
on). A layered export has one folder per scene
(`01-<scene-slug>/map.mov`, `route.mov`, `signs.mov`), plus `preview.mp4`
(if requested; every rendered scene joined, or `01-<scene-slug>-preview.mp4`
per scene with `join: false`), `<name>.fcpxml` and `manifest.json`. A one-scene
project still gets one scene folder. The table in the stage 6 revision above
lists the names.

## FCPXML

- FCPXML version 1.11, which also opens in older Final Cut versions. Tests
  validate against `FCPXMLv1_11.dtd` from the installed Final Cut Pro bundle
  (skipped when Final Cut isn't installed).
- One `<format>` matching the output size and `frameDuration`
  (`den/num s`, e.g. `1/25s`, `1001/24000s`).
- Three `<asset>`s per scene pointing at the `.mov` files with `file://`
  URLs. The route and signs assets carry alpha.
- An event named `Mapper`, holding one compound clip (`<media>` with a
  `<sequence>`) per scene, named `<project> · <scene>`: map on the spine,
  route on lane 1, signs on lane 2.
- With `join: true` (the default), a project (timeline) named after the Mapper
  project places the scene compound clips back to back. With `join: false`,
  only the compound clips are created.
- Video roles: `Map.Base`, `Map.Route`, `Map.Signs`.
- `<marker>`s inside each scene's compound clip at each stop's arrival
  frame, using the stop label or `Day N · Name`.
- When `credit = 'description'`, the credit text goes in the compound clip's
  notes.

## Agent skill

`skills/mapper/SKILL.md` covers:

- The workflow: get the trip data the user points to → create → set_stops →
  validate → contact sheet →
  tweak → studio link for the user → render → report output paths.
- Shaping routes: add via points to bend a line around something, and mark
  them `sharp` for corners. Split a trip into scenes when the film cuts
  away between parts of it.
- Rules: always look at a contact sheet before rendering. Fix validation
  warnings or explain them. Never edit `mapper.json` by hand. Tell the user
  which credit is required.
- Setup for Claude Code, Claude Desktop, Codex and Cursor
  (`mapper mcp` as a stdio server).

## Error handling summary

| Failure | Behaviour |
|---|---|
| Chrome, ffmpeg or ProRes missing | `doctor` and the render say what's missing and how to install it |
| Invalid patch | Tool error with the Zod path and message; project unchanged |
| Sea routing fails | Falls back to `line`; warning |
| Tile or WebGL failure mid-render | Retry, reload, resume from the failed frame |
| Port in use | Pick another free port |
| Project changed during render | Render uses the snapshot it started with; the manifest records the hash |

## Testing

- **core** (Vitest): schema round trips and rejections, version 1 → 2
  upgrade, patch ops (stops, legs, via points, scenes), curves with sharp
  points (a corner exists exactly at the sharp point), transport default
  modes, timeline
  frame maths at 25 and 23.976 fps, camera determinism (frame `n` is the
  same however it's reached), flight arcs, sea routing fixtures
  (Athens → Mykonos and Barcelona → Marseille stay at sea; a path between
  two landlocked points fails cleanly).
- **GPX**: parser fixtures (tracks, routes, named waypoints, multiple tracks).
- **server**: Host and token checks, folder confinement, file-watch sync.
- **studio**: Playwright tests for inserting, dragging and removing via
  points, the curved/sharp toggle, transport and style pickers, and undo
  and redo, including the history being cleared by an outside change.
- **render**:
  - Golden frames: chosen frames of fixture projects compared with stored
    PNGs using pixelmatch, with a tolerance. These run on macOS, and
    `--update` refreshes them.
  - ffprobe checks on the outputs: codec, profile, alpha, fps, colour tags,
    frame count.
- **FCPXML**: `xmllint --dtdvalid` against the bundled DTD, plus structural
  assertions (a compound clip per scene, lanes, roles, marker times, the
  joined timeline's clip order).
- **mcp**: an end-to-end test with the MCP SDK client against a fixture
  project: create → set_stops → validate → preview → render a
  2-second clip.

## Build stages

Each stage gets its own implementation plan.

1. **Agent-driven MVP** (built): core (schema version 1, `line` legs,
   timeline, glide and fixed camera), studio (preview, scrub, drag stops, set
   shots), server, MCP tools and CLI, doctor, skill, and a flattened render
   (ProRes 422 HQ or H.264). One built-in theme.
2. **Final Cut export**: layer passes, ProRes 4444 with alpha, FCPXML with
   lanes, roles and markers, DTD validation. One scene, as in version 1.
3. **Route editing**: project file version 2 and the version 1 upgrade
   (scenes exist in the format, but tools and studio use one scene),
   curved/sharp points, via point ops, the studio's route editing (via
   points, curved/sharp, legs panel with transport picker, style picker,
   undo and redo).
4. **Routes**: sea routing, `air` arcs, follow camera, GPX import,
   `validate_project` warnings.
5. **Look**: the full transport set (about 20 symbols) and the eleven themes
   from the style builder, terrain and tilt.
6. **Scenes**: several scenes per project, scene ops and the `scene`
   argument on tools, studio scene tabs, renders per scene or joined, a
   compound clip per scene in FCPXML.
7. **Fix pass** (built): the open items from stages 4 to 6, each fixed with a
   test or parked with a reason. Render warnings, sign lift, screen-angle
   turning symbols, blank scene names, source-aware map-data errors.
8. **Sea routes against OpenFreeMap water** (planned): sea routing that uses
   the water the basemap draws, so a route stays off every island it shows.

## Risks

| Risk | Mitigation |
|---|---|
| Headless Chrome WebGL is slow or falls back to software on some Macs | `doctor` reports the WebGL renderer; offer 1080p; measure frames per second in stage 1 |
| Reading 4K pixels per frame is slow | Measure in stage 1; if needed, capture with CDP screencast or use PBO-style async reads |
| Tile fair use during long 4K renders | Disk tile cache and throttling; self-hosted PMTiles as a later option |
| Sea routing quality near complex coastlines | Grid resolution scales with leg length; `via` points let the agent or user correct it |
| Drawing about 20 transports and nine themes is a lot of design work | One icon grid and stroke style for every transport; themes come from one parameterised style builder, so each is a palette plus a few options |
| Undo fighting with agent edits | Outside changes clear the studio's undo history |
| Route layer misaligned with the map layer | Same timeline and camera per frame; a golden test composites the layers and compares them against the `all` layer |
