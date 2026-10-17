# Stage 9 fix pass 2 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not begin implementation until the user approves this plan.

**Goal:** Clear what Stages 7 and 8 left open. Each item ends fixed with a test, or parked with a reason. The Stage 8 hand-over check found nothing.

**Architecture:** No new subsystems. Each fix lives in the file that owns it:
- the sea router's offline memory in `src/server/sea-water.ts`
- the hand-edit reload in `src/server/server.ts`, with a guarded restamp in `src/server/store.ts`
- the straight-line wording in `core`, `render` and the studio's labels

**Tech Stack:** TypeScript, Zod 4, React, MapLibre GL 6.14.0, Playwright with Chrome, ffmpeg, Vitest, the MCP SDK.

**Spec:** [Mapper design](../specs/2026-10-13-mapper-local-agent-design.md), with its revisions at the top, especially stage 8 (sea routes). Also read `AGENTS.md` and `docs/plan.md`. The decisions below come from the Stage 9 brainstorm. Where they differ from the spec they replace it, and Task 6 copies them into the spec.

## Stage 9 decisions

**1. A straight-line fallback says so.**
- A sea leg with `status: 'fallback'` that is also unverified is described as drawn as a straight line that may cross land, whatever the reason. That covers `unsettled`, which can end as a fallback too.
- This applies to the render warning, validation's `sea-unverified` message and the studio's legs-panel note.
- A routed leg (`status: 'ok'`) keeps today's "may cross small islands" wording.

**2. The offline memory: the latest news about the network wins.**
- A route that ends `offline` always starts the minute, from when its failure came back. Every cause counts: a thrown fetch, any reply other than 200 or 204 (so 4xx too), bytes that don't decode after a refetch, or no TileJSON.
- Only a tile reply fetched from upstream (`fromCache: false`, status 200 or 204) clears the memory, at the moment it arrives.
- A route served from memory or disk proves nothing about the network, so it leaves the memory alone.
- The `down` flag in `fetchTile`/`obtain` goes away.

**3. A 404 on a planet tile drops the cached TileJSON** (`store.forget('planet')`). If OpenFreeMap retires the build that a cached TileJSON still names, the next try reads the current build instead of failing for up to 24 h. Other statuses don't touch the TileJSON.

**4. A new weekly OpenFreeMap build doesn't re-route cached legs (parked, as it stands).**
- A verified route is a shape the user has approved. Re-routing it weekly would change a clip between two renders without telling anyone.
- Water edits in OpenStreetMap rarely move a sea route, and each cache entry records its build.
- To re-route on the current build, delete `.mapper/paths.json`, or move a via point on one leg. The docs say so, and a test pins the behaviour.

**5. Hand edits reach the studio.** The server's watcher compares the project's content (`projectHash`), not only `updatedAt`.
- **Changed content with a newer `updatedAt`:** broadcast as today.
- **Changed content whose `updatedAt` isn't newer than the last version the server knew:** either the same timestamp, or an older file restored from git or a backup. The server saves the file again with a fresh `updatedAt`, later than both, and nothing else changes. The watcher then broadcasts that version as a change from outside the studio.
- **Unchanged content** (an identical rewrite, or reformatting): nothing is sent or written.
- **The restamp is guarded.** It writes only if the file still holds the content it saw and no newer version has landed, so it never stamps over a studio patch or an agent write.
- A version counter on the server instead of `updatedAt` was considered and rejected. It touches patches, undo and the studio's ordering, which is too much for a fix pass.

**6. Test sleeps.**
- A test that waits for something to happen polls the condition (`vi.waitFor` or the existing bounded loops), never a fixed sleep.
- A test that checks nothing happens waits a named window tied to the product constant it outlasts: 4 × `WATCH_DEBOUNCE_MS` for the watcher, 10 × `retryMs` for the retry timer. It never uses a magic number.
- A check that a held promise hasn't settled yet flushes with `setImmediate` instead of sleeping.
- Sleeps inside mocks that stand for a slow operation stay, with a comment.

**7. Test hooks in product code (parked).** These are injection points:
- `faultAtFrame`, `faultAfterRenderFrame`, `forceUnsettledAt`, `removeFile` and `h264Encoder` on the render path
- `cpuOverlay`
- `MapStage.lastScreenAngle`

They follow the pattern Stage 1 started, and each is documented as a test hook. The MCP `render` tool and the CLI pass only their own named options, so none of them can be reached from outside. A test pins that.

## Global constraints

- Coordinates are `[lng, lat]` (GeoJSON order) everywhere in the public interface.
- `core` imports nothing else from the package and has no DOM, filesystem or network imports (`test/core/purity.test.ts`).
- Every render carries the map credit for what it shows. Satellite uses EOxCloudless **2016** only.
- **Clean-room:** no Map Animator code, themes, icons, sign art, UI text or file format. **Public repo:** nothing private.
- Project files stay schema version 2. `paths.json` keeps cache version 2, and `ROUTER_VERSION` doesn't change: no routing changes in this stage.
- Defaults for new projects: 3840×2160, 25 fps, 16:9.
- Tests never touch the network unless `MAPPER_NET` is set.
- Run `npm test` and `npm run test:e2e` one after the other, never together.
- **Any e2e failure, network or not:** save the full output to `/tmp/stage9-e2e-<YYYYMMDD-HHmmss>.log` before rerunning, and name the file in the report.
- Every task leaves `npm test` and `npm run typecheck` passing.

## Review focus

1. **Concurrent routes on one router.** The studio's retry and a render both route on the one shared `SeaWater`. A route answered from memory that finishes after another route's failure must not clear the memory. A held upstream reply that arrives after the failure must clear it (today's test "a route that verifies clears the memory of a failure" stays green). Tests: Task 2.
2. **A restamp racing a patch or an agent write.** If anything writes between the watcher's read and the restamp, the restamp leaves the file alone, and the newer write is broadcast as usual. Test: Task 4, "restamp leaves a file that changed since it was read".
3. **An invalid hand edit** (half-written JSON, or valid JSON that fails the schema) is never written back and never broadcast. The next valid write still goes through. Tests: Task 4, "a schema-invalid hand edit is never rewritten", and the existing "ignores a half-written file and tries again on the next change".
4. **A hand edit that only reformats** (whitespace or key order) sends nothing and isn't rewritten, because `projectHash` is canonical. Test: Task 4, "reformatting the file sends nothing and leaves it alone".
5. **Labels on several scenes.** The new straight-line render line keeps the `Scene 2 of 2 · Sail:` prefix and lower-cases its first letter, as the other lines do. Test: Task 1, "a straight-line warning keeps the scene label".

---

## Starting point

- **Branch:** `stage-9-fix-pass-2` in the worktree `.claude/worktrees/stage-9-fix-pass-2`, from `main` at `17770b6` or later.
- **Baseline:** `npm test` passes about 1,000 tests; `MAPPER_NET=1 npm run test:e2e` passes 175. Record the exact counts before Task 1.
- **Order:** Tasks 1–3 are independent. Task 5 edits tests in `server.test.ts` after Task 4 has added its own, so run 4 before 5. Task 6 comes last.

## Files

| File | Responsibility |
|---|---|
| `src/core/sea.ts`, `src/core/validate.ts`, `src/render/warnings.ts`, `src/studio/edit/labels.ts`, `LegsPanel.tsx` | Straight-line wording |
| `src/server/sea-water.ts` | Offline memory; TileJSON on 404 |
| `src/server/store.ts`, `src/server/server.ts` | Hand edits: hash compare, guarded restamp |
| `test/server/server.test.ts`, `test/studio/history.test.ts`, `test/render/render-cancel.test.ts`, `test/mcp/tools.test.ts` | Sleeps; the hook pin |
| `README.md`, `skills/mapper/SKILL.md`, `docs/plan.md`, spec | Docs |

---

### Task 1: A straight-line fallback says so

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Modify: `src/core/sea.ts` (next to `UNVERIFIED_CAUSE`), `src/core/index.ts`, `src/core/validate.ts:236-246`, `src/render/warnings.ts:52-62`, `src/studio/edit/labels.ts:44-52`, `src/studio/edit/LegsPanel.tsx:116`, `README.md:79-82`, `skills/mapper/SKILL.md:74-82`
- Test: `test/render/warnings.test.ts`, `test/core/validate.test.ts`, `test/studio/labels.test.ts`

**Interfaces:**
- Produces: `STRAIGHT_LINE = 'drawn as a straight line, which may cross land'` in `src/core/sea.ts`, exported from `core/index.ts`. It's the one clause all three surfaces use.
- Produces: `unverifiedNote(why: NonNullable<SeaPath['unverified']>, status: SeaPath['status']): string`. `LegsPanel` passes `sea.status`.

- [ ] **Step 1: Write the failing tests.** Each has a fallback leg for every `why`, plus one routed leg that keeps today's text.
  - `warnings.test.ts`, `a straight-line fallback says it's a straight line`: for `status: 'fallback', unverified: 'offline'`, the line is exactly
    `Leg 1: no sea route was found (OpenFreeMap couldn't be reached), so it's drawn as a straight line, which may cross land.`
    It does the same for `budget` and `unsettled` with their causes. No line contains `small islands`.
  - `warnings.test.ts`, `a straight-line warning keeps the scene label`: with label `Scene 2 of 2 · Sail`, the line starts `Scene 2 of 2 · Sail: no sea route was found (`.
  - `validate.test.ts`, `sea-unverified on a fallback leg says straight line`: the message is exactly
    `` `${legName(i)} has no checked sea route, because ${UNVERIFIED_CAUSE[why]}. It's drawn as a straight line, which may cross land.` ``
    (`legName` gives `Leg 1 (Piraeus → Mykonos)`).
    `fix` stays `UNVERIFIED_FIX[why]`, and the `sea-fallback` warning for the same leg is still there.
  - `labels.test.ts`:
    - `unverifiedNote('offline', 'fallback')` → `No route found: OpenFreeMap couldn't be reached. Drawn as a straight line, which may cross land. Mapper checks it again by itself.`
    - `unverifiedNote('unsettled', 'fallback')` → `No route found: it kept finding new islands. Drawn as a straight line, which may cross land.`
    - The existing three expectations take `'ok'` as the second argument, unchanged.
- [ ] **Step 2:** Run `npx vitest run test/render/warnings.test.ts test/core/validate.test.ts test/studio/labels.test.ts`. Expected: FAIL on the new tests.
- [ ] **Step 3:** Add `STRAIGHT_LINE`. Branch on `status === 'fallback'` first in all three places, then on `why` as today.
- [ ] **Step 4:** Update the docs:
  - README `:79-82` and SKILL.md `:74-77`: a leg left unverified and also falling back is drawn as a straight line, which may cross land.
  - Then `grep -rn "small islands" README.md skills src`. Every hit must be about a routed leg.
- [ ] **Step 5:** `npm test` and `npm run typecheck` PASS.
- [ ] **Step 6: Commit:** `git commit -m "fix: an unverified sea leg drawn straight says it may cross land"`

### Task 2: The offline memory, and a stale planet build

**Model:** Opus 5.5 (`opus`). Concurrency in the shared router.

**Files:**
- Modify: `src/server/sea-water.ts` (`createSeaWater`: `downAt`, `fetchTile`, `obtain`, `route`; the `OFFLINE_MS` doc comment)
- Test: `test/server/sea-water.test.ts` (`describe('SeaWater.route')`)

**Interfaces:**
- Consumes: `TileStore.forget(subpath)`. `forget('planet')` deletes the cached TileJSON (`planet.tilejson`).
- Produces: no new exports. `SeaWater.route`'s contract is unchanged. Its doc comment gains the rule from decision 2.

- [ ] **Step 1: Write the failing tests.** Use the hand-built `TileStore` fakes and the `now` clock, as "a route that verifies clears the memory of a failure" does.
  - **`a route served from memory doesn't clear the memory of a failure`:**
    - Warm the router: route FROM→TO once with every tile answering 204.
    - Start route V on FROM→TO with `planetBuild` held on a gate.
    - While it's held, route F on a leg whose tiles aren't in memory (shift it by whole tiles from FROM/TO) while `get` throws. Expect `unverified: 'offline'`.
    - Release V. Expect it verified, with no `get` call made.
    - Then route Z on another fresh leg at a clock 30 s after F's failure. Expect `unverified: 'offline'`, with zero `get` and zero `planetBuild` calls after V.
  - **`a 4xx tile reply starts the offline minute`:** for each of 404 and 429:
    - `get` answers that status with `fromCache: false`. The route is `offline`.
    - A second route 30 s later is `offline` with no new `get` or `planetBuild` call.
    - A third at 61 s calls `planetBuild` again.
  - **`a tile served from disk doesn't clear the memory`:**
    - Fail one route (`get` throws).
    - At 61 s, route a leg whose tiles all answer 204 with `fromCache: true`. It's verified.
    - Then fail another fresh leg (`get` throws) at 62 s.
    - At 70 s, a route is `offline` with no calls, so the memory restarted at 62 s.
    - Also: with `get` answering `fromCache: false` at 61 s, a route at 70 s goes to the network.
  - **`a 404 on a planet tile forgets the cached TileJSON`:**
    - `get` answers 404, and `forget` records its argument.
    - After the route, the recorded calls include `'planet'`.
    - With 429, 500 or a throw, they don't include `'planet'`.
- [ ] **Step 2:** Run `npx vitest run test/server/sea-water.test.ts`. Expected: the four new tests FAIL. The existing tests pass.
- [ ] **Step 3:** Implement decisions 2 and 3:
  - Remove `down`.
  - Set `downAt = now()` wherever a route returns `offline`, as it returns.
  - Set `downAt = undefined` in `obtain` on each upstream 200 or 204 reply, as it arrives.
  - Delete the clear at `need.length === 0`.
  - On a 404 in `fetchTile`, `await store.forget('planet')` before returning the failure.
- [ ] **Step 4:** Run the file again. Expected: all PASS, including "a slow network failure is remembered from when it came back" and "a route that verifies clears the memory of a failure".
- [ ] **Step 5:** `npm test` and `npm run typecheck` PASS.
- [ ] **Step 6: Commit:** `git commit -m "fix: the sea router's offline minute starts on every failure and only the network clears it"`

### Task 3: A new planet build doesn't re-route (parked, pinned)

**Model:** Haiku 5.5 (`haiku`).

**Files:**
- Modify: `skills/mapper/SKILL.md:94-96`, `README.md` (the sea-route bullets near `:79`)
- Test: `test/server/paths.test.ts`

- [ ] **Step 1: Write the test `a new planet build doesn't re-route a verified leg`.** It sits next to "a verified entry is never re-routed".
  - Resolve one leg with `fakeWater()` (its note records build `b1`).
  - Resolve again with a `createSeaWater` on a `TileStore` whose `planetBuild` returns `'b2'` and whose `get` throws.
  - Expect the same result. `planetBuild` and `get` were never called, and the cache file's entry still has `water.build === 'b1'`.
- [ ] **Step 2:** Run `npx vitest run test/server/paths.test.ts`. Expected: PASS straight away. This pins behaviour that already exists.
- [ ] **Step 3:** Update the docs:
  - SKILL.md's cache bullet: a verified route keeps the OpenFreeMap build it was routed on until its stops or via points change. To re-route every sea leg on the current build, delete `<project>/.mapper/paths.json`.
  - README: the same in one sentence.
- [ ] **Step 4: Commit:** `git commit -m "test: a new planet build doesn't re-route a verified leg; docs say how to"`

### Task 4: Hand edits reach the studio

**Model:** Opus 5.5 (`opus`). Server concurrency and the file watcher.

**Files:**
- Modify: `src/server/store.ts` (`saveProject`, `mutateProject`, new `restampProject`), `src/server/server.ts` (`Registered`, `registerProject`, `reload`, the retry check at `:481-487`, `WATCH_DEBOUNCE_MS` exported)
- Test: `test/server/store.test.ts`, `test/server/server.test.ts` (`describe('websocket sync')`)

**Interfaces:**
- Produces, in `src/server/store.ts`:
  - `saveProject(folder: string, project: Project, opts?: { after?: string }): Promise<Project>`
  - `mutateProject(folder: string, fn: (p: Project) => Project, opts?: { after?: string }): Promise<Project>`
  - In both, the saved `updatedAt` is strictly later than the project's own and than `after`.
  - `restampProject(folder: string, expect: { hash: string; after: string }): Promise<Project | undefined>`. It runs in the folder queue. It saves the file again with `{ after }`, but only if the file's `projectHash` still equals `expect.hash` and its `updatedAt` isn't later than `expect.after`. Otherwise it returns `undefined` and leaves the file alone.
- Produces, in `src/server/server.ts`:
  - `export const WATCH_DEBOUNCE_MS = 50`
  - `Registered.lastHash: string`, set wherever `lastUpdatedAt` is set.

- [ ] **Step 1: Write the failing tests.**
  - **`store.test.ts`:**
    - `saveProject with after stamps later than after`: `after` is 1 h in the future, and the saved `updatedAt` is later.
    - `restamp leaves a file that changed since it was read`: hash the file, `mutateProject` a name change, then `restampProject` with the old hash returns `undefined`, and the file is byte-identical to before the call.
    - `restamp leaves a file already newer than after`.
    - `restamp saves a matching file with a later updatedAt and nothing else changed`: compare `projectHash` before and after.
  - **`server.test.ts`:**
    - `a hand edit that keeps updatedAt reaches the studio`: connect, then `writeFile` `mapper.json` with `name: 'By hand'` and the same `updatedAt`. The next message has `name === 'By hand'`, an `updatedAt` later than before and no `origin`. The file on disk now holds that `updatedAt`.
    - `a restored older file reaches the studio`: save v1 and keep its bytes, then save v2 (the studio gets it), then write v1's bytes back. The next message has v1's content, with an `updatedAt` later than v2's.
    - `an identical rewrite sends nothing and leaves the file alone`: this replaces "does not rebroadcast an unchanged updatedAt". The file's `updatedAt` is unchanged after the window.
    - `reformatting the file sends nothing and leaves it alone`: write the same project with 4-space indent and reversed top-level key order.
    - `a schema-invalid hand edit is never rewritten`: write the project with `output.fps` set to `{ num: 7, den: 1 }` and the same `updatedAt`. Nothing is sent, and the file is byte-identical. Then a valid `saveProject` is broadcast.
- [ ] **Step 2:** Run `npx vitest run test/server/store.test.ts test/server/server.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement decision 5:
  - In `reload`, after `loadProject`, compute `projectHash`.
  - Same hash: return. If only `updatedAt` moved, take the newer one into `lastUpdatedAt`.
  - Changed hash with a newer `updatedAt`: broadcast as today and record both.
  - Changed hash without a newer `updatedAt`: call `restampProject(folder, { hash, after: entry.lastUpdatedAt })` and return. The watcher's next event broadcasts the restamped file. A restamp that returns `undefined` needs nothing more: whatever wrote in between fires its own event.
  - The retry check at `:481` treats a changed hash like a changed `updatedAt`.
  - "Newer" means `Date.parse` order, as the studio's `newer` does.
- [ ] **Step 4:** Run the two files. Expected: all PASS, including every existing `websocket sync` and `sea paths` test.
- [ ] **Step 5:** `npm test` and `npm run typecheck` PASS.
- [ ] **Step 6: Commit:** `git commit -m "fix: a hand edit that keeps or rewinds updatedAt reaches the studio"`

### Task 5: Test sleeps; the hooks stay out of reach

**Model:** Sonnet 5.5 (`sonnet`).

**Files:**
- Modify: `test/server/server.test.ts` (the waits at `:518`, `:649`, `:721`, `:747`, and Task 4's two "sends nothing" tests), `test/studio/history.test.ts:117`, `test/render/render-cancel.test.ts:58,221,224`
- Test: `test/mcp/tools.test.ts`

**Interfaces:**
- Consumes: `WATCH_DEBOUNCE_MS` from Task 4.

- [ ] **Step 1:** Write `render passes only its own options to the job` in `tools.test.ts`.
  - With `startRenderJob` mocked, call the `render` tool with its usual arguments plus `forceUnsettledAt: 3`, `faultAtFrame: 1` and `removeFile: 'x'`.
  - Expect the job's argument to have only the keys `folder`, `codec`, `range`, `layers`, `scenes` and `join`, or the call to be refused before any job starts.
  - Run it. Expected: PASS. It pins decision 7.
- [ ] **Step 2:** Apply decision 6 in `server.test.ts`:
  - Add one helper with a comment: `const quiet = (ms: number) => new Promise((r) => setTimeout(r, ms))`. It's a window in which nothing must happen.
  - The watcher waits (`:518` and Task 4's tests) become `quiet(4 * WATCH_DEBOUNCE_MS)`.
  - The retry waits (`:649`, `:721`, `:747`, where `retryMs: 20`) become `quiet(10 * RETRY)`, with `const RETRY = 20` passed as `retryMs` in those tests.
- [ ] **Step 3:** Fix `history.test.ts:117` and `render-cancel.test.ts:221`. They check that a held promise hasn't settled yet, so they become `await new Promise((r) => setImmediate(r))`.
- [ ] **Step 4:** Fix `render-cancel.test.ts:224`. It waits for something to happen, so it becomes `await vi.waitFor(() => expect([firstDone, secondDone]).toEqual([true, true]))`.
- [ ] **Step 5:** `render-cancel.test.ts:58` stays: it stands for a slow page close. Add a one-line comment saying so.
- [ ] **Step 6:** Run the three files 20 times in a loop. Expected: 20/20 PASS. Then `npm test` and `npm run typecheck` PASS.
- [ ] **Step 7: Commit:** `git commit -m "test: named quiet windows, no fixed waits for events; pin the render tool's options"`

### Task 6: Docs and the spec revision

**Model:** Haiku 5.5 (`haiku`).

**Files:**
- Modify: `docs/plan.md` (new row 9), `docs/superpowers/specs/2026-10-13-mapper-local-agent-design.md` (top revisions; "Studio and server"; "Build stages"), `README.md` (the studio section)

- [ ] **Step 1:** In `docs/plan.md`, add row 9 after row 8:

  `| 9 | **Fix pass 2** (built): every open item from stages 7 and 8 fixed with a test or parked with a reason. Straight-line sea legs say they may cross land, the sea router's offline minute starts on every failure and only the network clears it, a stale planet build is refetched, hand edits to the project file reach the studio. A new weekly OpenFreeMap build doesn't re-route cached legs, and the render test hooks stay (both parked) | Every open item from stages 7 and 8, and from the Stage 8 hand-over check, is fixed with a test or parked with a reason |`

- [ ] **Step 2:** Update the spec:
  - Add "**Revision, 2026-10-17 (stage 9 decisions):**" after the stage 8 revision, with decisions 1–7 shortened to one bullet each.
  - In "Studio and server", say that a hand edit whose `updatedAt` isn't newer is saved again with a fresh one.
  - Add stage 9 to "Build stages".
- [ ] **Step 3:** README's studio section: a hand edit to `mapper.json` shows in an open studio, and Mapper saves it once more with a new `updatedAt`.
- [ ] **Step 4: Commit:** `git commit -m "docs: stage 9 fix pass 2"`

### Final review

- **Review:** run the whole-branch review with Opus 5.5 (`opus`) against this plan and the spec, with the "Review focus" list. If Opus fails twice with an API error, stop and tell the user rather than dropping to Sonnet.
- **Suite:** then `npm test`, `MAPPER_NET=1 npm run test:e2e` (one after the other) and `npm run typecheck`.
- **PR:** push and open a PR against `main`. Then the Sol review loop:
  - Codex `gpt-6.1-sol` (reasoning high, review role) reviews the full diff and posts its findings as PR comments labelled **blocking** or **nit**. It edits no files.
  - Fix the blocking findings, push, and reply to each comment.
  - If a fix was substantial, run another Sol round with the earlier findings and replies. Stop after 3 rounds at most.
- **Hand over:** a short check for the user.
  - Open the studio on a project, and edit a stop label in `mapper.json` by hand without touching `updatedAt`. It shows within a second, and the file now has a new `updatedAt`.
  - Copy back an older `mapper.json`. The studio shows it.
- **Then ask:** "Can I merge it once review is complete, or do you want to run a final test first?"
