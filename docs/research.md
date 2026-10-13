# Research: rebuilding Map Animator

Date: 2026-10-13
Subject: <https://mapanimator.baldinger.se/>, the production bundle live on that date

## Verdict

We can build it. Map Animator is a single-page app that does all its real work
in the browser. Every heavy part rests on open-source libraries and open map
data we can use too. The only server code is a small analytics endpoint we
don't need.

The hard part is the video renderer, not the map. Each frame has to wait
until its tiles have loaded, then go to a hardware encoder without dropping or
stuttering. Most of the risk is there, so it gets built and tested early.

## How we looked

- Downloaded the public HTML, the 1.9 MB JS bundle, the CSS and the demo
  project file, and read them statically. Nothing was executed.
- Identified libraries from strings, URLs and API calls in the bundle.
- Read the in-app About, Terms and Privacy text for data sources and licences.

No source maps are published. Map Animator's source isn't public and carries
no open-source licence, so we treat it as proprietary. We use what we learned
about behaviour and architecture, and copy nothing.

## Architecture

```
Browser (all rendering, storage and encoding)
├── React SPA (React 19, React Router, built with Vite)
├── MapLibre GL JS: vector map, globe, 3D terrain, hill shading
│   ├── OpenFreeMap vector tiles + style JSON, restyled into ~30 themes
│   ├── EOxCloudless 2016 WMTS for satellite
│   └── AWS Terrain Tiles (Terrarium PNG) for elevation
├── Route engine: Bézier spline through anchor points, or GPX/KML tracks
├── Animation engine: timeline drives line progress, symbol, camera, signs
├── Export: canvas → VideoFrame → WebCodecs VideoEncoder (H.264) → Mediabunny MP4
├── Storage: IndexedDB (projects, photos), localStorage (prefs)
└── Web Workers (MapLibre tile parsing; encoding off the main thread)

Cloudflare Pages
├── Static hosting
└── Functions: /api/event (usage beacon), /api/count, /api/stats (password-protected dashboard)
```

### Libraries and services

| Part | What they use | Licence / terms | Notes for us |
|---|---|---|---|
| Map renderer | MapLibre GL JS (globe and terrain controls present) | BSD-3 | Use it. |
| Vector tiles | OpenFreeMap (`tiles.openfreemap.org/styles/…`) | Free, fair use; data ODbL | Fine to start. Self-host later if render volume gets high (OpenFreeMap or PMTiles from Protomaps). |
| Satellite | EOxCloudless **2016** (`tiles.maps.eox.at/wmts`) | CC BY 4.0 | Only the 2016 layer is CC BY. Later years are CC BY-NC-SA, which rules out commercial videos. |
| Elevation | AWS Terrain Tiles, Terrarium encoding | Open data | No key needed. |
| Place search | Photon by Komoot (`photon.komoot.io/api`) | Public API, fair use | Fine at low volume. |
| Video encoding | WebCodecs `VideoEncoder`, `avc1` (H.264) | Browser API | Chrome and Edge are reliable. Safari and Firefox have gaps; they show a "Use Chrome or Edge" notice. |
| MP4 muxing | Mediabunny v1.61 | MPL-2.0 | Use it. |
| Fonts | Overpass, IM Fell English (OFL); Noto Sans glyphs for map labels | OFL | Fine. |
| Hosting/analytics | Cloudflare Pages, Pages Functions, Cloudflare Web Analytics | — | Same setup works for us; analytics is optional. |
| Money | PayPal donate link | — | Free, no account needed. |

### Routes in the app

`/`, `/p/:id` (project editor), `/help`, `/faq`, `/changelog`, `/about`,
`/privacy`, `/cookies`, `/terms`, `/stats`.

### How export works

1. The project is laid out on a timeline: hold at start, line draws, pauses at
   points, hold at end, and scenes either joined into one video or exported
   separately.
2. For each frame, the app sets the map camera and the line progress, then
   waits for the map to finish loading tiles before capturing.
3. The MapLibre canvas (with `preserveDrawingBuffer`) becomes a `VideoFrame`.
   Overlays such as signs, compass, elevation profile and title are composited
   on an `OffscreenCanvas`.
4. `VideoEncoder` encodes H.264, and Mediabunny muxes the result into an MP4
   in memory, which the user then downloads.
5. Error handling covers GPU failures ("Try 30 fps, or a smaller video size"),
   cancelled renders and renders in background tabs. Users can lower the fps
   or resolution if their machine can't keep up.

Output: 16:9 and other aspect ratios, 1080p up to 4K, a choice of frame rate.

## Data model (from the demo project file)

Projects save as JSON (`.mapanim`), with photos embedded as data URLs.

```
project
├── id, name, createdAt, updatedAt
├── aspect ("16:9", …), size (1080 … 2160), fps, joinScenes
├── scenes[]
│   ├── source: "draw" | "gpx"
│   ├── anchors[]: { x, y, ix, iy, ox, oy, mode: auto|curved|sharp }
│   │     x/y are normalised Web Mercator (0–1); ix/iy and ox/oy are Bézier in/out handles
│   ├── firstLeg / legs: transport mode per leg ("motorcycle", "boat", …)
│   ├── style + modeStyles{mode}: { color, width, dash, head, outline, glow, startDot }
│   ├── mapStyle (theme id), mapLabels, terrain, regions, symbols3d
│   ├── markers[]: { kind, x, y, text, sub, show: always | when passed }
│   ├── cameraMode: fixed | start-to-end | follow
│   ├── shots.start / shots.end: { center, zoom, bearing, pitch }
│   ├── follow: { zoom, orient: north|heading, lookAhead, steadiness }
│   ├── easing, lineEase, tilt, speed, holdStart, holdEnd, signSize
│   └── camera / view / frameBounds (editor state and the video frame)
└── photos{ id → data URL }
```

Storing points in normalised Mercator rather than lat/lng makes spline and
handle maths uniform across the map. It's worth copying the idea, not the
format.

## Features to match

The editor works in five steps per scene.

1. **Route**: click to place points, drag points, make a point curved or
   sharp, pause at a point, reverse, simplify, undo. Or import a GPX/KML file
   (Google Maps, Google Earth and flight logs; pick tracks; join several into
   one). Search for a place. Split the route into legs, each with its own
   transport.
2. **Look**: around 30 map themes, local or translated place names (about 35
   languages), terrain, a custom map image, compass. Line colour, thickness,
   dashes, outline and glow. Over 30 moving symbols (walk, bike, car,
   motorcycle, train, boat, ferry, cruise ship, plane, helicopter, balloon and
   more), which either stay upright or turn with the line. Each transport can
   have its own style.
3. **Signs**: sign styles (boards, flags, callouts, plaques), captions, preset
   icons (camp, hotel, start banner, finish flag, warning), custom images.
   Photos placed from EXIF location or time. Signs show always or appear as
   the line passes.
4. **Camera**: fixed view, glide from start shot to end shot, or follow the
   line (north-up or direction of travel, look-ahead, steadiness). Zoom in or
   out to reveal, tilt for 3D mountains, easing.
5. **Preview & export**: live preview, then render to MP4 with progress and
   cancel. Scenes export separately or joined into one video.

Overlays: title, description, elevation profile, distance, altitude and speed
from the route file, in several units and languages.

Other: several scenes per project, project files you can download and
reimport, keyboard shortcuts, nothing to sign up for, everything kept on the
device.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Uneven browser support for WebCodecs | Some users can't export | Target Chrome and Edge first. Detect support and explain. |
| Renders are slow because each frame waits for tiles | Long exports, especially at 4K | Prefetch tiles along the camera path. Offer 1080p and 30 fps defaults. |
| GPU or memory failure on long or 4K renders | Render stops partway | Encode in chunks, recover, suggest settings that will work. |
| Load on public tile and geocoder services | Fair-use breach once we have real traffic | Cache. Self-host tiles (PMTiles on Cloudflare R2) if usage grows. |
| Licences on map imagery | Videos break licence terms | Use only EOxCloudless 2016. Burn in the credit by default. |
| Looking too much like Map Animator | Legal and reputation risk | Our own themes, icons, sign art, copy and file format. No code copied. |

## What we need

- **Skills:** TypeScript and React, MapLibre styling and camera control,
  WebCodecs, and some geometry (splines, Mercator).
- **Accounts:** GitHub, plus Cloudflare Pages (free tier). No paid APIs or
  keys for the MVP.
- **Design:** an Aloft & Away look for themes, signs and transport icons.
  This is our main way to stand apart.
