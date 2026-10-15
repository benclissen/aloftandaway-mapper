# Mapper

Animated map videos of Aloft & Away trips, built by your AI agent. Ask Claude
(or any MCP-capable agent) for a map. It plans the route and camera, shows you
a local preview to tweak, and renders an H.264 MP4, or optional layers for Final Cut Pro.
Everything runs on your machine; nothing is hosted.

Mapper is an independent build. It takes its feature set from
[Map Animator](https://mapanimator.baldinger.se/) by Robert Baldinger, studied
from the outside. It contains none of Map Animator's code, map themes, artwork
or copy.

## Status

Stages 1 to 5 (agent-driven MVP, Final Cut export, route editing, routes, look) built. What works today:

- An MCP server and CLI. The agent creates a project, sets stops, validates,
  previews, opens the studio and renders.
- A local studio for scrubbing the preview, dragging stops and setting start
  and end shots.
- Contact sheets and single-frame previews, so the agent can check its work.
- Renders at 3840×2160 and 25 fps by default, as one flattened H.264 MP4
  (`all.mp4`) with the map credit burned in. `--codec prores` makes a
  flattened ProRes 422 HQ master instead.
- Stage 2 (optional Final Cut export): renders the map, route and signs as
  separate ProRes layers, with an FCPXML that rebuilds them in Final Cut Pro.
  The default MP4 path is done; the Final Cut import check is still
  outstanding for the layered export only. See below.
- Route editing in the studio: click a leg's line to select it, click it
  again to add a via point, and drag points to reshape the route. Alt-click or
  right-click a point to make it sharp or curved, or remove it. A legs panel
  sets each leg's transport, and a picker changes the map style. Undo and redo
  (⌘Z, ⇧⌘Z) cover the studio's own edits. Projects saved by earlier versions
  open as before and are saved in the new format on the next edit.
- Route editing from the agent: via points bend a leg, `sharp` makes a corner, and each leg
  can have its own transport. The agent changes scene settings (timing, look,
  camera) with `update_project` `sceneSet`, and the project name, output and
  credit with `set`.
- The look: eleven map styles including the Aloft & Away series look, terrain
  with tilt, and drawn transport icons in three styles. See [Look](#look).
- Not yet: several scenes per project.

Docs:

- [Design spec](docs/superpowers/specs/2026-10-13-mapper-local-agent-design.md): the local, agent-driven design
- [docs/plan.md](docs/plan.md): build stages
- [docs/research.md](docs/research.md): how Map Animator works, and whether we can build it

## Install

You need macOS, Node 22 or newer, Google Chrome and Homebrew ffmpeg.

```bash
npm install && npm run build && npm link && mapper doctor
```

`mapper doctor` checks the machine and prints a fix for anything missing.

## Use with your agent

Register Mapper as an MCP server (`mapper mcp`), then ask your agent for a map.
[skills/mapper/SKILL.md](skills/mapper/SKILL.md) is the agent's guide: the
workflow, the rules, and setup for Claude Code, Claude Desktop, Codex and
Cursor.

## Routes

Sea legs route around land over the water, using Natural Earth 1:10m land
outlines (public domain) shipped in `data/land-10m.bin`. A stop more than
30 km from the sea, or a leg with no route found, is drawn as a straight line
with a `sea-fallback` warning. Via points are forced waypoints: a route pulled
ashore by one gets a `sea-crosses-land` warning. Air legs are great-circle
arcs that bow toward the nearer pole. The follow camera keeps the moving
symbol in view, with its zoom, orientation and look-ahead set in the scene's
camera. `import_gpx` turns a local GPX file into stops and via points. Land
data credit: [Natural Earth](https://www.naturalearthdata.com/), see
[data/README.md](data/README.md).

## Look

Eleven styles, set with `look.theme`: `aloftandaway` (the default, the Aloft &
Away series look), `aloftandaway-warm`, `paper`, `light`, `dark`, `nautical`,
`atlas`, `outdoor`, `satellite`, `monochrome` and `blank`. The Aloft & Away
styles set their labels in Plus Jakarta Sans. `satellite` uses EOxCloudless
2016 imagery (CC BY 4.0). Later EOxCloudless years are non-commercial and aren't used.

`look.terrain` adds 3D elevation and hill shading from AWS Terrain Tiles. A
shot's `pitch` (or `camera.follow.pitch`) tilts the view. Transports are drawn
as badges, badges in the line colour, or bare icons (`look.symbolStyle`), and
side-view vehicles turn to face the way they travel.

Credits for the look: icons are from [Lucide](https://lucide.dev) (ISC licence),
labels use [Plus Jakarta Sans](https://fonts.google.com/specimen/Plus+Jakarta+Sans)
(SIL Open Font License 1.1), satellite is EOxCloudless 2016 by EOX IT Services
GmbH (CC BY 4.0), and terrain is from AWS Terrain Tiles with the sources listed in
[data/README.md](data/README.md). Renders carry the credit lines their style
needs.

## Final Cut Pro export (optional)

A plain `mapper render <folder>` writes `all.mp4`. Ask for layers only when you
want to rebuild the clip in Final Cut Pro.

```bash
mapper render /absolute/path/to/project --layers map,route,signs
mapper render /absolute/path/to/project --layers map,route,signs,preview
mapper render /absolute/path/to/project --layers map,route,signs --from 2 --to 4
```

Each render gets a folder under the project:

```
<project>/renders/<timestamp>/
  01-<project>/map.mov      ProRes 422 HQ
  01-<project>/route.mov    ProRes 4444, alpha
  01-<project>/signs.mov    ProRes 4444, alpha
  <project>.fcpxml          FCPXML 1.11, checked against Final Cut's DTD when installed
  preview.mp4               H.264 check clip, with `preview`
  manifest.json
```

Import the `.fcpxml` into Final Cut Pro. The `Mapper` event gets a compound
clip: map on the primary storyline, route on lane 1 and signs on lane 2, with
roles `Map.Base`, `Map.Route` and `Map.Signs`, and a marker at each stop
arrival inside the range. The FCPXML points at the media by absolute path, so
if you move the render folder, Final Cut asks you to relink.

- The map credit is still required. If the project's `credit` is
  `description`, it also goes in the compound's notes, but put it in the video
  description too.
- Without all of `map`, `route` and `signs` there is no FCPXML. The layers are
  always ProRes; `--codec` only applies to the flattened clip, so
  `--codec h264` is an error unless `all` is requested too.
- Layers need far more disk than the default: the map layer is about 4.4 GB
  per minute at 4K25.
- Cancelling or a failure keeps the layers that finished, and the manifest
  lists them.
- One scene per project for now.

Details, tool versions and the manual import checklist are in
[docs/final-cut-export.md](docs/final-cut-export.md).

## Stack

| Concern | Choice |
|---|---|
| Agent interface | MCP server (stdio), CLI and an agent skill |
| Preview studio | Vite, React, TypeScript, served on `127.0.0.1` |
| Map rendering | [MapLibre GL JS](https://maplibre.org/) |
| Vector tiles | [OpenFreeMap](https://openfreemap.org/) (OpenStreetMap data) |
| Rendering | Headless Chrome driven over CDP (Playwright), screenshots piped into ffmpeg |
| Output, default | One flattened H.264 MP4 (ProRes 422 HQ with `--codec prores`) |
| Output, optional | ProRes layers (map, route and signs with alpha) and FCPXML for Final Cut Pro |
| Satellite | [EOxCloudless 2016](https://cloudless.eox.at/) (CC BY 4.0) |
| Elevation | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) |
| Storage | A project folder on disk |

## Map credits

Every exported video must carry this credit, or carry it in the end credits
or description if it's cropped out:

© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap, plus EOxCloudless 2016 by EOX
(contains modified Copernicus Sentinel data 2016) when satellite is used, and the
AWS Terrain Tiles attribution when terrain is on (see [data/README.md](data/README.md)).
