# Mapper

Animated map videos of Aloft & Away trips, built by your AI agent. Ask Claude
(or any MCP-capable agent) for a map. It plans the route and camera, shows you
a local preview to tweak, and renders layered ProRes clips with an FCPXML file
ready for Final Cut Pro. Everything runs on your machine; nothing is hosted.

Mapper is an independent build. It takes its feature set from
[Map Animator](https://mapanimator.baldinger.se/) by Robert Baldinger, studied
from the outside. It contains none of Map Animator's code, map themes, artwork
or copy.

## Status

Design written, no code yet.

- [Design spec](docs/superpowers/specs/2026-10-13-mapper-local-agent-design.md): the local, agent-driven design
- [docs/plan.md](docs/plan.md): build stages
- [docs/research.md](docs/research.md): how Map Animator works, and whether we can build it

## Planned stack

| Concern | Choice |
|---|---|
| Agent interface | MCP server (stdio), CLI and an agent skill |
| Preview studio | Vite, React, TypeScript, served on `127.0.0.1` |
| Map rendering | [MapLibre GL JS](https://maplibre.org/) |
| Vector tiles | [OpenFreeMap](https://openfreemap.org/) (OpenStreetMap data) |
| Satellite | [EOxCloudless 2016](https://cloudless.eox.at/) (CC BY 4.0) |
| Elevation | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) |
| Place search | [Photon](https://photon.komoot.io/) |
| Rendering | Headless Chrome (Playwright) and ffmpeg |
| Output | ProRes layers (map, route and signs with alpha) and FCPXML for Final Cut Pro |
| Storage | A project folder on disk |

## Map credits

Every exported video must carry this credit, or carry it in the end credits
or description if it's cropped out:

© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap, plus EOxCloudless 2016 by EOX
(contains modified Copernicus Sentinel data 2016) when satellite is used.
