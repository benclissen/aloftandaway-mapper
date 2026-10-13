# Build plan

Mapper runs locally and is driven by an AI agent. See the
[design spec](superpowers/specs/2026-10-13-mapper-local-agent-design.md) for
the full design. Each stage gets its own implementation plan and ends with
something that works.

| # | Stage | Done when |
|---|---|---|
| 1 | **Agent-driven MVP**: schema, timeline, preview studio, local server, MCP tools and CLI, `mapper doctor`, flattened render | An agent creates a project from typed-in stops, checks a contact sheet, the user tweaks it in the studio, and it renders a 4K 25p clip |
| 2 | **Final Cut export**: layer passes, ProRes 4444 with alpha, FCPXML with lanes, roles and markers | Double-clicking the FCPXML gives a three-layer compound clip with arrival markers |
| 3 | **Routes**: sea routing around land, flight arcs, follow camera, GPX import, place search, validation warnings | A cruise route stays at sea |
| 4 | **Private source plugin**: built outside this repo against the `MapperSource` interface | Real trip data builds a project |
| 5 | **Look**: brand theme and more themes, sign styles, transport symbols, terrain and tilt | Videos look on-brand |

Out of scope for now: hosting, a full manual editor, editable Final Cut titles,
render-to-exact-length, photo signs, stats overlays.
