# Final Cut export

Mapper can render a clip as separate layers and write an FCPXML that rebuilds
them in Final Cut Pro. This page covers the commands, what lands on disk, how
the FCPXML is laid out, and what has and hasn't been verified.

## Render layers

```bash
mapper render /absolute/path/to/project --layers map,route,signs
mapper render /absolute/path/to/project --layers map,route,signs,preview
mapper render /absolute/path/to/project --layers map,route,signs --from 2 --to 4
mapper render /absolute/path/to/project --codec h264      # flattened H.264, no layers
```

The MCP `render` tool takes the same options:

```json
{"folder":"/absolute/path/to/project","layers":["map","route","signs","preview"],"range":{"from":0,"to":2}}
```

`layers` takes any of `map`, `route`, `signs`, `all` and `preview`, each once.

- `all` is the flattened clip, and the default when `layers` is left out.
- `preview` is a flattened H.264 check clip. Don't combine it with `all`.
- `map`, `route` and `signs` need ProRes. Asking for them with `--codec h264`
  is an error.
- The FCPXML is written only when `map`, `route` and `signs` are all
  requested. Any smaller set renders just those files.

## Output

```
<project>/renders/<YYYY-MM-DD-HHmmss>/
  01-<project-slug>/
    map.mov        ProRes 422 HQ, opaque
    route.mov      ProRes 4444, alpha
    signs.mov      ProRes 4444, alpha
  <project-slug>.fcpxml     FCPXML 1.11
  preview.mp4               H.264, when preview is requested
  all.mov | all.mp4         the flattened clip, when all is requested
  manifest.json
```

Every file covers the same frames. All are tagged Rec. 709. The manifest
lists only the layers that finished, plus the credit placement, the FCPXML
file name and its validation result.

## Import into Final Cut Pro

Double-click `<project-slug>.fcpxml`, or use File > Import > XML. Final Cut
creates an event called `Mapper` holding a compound clip and a project that
uses it.

Open the compound clip. It has three connected layers:

| Layer | Position | Role |
|---|---|---|
| Map | primary storyline | `Map.Base` |
| Route | lane 1, above the map | `Map.Route` |
| Signs | lane 2, above the route | `Map.Signs` |

The compound holds one marker per stop arrival, named with the stop's label,
or `Day N · name`, or its name. A marker is one frame long, on the map clip.

- **Range.** With `--from` and `--to`, the clip holds the frames from
  `floor(from × fps)` up to `ceil(to × fps)`, clamped to the clip. Only
  arrivals inside that range get a marker, and marker times count from the
  first rendered frame.
- **Frame rates.** Durations are exact fractions of a frame, for example
  `73073/24000s` for 73 frames at 24000/1001.
- **Credit.** If the project's `credit` is `description`, the credit is also
  written into the compound's notes. Notes aren't published. The video
  description still needs the credit, whatever the notes say:
  `© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap`. When the credit
  is `burned`, the map layer carries it.
- **Moving files.** The FCPXML points at the media by absolute path. If you
  move or rename the render folder after rendering, Final Cut asks you to
  relink the three clips. Import again from the new location, or relink.

## Limits

- One scene per project. The FCPXML writer is built to join several scenes,
  one compound clip each, and that is exercised with a test fixture. Project
  files and tools don't expose scenes yet.
- Partial layer sets (`map` alone, or `route,signs`) write media but no
  FCPXML.
- Cancelling or failing a render keeps every layer that finished, and the
  manifest says which. No FCPXML is written for an incomplete render. A
  render that is cancelled while the FCPXML is being validated leaves no
  `.fcpxml` either.
- If Final Cut Pro isn't installed, the FCPXML can't be checked against its
  DTD. It is still written, and the manifest says `fcpxmlValidation:
  "skipped-no-fcp"`.

## Acceptance record

Run on 2026-10-14, branch `stage-2-final-cut-export`. All data is made up.

### Tools

| Tool | Version |
|---|---|
| macOS | Darwin 27.0.0 |
| Node | v26.11.1 |
| ffmpeg | 9.0.2 |
| Google Chrome | 155.0.8059.79 |
| xmllint | libxml 20913 |
| Final Cut Pro | 12.4 (read from its Info.plist; not launched) |

### Automated checks

Run one after another.

| Command | Result |
|---|---|
| `npm run typecheck` | passed |
| `npm test` | 20 files, 447 passed, 0 failed, 0 skipped |
| `npm run test:e2e` | 10 files, 76 passed, 0 failed, 3 skipped (the three `MAPPER_NET` tests) |
| `MAPPER_NET=1 npm run test:e2e -- test/e2e/layers.test.ts` | 11 passed, 0 skipped, including the real paper tiles composite |

No goldens were regenerated.

### Acceptance renders

Both used a three-stop synthetic route (Alpha Harbour, Beta Bay, Gamma Cove)
and `--layers map,route,signs,preview`.

| | A: 4K 25p | B: 1080p 24000/1001 |
|---|---|---|
| Credit | `description` | `burned` |
| Range | `--from 0 --to 3` | `--from 5 --to 8` |
| Frames | 75 (0 to 75) | 73 (119 to 192) |
| map.mov | prores HQ, `yuv422p10le`, 3840x2160, 25/1, 75 frames | prores HQ, `yuv422p10le`, 1920x1080, 24000/1001, 73 frames |
| route.mov, signs.mov | prores 4444, `yuva444p12le`, 75 frames | prores 4444, `yuva444p12le`, 73 frames |
| preview.mp4 | h264 High, `yuv420p`, 75 frames | h264 High, `yuv420p`, 73 frames |
| Colour tags | bt709 primaries, transfer and matrix; tv range (all files) | same |
| Compound note | credit present | none |
| Markers | `Alpha Harbour` at `1s` | `Beta Bay` at `29029/12000s`, frame 58 of the clip (arrival at frame 177) |
| Duration | `3s` | `73073/24000s` |
| DTD validation | passed (manifest and an independent `xmllint --dtdvalid`) | same |

Frame counts come from `ffprobe -count_frames`. Roles and lanes in the
FCPXML text match the table above.

### Fixtures

The renders and a two-scene FCPXML are kept in `/tmp/mapper-accept.rb2RTZ`
(temporary; copy them if you need them to last).

- `proj-a/renders/2026-10-14-200910/`: render A
- `proj-b/renders/2026-10-14-200944/`: render B
- `two-scene/two-scene-fixture.fcpxml`: two scenes (`Scene One`, with markers
  at frames 0 and 58, and `Scene Two`, with a marker at frame 72), both reading
  render B's media, written with `writeFcpxml` and DTD-valid. Resource ids are
  unique, and scene two starts at `73073/24000s`.

### Outstanding manual acceptance

Final Cut Pro was not launched, so none of the following has been checked.
DTD success does not stand in for it. Stage 2 stays open in
[plan.md](plan.md) until these pass. Use a disposable library.

1. Import `proj-a/.../synthetic-isles.fcpxml` (File > Import > XML). Check the
   `Mapper` event holds a compound clip and a project, and the media isn't
   offline.
2. Open the compound (right-click > Open in Timeline). Map is on the primary
   storyline, Route on lane 1, Signs on lane 2.
3. Turn each layer off in turn. Route and Signs must show the map through
   them. Look at pale and dark areas along the route and sign edges for light
   or dark halos.
4. Compare colour against `preview.mp4` in the same library. Both should
   look like Rec. 709.
5. Open the Roles list in the Timeline Index. `Map.Base`, `Map.Route` and
   `Map.Signs` should be there.
6. Check the markers. A: one at 1:00 (frame 25). B: one at frame 58 of the
   clip. Compare against the stop arrival frames in the studio.
7. In the render B project, check the duration is 73 frames with no gap on
   the last frame, and the timeline frame rate is 23.976.
8. In render A, open the compound's notes (Inspector > Info) and find the
   credit. In render B there should be none.
9. Import `two-scene/two-scene-fixture.fcpxml`. The project should hold two
   compound clips back to back, with no overlap or gap. Both scenes read the
   same media files, which is expected for this fixture.
10. Move a copy of a render folder and import its FCPXML to confirm the
    relink prompt appears.

Known oddity: the compound is named `<project> · <scene>`, and for a
one-scene project the scene name is the project name, so it reads "Synthetic
Isles · Synthetic Isles".
