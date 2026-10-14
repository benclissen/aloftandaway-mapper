# Mapper: local, agent-driven design

Date: 2026-10-13
Status: approved; revised 2026-10-14

**Revision, 2026-10-14:** the studio gains hands-on route editing (waypoints,
curved/sharp points, transport per leg, map style, undo). The transport list
grows to about 20 and the map styles to 9. Projects gain scenes. These need
project file version 2, which upgrades version 1 files on load. The build
stages were reordered to fit.

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
3. Opening the exported FCPXML in Final Cut Pro gives a compound clip with
   map, route and signs on separate lanes, with a marker at each arrival.
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
| Output | ProRes layers plus FCPXML, with optional H.264 preview | What Final Cut handles best |
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
  | 'aloftandaway' | 'paper' | 'light' | 'dark' | 'nautical'
  | 'atlas' | 'outdoor' | 'satellite' | 'monochrome'

interface Look {
  theme: ThemeId
  labels: 'local' | 'en'
  terrain: boolean
  line: { color: string; width: number; dash: 'solid' | 'dashed' | 'dotted'; outline: boolean; glow: boolean }
  symbol: SymbolKind
  signStyle: string               // built-in sign style id
}

interface Shot { center: LngLat; zoom: number; bearing: number; pitch: number }

interface Camera {
  mode: 'fixed' | 'glide' | 'follow'
  start?: Shot                    // fixed uses start; glide uses start → end
  end?: Shot
  follow?: { zoom: number; orient: 'north' | 'heading'; lookAhead: number; smoothing: number }
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
- **air**: a great-circle arc. If `via` is given, arcs between each pair.
- **sea**: the shortest path over water. Natural Earth 1:10m land polygons
  (public domain) are rasterised once into a water grid around the leg's
  bounds. A* finds a path, which is then simplified and smoothed with a
  check that the smoothed line still stays off land. `via` points are forced
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
- **follow**: centres ahead of the symbol by `lookAhead` route-distance.
  Bearing comes from the route heading when `orient = 'heading'`. Critically
  damped smoothing (`smoothing` from 0 to 1) is precomputed over the whole
  timeline, so any frame can be rendered on its own.

Every camera state is a pure function of the frame number. This is what
makes frame-by-frame rendering, resuming and golden tests possible.

### Validation

`validateProject(project)` returns `{ errors, warnings }`. Errors block a
render; warnings don't. It checks:

- Schema errors.
- A sea leg crossing land (sampled against the water grid).
- A sea leg that fell back to `line`.
- Sign labels overlapping at their arrival frames (estimated from text size
  at the shot zoom).
- Camera zoom above the tile source's maximum zoom.
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
| `render` | `folder`, `scenes?` (`'joined'` (default), `'each'`, or a list of scene ids), `layers?`, `codec?`, `range?` | Job id |
| `render_status` | `jobId` | Progress, ETA, output paths, or error |
| `cancel_render` | `jobId` | Final status |

`update_project` ops. Stop, leg and via ops act on the selected scene:

- Stops: `{ op: 'insert_stop', index, stop }`, `{ op: 'update_stop', id, changes }`,
  `{ op: 'remove_stop', id }`, `{ op: 'move_stop', id, index }`.
- Legs: `{ op: 'update_leg', index, changes }`. Setting `symbol` without
  `mode` also sets the transport's default mode.
- Via points: `{ op: 'insert_via', leg, index, point }`,
  `{ op: 'update_via', leg, index, changes }`, `{ op: 'remove_via', leg, index }`.
- Scenes: `{ op: 'add_scene', index?, name?, copyLookFrom? }`,
  `{ op: 'duplicate_scene', id }`, `{ op: 'remove_scene', id }`,
  `{ op: 'move_scene', id, index }`. A new scene starts empty, with the
  look and camera settings of `copyLookFrom` (default: the scene before it).
  The last scene can't be removed.

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
- **Scene tabs** (stage 6): switch scenes; add, rename, duplicate,
  reorder and delete them.
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
   - **map**: basemap, terrain and labels, plus the map credit when
     `credit = 'burned'`. Encoded as ProRes 422 HQ (`prores_ks -profile:v 3`).
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
- Free disk space is checked first, from an estimate of the ProRes bitrate.

**Output folder**: `renders/<YYYY-MM-DD-HHmmss>/` containing one folder per
scene (`01-<scene-slug>/map.mov`, `route.mov`, `signs.mov`), plus
`preview.mp4` (if requested; every rendered scene joined), `<name>.fcpxml`
and `manifest.json`. A one-scene project still gets one scene folder.

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
- With `scenes: 'joined'`, a project (timeline) named after the Mapper
  project places the scene compound clips back to back. With `'each'`,
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
  same however it's reached), great-circle arcs, sea routing fixtures
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
5. **Look**: the full transport set (about 20 symbols) and the nine themes
   from the style builder, sign styles, terrain and tilt.
6. **Scenes**: several scenes per project, scene ops and the `scene`
   argument on tools, studio scene tabs, renders per scene or joined, a
   compound clip per scene in FCPXML.

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
