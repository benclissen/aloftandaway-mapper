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
   (see step 3). For a log of where something really went, see "Recorded
   tracks".
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
   `preview_frame` for a closer look at one moment. On a project with several
   scenes, check each scene (see "Scenes").
6. Tweak with `update_project`, then check the contact sheet again. `set`
   changes the project's name, output and credit. `sceneSet` changes the
   scene's name, timing, look and camera (for example `look.theme`,
   `look.terrain` or `look.symbolStyle`). `ops` edits stops, legs and via
   points, and adds, duplicates, removes or moves scenes. Passing `null`
   removes a key.
7. `open_studio` and give the user the link. They can scrub the preview, drag
   stops, set start and end shots, and reshape routes: click a leg to select
   it, click again to add a via point, drag points, and Alt-click or right-click
   a point for sharp, curved or remove. The legs panel sets each leg's transport. It doesn't open a browser itself.
8. When the user says they're done, call `get_project` and look at the contact
   sheet again, because their edits are now in the project.
9. `render` returns a `jobId`. Render the default flattened H.264 MP4 unless
   the user asks for Final Cut layers or a ProRes master. For layers, pass
   `layers: ["map","route","signs"]` (see "Final Cut Pro export"); for a
   flattened ProRes master, pass `codec: "prores"`. To render some scenes, or
   one file per scene, pass `scenes` and `join` (see "Scenes"). Poll
   `render_status` every few seconds.
10. Report the output paths and the required credit.

`get_project` reads the current state at any point.

## Shaping routes

- Add via points to bend a line around land or a coastline: `insert_via` with
  `{ "op": "insert_via", "leg": 0, "index": 0, "point": { "at": [lng, lat] } }`.
  `leg` and `index` count from 0. `update_via` moves or changes one, and
  `remove_via` deletes it.
- Mark a stop or a via point `sharp` for a corner. Without it, the line curves
  through.
- Sea legs route over the water the map draws, so a route stays off the islands
  you can see. The first route through an archipelago fetches map tiles and can
  take several seconds, up to about 20 s for a long one. After that it is
  cached. If validation reports `sea-fallback`, the leg couldn't be routed (or the stop is more than 30 km
  from the sea, or Mapper's land data couldn't be loaded) and is drawn as a
  straight line. If it reports
  `sea-crosses-land`, a via point has pulled the route ashore. Add via points
  over open water to fix either. `sea-stop-far` means a stop is more than 2 km
  from the water its route starts or ends in, so the line crosses land to reach
  it. Put a ferry or cruise stop on the quay, not in the town centre, or add a
  via point at the harbour mouth.
  `sea-unverified` means the route wasn't checked against all of OpenFreeMap's
  water. With no network, or too many tiles at once, it was checked against
  Natural Earth's coarser land outlines only, and it may cross small islands.
  A leg left unverified that also falls back is drawn as a straight line,
  which may cross land.
  Don't edit the leg for that, even if it also reports `sea-fallback`: once a
  minute has passed, the next call (or a studio left open) routes it again, so
  validate again then. If the route kept finding new islands, it was only
  partly checked; add a via point over open water to steer it. Mapper tries
  that one again only after a day. A render that uses an unverified route
  finishes with a warning, and the studio's legs panel notes it.
- Air legs follow the great circle, bowed toward the nearer pole so even short
  flights curve (at least 15% of their length). Via points split an air leg
  into arcs that meet at corners.
- Follow camera: set `camera.mode: 'follow'` through `sceneSet`, with
  `camera.follow { zoom, orient, lookAhead, smoothing, pitch }`. Every field is
  optional, and a partial object is fine. `orient` is `'north'` (the default)
  or `'heading'`. `lookAhead` is in seconds: the camera aims where the symbol
  will be that many seconds later (default 0.25). `smoothing` runs from 0 to 1
  (default 0.2). `pitch` tilts the view from 0 to 60 (default: the start shot's
  pitch, or 0). Missing `zoom` is the fitted zoom + 3, capped at the theme's
  maximum. `get_project` shows the resolved values as `resolvedFollow`.
- Computed sea paths are cached in `<project>/.mapper/paths.json`. A verified
  route keeps the OpenFreeMap build it was routed on until its stops or via
  points change. To re-route every sea leg on the current build, delete the
  file: Mapper recomputes the paths on the next read, which fetches map tiles
  again for any tiles no longer on disk.
- Set the transport per leg with `update_leg`, for example
  `{ "op": "update_leg", "index": 1, "changes": { "symbol": "ferry" } }`. A
  symbol without a mode also sets that transport's usual mode (a ferry sails,
  a plane flies). In `set_stops`, a stop's `symbol` does the same for the leg
  leaving it.
- Check the result with `preview_contact_sheet`.
- The user may have reshaped the route in the studio. Read `get_project`
  before changing legs, so you don't undo their edits.
- Stops, legs, look, camera and timing live in each scene in `project.scenes`.
  The result's `scenes` list has each scene's position, its timeline and its
  resolved camera shots, next to `project`.

## Scenes

A project can hold several scenes. Each has its own stops, legs, look, camera
and timing, and the film plays them one after another.

- Split a trip into scenes when the film cuts away between parts of it, for
  example a drive and then a sail. Keep one scene when the route plays as one
  continuous shot.
- Every tool that works on one scene takes `scene`: a scene id, or its 1-based
  position. Without it, the tool uses the first scene.
- On a project with more than one scene, every result names the scene it
  changed, as `Scene 2 of 2 · Sail`.
- Scene ops go in `update_project`'s `ops`, with 0-based indexes:
  - `add_scene { index?, name?, copyLookFrom? }` inserts an empty scene, named
    `Scene N` unless you give a name. A blank name is refused. It appends
    unless `index` is given. `copyLookFrom` is a scene id or a 1-based position
    (unlike `index`, which is 0-based).
    Without `copyLookFrom`, it copies the look of the scene before the new one
    (the one after it when it goes first). It copies the look, the timing, and
    the camera's mode, easing and follow settings. It doesn't copy the start or
    end shots.
  - `duplicate_scene { id }` puts a deep copy right after the original, named
    `<name> copy`, with new stop ids.
  - `remove_scene { id }`. The last scene can't be removed.
  - `move_scene { id, index }`.
- A scene name can't be blank. `add_scene` and `sceneSet` refuse an empty or
  all-space name, and names are stored without surrounding spaces. A project
  file that already holds a blank name still loads, and the scene shows as
  `Scene N`.
- Scene ids are in `get_project`. In `update_project`, `scene` picks the scene
  that `sceneSet` and the stop, leg and via ops change, even if a scene op in
  the same patch moves it. Don't remove a scene in the same patch that edits
  it.
- Call `preview_contact_sheet` once per scene before rendering. On a project
  with several scenes, the saved previews are named
  `scene<position>-frame-<n>.png` and `scene<position>-contact-<stamp>.png`.
- `render` joins the picked scenes by default. The cut between scenes is a hard
  cut, with no transition. Add transitions in Final Cut if the film needs them.
  - `scenes` picks scenes by id or position. The default is all of them. They
    always render in film order, and duplicates are refused.
  - `join: false` writes one file per scene. Then `range` works only with one
    scene picked.
  - `range` is in seconds on the joined timeline (on the picked scenes, back to
    back).
  - Errors block a render only in a picked scene. The credit covers only the
    rendered scenes.
  - The finished render lists where each scene starts in the joined clip, as
    MM:SS:FF, for example `Scene 2 · Sail starts at 00:07:00`.
  - On the CLI, the same options are `--scenes 1,3` and `--each`.
- The studio shows one tab per scene, so the user can switch between them.

Output folders with several scenes (`<scene-slug>` is the scene's name, and
`01`, `02` are its film position):

| | `join: true` (default) | `join: false` |
|---|---|---|
| Flattened | `all.mp4` or `all.mov` | `01-<scene-slug>.mp4` or `.mov`, `02-…` |
| Preview | `preview.mp4` | `01-<scene-slug>-preview.mp4` |
| Layers | `01-<scene-slug>/map.mov`, `route.mov`, `signs.mov` | same |
| FCPXML | compound clips plus a project timeline | compound clips only |

## Recorded tracks

`import_track` draws a path that was really travelled, exactly as logged. It
reads a local `.gpx` (with a `<time>` on every point) or `.csv`, puts a stop
wherever the track stood still, and makes every leg a `track` leg that follows
the recorded points. Like `set_stops`, it replaces the scene's stops. The track
is thinned once, at import, and kept in `<project>/tracks/<id>.json`. That
folder is source data, not cache: don't delete it. Re-importing the same track
reuses the same file. `symbol` sets the transport of every leg, for example
`"symbol": "cruise-ship"`.

- Use `import_track` for a log you want kept as it was: a phone GPS log, a
  ship's positions. Use `import_gpx` for a planned route you may reshape,
  where the track only becomes via points and a sea leg is still routed over
  water. A track leg is never re-routed.
- Mapper never fetches the data. If the positions come from a provider or an
  API, you fetch them and write a CSV file first. The first row names the
  columns: `lng`, `lat` and `time` (`lon`, `longitude`, `latitude` and
  `timestamp` also work, in any order and case). Longitude first, as everywhere
  else. Write `time` in ISO 8601 with a `Z` or an offset, or as Unix seconds:

  ```
  lng,lat,time
  23.6469,37.9426,2026-06-01T06:00:00Z
  23.6471,37.9427,2026-06-01T06:05:00Z
  ```

  Rows with a bad coordinate are skipped and counted in the result. Rows may
  come in any order. If any time is missing or unreadable, `stops: 'stays'` is
  refused with a fix: repair the times, or pass `stops: 'ends'`. Without
  `stops`, such a file gets `ends`, and the summary says why no stays were
  looked for. `track` picks a track in a GPX file and is refused for a CSV.
- `stops: 'stays'` (the default when every point has a time) makes a stop
  wherever the track stayed within 1 km for `minStayMinutes` (default 120),
  plus the first and last points. `stops: 'ends'` makes only the first and last.
  Lower `minStayMinutes` for short calls, raise it to ignore traffic stops.
  A log of more than 10,000 points is searched at a coarser time step (its
  span over 5,000), so a call only just longer than `minStayMinutes` can be
  missed: lower it a little if a known call is missing. A
  loop that ends where it began, such as a day out from a hotel, gives two
  stops at the same place and one leg round the loop. Keep both stops. If the
  way out comes back within 2 km of the start before the end, the leg is cut
  there, so check a preview.
- Stops are named after a GPX waypoint within 1 km, otherwise `Stop 1`,
  `Stop 2`. The result lists each stop with its arrival and departure times.
  Match those to the itinerary, then rename with `update_project`'s
  `update_stop` op. The stop ids are in the result's `project`, at
  `scenes[].stops[].id`, in the same order as `import.stops` and its times.
  (If your client shows only the text summary, call `get_project` for them.)

  ```json
  { "op": "update_stop", "id": "<stop id>", "changes": { "name": "Santorini", "pause": 2 } }
  ```
- Fix a missed stop with `insert_stop` at the port's `[lng, lat]`, and a false
  one with `remove_stop { id }`. Both keep every leg on the track: an inserted
  stop splits its leg, and removing a stop joins the two parts. A `legMode` on
  an inserted stop wins for the leg leaving it, so leave it out. Changing a
  leg's `symbol` alone also keeps it on its track.

  ```json
  { "op": "insert_stop", "index": 2, "stop": { "name": "Rhodes", "at": [28.2278, 36.4349] } }
  ```
- Validation: `track-missing` is an error (the file in `tracks/` is gone or
  damaged; put it back, or import the same file again to rewrite it).
  `track-stop-far` is a warning: a stop is more than 2 km from the track, so
  the line jumps to it. Move the stop onto the track.
- A track leg takes no via points, and the studio shows it read-only.
- Timing uses distance only. The recorded times don't set the clip's pace.

### Exact length

`timing.length` fixes a scene's length in seconds, for a clip that has to fit
a gap in the edit. Set it with `sceneSet`:

```json
{ "folder": "/abs/path", "sceneSet": { "timing": { "length": 8 } } }
```

At 25 fps that renders exactly 200 frames. Mapper works out `travel` as the
length minus both holds and all pauses, and writes it back into `timing.travel`.
A `travel` you set by hand on that scene is overwritten, so change the length,
holds or pauses instead. Changing a pause leaves the total at 8 s. If the holds
and pauses add up to more than the length, the patch is refused. `null` clears
the length. The summary shows `(200 frames, fixed length)`.

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
- Camera keys: `camera.keys` is a list of `{ "at": seconds, "shot": {...} }`,
  glide mode only. `at` counts from the scene's first frame. The camera holds
  the first key's shot until its time, flies from key to key (`camera.easing`
  applies to each flight), and holds the last shot. The ship's timing doesn't
  change. While keys are set, `start` and `end` are ignored, and validation says
  so (`camera-start-end-ignored`). Keys must be in ascending `at` order, with no
  two at the same time, or validation reports an error
  (`camera-keys-order`) and blocks a render. Keys on a fixed or follow camera
  are ignored (`camera-keys-ignored`). A key after the scene's last frame
  gets `camera-key-late`, and a key zoomed past the theme's maximum gets
  `zoom-above-max`. Send the whole list in `sceneSet`, for example
  `{ "camera": { "keys": [ { "at": 0, "shot": {...} }, { "at": 3, "shot": {...} } ] } }`.
  `null` clears it. `get_project` shows `keys` as stored, and `resolvedStart`
  and `resolvedEnd` are the first and last key's shots. In the studio's glide
  mode: Add key, click a key chip to scrub to it, × on a chip removes it, and
  Clear keys removes them all. Fit to route clears keys, and Use as start / end
  is hidden while keys exist. `duplicate_scene` copies keys. `add_scene` doesn't.
- Route context: `scene.context` is a faint copy of another route, drawn under
  the scene's own. Use it when a scene shows one leg of a longer trip and the
  viewer should still see where it sits. The `copy_context { folder?, scene? }`
  op in `update_project`'s `ops` fills it. The scene that receives the context
  is the patch's own `scene`. The op's `scene` is the one to copy from (an id or
  1-based position, default the first). `folder` is the absolute path of another
  project (leave it out to copy from this one). A scene can't be its own
  context. It copies
  the stops (name and position) and the legs (mode and via points). A
  recorded track leg comes over as a plain `line` leg, because a context keeps
  no tracks. It's a snapshot, so if the main route changes, run `copy_context` again. The source
  project is only read. `sceneSet: { "context": null }` removes it. Context
  shows as a thin line in the line colour at about a third opacity, plus a
  faint dot at each of its stops, with no name tags. In a layered export it is
  on the `route` layer. Context sea legs are routed like any sea leg, and a
  context sea leg that falls back to a straight line is a warning.
  `get_project` gives each scene's `resolvedContext`: a shot that fits the
  whole context route in the output frame. That's your wide shot for key 0.

### Subclip of one leg

Say a trip has several islands, and the film wants a clip of just the sail from
one to the next. Make it a one-leg scene with the full trip as context.

1. Make a project, or add a scene, with the two ports as its only stops. Set the
   leg mode (a ferry, say).
2. `update_project` with `ops: [{ "op": "copy_context", "folder": "<abs path of the full trip project>", "scene": 1 }]`.
   (`scene` is the trip's scene to copy from.) The full route now shows faintly
   under the leg.
3. `get_project` and take `resolvedContext` from the scene's `camera`. That's
   the whole trip in frame.
4. Set `timing.holdStart` so the ship leaves after the zoom, say 3 s, and read
   the arrival time from the scene's `timeline` (`holdStart` plus `travel`).
5. Set `camera.keys` with `sceneSet`, in this order:
   - `at: 0`, the `resolvedContext` shot, so the clip opens on the whole trip.
   - `at: 1`, a close shot of the first port.
   - `at: 3`, the same close shot again, so the camera holds there until the
     ship sets off. Match this to `holdStart`.
   - `at: <arrival time>`, a close shot of the next port.
6. `preview_contact_sheet`, and look at it. Check that the whole trip shows
   first, the camera is close on the first port by about a second in, and it has
   flown to the next port by the time the ship arrives. Nudge the key times and zooms, then check again.

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

- Transitions between scenes. A joined render uses hard cuts, and a layered
  export gets its transitions in Final Cut Pro.

## Reading `render_status`

- Running: `Frame N of M`, frames per second and time left. Keep polling.
- "Queued behind another render" or "Starting": no frames yet. Keep polling.
- Done: the video path, the manifest path, the render folder and the credit
  line. Pass these on to the user.
- A render can finish with warnings. They follow the result under `Warnings:`,
  and they're also in `manifest.json`. `preview_frame` and
  `preview_contact_sheet` report them too. Pass them on to the user. The most
  likely one reads `Frames 12, 13 and 40: the camera height over terrain hadn't
  settled, so these frames may differ slightly between renders and between
  layers.` It only comes up with `look.terrain: true`, and it means the 3D
  camera height wasn't steady on those frames, so they may sit a hair differently
  from one render, or one layer, to the next. The clip is still good. To get
  rid of it, render again, or lower the shot's pitch. The frame numbers count
  from the start of that scene, as `preview_frame` counts them, not from the
  start of a ranged output file. On a project with several scenes the line starts
  with the scene, as `Scene 2 of 2 · Sail: frames 12 and 13 …`. Another warning
  says Mapper couldn't delete the part files after joining scenes. The joined
  clip is fine, and the leftover parts can be deleted by hand.
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

With `join: false`, the flattened files are one per scene instead (see
"Scenes").

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
  01-<scene-slug>/map.mov      ProRes 422 HQ
  01-<scene-slug>/route.mov    ProRes 4444, alpha
  01-<scene-slug>/signs.mov    ProRes 4444, alpha
  <project>.fcpxml          FCPXML 1.11, validated against Final Cut's DTD if installed
  preview.mp4
  manifest.json
```

- Tell the user to import the `.fcpxml`. The `Mapper` event holds one compound
  clip per scene, named `<project> · <scene>`. Each has map on the primary
  storyline, route on lane 1 and signs on lane 2 (roles `Map.Base`,
  `Map.Route`, `Map.Signs`). With `join` (the default), a project timeline
  places the scene clips back to back.
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
- Final Cut import hasn't been checked by hand yet. The check for a two-scene
  layered export is waiting for the user's import. See
  `docs/final-cut-export.md`.

## Changes for existing projects

Projects made before stage 5 still load, with these intended differences:

- A glide with no `camera.start` now opens on the first leg and pulls out to the whole route.
- Follow mode caps how far ahead it aims and turns more slowly with `orient: 'heading'`.
- A project with `terrain: true` now renders in 3D. It used to render flat.
- A symbol other than `dot` now draws its icon in place of the dot.
- Sign text uses Plus Jakarta Sans.

Camera keys and route context are new fields, so older projects have neither
and look exactly as before. Add them where a scene needs them.

Projects made before stage 6 still load. Their one scene keeps its stops and
settings. The layer folder is now named after the scene (`01-<scene-slug>`, not
`01-<project>`), which is usually the same name.

## Credit

Every render that shows map data needs this map credit, exactly as written:

`© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap`

Some looks need more lines:

- `satellite` adds `Sentinel-2 cloudless 2016 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016), CC BY 4.0`.
- Elevation data adds `Terrain: USGS, Copernicus EU-DEM, NOAA ETOPO1 and others`. That is
  `look.terrain: true`, and also `outdoor`, which always shades hills.
- `blank` with terrain off and no sea legs needs no credit, since it shows no
  map data. A `blank` scene with a sea leg needs the map credit above: the
  route is drawn from OpenStreetMap water data.

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
