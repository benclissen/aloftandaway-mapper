# Render speed

Measurements of how fast Mapper can render 4K map frames on the user's Mac.

## Benchmark (Task 1)

- Date: 2026-10-13
- Chrome: 155.0.8059.40 (Playwright `channel: 'chrome'`, headless)
- Machine: Apple M6
- Frames per pass: 100
- Chosen launch args: `[]`
- Fastest capture method: frame → CDP screenshot PNG → prores_ks (9.29 fps)

| Group | Measurement | Result |
|---|---|---|
| GPU | args [] | ANGLE (Apple, ANGLE Metal Renderer: Apple M6, Unspecified Version) |
| GPU | args ["--use-angle=metal"] | ANGLE (Apple, ANGLE Metal Renderer: Apple M6, Unspecified Version) |
| GPU | args ["--use-angle=metal","--enable-gpu","--ignore-gpu-blocklist"] | ANGLE (Apple, ANGLE Metal Renderer: Apple M6, Unspecified Version) |
| Settle | 3840×2160 (pixelRatio 2) cold | median 15.6 ms, p95 31.3 ms, max 299.0 ms |
| Settle | 3840×2160 (pixelRatio 2) warm | median 11.9 ms, p95 26.1 ms, max 114.1 ms |
| Settle | 1920×1080 (pixelRatio 1) cold | median 15.6 ms, p95 32.0 ms, max 546.6 ms |
| Settle | 1920×1080 (pixelRatio 1) warm | median 15.6 ms, p95 32.2 ms, max 148.0 ms |
| Readback | readPixelsGL (map canvas only, bottom-up rows) | 6.5 ms |
| Readback | readComposite (map + overlay, drawImage + getImageData) | 15.6 ms |
| Transfer | WebSocket binary (send until received in Node) | 231.6 ms |
| Transfer | page.evaluate(base64) + Buffer.from | 235.9 ms |
| Transfer | CDP Page.captureScreenshot PNG (readback + transfer) | 54.0 ms |
| Alpha | opaque map: CDP PNG vs readComposite | 8294400 px; max Δ RGBA 0/0/0/0; mean Δ RGBA 0.000/0.000/0.000/0.000; 0 px > 2 off |
| Alpha | transparent layer, opaque pixels: CDP PNG vs readComposite | 15013 px; max Δ RGBA 0/0/0/0; mean Δ RGBA 0.000/0.000/0.000/0.000; 0 px > 2 off |
| Alpha | transparent layer, semi-transparent pixels: CDP PNG vs readComposite | 572984 px; max Δ RGBA 0/0/0/0; mean Δ RGBA 0.000/0.000/0.000/0.000; 0 px > 2 off |
| Alpha | transparent layer, transparent pixels: CDP PNG vs readComposite | 7706403 px; max Δ RGBA 0/0/0/0; mean Δ RGBA 0.000/0.000/0.000/0.000; 0 px > 2 off |
| Alpha | transparent layer: CDP Page.captureScreenshot PNG | 54.1 ms |
| Encode | prores_ks 3840×2160 | 42.08 fps |
| Encode | prores_videotoolbox 3840×2160 | 136.49 fps |
| Encode | h264_videotoolbox 3840×2160 | 85.57 fps |
| End to end | warm 4K, pipelined: frame → readPixelsGL → sendWS → prores_ks | 3.68 fps |
| End to end | per-frame medians | settle 13.5 ms, readback 6.2 ms, transfer 244.9 ms, encode (prores_ks ceiling) 23.8 ms |
| End to end | slowest stage | transfer (244.9 ms) |
| End to end | warm 4K, pipelined: frame → CDP screenshot PNG → prores_ks | 9.29 fps |
| End to end | per-frame medians | settle 9.7 ms, screenshot 90.1 ms, encode (prores_ks ceiling) 23.8 ms |
| End to end | slowest stage | screenshot (90.1 ms) |


## Decision (Task 1)

The table above comes from run 3 (fix round 1). Runs 1 and 2 were earlier full runs
of the same benchmark without the Alpha rows. Their tables were not kept, and their
figures appear below only where marked.

- Launch args: `[]`. All three arg sets report ANGLE on Metal (GPU rows), so the
  extra flags change nothing. `doctor` should still report the renderer and flag
  SwiftShader.
- Capture method, every layer: CDP `Page.captureScreenshot` (`format: 'png'`,
  `optimizeForSpeed: true`, clip at the CSS size with `scale` set to the pixel
  ratio), piped to ffmpeg as `-f image2pipe -c:v png`. For the transparent layers
  (route, signs), the page has no CSS background and
  `Emulation.setDefaultBackgroundColorOverride` is set to `{ r: 0, g: 0, b: 0, a: 0 }`.
- Encoding: every ffmpeg command adds
  `setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709` after the
  `scale` filter. With ffmpeg 9.0.2 the `-color_primaries`/`-color_trc` output
  flags alone leave primaries and transfer untagged. This comes from ffprobe on
  the run 1 and run 2 outputs, not from a table row.

Rationale. Both capture paths clear the 2 fps bar. The spec's design (pixel
readback, then a binary WebSocket message) reached 3.68 fps end to end (End to
end rows), and the WebSocket transfer was the slowest stage at about 245 ms per
4K frame. Readback itself is cheap (Readback rows: 6.5 and 15.6 ms). Base64
through `page.evaluate` is no faster (Transfer rows). The CDP screenshot does
readback and transfer in 54.0 ms (Transfer row) and reached 9.29 fps end to end
on the opaque map layer (End to end rows). Earlier runs gave 9.35 fps (run 1)
and 5.09 fps (run 2), so this figure varies between runs. The Alpha rows compare
CDP PNGs, decoded with pngjs, against `readComposite`. They match exactly on the
opaque map, and on a transparent layer built with the recipe above, which has a
60%-opacity route line, a 45% blue shape, a 90% white sign and anti-aliased
edges: opaque, semi-transparent and fully transparent pixels all differ by 0 in
every channel. Capturing that transparent layer takes 54.1 ms (Alpha timing row).
The Alpha rows show the two Chrome paths agree. They do not check the
un-premultiplied values against an independent reference, and the transparent
layer has not been encoded to ProRes 4444 end to end; Task 13 covers that. Two
claims are unverified spot checks from debugging and have no table rows: a
`fetch` POST of a raw frame took about 1.5 s, and the `bufferutil` addon for
`ws` did not speed up the WebSocket path. If the screenshot path fails in Task
13, the WebSocket path still runs at about 3.7 fps, about 7 minutes per layer
for a 60 s clip.

## Pipeline (Task 13)

- Date: 2026-10-13
- Script: `npm run bench:pipeline` (`bench/pipeline.ts`)
- Clip: `greekIslands()` fixture, `look.theme: 'paper'`, 3840×2160 at 25 fps, range 0–10 s (10 s, 250 frames), ProRes 422 HQ
- Path: `renderProject`: browser per render, `RenderPage.capturePng()` (CDP PNG) → `prores_ks`, frame n+1 rendering while frame n is written
- Cold: empty tile cache (a fresh `MAPPER_CACHE_DIR`), tiles from the live OpenFreeMap service. Warm: the same cache, second run.
- `renderFps` is frames ÷ time from the first `renderFrame` to ffmpeg finishing. Wall time is the whole `renderProject` call, including Chrome launch and map load.

| Run | Frames | renderFps | Wall time | Wall ÷ clip length |
|---|---|---|---|---|
| Cold | 250 | 9.71 fps | 26.4 s | 2.6× |
| Warm | 250 | 9.93 fps | 25.8 s | 2.6× |

Warm `renderFps` against Task 1's 9.29 fps CDP end-to-end figure: +7%.

ffprobe of the warm output: codec `prores`, profile `HQ`, pix_fmt `yuv422p10le`, 3840×2160, r_frame_rate `25/1`, nb_frames 250, color_space `bt709`, color_transfer `bt709`, color_primaries `bt709`, color_range `tv`.

Frame at 5 s extracted to `test-output/bench/pipeline-frame.png` (not committed).

## Acceptance (Task 18)

- Date: 2026-10-14
- Run: a fresh Claude Code session drove Mapper over MCP. Stops were typed in: Piraeus, Mykonos (2 s pause), Santorini (2 s pause), Rhodes, as plain lines on the `paper` theme. The default timing gave a 17 s clip.
- Path: `render` MCP tool, ProRes 422 HQ at the default 3840×2160 and 25 fps. Two contact sheets beforehand had already fetched the tiles.
- `renderFps` comes from the manifest. Wall time runs from the `render` call to the manifest's `renderedAt`.

| Frames | Clip length | renderFps | Wall time | Wall ÷ clip length | Recoveries |
|---|---|---|---|---|---|
| 425 | 17.0 s | 9.77 fps | about 46 s | 2.7× | 0 |

ffprobe: codec `prores`, profile `HQ`, pix_fmt `yuv422p10le`, 3840×2160, r_frame_rate `25/1`, nb_frames 425, color_space `bt709`, color_transfer `bt709`, color_primaries `bt709`, color_range `tv`. The file is 931 MB, and the credit is burned in at the bottom right.

The user opened the studio but made no edits; the studio re-saved the project unchanged. Studio drags and shots are covered by `test/e2e/studio.test.ts`.

The run found a bug: Claude Code shows only a tool's `structuredContent`, so the agent never saw the text summaries, which include the credit line in `render_status`. Each summary is now in `structuredContent` as well.

## Known capture glitch (Stage 7, Task 8)

- Date: 2026-10-16
- Chrome: 155.0.8059.80 (Playwright `channel: 'chrome'`, headless), WebGL ANGLE Metal on Apple M6
- Script: `MAPPER_NET=1 npm run bench:capture -- --loads 1000 [--cold-every N]` (`bench/capture-stress.ts`)
- Status: parked. Not reproduced in 3,000 loads, no product change.

**The sighting.** A probe written while chasing an e2e flake opened two pages in one browser, 200 times, with a new
server and an empty tile cache before each pair. Both pages showed `alpine()` as satellite with terrain at
1920×1080. The first page had the credit burned in and the second had it in the description, and the probe diffed
their frame 0 captures. In iteration 78 the second page's capture (`it78-plain.png`) had a solid 6×8 px block in
the sign text colour (#1d2430) over the Chamonix sign, and under it a 9×5 px white hole through the "i". The largest
channel difference was 212. So the page that glitched was the second one, which loaded from a server cache the
first page had just filled (3,854 ms for the first page against 271 ms for the second). In a separate run, 600
captures of one loaded page all matched, so capture alone doesn't cause it. Page load is the suspect, probably the
GPU glyph and raster cache that pages in one browser share.

**The check.** `bench:capture` repeats that pattern: one browser for the whole run and two pages per load, burned
then plain, with a new server and an empty tile cache every `--cold-every` loads (default 10). A glitch is any pixel
outside the credit box whose largest channel difference is above 8. Satellite and terrain seams can differ slightly
between pages, so smaller differences don't count. The credit box is measured in the page with the credit font,
[1142,1005]–[1912,1075] here. Each glitch's two captures and a diff go under `/tmp/stage7-capture-stress/`. So does
the PNG pair of the worst clean load, the one with the largest difference outside the credit box, so it can be
checked by eye. `--cpu-overlay` sets the test-only `RenderPageOptions.cpuOverlay`, which creates the overlay's 2D
context with `willReadFrequently: true` so the overlay is drawn on the CPU.

| Run | Cache emptied | Loads with a cold first page | Glitches | Errors | Worst clean difference outside the credit box | Time |
|---|---|---|---|---|---|---|
| 1 | every 10 loads | 100 of 1,000 | 0 of 1,000 | 0 | 7 (position not logged; logging came later) | 24.0 min (1.44 s/load) |
| 2 | every load | 1,000 of 1,000 | 0 of 1,000 | 0 | 6 at (686,875) | 71.7 min (4.30 s/load) |
| 3 | every 10 loads (rerun of 1) | 100 of 1,000 | 0 of 1,000 | 0 | 4 at (703,790) | 23.3 min (1.40 s/load) |

All three runs used the GPU overlay (the default). No frame came back unsettled.

**How strong the negative is.** Take the probe's rate, 1 glitch in 200 loads, and count only loads that match its
pattern (a cold first page, then a second page from the cache it just filled). Then P(G = 0) is 0.995^100 ≈ 0.61 for
run 1 or run 3 alone, 0.995^1000 ≈ 0.0067 for run 2, and 0.995^1200 ≈ 0.0024 for all three together. So a glitch
as common as the probe suggested would almost certainly have shown up. Zero in 1,200 matching loads puts the rate
below about 1 in 400 (the rule of three, 95%). It doesn't rule out a rarer glitch, or one that depends on something
these runs didn't vary, such as the machine's other GPU load.

**The worst clean difference.** Run 2's worst, load 283, has 8 pixels outside the credit box that differ at all:
four by 1, two by 2, one by 5 and one by 6. The two above 4 sit in a 2×3 px cluster at [686,873]–[687,875] in plain
satellite imagery, with no stop, sign or route nearby. The two captures are identical by eye. Run 3's worst is 4, at
(703,790), the same pixel as the largest difference in the probe's clean iteration 29. Both look like raster noise
in the imagery, not the glitch. The PNG pairs are in
`/tmp/stage7-capture-stress/gpu-2026-10-16T20-55-33-093Z/` and `/tmp/stage7-capture-stress/gpu-2026-10-16T22-07-48-445Z/`.
Run 1's 7 wasn't located. The margin under the threshold of 8 is small, so a real glitch peaking at 8 or less would
be missed. The sighting peaked at 212.

The detector was checked on the probe's own captures with `npm run bench:capture -- --diff <burned.png> <plain.png>`.
Iteration 78 is a glitch (60 px, largest difference 212, box [790,115]–[796,127]), and iterations 0, 29 and 79 are
not (largest differences outside the credit box 0, 4 and 2).

The CPU overlay wasn't run for 1,000 loads, since there was nothing for it to fix. If the glitch shows up again,
rerun with `--cold-every 1`, first on the default overlay and then with `--cpu-overlay`.

## Sea routing (Stage 8, Task 9)

`npm run bench:sea` routes five sea legs through `SeaWater` against live OpenFreeMap and times each three ways. Cold
starts from an empty temp cache directory, so every tile is fetched. Disk uses the same directory with a new tile
store and a new `SeaWater`, so tiles come off disk and are decoded again. Memory runs the same `SeaWater` a second
time, with its decoded tiles. Every route gets its own cache directory and a fresh budget of 2,500 tiles, and the
legs have no via points. Add `-- --profile` for a column counting the tile `get` calls and the time spent in them,
summed over the up to 4 requests in flight. Without network it prints one line and exits 0.

Run on 2026-10-17: Apple M6, macOS 27.0.1, Node 26.11.1. Every route came back verified.

| Route | Pass | Tiles | Rounds | Seconds | Fetched | Tile gets (n, summed s) |
|---|---|---|---|---|---|---|
| Stockholm–Sandhamn | cold | 34 | 1 | 0.49 | 34 | 34, 0.83 |
| Stockholm–Sandhamn | disk | 34 | 1 | 0.20 | 0 | 34, 0.05 |
| Stockholm–Sandhamn | memory | 34 | 1 | 0.17 | 0 | 0, 0.00 |
| Stockholm–Mariehamn | cold | 144 | 4 | 2.00 | 144 | 144, 3.84 |
| Stockholm–Mariehamn | disk | 144 | 4 | 0.99 | 0 | 144, 0.18 |
| Stockholm–Mariehamn | memory | 144 | 4 | 0.89 | 0 | 0, 0.00 |
| Stockholm–Helsinki | cold | 485 | 7 | 12.58 | 485 | 485, 44.27 |
| Stockholm–Helsinki | disk | 485 | 7 | 1.07 | 0 | 485, 0.34 |
| Stockholm–Helsinki | memory | 485 | 7 | 0.95 | 0 | 0, 0.00 |
| Bergen–Geiranger | cold | 302 | 4 | 8.91 | 302 | 302, 32.81 |
| Bergen–Geiranger | disk | 302 | 4 | 0.48 | 0 | 302, 0.25 |
| Bergen–Geiranger | memory | 302 | 4 | 0.39 | 0 | 0, 0.00 |
| Piraeus–Mykonos | cold | 54 | 2 | 0.50 | 54 | 54, 1.15 |
| Piraeus–Mykonos | disk | 54 | 2 | 0.19 | 0 | 54, 0.03 |
| Piraeus–Mykonos | memory | 54 | 2 | 0.18 | 0 | 0, 0.00 |

**Budgets.** From disk, Stockholm–Mariehamn took 0.99 s (budget 6 s) and Stockholm–Helsinki 1.07 s (budget 10 s), so
neither needed profiling. The router parameters were left as they are.

**Where the time goes.** From disk the tile reads add up to 0.34 s of the 1.07 s for Helsinki, so most of a warm
route is routing and decoding, and the memory pass (0.95 s) shows decoding is only about a tenth of it. Cold is
bound by the network: 485 tiles took 44 s of summed request time over 4 requests at once, about 11 s of wall time.
Rounds cost little on top of that, since each round fetches only the tiles the new route needs.

**Memory.** A decoded tile is about 49 KB (32 KB of pixel bits and 17 KB of block sums). `SeaWater` keeps at most
1,500 of them, so its tile memory tops out at about 73 MB.
