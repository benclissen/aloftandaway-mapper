# Road-following land legs

Date: 2026-11-03
Status: draft, awaiting review

## Why

On port-day maps a drive, bus ride or walk is drawn as a smooth curve through
its stops and via points. It cuts across bends, so it doesn't follow the road
we actually took. On the Santorini map the Athinios port to Oia leg leaves the
road on the bend north of Fira. Placing enough via points by hand is slow,
and the curve still doesn't hold the road.

The original design left this out: "land: same as `line` for now. Road
snapping is out of scope." This spec adds it.

## Success

- The Athinios to Oia leg follows the road with no hand-placed points.
- Dragging a via point onto another road reroutes the leg along that road.
- A leg's route doesn't change between preview, render and a later
  re-render, unless its stops, via points or transport change.
- Offline, or where there is no road, the leg is drawn as it is today, with a
  warning.

## Decisions

- Road routes come from the public OSRM server that FOSSGIS runs at
  `routing.openstreetmap.de` (the router openstreetmap.org uses). It has car,
  bike and foot profiles worldwide. We considered and rejected two other
  approaches. Building a router from OpenFreeMap tiles fails because their
  roads carry no junction or one-way data. A routing server on the Mac means
  downloading and refreshing map data for each region.
- Following roads is automatic for `land` legs. There is no new leg mode and
  no new setting. `line` stays as the hand-drawn smooth curve.
- No new MCP tools.

## Behaviour

### Which legs follow roads

A `land` leg's profile comes from its transport: the leg's `symbol`, or
`look.symbol` when the leg has none.

| Transport | Profile |
|---|---|
| `walk` | foot |
| `bike` | bike |
| `train`, `tram`, `cable-car` | none: drawn as today's curve |
| any other symbol | car |

"Any other" covers the road vehicles (`car`, `campervan`, `bus`, `coach`,
`motorcycle`, `scooter`). It also covers a marker or boat symbol on a leg that
was set to `land` by hand, because choosing `land` asks for a road.

Route context legs (`scene.context`) have no symbol of their own, so they take
the profile of the scene's `look.symbol`, by the same table.

A `land` leg with no profile still curves into neighbouring `line` and `land`
legs, exactly as now. A road leg (a `land` leg with a profile) that has a
route is drawn on its own, like a sea leg: the curve of the legs before it
ends at its first stop, and the legs after it start a new curve at its last
stop. A road leg without a route yet (pending or fallback) is drawn exactly as
today, curving into its neighbours.

### Via points

On a road leg a via point is a place the route must pass through. The router
matches it to the nearest usable road, and the line passes through that road
point; it doesn't detour to the via point itself. In the studio the via handle
stays where it was placed. `sharp` is ignored on road legs, and the studio's
point menu doesn't offer it for them. Clicking the selected road leg still
inserts a via point.

### Ends of a leg

The router starts and ends on the nearest usable road, which can be some
distance from a stop. Oia's stop is about 110 m from the nearest drivable road.
The path runs in a straight line from the stop to the road, then along the
road, and then in a straight line again from the road to the next stop. These
joins are part of the leg and animate with it. The distance of each join is
kept as `stopGapKm`, as it is for sea legs.

### Shape

The router returns every vertex of the road (1,544 for Athinios to Oia). The
path is simplified with Douglas–Peucker at a 3 m tolerance in Mercator metres
at the leg's latitude, keeping every stop, via and join point. Hairpins stay;
noise smaller than a few metres goes.

### Timing

Travel time is still shared by length. A road leg is usually longer than the
curve it replaces, so it takes a larger share of the scene.

### Existing projects

No file migration. Existing `land` legs with a profile follow roads the next
time the studio, a preview, a render or `validate_project` resolves them.

## How it works

### `src/core/road.ts` (pure)

- `roadProfile(symbol): 'car' | 'bike' | 'foot' | undefined`: the table above.
- `profileForLeg(scene-or-context, legIndex)`: picks the symbol and applies
  `roadProfile`.
- `ROAD_VERSION`: bump whenever path building or its parameters change. It's
  part of every key, so bumping it routes every road leg again.
- `roadLegKey(profile, from, to, via)`: `road:` followed by an FNV-1a 64 hash
  (the same hash `seaLegKey` uses) of `[ROAD_VERSION, profile, from, to,
  via.map(v => v.at)]`. `sharp` isn't in the key, because it has no effect on
  a road leg. Sea keys are hex and track keys start with `track:`, so the
  three kinds can't collide.
- `roadPath(answer, from, to, via)`: turns an OSRM answer into a `RoadPath`
  (below). It adds the joins, finds each waypoint's index on the geometry by
  searching forward from the previous one for the nearest vertex, simplifies,
  and unwraps longitudes from `from` so a leg across the 180° line stays
  continuous. Zero-length answers keep a start and an end point.

`RoadPath` has the same shape as `SeaPath` (`status`, `reason`, `path`,
`knots`, `unverified`, `stopGapKm`), so `buildRoute`, the editor and the
timeline read it the same way. `unverified` only ever takes `'offline'`.
`crossesLand` is never set.

### `src/core/route.ts`

`buildRoute` reads road paths from the same lookup it already takes
(`SeaPaths`, which also carries tracks). A road leg with an `ok` path follows
it: its first and last points are the stops exactly, and `knots` index the
stops and the matched via points. A road leg without one takes part in the
`line`/`land` curve chain exactly as today, and is tagged `pending` or
`fallback` with its reason. `RouteLeg` gains a `road` status field
alongside `sea`. A road leg is drawn in the leg's normal line style.

### `src/server/roads.ts`

The OSRM client.

- URL: `MAPPER_ROAD_ROUTER`, a template with `{profile}`. The default is
  `https://routing.openstreetmap.de/routed-{profile}/route/v1/driving`, where
  `{profile}` is `car`, `bike` or `foot`. A self-hosted OSRM can use
  `http://localhost:5000/route/v1/{profile}`.
- Request: `<url>/<lng,lat;…>?overview=full&geometries=geojson&steps=false`.
- At most one request a second for the whole process, one at a time.
- 15 s timeout per request.
- `User-Agent: aloftandaway-mapper/<package version>
  (+https://github.com/benclissen/aloftandaway-mapper)`.
- Results:
  - `Ok`: a route.
  - `NoRoute` or `NoSegment`: no route.
  - Anything else counts as offline: no answer, a timeout, HTTP 429 or 5xx, a
    body that doesn't parse, or any other OSRM code.
- After an offline result the client answers offline at once for 60 s (the
  same minute `OFFLINE_MS` gives tiles), so one dead network doesn't hold a
  render up leg by leg.

### Cache: `.mapper/roads.json`

This is a separate file from the sea routes' `.mapper/paths.json`, so a land or
water data change never drops road routes. It is written the same way:
atomically, one resolve per folder at a time, with the newest 200 entries kept
by `usedAt`. A memo is keyed on the file's change time and size. If the file
can't be written, routes are still answered and a single error is logged.

Each entry is a `RoadPath` plus `usedAt` and, for a fallback, `retryAt`:

| Result | Used until |
|---|---|
| `ok` | its key changes (never expires) |
| fallback, offline | 1 minute after routing finished |
| fallback, no route | 1 day after routing finished |

The file is `{ version: 1, paths: { <key>: entry } }`. A file of any other
version is dropped.

### Resolving

`resolveSeaPaths` in `src/server/paths.ts` already gathers every sea path and
track a project needs, for the studio, preview, render and validation. It also
resolves road legs: it collects every road leg in the scenes and their
contexts (`roadLegsOf`), reads `roads.json`, routes the legs that are missing
or due, saves, and adds the road paths to the returned lookup under their
`road:` keys. The studio server's retry timer (`retriesSoon`) also covers road
legs that are due for a retry.

## Errors and warnings

| Case | Drawn as | Warning code | Wording (roughly) |
|---|---|---|---|
| Router unreachable | today's curve | `road-offline` | "Leg N couldn't be routed along roads because the road router couldn't be reached; drawn as a curve." |
| No route | today's curve | `road-no-route` | "Leg N has no road route between its stops; drawn as a curve." |
| Stop far from a road | road route with a long join | `road-stop-far` | "Stop X is 1.2 km from the nearest road; the route joins it in a straight line." |

The stop-far threshold is 0.5 km. Warnings appear in `validate_project`, the
render's warnings and the studio's legs panel, next to the sea warnings.
`pending` (not resolved yet) isn't a warning.

## Credits

A road route is made from OpenStreetMap data. A scene with a road leg, between
its stops or in its context, always needs the map credit, even where no
basemap is drawn. This is the same rule `hasSeaLeg` applies, extended. The
written credit (manifest, FCPXML notes, tool text) adds "Road routes: OSRM on
OpenStreetMap data, routing.openstreetmap.de (FOSSGIS)". The burned-in credit
is unchanged.

## Privacy

The coordinates of a road leg's stops and via points are sent to FOSSGIS,
whose server logs them. Nothing else from the project is sent. The README
says so.

## Docs

- Main design spec: add a dated revision pointing here and replace the `land`
  line under Core.
- `skills/mapper/SKILL.md`: land legs follow roads, via points steer them,
  `line` mode for a hand-drawn curve, the three warnings.
- `README.md`: `MAPPER_ROAD_ROUTER` and the privacy note.

## Testing

Unit tests:

- `roadProfile` for every symbol, and the profile chosen for leg and context
  legs.
- `roadLegKey` changes with each input and is stable otherwise.
- `roadPath`: joins, knot placement, simplification keeping a hairpin,
  crossing the 180° line, zero length.
- `buildRoute` with a road leg that is ok, pending or a fallback; a road leg
  between two `line` legs; a `land` leg on `train` still chaining.
- Cache reuse, retry times and an unwritable folder.
- Client: one request a second, the 15 s timeout, and 429 and 5xx treated as
  offline. These run against a fake `fetch`.

End-to-end, against a fake local OSRM server, the same way tile tests use a
fake tile upstream:

- preview, render and `validate_project` with road legs;
- the offline fallback and its warning.

Network (`MAPPER_NET=1`): Athinios (25.4325, 36.3480) to Oia (25.3756,
36.4614) by car is between 20 and 27 km.

By hand (Ben): open the Santorini map in the studio, check the port to Oia leg
follows the road, drag a via point onto another road, and render a short clip.

## Out of scope

- Routing on rails (train, tram, cable car).
- Turn-by-turn directions, travel times from the router, or road names.
- Choosing among alternative routes; via points are the way to steer.
- Refreshing `ok` routes when OpenStreetMap changes.
