# Agent instructions

Mapper makes animated map clips for travel films. It runs locally and an AI
agent drives it through MCP. It renders layered ProRes and FCPXML for Final
Cut Pro. Nothing is hosted.

Read before working:

- Design spec: `docs/superpowers/specs/2026-10-13-mapper-local-agent-design.md`
- Build stages: `docs/plan.md`
- Background on the product we took features from: `docs/research.md`

Plans go in `docs/superpowers/plans/`. Build one stage at a time. Each stage
gets its own plan, and the user approves it before any code is written.

## Rules

- **This is a public repo.** Commit nothing private: no API keys or tokens,
  no internal URLs, no details of the Aloft & Away site or its API.
- **Clean-room build.** Mapper takes its feature set from Map Animator
  (mapanimator.baldinger.se), which is proprietary. Never copy its code, map
  themes, icons, sign artwork, UI text or project file format. Don't download
  its bundle or demo files into this repo. Describe behaviour in your own
  words and build it from scratch.
- **No data-source connectors.** Mapper takes stops through `set_stops` or a
  local GPX file through `import_gpx`. Fetching trip data from any API is the
  calling agent's job, outside this repo.
- **Map licences.** Every render must carry the map credit (OpenStreetMap
  contributors, OpenMapTiles, OpenFreeMap), burned in or in the description.
  For satellite, use only EOxCloudless **2016** (CC BY 4.0). Later years are
  non-commercial and must not be used.
- **Coordinates** are `[lng, lat]` (GeoJSON order) everywhere in the public
  interface.
- **Defaults** for new projects: 3840×2160, 25 fps, 16:9.

## Environment

The user's machine runs macOS with:

- Node 26
- Homebrew ffmpeg with `prores_ks` and VideoToolbox encoders
- Google Chrome
- Final Cut Pro 12.4, whose bundle has the FCPXML DTDs up to v1.14
- `xmllint`

Mapper writes FCPXML v1.11 and validates it against `FCPXMLv1_11.dtd` from
the installed Final Cut Pro.

## Commands

No code yet. Add the install, test and run commands here once stage 1 is
scaffolded.
