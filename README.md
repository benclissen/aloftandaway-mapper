# Mapper

Animated map videos of Aloft & Away trips, built by your AI agent. Ask Claude
(or any MCP-capable agent) for a map. It plans the route and camera, shows you
a local preview to tweak, and renders a clip you can drop into Final Cut Pro.
Everything runs on your machine; nothing is hosted.

Mapper is an independent build. It takes its feature set from
[Map Animator](https://mapanimator.baldinger.se/) by Robert Baldinger, studied
from the outside. It contains none of Map Animator's code, map themes, artwork
or copy.

## Status

Stage 1 (agent-driven MVP) built. What works today:

- An MCP server and CLI. The agent creates a project, sets stops, validates,
  previews, opens the studio and renders.
- A local studio for scrubbing the preview, dragging stops and setting start
  and end shots.
- Contact sheets and single-frame previews, so the agent can check its work.
- Renders at 3840×2160 and 25 fps by default, as flattened ProRes 422 HQ or
  H.264, with the map credit burned in.
- Stage 2 (Final Cut export, built; import into Final Cut still to be checked
  by hand): renders the map, route and signs as separate ProRes layers, with an
  FCPXML that rebuilds them in Final Cut Pro. See below.
- Not yet: sea and air routing (those legs draw as straight lines), the follow
  camera, terrain, vehicle symbols, GPX import.

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

## Final Cut Pro export

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
  <project>.fcpxml          FCPXML 1.11, checked against Final Cut's own DTD
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
- Without all of `map`, `route` and `signs` there is no FCPXML. `h264` can't
  make the isolated layers.
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
| Output, stage 1 | One flattened clip: ProRes 422 HQ or H.264 |
| Output, stage 2 | ProRes layers (map, route and signs with alpha) and FCPXML for Final Cut Pro |
| Satellite (later) | [EOxCloudless 2016](https://cloudless.eox.at/) (CC BY 4.0) |
| Elevation (later) | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) |
| Storage | A project folder on disk |

## Map credits

Every exported video must carry this credit, or carry it in the end credits
or description if it's cropped out:

© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap, plus EOxCloudless 2016 by EOX
(contains modified Copernicus Sentinel data 2016) when satellite is used.
