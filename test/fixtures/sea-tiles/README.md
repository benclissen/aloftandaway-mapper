# Sea-route fixture tiles

Small vector tiles that let the sea-route tests run offline. They are OpenFreeMap basemap tiles with
everything cut away except the `water` layer.

- **What's here:** `<planet build>/<zoom>/<x>/<y>.pbf`, the layout `test/helpers/fake-tiles.ts` serves.
  Zoom 12 holds every tile the fixture routes used. Zoom 14 holds every tile within 300 m of each
  final route, which is what the tests use to check the routes against the map's own polygons.
  `manifest.json` lists the planet build, the legs and their stops (with how far each stop is from
  zoom-14 water, and any stop that was moved), and the tile counts.
- **Legs:** Stockholm (Stadsgarden quay) to Sandhamn, Stockholm to Mariehamn, and the three
  `greekIslands()` legs: Piraeus to Mykonos, Mykonos to Santorini, Santorini to Rhodes.
- **A missing file is an empty tile.** The fake answers 204 for it, as OpenFreeMap does. Every tile
  the routes needed had a water layer, so none are missing.
- **How they're made:** `npm run build:sea-fixtures` needs a network. It routes each leg with the real
  sea router on live OpenFreeMap, through a store that records which tiles the router asked for, then
  copies the `water` layer out of each tile's protobuf byte for byte (the top-level repeated field 3
  whose name is `water`). The result is a valid tile with one layer. Nothing is re-encoded. It uses a
  fresh temporary tile cache, so the output depends only on OpenFreeMap's planet build of the day.
  Rebuilding replaces the build folder and the manifest.

## Licence

The tiles contain OpenStreetMap data, which is available under the
[Open Database Licence 1.0 (ODbL)](https://opendatacommons.org/licenses/odbl/1-0/).

Data (c) OpenStreetMap contributors, via OpenMapTiles and OpenFreeMap. The tiles are an adapted
extract of that database: only the water layer is kept. See
[openstreetmap.org/copyright](https://www.openstreetmap.org/copyright).
