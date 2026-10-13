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
   connectors and no GPX import yet, so you supply the stops.
2. `create_project` with an absolute `folder` and a `name`. Defaults are
   3840×2160, 25 fps, 16:9.
3. `set_stops` with the stops in travel order. Each `at` is `[lng, lat]`.
4. `validate_project`. Fix every warning, or explain it to the user.
5. `preview_contact_sheet` and look at it: framing, labels, stop timing. Use
   `preview_frame` for a closer look at one moment.
6. Tweak with `update_project`, then check the contact sheet again.
7. `open_studio` and give the user the link. They can scrub the preview, drag
   stops and set start and end shots. It doesn't open a browser itself.
8. When the user says they're done, call `get_project` and look at the contact
   sheet again, because their edits are now in the project.
9. `render` returns a `jobId`. Poll `render_status` every few seconds.
10. Report the output paths and the required credit.

`get_project` reads the current state at any point.

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

## What stage 1 can't do

- Sea and air legs are drawn as straight lines, with a warning. Add `via`
  points through `update_project` to steer a leg, or use `line`.
- The `follow` camera acts as `glide`, with a warning.
- Terrain and the ship, plane, car, train and walk symbols aren't available.
  They warn too.
- Output is one flattened video. Stage 2 adds layered ProRes and FCPXML for
  Final Cut Pro.

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
<project>/renders/<timestamp>/all.mov   (ProRes 422 HQ, the default)
<project>/renders/<timestamp>/all.mp4   (when codec is 'h264')
<project>/renders/<timestamp>/manifest.json
```

The manifest records the settings and where the credit went.

## Credit

Every render needs the map credit: © OpenStreetMap contributors · OpenMapTiles
· OpenFreeMap. By default it's burned into the bottom-right of the video. If
the project's `credit` is `description`, tell the user to put it in the video
description. `render_status` repeats the credit when the render is done.

## Example

A cruise from Piraeus to Mykonos, Santorini and Rhodes:

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
