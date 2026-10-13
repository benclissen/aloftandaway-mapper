# Mapper

Animated map videos of Aloft & Away trips. Draw a route or drop in a GPX file,
pick a map style, add signs and camera moves, and export an MP4, all in the
browser.

Mapper is an independent build. It takes its feature set from
[Map Animator](https://mapanimator.baldinger.se/) by Robert Baldinger, studied
from the outside. It contains none of Map Animator's code, map themes, artwork
or copy.

## Status

Research done, no code yet.

- [docs/research.md](docs/research.md): how Map Animator works, and whether we can build it
- [docs/plan.md](docs/plan.md): what we'd build, in what order

## Planned stack

| Concern | Choice |
|---|---|
| App | Vite, React, TypeScript |
| Map rendering | [MapLibre GL JS](https://maplibre.org/) |
| Vector tiles | [OpenFreeMap](https://openfreemap.org/) (OpenStreetMap data) |
| Satellite | [EOxCloudless 2016](https://cloudless.eox.at/) (CC BY 4.0) |
| Elevation | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) |
| Place search | [Photon](https://photon.komoot.io/) |
| Video | WebCodecs `VideoEncoder` and [Mediabunny](https://mediabunny.dev/) for MP4 |
| Storage | IndexedDB, in the browser |
| Hosting | Cloudflare Pages |

## Map credits

Every exported video must carry this credit, or carry it in the end credits
or description if it's cropped out:

© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap, plus EOxCloudless 2016 by EOX
(contains modified Copernicus Sentinel data 2016) when satellite is used.
