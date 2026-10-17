# Build plan

Mapper runs locally and is driven by an AI agent. See the
[design spec](superpowers/specs/2026-10-13-mapper-local-agent-design.md) for
the full design. Each stage gets its own implementation plan and ends with
something that works.

| # | Stage | Done when |
|---|---|---|
| 1 | **Agent-driven MVP** (built): schema, timeline, preview studio, local server, MCP tools and CLI, `mapper doctor`, flattened render | An agent creates a project from typed-in stops, checks a contact sheet, the user tweaks it in the studio, and it renders a 4K 25p clip |
| 2 | **Final Cut export** (optional; the default render is a flattened H.264 MP4): layer passes, ProRes 4444 with alpha, FCPXML with lanes, roles and markers | Double-clicking the FCPXML gives a three-layer compound clip with arrival markers |
| 3 | **Route editing** (built): project file v2 (scenes in the format, curved/sharp points), studio waypoints, curved/sharp toggle, legs panel with transport picker, style picker, undo | The user can reshape a route by hand in the studio, and the agent sees the result |
| 4 | **Routes** (built): sea routing around land, flight arcs, follow camera, GPX import, validation warnings | A cruise route stays at sea |
| 5 | **Look** (built): about 20 transports (motorcycle, ferry, cruise ship, campervan…), eleven map styles including the Aloft & Away theme, terrain and tilt | Videos look on-brand, with the right vehicle on each leg |
| 6 | **Scenes** (built): several scenes per project, studio scene tabs, renders per scene or joined, a compound clip per scene in FCPXML | A two-scene project imports into Final Cut as two clips on one timeline |
| 7 | **Fix pass** (built): every open item from stages 4–6 fixed with a test or parked with a reason. Render warnings, sign lift, turning symbols that follow the line on screen, blank scene names. The rare corrupt capture is parked (0 glitches in 3,000 loads, see [render-speed.md](render-speed.md)) | Every open item from stages 4–6 is fixed with a test or parked with a reason |
| 8 | **Sea routes against OpenFreeMap water** (planned): vector tiles decoded in Node, land rebuilt from clipped tile polygons, the router given network access. Replaces the Baltic skerries item | A route through the Stockholm archipelago stays off every island the basemap draws |

**Decision, 2026-10-14:** the default render is one flattened H.264 MP4
(`all.mp4`). Layered ProRes plus FCPXML stays as an option (`layers`), and a
flattened ProRes master is `codec: 'prores'`. Stage 2 is complete for the
default path. The Final Cut import check for the optional layered export
passed on 2026-10-17 (see below).

**Final Cut import, passed 2026-10-17:** the user imported a two-scene
layered export (the Stage 7 check project) into Final Cut Pro 12.4. It gave two
compound clips back to back on one timeline, each with map, route and signs on
separate lanes. That confirms stage 6's last "Done when" line and Stage 2's
import check. The finer checks in
[final-cut-export.md](final-cut-export.md) (halos, colour, roles, markers,
frame rate, relink) weren't reported one by one.

Out of scope for now: connecting to trip-data APIs (the agent fetches the
data and passes stops in), hosting, a full manual editor, editable Final Cut titles,
render-to-exact-length, photos on the map, photo signs, stats overlays.

## Parked: real ship tracks (AIS)

Researched 2026-10-13, inspired by [The Cruise Globe](https://thecruiseglobe.com/).
It draws a cruise's real route from historical AIS satellite data (2015
onwards), given the ship and the sailing dates.

Why it's parked: the goal would be real routes for *past* cruises, and
historical AIS data is only available from paid providers. Free options
only record from now on.

| Source | Cost | Notes |
|---|---|---|
| Phone GPS log (GPX) | Free | Future trips only; already covered by GPX import |
| [aisstream.io](https://aisstream.io) live feed, recorded locally | Free | Future trips only; shore receivers, gaps mid-ocean |
| [Datalastic](https://datalastic.com/pricing/) historical API | About €199/month, billed per vessel-day; €9 trial | Up to 31 days per request, by IMO/MMSI |
| [VesselFinder](https://www.vesselfinder.com/vessel-positions-api) historical API | €330 per 10,000 credits; 1 credit per shore position, 10 per satellite position | Archive from 2009 |

Prices are from vendor pages and third-party comparisons as of 2026-10-13.
Confirm current prices, and check that the licence allows derived routes in
commercial videos, before buying.

If we pick it up again:

- An `import_track` tool that takes a recorded track (from a provider the
  agent calls, or a file) and turns it into legs.
- A `track` leg mode that draws a recorded path as-is, with port calls
  detected from stationary periods, and optionally the real timing.
- One month of a historical provider would be enough to backfill every past
  cruise in one go.
