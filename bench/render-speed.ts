// 4K render-speed benchmark. Runs on its own, without Mapper code.
// Usage: npm run bench:render [-- --frames 100 --write]

import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright';
import { WebSocketServer } from 'ws';

interface Bench {
  ready: Promise<void>;
  size(): [number, number];
  frame(i: number, n: number): Promise<number>;
  readPixelsGL(): number;
  readComposite(): number;
  sendWS(url: string): Promise<number>;
  base64(): string;
  webgl(): string;
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

async function openBench(context: BrowserContext, origin: string, pixelRatio: number): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${origin}/bench/page.html?pixelRatio=${pixelRatio}`);
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

function writeDoc(section: string) {
  const header = '# Render speed\n\nMeasurements of how fast Mapper can render 4K map frames on the user\'s Mac.\n';
  const current = existsSync(DOC) ? readFileSync(DOC, 'utf8') : header;
  const start = current.indexOf(SECTION);
  let next: string;
  if (start === -1) {
    next = `${current.trimEnd()}\n\n${section}\n`;
  } else {
    const after = current.indexOf('\n## ', start + SECTION.length);
    next = `${current.slice(0, start)}${section}\n${after === -1 ? '' : current.slice(after)}`;
  }
  writeFileSync(DOC, next);
}

// ---------- main ----------

async function main() {
  const { values } = parseArgs({ options: { frames: { type: 'string', default: '100' }, write: { type: 'boolean', default: false } } });
  const frames = Number(values.frames);
  if (!Number.isInteger(frames) || frames < 2) throw new Error('--frames must be an integer of at least 2');
  mkdirSync(OUT_DIR, { recursive: true });

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
