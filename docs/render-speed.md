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
