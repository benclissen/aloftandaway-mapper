# Build plan

The aim is to get the riskiest piece working first: a route drawn on a map,
exported as a clean 1080p MP4. Everything else adds on top of that.

## Phase 0: Skeleton

- Vite, React and TypeScript app, deployed to Cloudflare Pages from `main`
- Full-screen MapLibre map on an OpenFreeMap style
- Project list and editor routes; projects saved in IndexedDB

## Phase 1: Route

- Click to add points, drag to move, delete, undo
- Smooth spline through the points (auto handles), with sharp and curved
  modes per point
- GPX import (tracks and routes), with simplification
- Place search through Photon

## Phase 2: Animation engine and preview

- Timeline model: hold at start, line draw, hold at end
- Progressive line (trimmed geometry or `line-gradient`) with a moving symbol
  at the tip
- Camera modes: fixed, start shot to end shot, follow the line
- Play and scrub the preview in the editor

## Phase 3: Export (MVP ends here)

- Fixed-step frame loop: set the frame state, wait for the map to go idle,
  then capture
- `VideoFrame` → `VideoEncoder` (H.264) → Mediabunny MP4, with progress and
  cancel
- 1080p at 30 fps first, with map credit burned in
- Browser support check, with a clear message

**MVP:** draw or import a route, play it, download a 1080p MP4.

## Phase 4: Look

- 3–5 Aloft & Away map themes of our own (restyled OpenFreeMap style JSON)
- Line styling (colour, width, dash, outline, glow)
- Transport symbols and per-leg transport

## Phase 5: Story layers

- Signs and captions, shown always or as the line passes
- Photos placed from EXIF
- Overlays: title, elevation profile, distance and speed

## Phase 6: Scale up

- Several scenes, joined or exported separately
- Terrain and tilt, globe, satellite (EOxCloudless 2016)
- 4K, 60 fps, and recovering failed renders
- Project file export and import

## Ideas specific to Aloft & Away

- Brand themes and sign art that match aloftandaway.com
- Export shapes for Stories and Reels (9:16) as well as YouTube
- Later: pull routes from Tripsy trips, or embed animated maps on place
  and story pages
