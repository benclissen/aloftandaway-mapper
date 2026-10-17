# Final Cut export

This is the optional layered export. By default `mapper render` writes one
flattened H.264 MP4 (`all.mp4`); use the options here only when you want
separate layers and an FCPXML that rebuilds them in Final Cut Pro. This page covers the commands, what lands on disk, how
the FCPXML is laid out, and what has and hasn't been verified.

## Render layers

```bash
mapper render /absolute/path/to/project --layers map,route,signs
mapper render /absolute/path/to/project --layers map,route,signs,preview
mapper render /absolute/path/to/project --layers map,route,signs --from 2 --to 4
mapper render /absolute/path/to/project --layers map,route,signs --scenes 1,3
mapper render /absolute/path/to/project --layers map,route,signs --each
mapper render /absolute/path/to/project                   # default: flattened H.264 all.mp4
mapper render /absolute/path/to/project --codec prores    # flattened ProRes 422 HQ all.mov
```

The MCP `render` tool takes the same options:

```json
{"folder":"/absolute/path/to/project","layers":["map","route","signs","preview"],"range":{"from":0,"to":2}}
{"folder":"/absolute/path/to/project","layers":["map","route","signs"],"scenes":[1,3],"join":false}
```

A render covers every scene of the project unless `scenes` (`--scenes`)
picks some, by id or 1-based position. They always render in film order.
`join` (on by default) puts the picked scenes back to back with hard cuts;
`join: false` (`--each`) keeps them apart. `range` (`--from`, `--to`) is in
seconds on the picked scenes back to back, and works with `join: false` only
when one scene is picked.

`layers` takes any of `map`, `route`, `signs`, `all` and `preview`, each once.

- `all` is the flattened clip, and the default when `layers` is left out. It
  is H.264 (`all.mp4`) unless you pass `codec: prores` (`all.mov`).
- `preview` is a flattened H.264 check clip. Don't combine it with `all`.
- `map`, `route` and `signs` are always ProRes, and need no codec. Asking for
  them with `--codec h264` is an error: `codec` only applies to `all`.
- The FCPXML is written only when `map`, `route` and `signs` are all
  requested. Any smaller set renders just those files.

## Output

```
<project>/renders/<YYYY-MM-DD-HHmmss>/
  01-<scene-slug>/
    map.mov        ProRes 422 HQ, opaque
    route.mov      ProRes 4444, alpha
    signs.mov      ProRes 4444, alpha
  02-<scene-slug>/          one folder per rendered scene, same three files
  <project-slug>.fcpxml     FCPXML 1.11
  preview.mp4               H.264, when preview is requested
  all.mov | all.mp4         the flattened clip, when all is requested
  manifest.json
```

`<scene-slug>` comes from the scene's name, and `01`, `02` are the scene's
position in the project, so a render of scenes 1 and 3 has `01-…` and `03-…`.
A one-scene project's scene is usually named after the project. With
`join: false`, the flattened clip and the preview are per scene too:
`01-<scene-slug>.mp4` (or `.mov`) and `01-<scene-slug>-preview.mp4` instead of `all.mp4`
and `preview.mp4`. The layer folders and the FCPXML are named the same either
way.

Within a scene, every layer covers the same frames; scenes have their own
lengths. All files are tagged Rec. 709. The manifest lists only the layers
that finished, plus the credit placement, the FCPXML file name, its
validation result and, for a joined render, where each scene starts.

## Import into Final Cut Pro

Double-click `<project-slug>.fcpxml`, or use File > Import > XML. Final Cut
creates an event called `Mapper` holding one compound clip per scene, named
`<project> · <scene>`.

- **Joined** (the default): the event also holds a project, named after the
  Mapper project, that plays the compound clips back to back in film order,
  with hard cuts and no gaps. Add transitions in Final Cut if the film needs
  them.
- **`join: false`** (`--each`): there is no project, only the compound clips.
  Put them on a timeline yourself.

Open a compound clip. It has three connected layers:

| Layer | Position | Role |
|---|---|---|
| Map | primary storyline | `Map.Base` |
| Route | lane 1, above the map | `Map.Route` |
| Signs | lane 2, above the route | `Map.Signs` |

Each compound holds one marker per stop arrival in its scene, named with the
stop's label, or `Day N · name`, or its name. A marker is one frame long, on
the map clip.

- **Range.** With `--from` and `--to`, the render holds the frames from
  `floor(from × fps)` up to `ceil(to × fps)` of the picked scenes back to
  back, clamped to their total. A scene the range doesn't reach is left out.
  Only arrivals inside the range get a marker, and marker times count from
  the first rendered frame of that scene.
- **Frame rates.** Durations are exact fractions of a frame, for example
  `73073/24000s` for 73 frames at 24000/1001.
- **Credit.** If the project's `credit` is `description`, the credit is also
  written into the compound's notes. Notes aren't published. The video
  description still needs the credit, whatever the notes say:
  `© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap`. When the credit
  is `burned`, the map layer carries it.
- **Moving files.** The FCPXML points at the media by absolute path. If you
  move or rename the render folder after rendering, Final Cut asks you to
  relink each scene's three clips. Import again from the new location, or
  relink.

## Limits

- Scenes are joined with hard cuts only. There are no transitions.
- Partial layer sets (`map` alone, or `route,signs`) write media but no
  FCPXML.
- Cancelling or failing a render keeps every layer that finished, and the
  manifest says which. No FCPXML is written for an incomplete render. A
  render that is cancelled while the FCPXML is being validated leaves no
  `.fcpxml` either.
- If Final Cut Pro isn't installed, the FCPXML can't be checked against its
  DTD. It is still written, and the manifest says `fcpxmlValidation:
  "skipped-no-fcp"`.
- If validation fails, the render fails and the rejected document is left as
  `<slug>.fcpxml.tmp` in the render folder for diagnosis. There is no
  `.fcpxml`.
- With Final Cut Pro installed, `xmllint` must be on the PATH. A render
  checks for it first and stops before it starts Chrome or creates a render
  folder.
- Disk space: before it starts, a render estimates what it needs (about 0.2 bytes
  per pixel per frame for ProRes 4444, 0.45 for 422 HQ, 0.03 for the default
  H.264, with a 1.5 margin) plus room to join the largest file. Measured
  sizes for 3 s of 4K25: 222 MB map, 10 MB route and 18 MB signs. A busy map
  layer runs to about 4.4 GB per minute at 4K25, so the estimate is the safe
  number to plan around: a 30 s 4K25 layered export needs about 12 GB free.

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

The acceptance renders are kept in `/tmp`, so recreate them when you need them.
All stop data is made up. Run these from the repo root after `npm run build`,
with `mapper` meaning `node dist/cli/main.js` (or use `npm link`). `T` is a
scratch folder of your choice.

```bash
T=$(mktemp -d)
mapper() { node dist/cli/main.js "$@"; }
STOPS='[{"name":"Alpha Harbour","at":[10,45],"pause":1,"sign":"always"},
        {"name":"Beta Bay","at":[11.5,44.2],"pause":1,"sign":"always"},
        {"name":"Gamma Cove","at":[13,43.8],"pause":0,"sign":"always"}]'
```

Project A, 4K 25p, credit in the description:

```bash
mapper create-project --json "{\"folder\":\"$T/proj-a\",\"name\":\"Synthetic Isles\"}"
mapper set-stops --json "{\"folder\":\"$T/proj-a\",\"stops\":$STOPS}"
mapper update-project --json "{\"folder\":\"$T/proj-a\",\"set\":{\"credit\":\"description\"},\"sceneSet\":{\"timing\":{\"holdStart\":1,\"travel\":10,\"holdEnd\":2}}}"
mapper render "$T/proj-a" --layers map,route,signs,preview --from 0 --to 3
```

Project B, 1080p at 24000/1001, credit burned in:

```bash
mapper create-project --json "{\"folder\":\"$T/proj-b\",\"name\":\"Synthetic Coast\"}"
mapper set-stops --json "{\"folder\":\"$T/proj-b\",\"stops\":$STOPS}"
mapper update-project --json "{\"folder\":\"$T/proj-b\",\"set\":{\"credit\":\"burned\",\"output\":{\"height\":1080,\"fps\":{\"num\":24000,\"den\":1001}}},\"sceneSet\":{\"timing\":{\"holdStart\":1,\"travel\":10,\"holdEnd\":2}}}"
mapper render "$T/proj-b" --layers map,route,signs,preview --from 5 --to 8
```

The renders land in `$T/proj-a/renders/` and `$T/proj-b/renders/`. The same
steps work through the MCP tools (`create_project`, `set_stops`,
`update_project`, `render`) with the same JSON.

Project C, two scenes at 1080p 24000/1001, credit in the description. The
first `update-project` names scene 1 `Coast`, shortens its timing and adds
scene 2, `Islands`, which copies the look and timing. The render is joined,
the default, so the FCPXML has a compound clip per scene and a project that
plays them back to back:

```bash
STOPS_2='[{"name":"Delta Point","at":[14,43.2],"pause":1,"sign":"always"},
          {"name":"Epsilon Reef","at":[15.2,42.6],"pause":0,"sign":"always"}]'
mapper create-project --json "{\"folder\":\"$T/proj-c\",\"name\":\"Synthetic Voyage\"}"
mapper set-stops --json "{\"folder\":\"$T/proj-c\",\"stops\":$STOPS}"
mapper update-project --json "{\"folder\":\"$T/proj-c\",\"set\":{\"credit\":\"description\",\"output\":{\"height\":1080,\"fps\":{\"num\":24000,\"den\":1001}}},\"sceneSet\":{\"name\":\"Coast\",\"timing\":{\"holdStart\":1,\"travel\":3,\"holdEnd\":1}},\"ops\":[{\"op\":\"add_scene\",\"name\":\"Islands\"}]}"
mapper set-stops --json "{\"folder\":\"$T/proj-c\",\"scene\":2,\"stops\":$STOPS_2}"
mapper render "$T/proj-c" --layers map,route,signs,preview
```

On 2026-10-16 (branch `stage-6-scenes`) all three scripts above were run as
written. A and B validated and gave the same markers, durations and notes as
the table above. C took about 80 s and gave:

- `01-coast/` and `02-islands/`, each with `map.mov`, `route.mov` and
  `signs.mov`, and a joined `preview.mp4`. Coast is 168 frames, Islands 144.
- `synthetic-voyage.fcpxml`, validated against the Final Cut Pro DTD
  (`fcpxmlValidation: "passed"`). It holds the compound clips
  `Synthetic Voyage · Coast` (`7007/1000s`) and `Synthetic Voyage · Islands`
  (`3003/500s`), each with the credit note, and a project
  `Synthetic Voyage` (`13013/1000s`) with Islands at offset `7007/1000s`.
- Markers: Coast at frames 24, 87 and 144 (Alpha Harbour, Beta Bay, Gamma
  Cove), Islands at 24 and 120 (Delta Point, Epsilon Reef).
- The result says `Scene 2 · Islands starts at 00:07:00`.

Add `--each` to the render for the unjoined layout: `01-coast-preview.mp4`
and `02-islands-preview.mp4`, and an FCPXML with the two compound clips and
no project.

### Manual acceptance in Final Cut

On 2026-10-17 the user imported a two-scene layered export (the Stage 7
check project) into Final Cut Pro 12.4: two compound clips back to back on one
timeline, each with map, route and signs on separate lanes. That passes check 9
and the import itself (checks 1 and 2). Checks 3 to 8 and 10 weren't reported
one by one; DTD success does not stand in for them. This checklist applies only
to the optional layered export; the default MP4 path doesn't depend on it (see
[plan.md](plan.md)). Use a disposable library.

1. Import `$T/proj-a/renders/<timestamp>/synthetic-isles.fcpxml` (File > Import > XML). Check the
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
9. Import `$T/proj-c/renders/<timestamp>/synthetic-voyage.fcpxml`. The
   `Mapper` event should hold two compound clips, `Synthetic Voyage · Coast`
   and `Synthetic Voyage · Islands`, and a project `Synthetic Voyage`. Open
   the project: the two compounds play back to back with a hard cut, no
   overlap and no gap, Islands starting at 7:00 (frame 168). Each compound
   reads its own scene's folder (`01-coast/`, `02-islands/`) and has its own
   markers. The cut should land where it does in `preview.mp4`. Passed
   2026-10-17, with the Stage 7 check project in place of this one.
10. Move a copy of a render folder and import its FCPXML to confirm the
    relink prompt appears.

Known oddity: the compound is named `<project> · <scene>`, and for a
one-scene project the scene name is the project name, so it reads "Synthetic
Isles · Synthetic Isles".
