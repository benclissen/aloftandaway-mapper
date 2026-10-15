---
name: mapper
description: Make animated travel maps, route animations and map clips for a video with the Mapper MCP tools. Use when the user wants a map of a trip, a route drawn between places, or a map clip for a travel film.
---

# Mapper

Mapper renders an animated map clip to a video file. A line is drawn from stop
to stop while the camera moves along it. Mapper runs on the user's machine. You
drive it through MCP tools, and the user tweaks the result in a local studio
page.

## Workflow

1. Get the stops from wherever the user points you. Mapper has no data
   connectors, so you supply the stops. A local GPX file can be used instead
   (see step 3).
2. `create_project` with an absolute `folder` and a `name`. Defaults are
   3840×2160, 25 fps, 16:9.
3. `set_stops` with the stops in travel order. Each `at` is `[lng, lat]`. For a
   local GPX file, call `import_gpx` with `folder`, an absolute `path` and
   optionally `track` (a 1-based number or a name, when the file has several).
   By default (`stops: 'ends'`) only the first and last points become stops;
   this needs a track or route in the file. `stops: 'waypoints'` makes each
   waypoint within 2 km of the track a stop. For a file with only waypoints,
   pass `stops: 'waypoints'`: they become stops in file order.
   The track between stops becomes up to 100 via points per leg. `legMode`
   (default `'line'`) and `symbol` work as they do in `set_stops`.
4. `validate_project`. Fix every warning, or explain it to the user.
5. `preview_contact_sheet` and look at it: framing, labels, stop timing. Use
   `preview_frame` for a closer look at one moment.
6. Tweak with `update_project`, then check the contact sheet again. `set`
   changes the project's name, output and credit. `sceneSet` changes the
   scene's name, timing, look and camera (for example `look.theme`,
   `look.terrain` or `look.symbolStyle`). `ops`
   edits stops, legs and via points. Passing `null` removes a key.
7. `open_studio` and give the user the link. They can scrub the preview, drag
   stops, set start and end shots, and reshape routes: click a leg to select
   it, click again to add a via point, drag points, and Alt-click or right-click
   a point for sharp, curved or remove. The legs panel sets each leg's transport. It doesn't open a browser itself.
8. When the user says they're done, call `get_project` and look at the contact
   sheet again, because their edits are now in the project.
9. `render` returns a `jobId`. Render the default flattened H.264 MP4 unless
   the user asks for Final Cut layers or a ProRes master. For layers, pass
   `layers: ["map","route","signs"]` (see "Final Cut Pro export"); for a
   flattened ProRes master, pass `codec: "prores"`. Poll `render_status` every
   few seconds.
10. Report the output paths and the required credit.

`get_project` reads the current state at any point.

## Shaping routes

- Add via points to bend a line around land or a coastline: `insert_via` with
  `{ "op": "insert_via", "leg": 0, "index": 0, "point": { "at": [lng, lat] } }`.
  `leg` and `index` count from 0. `update_via` moves or changes one, and
  `remove_via` deletes it.
- Mark a stop or a via point `sharp` for a corner. Without it, the line curves
  through.
- Sea legs route around land over the water. If validation reports
  `sea-fallback`, the leg couldn't be routed (or the stop is more than 30 km
  from the sea, or Mapper's land data couldn't be loaded) and is drawn as a
  straight line. If it reports
  `sea-crosses-land`, a via point has pulled the route ashore. Add via points
  over open water to fix either.
- Air legs draw as great-circle flight arcs. Via points split an air leg into
  arcs that meet at corners.
- Follow camera: set `camera.mode: 'follow'` through `sceneSet`, with
  `camera.follow { zoom, orient, lookAhead, smoothing, pitch }`. Every field is
  optional, and a partial object is fine. `orient` is `'north'` (the default)
  or `'heading'`. `lookAhead` is in seconds: the camera aims where the symbol
  will be that many seconds later (default 0.25). `smoothing` runs from 0 to 1
  (default 0.2). `pitch` tilts the view from 0 to 60 (default: the start shot's
  pitch, or 0). Missing `zoom` is the fitted zoom + 3, capped at the theme's
  maximum. `get_project` shows the resolved values as `resolvedFollow`.
- Computed sea paths are cached in `<project>/.mapper/paths.json`. The cache is
  safe to delete; Mapper recomputes the paths on the next read.
- Set the transport per leg with `update_leg`, for example
  `{ "op": "update_leg", "index": 1, "changes": { "symbol": "ferry" } }`. A
  symbol without a mode also sets that transport's usual mode (a ferry sails,
  a plane flies). In `set_stops`, a stop's `symbol` does the same for the leg
  leaving it.
- Check the result with `preview_contact_sheet`.
- The user may have reshaped the route in the studio. Read `get_project`
  before changing legs, so you don't undo their edits.
- Stops, legs, look, camera and timing live in `project.scenes[0]`. The
  per-scene timeline and resolved camera shots are in `scenes[0]` of the
  result, next to `project`.

## Look and camera

Set the style with `look.theme`, through `sceneSet` or the studio's style
picker. Pick by what the film needs:

- `aloftandaway`: the series-map look, with cool greys, a navy coast line and
  spaced capitals. Use it for Aloft & Away films. It's the default.
- `aloftandaway-warm`: the same look with sage and sand tones. Use it when the
  film needs more warmth.
- `paper`: warm off-white land and a grey-blue sea, like a printed map. Use it
  for a quiet, classic look.
- `light`: near-white land and a pale blue sea. Use it when the map should stay
  out of the way.
- `dark`: night blues with pale labels. Use it for night scenes or a moody cut.
- `nautical`: a deep sea against parchment land, like a chart. Use it for
  passages and sailing.
- `atlas`: a school atlas, with cream land and red borders. Use it for a
  retro, educational feel.
- `outdoor`: greens and hill shading. Use it for walking and mountain routes.
  It always shows hills.
- `satellite`: 2016 satellite imagery with white labels. Use it when the place
  itself is the subject. It adds a credit line.
- `monochrome`: greys only, so any line colour stands out. Use it when the
  route colour has to carry the film.
- `blank`: a plain background with no map data. Use it for a route on its own.

- Terrain: `look.terrain: true` adds 3D elevation. Every style except
  `satellite` also gets hill shading. Pair it with a shot `pitch` (0 to 60) or
  `camera.follow.pitch` to tilt the view. Terrain renders take about 1.5 times
  as long.
- Symbols: `look.symbol` sets the scene's default transport, and a leg's
  `symbol` overrides it. `look.symbolStyle` sets how it's drawn: `badge` (the
  default, a navy disc with a white ring and a white icon), `badge-line` (the
  disc in the line colour), or `icon` (a navy icon on a white halo). `dot` is
  the plain head and `none` draws nothing.
- Transports: land is walk, bike, motorcycle, scooter, car, campervan, bus,
  coach, train, tram and cable-car. Sea is ferry, cruise-ship, sailboat,
  speedboat and kayak. Air is plane, helicopter and balloon. Lines are dot,
  arrow and none.
- Facing: side-view vehicles (bike, car, bus and the rest) mirror to face the
  way they travel. The flip is decided per leg, so a loop flips once per leg.
  Plane, helicopter and arrow turn with the line. Walk, train, tram, cable-car,
  cruise-ship and balloon stay upright.
- Signs: `tag` is the only sign style. Its font is the same in every style.
- Camera: a glide with no `start` opens on the first leg and pulls out to the
  whole route. A `fixed` camera with no `start` shows the whole route.

## Rules

- Look at a contact sheet before every render.
- Fix validation warnings or explain them to the user. Errors block a render.
- Never edit `mapper.json` by hand. Use the tools, so the project stays valid.
- Coordinates are `[lng, lat]`, longitude first. Mixing them up puts the stop
  in the wrong ocean.
- Never invent coordinates. Look them up, or ask the user.
- Drop sea days, meaning days at sea with no stop. Merge an overnight stay into
  the stop's `pause`, the seconds the clip holds there, instead of adding a
  second stop.
- Every `folder` must be an absolute path. Relative paths are rejected.
- Tell the user which map credit is required (see below).

## What Mapper can't do yet

- One scene per project.

## Reading `render_status`

- Running: `Frame N of M`, frames per second and time left. Keep polling.
- "Queued behind another render" or "Starting": no frames yet. Keep polling.
- Done: the video path, the manifest path, the render folder and the credit
  line. Pass these on to the user.
- Failed: the error text ends with a fix. Apply it, or tell the user.
- Cancelled: call `render` again if the user still wants the clip.

`cancel_render` stops a job. Job ids last only as long as the Mapper process.

## Outputs

Each render gets its own folder under the project:

```
<project>/renders/<timestamp>/all.mp4   (H.264, the default)
<project>/renders/<timestamp>/all.mov   (when codec is 'prores': ProRes 422 HQ)
<project>/renders/<timestamp>/manifest.json
```

The manifest records the settings and where the credit went.

## Final Cut Pro export (optional)

Only when the user asks for it. Pass `layers` to `render`: any of `map`, `route`, `signs`, `all` (the flattened
clip, the default) and `preview` (an H.264 check clip). From a shell:
`mapper render <folder> --layers map,route,signs,preview --from 2 --to 4`.

```json
{"folder":"/abs/path","layers":["map","route","signs","preview"],"range":{"from":0,"to":2}}
```

```
<project>/renders/<timestamp>/
  01-<project>/map.mov      ProRes 422 HQ
  01-<project>/route.mov    ProRes 4444, alpha
  01-<project>/signs.mov    ProRes 4444, alpha
  <project>.fcpxml          FCPXML 1.11, validated against Final Cut's DTD if installed
  preview.mp4
  manifest.json
```

- Tell the user to import the `.fcpxml`. The `Mapper` event holds a compound
  clip with map on the primary storyline, route on lane 1 and signs on lane 2
  (roles `Map.Base`, `Map.Route`, `Map.Signs`).
- There is a marker at each stop arrival in the range, named with the stop's
  label or `Day N · name`. With `range`, times count from the range start, and
  frames run from `floor(from × fps)` to `ceil(to × fps)`.
- No FCPXML unless `map`, `route` and `signs` are all requested. They need
  ProRes. `codec` only applies to the flattened `all` clip, which is H.264
  unless you pass `codec: "prores"`, so `codec: "h264"` without `all` is an error.
  They need far more disk than the default MP4: the map layer is about 4.4 GB
  per minute at 4K25. `all` and `preview` can't
  be combined.
- A cancelled or failed render keeps the layers that finished. The status
  lists them and the manifest records them. There is no FCPXML.
- The FCPXML uses absolute paths. If the user moves the render folder, Final
  Cut needs the media relinked.
- The FCPXML is validated against Final Cut's DTD when Final Cut Pro is
  installed; otherwise validation is skipped and recorded as `skipped-no-fcp`.
  `render_status` says which happened.
- Final Cut import hasn't been checked by hand yet. See
  `docs/final-cut-export.md`.

## Changes for existing projects

Projects made before stage 5 still load, with these intended differences:

- A glide with no `camera.start` now opens on the first leg and pulls out to the whole route.
- Follow mode caps how far ahead it aims and turns more slowly with `orient: 'heading'`.
- A project with `terrain: true` now renders in 3D. It used to render flat.
- A symbol other than `dot` now draws its icon in place of the dot.
- Sign text uses Plus Jakarta Sans.

## Credit

Every render that shows map data needs this map credit, exactly as written:

`© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap`

Some looks need more lines:

- `satellite` adds `Sentinel-2 cloudless 2016 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016)`.
- Elevation data adds `Terrain: USGS, Copernicus EU-DEM, NOAA ETOPO1 and others`. That is
  `look.terrain: true`, and also `outdoor`, which always shades hills.
- `blank` with terrain off needs no credit. It shows no map data (its sea routing data is
  Natural Earth, which is public domain).

By default the short lines are burned into the bottom-right of the video, but
the full text still belongs in the video description. If the project's
`credit` is `description`, nothing is burned in, so tell the user to put the
full credit in the description. The render summary and `render_status` give
that full text: the EOxCloudless
wording with its link and licence, and the complete terrain attribution. The
FCPXML repeats it in the compound's notes, but the description still needs it.

## Example

A cruise from Piraeus to Mykonos, Santorini and Rhodes, as `set_stops` input:

```json
{
  "folder": "/Users/me/maps/greek-isles",
  "stops": [
    { "name": "Piraeus",   "at": [23.6469, 37.9426] },
    { "name": "Mykonos",   "at": [25.3289, 37.4467], "pause": 2 },
    { "name": "Santorini", "at": [25.4319, 36.3932], "pause": 2 },
    { "name": "Rhodes",    "at": [28.2278, 36.4349] }
  ]
}
```

Those coordinates are approximate. For a real project, look them up.

## Setup

Run `mapper doctor` first. It checks Node, Chrome, ffmpeg and WebGL, and prints
a fix for anything missing.

The server command is `node <abs path to repo>/dist/cli/main.js mcp`. After
`npm link` in the repo, it's `mapper mcp`. Build first with `npm run build`.

**Claude Code**

```
claude mcp add mapper -- node /abs/path/to/repo/dist/cli/main.js mcp
```

**Claude Desktop**: add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mapper": {
      "command": "node",
      "args": ["/abs/path/to/repo/dist/cli/main.js", "mcp"]
    }
  }
}
```

**Codex**: add to `~/.codex/config.toml`:

```toml
[mcp_servers.mapper]
command = "node"
args = ["/abs/path/to/repo/dist/cli/main.js", "mcp"]
```

**Cursor**: add to `.cursor/mcp.json`, with the same shape as Claude Desktop.

Restart the client after adding the server.
