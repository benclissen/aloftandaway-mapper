# Render speed

Measurements of how fast Mapper can render 4K map frames on the user's Mac.

## Benchmark (Task 1)

- Date: 2026-10-13
- Chrome: 155.0.8059.40 (Playwright `channel: 'chrome'`, headless)
- Machine: Apple M6
- Frames per pass: 100
- Chosen launch args: `[]`
- Fastest capture method: frame → CDP screenshot PNG → prores_ks (5.09 fps)

| Group | Measurement | Result |
|---|---|---|
| GPU | args [] | ANGLE (Apple, ANGLE Metal Renderer: Apple M6, Unspecified Version) |
| GPU | args ["--use-angle=metal"] | ANGLE (Apple, ANGLE Metal Renderer: Apple M6, Unspecified Version) |
| GPU | args ["--use-angle=metal","--enable-gpu","--ignore-gpu-blocklist"] | ANGLE (Apple, ANGLE Metal Renderer: Apple M6, Unspecified Version) |
| Settle | 3840×2160 (pixelRatio 2) cold | median 15.5 ms, p95 31.7 ms, max 349.9 ms |
| Settle | 3840×2160 (pixelRatio 2) warm | median 12.0 ms, p95 24.2 ms, max 202.5 ms |
| Settle | 1920×1080 (pixelRatio 1) cold | median 15.5 ms, p95 32.4 ms, max 264.0 ms |
| Settle | 1920×1080 (pixelRatio 1) warm | median 15.7 ms, p95 32.1 ms, max 165.3 ms |
| Readback | readPixelsGL (map canvas only, bottom-up rows) | 6.6 ms |
| Readback | readComposite (map + overlay, drawImage + getImageData) | 17.1 ms |
| Transfer | WebSocket binary (send until received in Node) | 247.4 ms |
| Transfer | page.evaluate(base64) + Buffer.from | 255.3 ms |
| Transfer | CDP Page.captureScreenshot PNG (readback + transfer) | 67.4 ms |
| Encode | prores_ks 3840×2160 | 34.99 fps |
| Encode | prores_videotoolbox 3840×2160 | 134.41 fps |
| Encode | h264_videotoolbox 3840×2160 | 85.36 fps |
| End to end | warm 4K, pipelined: frame → readPixelsGL → sendWS → prores_ks | 3.58 fps |
| End to end | per-frame medians | settle 13.4 ms, readback 6.2 ms, transfer 248.6 ms, encode (prores_ks ceiling) 28.6 ms |
| End to end | slowest stage | transfer (248.6 ms) |
| End to end | warm 4K, pipelined: frame → CDP screenshot PNG → prores_ks | 5.09 fps |
| End to end | per-frame medians | settle 12.2 ms, screenshot 127.1 ms, encode (prores_ks ceiling) 28.6 ms |
| End to end | slowest stage | screenshot (127.1 ms) |


## Decision (Task 1)

- Launch args: `[]`. Headless Chrome 155 picks ANGLE on Metal by default, so the
  extra flags change nothing. `doctor` should still report the renderer and flag
  SwiftShader.
- Capture method: CDP `Page.captureScreenshot` (`format: 'png'`,
  `optimizeForSpeed: true`, clip at the CSS size with `scale` set to the pixel
  ratio), piped to ffmpeg as `-f image2pipe -c:v png`.
- Encoding: every ffmpeg command adds
  `setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709` after the
  `scale` filter. With ffmpeg 9 the `-color_primaries`/`-color_trc` output flags
  alone leave primaries and transfer untagged.

Both paths clear the 2 fps bar, but the spec's design (pixel readback, then a
binary WebSocket message) spends about 250 ms of every 4K frame getting 33 MB
out of Chrome. The readback itself is cheap (7–17 ms). The cost is Chrome's
WebSocket send path, about 140 MB/s. Base64 through `page.evaluate` is no
better, a `fetch` POST was far worse (about 1.5 s), and the `bufferutil` addon
for `ws` made no difference. A PNG screenshot carries the same frame in about
1.3 MB, so the transfer cost mostly goes away. Across two full runs it gave 9.35
and 5.09 fps end to end, against 3.72 and 3.58 fps for the WebSocket path. In a
spot check its pixels matched `readComposite` exactly. With the page background
transparent and `Emulation.setDefaultBackgroundColorOverride` at alpha 0, it
returns RGBA PNGs with straight alpha, which the route and signs layers need for
ProRes 4444. If the screenshot path causes trouble in Task 13, the WebSocket
path still works at about 3.6 fps, a 60 s clip in about 7 minutes per layer.
