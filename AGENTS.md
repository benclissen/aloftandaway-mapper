# Agent instructions

Mapper makes animated map clips for travel films. It runs locally and an AI
agent drives it through MCP. By default it renders a
flattened H.264 MP4. A layered ProRes and FCPXML export for Final Cut Pro is
optional. Nothing is hosted.

Read before working:

- Design spec: `docs/superpowers/specs/2026-10-13-mapper-local-agent-design.md`
- Build stages: `docs/plan.md`
- Background on the product we took features from: `docs/research.md`

Plans go in `docs/superpowers/plans/`. Build one stage at a time. Each stage
gets its own plan, and the user approves it before any code is written.

## Sub-agents

Carry out plans with sub-agents (superpowers:subagent-driven-development).
Each task gets a fresh implementer and a review, and the whole branch gets a
final review. Always set the model explicitly, and pick it by how hard the
work is:

- **Opus 5.5** (`opus`) for complex work: design judgement, tricky maths,
  the render and GPU pipeline, concurrency, recovery logic, and the final
  whole-branch review.
- **Sonnet 5.5** (`sonnet`) for medium work: multi-file features with a clear
  plan, integration, and most task reviews.
- **Haiku 5.5** (`haiku`) for very simple, straightforward work: small
  mechanical edits to one or two files where the plan spells out the change,
  and re-reviews of small fixes.

Each task in a plan names its model. If a sub-agent gets stuck, retry the
task one tier up.

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

```bash
npm install                       # install dependencies
npm run build                     # compile the server and build the studio into dist/
npm test                          # unit tests
npm run test:e2e                  # build, then end-to-end tests
npm run typecheck                 # type-check the server, bench and studio code
npm run bench:render              # render speed benchmark
npm run bench:core                # per-frame cost of a recorded track in core
npm run bench:pipeline            # build, then pipeline benchmark
node dist/cli/main.js doctor      # check Chrome, ffmpeg, WebGL and disk space
npm link                          # put `mapper` on PATH
```

- `MAPPER_NET=1 npm run test:e2e` also runs the tests that need the network
  (they fetch OpenFreeMap tiles).
- `UPDATE_GOLDENS=1 npm run test:e2e` refreshes the golden frames.
- Don't run `npm test` and `npm run test:e2e` at the same time. The CLI tests
  rebuild `dist`.
- Register the MCP server with `node <abs path to repo>/dist/cli/main.js mcp`,
  or `mapper mcp` after `npm link`. `skills/mapper/SKILL.md` has the setup for
  each client.
