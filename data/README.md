# Data

## land-10m.bin

Land outlines used by the sea router. They are the base for open water: they
cover everywhere no OpenFreeMap tile is loaded, which is the open sea and any
stretch the router didn't need tiles for. Inside a loaded tile, the tile's own
water decides instead (see "Sea water" below).

- **Source:** [Natural Earth](https://www.naturalearthdata.com/) v5.1.2, the `ne_10m_land` and
  `ne_10m_minor_islands` layers, from
  `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/`.
- **Licence:** public domain. No permission needed. Credit to Natural Earth is appreciated.
- **Precision:** 1e-4 degrees, about 11 m.
- **Format:** a compact varint stream, described in `src/core/land.ts` (`encodeLand` and
  `decodeLand`). Lakes are land: only the coastline layers are included.
- **Rebuild:** `npm run build:land` downloads the layers into a fresh temp folder, encodes them
  and rewrites this file.

## Sea water

Near the coast the sea router reads water from OpenFreeMap's own vector tiles, the same data the
basemap draws, so a route and the map agree. Nothing from these tiles is stored in the repo except
the test fixtures below. Tiles are fetched at run time and cached on disk under `~/.cache/mapper/tiles`
by the tile store (`src/server/tiles.ts`), which the map views share.

- **Source:** `https://tiles.openfreemap.org/planet/<build>/<z>/<x>/<y>.pbf`, where `<build>` is the
  planet build the OpenFreeMap TileJSON names that day. OpenStreetMap data under the ODbL, through
  OpenMapTiles and OpenFreeMap.
- **Zoom:** 12 (`WATER_ZOOM` in `src/core/land.ts`).
- **Pixels:** each tile is read onto 512 by 512 pixels (`TILE_PIXELS`), about 10 m at 60° N and 19 m at
  the equator. A pixel is water when its centre lies inside a water polygon (even-odd per polygon, any
  polygon counts).
- **Feature filter:** every polygon in the tile's `water` layer except `brunnel: tunnel`. That is the
  filter the basemap style's own water layer uses, so lakes, rivers and docks count as water. A lake that
  doesn't join the sea stays unreachable, since a stop snaps only to water connected to the other end.
- **Which tiles:** the router loads the tiles within 2 km of its route, then routes again, up to 12
  rounds, until it needs no tile it doesn't have. A tile is loaded only when Natural Earth land lies
  within 20 km of it, so a crossing of open sea fetches tiles only near the coasts. Every leg starts from
  no tiles, so its route doesn't depend on what an earlier leg loaded.
- **Download rules** (openfreemap.org, read 2026-10-17): each download at most 3,000 tiles or 50 MB, at
  most 4 requests at once, and a User-Agent that names the app. Router fetches use at most 4 requests at
  once. One call that resolves sea paths fetches at most 2,500 new tiles from OpenFreeMap (tiles already on
  disk don't count); past that the legs still to route are marked unverified, and the next call carries on.
- **User-Agent:** every request to OpenFreeMap, studio map views included, sends
  `aloftandaway-mapper/<package version>`.
- **Credit:** `© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap`. A route drawn from this data
  needs it, so a `blank` scene with a sea leg carries the credit too.
- **Offline or too many tiles:** the leg is routed on Natural Earth, and on any tiles it did get, and
  flagged `sea-unverified`. It is routed again after 60 seconds.
- **Cache:** a routed leg is kept in `<project>/.mapper/paths.json`, with the planet build it was routed
  on. It isn't routed again until its stops, via points or `ROUTER_VERSION` (`src/core/sea.ts`) change.
  A new planet build alone does not re-route anything. Bump `ROUTER_VERSION` when the routing code or its
  parameters change, or the way water is read changes (zoom, pixels, the feature filter).

### Dev and test settings

- `MAPPER_TILE_UPSTREAM` points the tile cache (map views and sea routing) at another server instead of
  `https://tiles.openfreemap.org`. Vitest sets it to `http://127.0.0.1:9`, an address that refuses
  connections, so tests never reach the network. Tests that need tiles start a local fake that serves the
  fixtures below.
- `MAPPER_NET=1` turns on the tests that use the real network.
- `npm run bench:sea` times five sea legs cold, from disk and from memory against live OpenFreeMap. The
  numbers are in [docs/render-speed.md](../docs/render-speed.md#sea-routing-stage-8-task-9).

## Sea-route test tiles

The sea-route tests don't use the network. `test/fixtures/sea-tiles/` holds the water layer of the
OpenFreeMap tiles their five fixture legs need: Stockholm to Sandhamn and Mariehamn, and the three
Greek Islands legs. It is OpenStreetMap data under the ODbL, and the folder's README has the credit,
the licence and how it's built. About 1,100 small files, just under 1 MB.

- **Rebuild:** `npm run build:sea-fixtures`, with network.

## Transport icons

The transport drawings are not in this folder. They're in `src/studio/stage/icons.ts`, and
`npm run build:icons` rewrites its generated block from `lucide-static` 1.57.0, which is pinned in
`package.json` and read as data from `node_modules`. No network is needed.

- **Lucide:** 14 drawings: `footprints`, `bike`, `motorbike`, `scooter`, `car`, `bus`, `train-front`,
  `tram-front`, `cable-car`, `ship`, `sailboat`, `kayak`, `plane` and `helicopter`. Lucide is ISC
  licensed; the text is in `LICENSES/Lucide-ISC.txt`.
- **Drawn for Mapper:** campervan, coach, ferry, speedboat, balloon and arrow, in the same style: a
  24 by 24 grid, 2 px round strokes and no fill. The build leaves that part of `icons.ts` alone.
- **Rebuild:** `npm run build:icons`, after `npm install`.

## glyphs/

SDF glyph files for the map labels of the two Aloft & Away styles. MapLibre asks for them as
`fonts/<font stack>/<range>.pbf`, and the tile proxy answers from this folder, never upstream, when
the first font in the stack starts with "Plus Jakarta Sans".

- **Faces:** `Plus Jakarta Sans SemiBold` (weight 600) and `Plus Jakarta Sans Bold` (700).
- **Ranges:** 0-255, 256-511, 512-767, 768-1023, 1024-1279, 7680-7935, 8192-8447 and 8448-8703:
  Latin, Latin Extended, Vietnamese and general punctuation. The font has no Greek or Cyrillic
  letters, so those ranges hold little or nothing. A range that isn't here is answered with an empty
  glyph set, so labels in other scripts fall back silently.
- **Source:** [Plus Jakarta Sans](https://github.com/tokotype/PlusJakartaSans) by Tokotype, from the
  `google/fonts` repository at commit `1d0e46c7933245c8180fe83e47917961c913bbdb`
  (`ofl/plusjakartasans/PlusJakartaSans[wght].ttf`).
- **Licence:** SIL Open Font License 1.1. The text is in `LICENSES/PlusJakartaSans-OFL.txt`.
- **Rebuild:** `npm run build:glyphs` downloads the font into a fresh temp folder, cuts the two
  weights from the variable font with fontTools 4.67.0 (installed in a throwaway venv, so it needs
  `python3` and network), and makes the PBFs with `fontnik` 0.7.7. The output is about 660 KB.

## Satellite and elevation sources

The tile proxy (`src/server/tiles.ts`) serves two more sources, cached under `~/.cache/mapper/tiles`
like the basemap, with the same throttling and retries. Neither is stored in this repo.

### Satellite: EOxCloudless 2016

- **Route:** `satellite/{z}/{x}/{y}.jpg` becomes
  `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg`. WMTS puts the
  row before the column, so y and x swap.
- **Which year:** checked against the
  [WMTS capabilities](https://tiles.maps.eox.at/wmts/1.0.0/WMTSCapabilities.xml) on 2026-10-15.
  `s2cloudless_3857` is titled "Sentinel-2 cloudless layer for 2016 by EOX - 3857" and its abstract
  gives the licence as Creative Commons Attribution 4.0. The layers for 2019 and later
  (`s2cloudless-2019_3857` and on) are CC BY-NC-SA 4.0, non-commercial, and must not be used. There is
  no layer named with 2016; the unsuffixed `s2cloudless_3857` is it.
- **Maximum zoom:** 14. The [EOxCloudless product list](https://cloudless.eox.at/documentation/product-list.html)
  gives 10 m resolution and zoom levels 0-14 for EPSG:3857. The server also answers at zoom 15, but the
  product stops at 14, so the style caps the source there and MapLibre overzooms past it
  (`THEME_MAX_ZOOM.satellite`).
- **Credit:** "Sentinel-2 cloudless 2016 by EOX IT Services GmbH (contains modified Copernicus Sentinel
  data 2016)", from the layer's own abstract, which asks for
  "EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel
  data 2016)". CC BY 4.0 needs the creator named, a licence link and a note of changes
  ([legal code](https://creativecommons.org/licenses/by/4.0/legalcode.en)). The burned-in line is
  "Sentinel-2 cloudless 2016 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016), CC BY 4.0",
  so it names the creator, the data and the licence.

### Elevation: AWS Terrain Tiles (Terrarium)

- **Route:** `terrain/{z}/{x}/{y}.png` becomes
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`. Encoding: Terrarium,
  `height = (R * 256 + G + B / 256) - 32768` metres. Zoom 0-15.
- **Attribution:** from the Tilezen Joerd
  [attribution page](https://github.com/tilezen/joerd/blob/master/docs/attribution.md), the
  "required attribution" block (the Mapzen line applies only to Mapzen's own hosted service, which this
  is not):
  - ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and funded under
    National Science Foundation awards 1043681, 1559691, and 1542736;
  - Australia terrain data (c) Commonwealth of Australia (Geoscience Australia) 2017;
  - Austria terrain data (c) offene Daten Oesterreichs - Digitales Gelaendemodell (DGM) Oesterreich;
  - Canada terrain data contains information licensed under the Open Government Licence - Canada;
  - Europe terrain data produced using Copernicus data and information funded by the European Union -
    EU-DEM layers;
  - Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration;
  - Mexico terrain data source: INEGI, Continental relief, 2016;
  - New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and the
    New Zealand Government (All rights reserved);
  - Norway terrain data (c) Kartverket;
  - United Kingdom terrain data (c) Environment Agency copyright and/or database right 2015. All
    rights reserved;
  - United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the
    U.S. Geological Survey.
- **What Mapper credits:** the list above is eleven entries, too long for the credit strip on the
  picture. `src/core/credit.ts` has two forms. The burned-in form uses the short
  `TERRAIN_CREDIT`, "Terrain: USGS, Copernicus EU-DEM, NOAA ETOPO1 and others". The written form
  (FCPXML notes, the render manifest's `credit` and the MCP tool text) uses `TERRAIN_CREDIT_WRITTEN`,
  the full list above, and for satellite `SATELLITE_CREDIT_WRITTEN`, the EOxCloudless wording with
  https://cloudless.eox.at and CC BY 4.0.
