// 4K render-speed benchmark. Runs on its own, without Mapper code.
// Usage: npm run bench:render [-- --frames 100 --write]
//        npm run bench:render -- --track [--frames 100 --write]   (recorded-track case only)

import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PNG } from 'pngjs';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright';
import { WebSocketServer } from 'ws';

interface Bench {
  ready: Promise<void>;
  size(): [number, number];
  frame(i: number, n: number): Promise<number>;
  cpu(): number[];
  readPixelsGL(): number;
  readComposite(): number;
  sendWS(url: string): Promise<number>;
  base64(): string;
  webgl(): string;
  transparent(): Promise<void>;
}

declare global {
  var bench: Bench;
}

type Readback = 'readPixelsGL' | 'readComposite';
type Transfer = 'sendWS' | 'base64';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'test-output', 'bench');
const DOC = join(ROOT, 'docs', 'render-speed.md');
const SECTION = '## Benchmark (Task 1)';
const TRACK_SECTION = '## Recorded track (Stage 10)';
const CSS_SIZE = { width: 1920, height: 1080 };
const FPS = 25;
const ARG_SETS: string[][] = [
  [],
  ['--use-angle=metal'],
  ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
];
const COLOUR_TAGS = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'];
const ENCODERS = [
  { name: 'prores_ks', file: 'prores_ks.mov', args: ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le'] },
  { name: 'prores_videotoolbox', file: 'prores_videotoolbox.mov', args: ['-c:v', 'prores_videotoolbox', '-profile:v', 'hq', '-pix_fmt', 'p210le'] },
  { name: 'h264_videotoolbox', file: 'h264_videotoolbox.mp4', args: ['-c:v', 'h264_videotoolbox', '-b:v', '40M', '-pix_fmt', 'yuv420p'] },
];

// ---------- stats and formatting ----------

interface Stats { median: number; p95: number; max: number }

function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  return { median: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

const median = (samples: number[]) => stats(samples).median;
const ms = (value: number) => `${value.toFixed(1)} ms`;
const fps = (value: number) => `${value.toFixed(2)} fps`;
const spread = (s: Stats) => `median ${ms(s.median)}, p95 ${ms(s.p95)}, max ${ms(s.max)}`;
const log = (message: string) => process.stderr.write(`${message}\n`);

// ---------- static server and WebSocket sink ----------

const ROUTES: [prefix: string, dir: string][] = [
  ['/bench/', join(ROOT, 'bench')],
  ['/node_modules/maplibre-gl/dist/', join(ROOT, 'node_modules', 'maplibre-gl', 'dist')],
];
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
};

function resolveStatic(urlPath: string): string | undefined {
  for (const [prefix, dir] of ROUTES) {
    if (!urlPath.startsWith(prefix)) continue;
    const file = normalize(join(dir, decodeURIComponent(urlPath.slice(prefix.length))));
    if (file.startsWith(dir + sep) && existsSync(file) && statSync(file).isFile()) return file;
  }
  return undefined;
}

/** Binary messages received on the WebSocket, in arrival order. */
class Inbox {
  bytes = 0;
  private queue: Buffer[] = [];
  private waiters: ((message: Buffer) => void)[] = [];

  push(message: Buffer) {
    this.bytes += message.length;
    const waiter = this.waiters.shift();
    if (waiter) waiter(message);
    else this.queue.push(message);
  }

  next(): Promise<Buffer> {
    const message = this.queue.shift();
    return message ? Promise.resolve(message) : new Promise((resolve) => this.waiters.push(resolve));
  }
}

async function startServer(): Promise<{ server: Server; wss: WebSocketServer; origin: string; wsUrl: string; inbox: Inbox }> {
  const server = createServer((req, res) => {
    const file = resolveStatic(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  const inbox = new Inbox();
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 * 1024 });
  wss.on('connection', (socket) => socket.on('message', (data: Buffer) => inbox.push(data)));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, wss, origin: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws`, inbox };
}

// ---------- browser helpers ----------

const isSoftware = (renderer: string) => /swiftshader|llvmpipe/i.test(renderer);

async function openBench(context: BrowserContext, origin: string, pixelRatio: number, extra = ''): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${origin}/bench/page.html?pixelRatio=${pixelRatio}${extra}`);
  await waitReady(page);
  return page;
}

async function waitReady(page: Page) {
  await page.waitForFunction(() => globalThis.bench !== undefined);
  await page.evaluate(() => globalThis.bench.ready);
}

async function settlePass(page: Page, frames: number): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < frames; i++) samples.push(await page.evaluate(([i, n]) => globalThis.bench.frame(i, n), [i, frames]));
  return samples;
}

async function readback(page: Page, method: Readback): Promise<number> {
  return method === 'readPixelsGL'
    ? page.evaluate(() => globalThis.bench.readPixelsGL())
    : page.evaluate(() => globalThis.bench.readComposite());
}

/** Moves the last readback into Node. Returns the bytes and the wall time in ms. */
async function transfer(page: Page, method: Transfer, wsUrl: string, inbox: Inbox): Promise<{ data: Buffer; ms: number }> {
  const start = performance.now();
  let data: Buffer;
  if (method === 'sendWS') {
    const received = inbox.next();
    await page.evaluate((url) => globalThis.bench.sendWS(url), wsUrl);
    data = await received;
  } else {
    data = Buffer.from(await page.evaluate(() => globalThis.bench.base64()), 'base64');
  }
  return { data, ms: performance.now() - start };
}

/** CDP screenshot of the page at the canvas resolution: readback and transfer in one. */
async function screenshot(cdp: CDPSession, pixelRatio: number): Promise<{ data: Buffer; ms: number }> {
  const start = performance.now();
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    optimizeForSpeed: true,
    clip: { x: 0, y: 0, ...CSS_SIZE, scale: pixelRatio },
  });
  return { data: Buffer.from(data, 'base64'), ms: performance.now() - start };
}

// ---------- pixel comparison ----------

type AlphaClass = 'opaque' | 'semi-transparent' | 'transparent';

interface Diff {
  pixels: number;
  /** Max and mean absolute difference for R, G, B, A. */
  max: number[];
  mean: number[];
  /** Pixels where any channel differs by more than 2. */
  over2: number;
}

/** Compares two straight-alpha RGBA buffers, grouped by the reference pixel's alpha. */
function compareRGBA(reference: Uint8Array, actual: Uint8Array): Record<AlphaClass, Diff> {
  const empty = (): Diff => ({ pixels: 0, max: [0, 0, 0, 0], mean: [0, 0, 0, 0], over2: 0 });
  const result: Record<AlphaClass, Diff> = { opaque: empty(), 'semi-transparent': empty(), transparent: empty() };
  for (let p = 0; p < reference.length; p += 4) {
    const alpha = reference[p + 3];
    const diff = result[alpha === 255 ? 'opaque' : alpha === 0 ? 'transparent' : 'semi-transparent'];
    diff.pixels++;
    let over2 = false;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(reference[p + c] - actual[p + c]);
      diff.max[c] = Math.max(diff.max[c], d);
      diff.mean[c] += d;
      over2 ||= d > 2;
    }
    if (over2) diff.over2++;
  }
  for (const diff of Object.values(result)) diff.mean = diff.mean.map((sum) => (diff.pixels ? sum / diff.pixels : 0));
  return result;
}

const describeDiff = (d: Diff) =>
  `${d.pixels} px; max Δ RGBA ${d.max.join('/')}; mean Δ RGBA ${d.mean.map((m) => m.toFixed(3)).join('/')}; ${d.over2} px > 2 off`;

/** readComposite and a CDP screenshot of the current frame, compared. */
async function compareCapture(page: Page, cdp: CDPSession, wsUrl: string, inbox: Inbox): Promise<Record<AlphaClass, Diff>> {
  await readback(page, 'readComposite');
  const { data: reference } = await transfer(page, 'base64', wsUrl, inbox);
  const png = PNG.sync.read((await screenshot(cdp, 2)).data);
  const [width, height] = await page.evaluate(() => globalThis.bench.size());
  if (png.width !== width || png.height !== height) throw new Error(`screenshot is ${png.width}×${png.height}, expected ${width}×${height}`);
  return compareRGBA(reference, png.data);
}

/**
 * Checks CDP screenshots against readComposite, first over the opaque map, then as a transparent
 * layer using the recipe for the route and signs layers: no page background and
 * Emulation.setDefaultBackgroundColorOverride at alpha 0. Then times that transparent capture.
 */
async function alphaCheck(page: Page, frames: number, wsUrl: string, inbox: Inbox) {
  const cdp = await page.context().newCDPSession(page);
  await page.evaluate(([i, n]) => globalThis.bench.frame(i, n), [Math.floor(frames / 2), frames]);
  const opaque = (await compareCapture(page, cdp, wsUrl, inbox)).opaque;
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await page.evaluate(() => globalThis.bench.transparent());
  const layer = await compareCapture(page, cdp, wsUrl, inbox);
  const timing: number[] = [];
  for (let i = 0; i < frames; i++) {
    await page.evaluate(([i, n]) => globalThis.bench.frame(i, n), [i, frames]);
    timing.push((await screenshot(cdp, 2)).ms);
  }
  return { opaque, layer, timing };
}

// ---------- ffmpeg ----------

interface Encoder {
  /** Resolves once ffmpeg has taken the frame off the pipe. */
  write(frame: Buffer): Promise<void>;
  finish(): Promise<void>;
}

const rawInput = (width: number, height: number) => ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-framerate', String(FPS), '-i', '-'];
const pngInput = () => ['-f', 'image2pipe', '-c:v', 'png', '-framerate', String(FPS), '-i', '-'];

function startEncoder(input: string[], encoder: string[], file: string, vflip: boolean): Encoder {
  // ffmpeg 9 takes the colour tags from the frames, so -color_primaries and -color_trc
  // alone leave them unset; setparams tags the frames themselves.
  const filter = `${vflip ? 'vflip,' : ''}scale=out_color_matrix=bt709:out_range=tv,`
    + 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709';
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...input,
    '-vf', filter, ...encoder, ...COLOUR_TAGS, '-r', String(FPS),
    join(OUT_DIR, file),
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  ffmpeg.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise<void>((resolve, reject) => {
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`))));
  });
  exited.catch(() => {}); // Reported by write() or finish().
  ffmpeg.stdin.on('error', () => {}); // A broken pipe shows up as ffmpeg's exit code.
  const exitedEarly = exited.then(() => { throw new Error('ffmpeg exited before the last frame'); });
  return {
    write: (frame) => ffmpeg.stdin.write(frame)
      ? Promise.resolve()
      : Promise.race([once(ffmpeg.stdin, 'drain').then(() => undefined), exitedEarly]),
    finish: () => {
      ffmpeg.stdin.end();
      return exited;
    },
  };
}

async function encodeCeiling(encoder: (typeof ENCODERS)[number], frame: Buffer, width: number, height: number, frames: number): Promise<number> {
  const start = performance.now();
  const ffmpeg = startEncoder(rawInput(width, height), encoder.args, encoder.file, false);
  for (let i = 0; i < frames; i++) await ffmpeg.write(frame);
  await ffmpeg.finish();
  return frames / ((performance.now() - start) / 1000);
}

// ---------- end to end ----------

type Capture = { kind: 'raw'; readback: Readback; transfer: Transfer } | { kind: 'cdp' };

interface EndToEnd {
  label: string;
  fps: number;
  /** Median ms per frame for each stage. */
  stages: Record<string, number>;
}

/** Warm 4K pass into prores_ks. Frame n+1 renders while ffmpeg encodes frame n. */
async function endToEnd(page: Page, capture: Capture, frames: number, wsUrl: string, inbox: Inbox): Promise<EndToEnd> {
  const [width, height] = await page.evaluate(() => globalThis.bench.size());
  const cdp = capture.kind === 'cdp' ? await page.context().newCDPSession(page) : undefined;
  const settle: number[] = [];
  const captureMs: number[] = [];
  const readbackMs: number[] = [];
  const start = performance.now();
  const ffmpeg = capture.kind === 'cdp'
    ? startEncoder(pngInput(), ENCODERS[0].args, 'end-to-end-cdp.mov', false)
    : startEncoder(rawInput(width, height), ENCODERS[0].args, 'end-to-end-raw.mov', capture.readback === 'readPixelsGL');
  let writing = Promise.resolve();
  for (let i = 0; i < frames; i++) {
    settle.push(await page.evaluate(([i, n]) => globalThis.bench.frame(i, n), [i, frames]));
    if (capture.kind === 'raw') readbackMs.push(await readback(page, capture.readback));
    const frame = capture.kind === 'raw'
      ? await transfer(page, capture.transfer, wsUrl, inbox)
      : await screenshot(cdp!, width / CSS_SIZE.width);
    captureMs.push(frame.ms);
    await writing;
    writing = ffmpeg.write(frame.data);
  }
  await writing;
  await ffmpeg.finish();
  const elapsed = (performance.now() - start) / 1000;
  return capture.kind === 'cdp'
    ? {
        label: 'frame → CDP screenshot PNG → prores_ks',
        fps: frames / elapsed,
        stages: { settle: median(settle), screenshot: median(captureMs) },
      }
    : {
        label: `frame → ${capture.readback} → ${capture.transfer} → prores_ks`,
        fps: frames / elapsed,
        stages: { settle: median(settle), readback: median(readbackMs), transfer: median(captureMs) },
      };
}

// ---------- report ----------

function machine(): string {
  try {
    return execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function markdownTable(rows: [string, string, string][]): string {
  return [
    '| Group | Measurement | Result |',
    '|---|---|---|',
    ...rows.map((cells) => `| ${cells.map((c) => c.replaceAll('|', '\\|')).join(' | ')} |`),
  ].join('\n');
}

function writeDoc(section: string, heading = SECTION) {
  const header = '# Render speed\n\nMeasurements of how fast Mapper can render 4K map frames on the user\'s Mac.\n';
  const current = existsSync(DOC) ? readFileSync(DOC, 'utf8') : header;
  const start = current.indexOf(heading);
  let next: string;
  if (start === -1) {
    next = `${current.trimEnd()}\n\n${section}\n`;
  } else {
    const after = current.indexOf('\n## ', start + heading.length);
    next = `${current.slice(0, start)}${section}\n${after === -1 ? '' : current.slice(after)}`;
  }
  writeFileSync(DOC, next);
}

// ---------- recorded track ----------

/** The two routes the track case compares. Same ends, same camera; only the line's vertices differ. */
const TRACK_CASES = [
  { name: 'plain line', query: '' },
  { name: 'track-10k', query: '&routePoints=10000&noise=100' },
  // Ten times the limit, to show the bench can see a cost when there is one. Not part of the verdict.
  { name: 'stress-100k', query: '&routePoints=100000&noise=100' },
] as const;
/** The most the track case may cost over the plain line before the thinning limit needs a second look. */
const TRACK_LIMIT = 0.1;

interface TrackRow {
  pixelRatio: number;
  name: string;
  samples: number[][];
  /** Main-thread ms per frame for the route slice and the `setData` call (the worker's tiling comes after it), one array per run. */
  cpu: number[][];
}

/**
 * Times a warm pass of the frame loop for the plain line and for a 10,000-point noisy line, alternating them so a
 * slow moment on the machine hits both: a throw-away warm-up of the plain line, then plain, track, plain, track.
 */
async function trackBench(frames: number, write: boolean): Promise<void> {
  const { server, wss, origin } = await startServer();
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ARG_SETS[0] });
  try {
    const rows: TrackRow[] = [];
    for (const pixelRatio of [1, 2]) {
      const context = await browser.newContext({ viewport: CSS_SIZE });
      const measured = TRACK_CASES.map((c) => ({ pixelRatio, name: c.name, samples: [] as number[][], cpu: [] as number[][] }));
      log(`Track: pixelRatio ${pixelRatio}, warm-up`);
      const warmup = await openBench(context, origin, pixelRatio, TRACK_CASES[0].query);
      await settlePass(warmup, frames);
      await warmup.close();
      for (let run = 1; run <= 2; run++) {
        for (const [i, c] of TRACK_CASES.entries()) {
          log(`Track: pixelRatio ${pixelRatio}, ${c.name}, run ${run}`);
          const page = await openBench(context, origin, pixelRatio, c.query);
          await settlePass(page, frames); // tiles for this page's route are cached by now, the first pass wakes the workers
          await page.evaluate(() => globalThis.bench.cpu());
          measured[i].samples.push(await settlePass(page, frames));
          measured[i].cpu.push(await page.evaluate(() => globalThis.bench.cpu()));
          await page.close();
        }
      }
      rows.push(...measured);
      await context.close();
    }

    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const table = [
      '| Size | Route | Run | Median | Mean | p95 | Max | Route slice + setData (mean) |',
      '|---|---|---|---|---|---|---|---|',
      ...rows.flatMap((r) =>
        r.samples.map((s, run) => {
          const st = stats(s);
          return `| ${r.pixelRatio === 2 ? '3840×2160' : '1920×1080'} | ${r.name} | ${run + 1} | ${ms(st.median)} | ${ms(mean(s))} | ${ms(st.p95)} | ${ms(st.max)} | ${(mean(r.cpu[run]!)).toFixed(2)} ms |`;
        }),
      ),
    ];
    const verdicts: string[] = [];
    for (const pixelRatio of [1, 2]) {
      const [plain, track] = rows.filter((r) => r.pixelRatio === pixelRatio);
      const medianOf = (r: TrackRow) => mean(r.samples.map(median));
      const meanOf = (r: TrackRow) => mean(r.samples.map(mean));
      const size = pixelRatio === 2 ? '3840×2160' : '1920×1080';
      const byMedian = medianOf(track) / medianOf(plain) - 1;
      const byMean = meanOf(track) / meanOf(plain) - 1;
      verdicts.push(
        `- ${size}: track-10k against the plain line is ${(byMedian * 100).toFixed(1)}% by median (${ms(medianOf(track))} against ${ms(medianOf(plain))}) and ${(byMean * 100).toFixed(1)}% by mean (${ms(meanOf(track))} against ${ms(meanOf(plain))})${Math.max(byMedian, byMean) > TRACK_LIMIT ? `: OVER the ${TRACK_LIMIT * 100}% limit` : ''}`,
      );
    }
    const over = verdicts.some((v) => v.includes('OVER'));
    const reading = [
      '',
      'Frames settle on the display\'s 60 Hz tick, so the medians sit near 16 ms and the means near 17.7 ms whatever the',
      'route: a change under a tick can\'t show. The last row of each size, a route of 100,000 points, is there to prove the',
      'bench can see a cost: it lands on the next tick.',
      over
        ? 'A row is over the limit. The remedy is a lower `MAX_TRACK_POINTS`, which is the user\'s decision.'
        : `Neither size is over the ${TRACK_LIMIT * 100}% limit, so \`MAX_TRACK_POINTS\` stays at 10,000.`,
    ];
    const body = [table.join('\n'), '', ...verdicts, ...reading].join('\n');
    process.stdout.write(`${body}\n`);
    if (write) {
      writeDoc(
        [
          TRACK_SECTION,
          '',
          '`npm run bench:render -- --track` times the frame loop with a route of 256 points on a straight line (the plain',
          'line the Task 1 benchmark uses) against one of 10,000 points, each moved up to 100 m off the line: the most a',
          'recorded track can carry (`MAX_TRACK_POINTS`). Both draw the way the studio does, by slicing the path to the head',
          'and calling `setData` on every frame. Each pass is a warm 100 frame settle (jump the camera, set the route, wait for',
          'idle) over the same Piraeus to Rhodes sweep, taken after a warm-up pass and a first pass of that route. The routes',
          'alternate, so a slow moment on the machine hits both. Needs the network, for the map style.',
          '',
          `- Date: ${new Date().toISOString().slice(0, 10)}`,
          `- Machine: ${machine()}`,
          `- Frames per pass: ${frames}`,
          '',
          body,
          '',
        ].join('\n'),
        TRACK_SECTION,
      );
      log(`Wrote ${DOC}`);
    }
  } finally {
    await browser.close();
    wss.close();
    server.close();
  }
}

// ---------- main ----------

async function main() {
  const { values } = parseArgs({
    options: {
      frames: { type: 'string', default: '100' },
      write: { type: 'boolean', default: false },
      track: { type: 'boolean', default: false },
    },
  });
  const frames = Number(values.frames);
  if (!Number.isInteger(frames) || frames < 2) throw new Error('--frames must be an integer of at least 2');
  mkdirSync(OUT_DIR, { recursive: true });
  if (values.track) return trackBench(frames, values.write);

  const { server, wss, origin, wsUrl, inbox } = await startServer();
  const rows: [string, string, string][] = [];
  let browser: Browser | undefined;
  try {
    // 1. GPU
    const renderers: { args: string[]; renderer: string }[] = [];
    let chromeVersion = '';
    for (const args of ARG_SETS) {
      log(`GPU: launching Chrome with ${JSON.stringify(args)}`);
      const probe = await chromium.launch({ channel: 'chrome', headless: true, args });
      chromeVersion = probe.version();
      const page = await probe.newPage({ viewport: CSS_SIZE });
      await page.goto(`${origin}/bench/page.html?pixelRatio=1`);
      await page.waitForFunction(() => globalThis.bench !== undefined);
      const renderer = await page.evaluate(() => globalThis.bench.webgl());
      await probe.close();
      renderers.push({ args, renderer });
      rows.push(['GPU', `args ${JSON.stringify(args)}`, `${renderer}${isSoftware(renderer) ? ' (software)' : ''}`]);
    }
    const chosen = renderers.find((r) => !isSoftware(r.renderer));
    if (!chosen) {
      process.stdout.write(`${markdownTable(rows)}\n\nEvery arg set reports software rendering. Stopping.\n`);
      process.exitCode = 1;
      return;
    }
    const launchArgs = chosen.args;
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: launchArgs });

    // 2–4. Settle, then readback and transfer during the warm 4K pass.
    const readbackMs: Record<Readback, number[]> = { readPixelsGL: [], readComposite: [] };
    const transferMs: Record<Transfer, number[]> = { sendWS: [], base64: [] };
    const screenshotMs: number[] = [];
    let screenshotError: string | undefined;
    let sample: Buffer | undefined;
    let size: [number, number] = [0, 0];
    let context4k: BrowserContext | undefined;

    for (const pixelRatio of [2, 1]) {
      const context = await browser.newContext({ viewport: CSS_SIZE });
      const page = await openBench(context, origin, pixelRatio);
      const [width, height] = await page.evaluate(() => globalThis.bench.size());
      log(`Settle: ${width}×${height} cold pass`);
      const cold = await settlePass(page, frames);
      await page.reload();
      await waitReady(page);
      log(`Settle: ${width}×${height} warm pass${pixelRatio === 2 ? ' with readback and transfer' : ''}`);
      const warm: number[] = [];
      const cdp = pixelRatio === 2 ? await context.newCDPSession(page) : undefined;
      for (let i = 0; i < frames; i++) {
        warm.push(await page.evaluate(([i, n]) => globalThis.bench.frame(i, n), [i, frames]));
        if (!cdp) continue;
        readbackMs.readPixelsGL.push(await readback(page, 'readPixelsGL'));
        readbackMs.readComposite.push(await readback(page, 'readComposite'));
        const ws = await transfer(page, 'sendWS', wsUrl, inbox);
        transferMs.sendWS.push(ws.ms);
        transferMs.base64.push((await transfer(page, 'base64', wsUrl, inbox)).ms);
        sample = ws.data;
        if (screenshotError === undefined) {
          try {
            screenshotMs.push((await screenshot(cdp, pixelRatio)).ms);
          } catch (error) {
            screenshotError = (error as Error).message.split('\n')[0];
          }
        }
      }
      const label = `${width}×${height} (pixelRatio ${pixelRatio})`;
      rows.push(['Settle', `${label} cold`, spread(stats(cold))]);
      rows.push(['Settle', `${label} warm`, spread(stats(warm))]);
      if (pixelRatio === 2) {
        size = [width, height];
        context4k = context;
        await page.close();
      } else {
        await context.close();
      }
    }

    const [width, height] = size;
    if (!sample || sample.length !== width * height * 4) throw new Error(`WebSocket frame was ${sample?.length} bytes, expected ${width * height * 4}`);
    rows.push(['Readback', 'readPixelsGL (map canvas only, bottom-up rows)', ms(median(readbackMs.readPixelsGL))]);
    rows.push(['Readback', 'readComposite (map + overlay, drawImage + getImageData)', ms(median(readbackMs.readComposite))]);
    rows.push(['Transfer', 'WebSocket binary (send until received in Node)', ms(median(transferMs.sendWS))]);
    rows.push(['Transfer', 'page.evaluate(base64) + Buffer.from', ms(median(transferMs.base64))]);
    rows.push(['Transfer', 'CDP Page.captureScreenshot PNG (readback + transfer)', screenshotError ? `n/a: ${screenshotError}` : ms(median(screenshotMs))]);

    log('Alpha: CDP screenshot against readComposite, opaque map and transparent layer');
    const alphaPage = await openBench(context4k!, origin, 2);
    const alpha = await alphaCheck(alphaPage, frames, wsUrl, inbox);
    await alphaPage.close();
    rows.push(['Alpha', 'opaque map: CDP PNG vs readComposite', describeDiff(alpha.opaque)]);
    for (const [group, diff] of Object.entries(alpha.layer)) {
      rows.push(['Alpha', `transparent layer, ${group} pixels: CDP PNG vs readComposite`, describeDiff(diff)]);
    }
    rows.push(['Alpha', 'transparent layer: CDP Page.captureScreenshot PNG', ms(median(alpha.timing))]);

    // 5. Encode ceiling
    const encodeFps: Record<string, number> = {};
    for (const encoder of ENCODERS) {
      log(`Encode: ${encoder.name}`);
      encodeFps[encoder.name] = await encodeCeiling(encoder, sample, width, height, frames);
      rows.push(['Encode', `${encoder.name} ${width}×${height}`, fps(encodeFps[encoder.name])]);
    }

    // 6. End to end, for the best raw path and for the CDP screenshot
    const captures: Capture[] = [{
      kind: 'raw',
      readback: median(readbackMs.readPixelsGL) < median(readbackMs.readComposite) ? 'readPixelsGL' : 'readComposite',
      transfer: median(transferMs.sendWS) < median(transferMs.base64) ? 'sendWS' : 'base64',
    }];
    if (!screenshotError) captures.push({ kind: 'cdp' });
    const results: EndToEnd[] = [];
    for (const capture of captures) {
      const page = await openBench(context4k!, origin, 2);
      const result = await endToEnd(page, capture, frames, wsUrl, inbox);
      log(`End to end: ${result.label}`);
      await page.close();
      result.stages['encode (prores_ks ceiling)'] = 1000 / encodeFps.prores_ks;
      const [slowest, slowestMs] = Object.entries(result.stages).sort((a, b) => b[1] - a[1])[0];
      rows.push(['End to end', `warm 4K, pipelined: ${result.label}`, fps(result.fps)]);
      rows.push(['End to end', 'per-frame medians', Object.entries(result.stages).map(([k, v]) => `${k} ${ms(v)}`).join(', ')]);
      rows.push(['End to end', 'slowest stage', `${slowest} (${ms(slowestMs)})`]);
      results.push(result);
    }
    const best = results.reduce((a, b) => (b.fps > a.fps ? b : a));
    log(`WebSocket received ${(inbox.bytes / 1e9).toFixed(2)} GB in total`);

    const table = markdownTable(rows);
    process.stdout.write(`${table}\n`);
    if (values.write) {
      writeDoc([
        SECTION,
        '',
        `- Date: ${new Date().toISOString().slice(0, 10)}`,
        `- Chrome: ${chromeVersion} (Playwright \`channel: 'chrome'\`, headless)`,
        `- Machine: ${machine()}`,
        `- Frames per pass: ${frames}`,
        `- Chosen launch args: \`${JSON.stringify(launchArgs)}\``,
        `- Fastest capture method: ${best.label} (${fps(best.fps)})`,
        '',
        table,
        '',
      ].join('\n'));
      log(`Wrote ${DOC}`);
    }
  } finally {
    await browser?.close();
    wss.close();
    server.close();
  }
}

await main();
