// 4K pipeline benchmark: a real renderProject of the Greek Islands fixture on the paper theme, run twice (cold tile
// cache, then warm). Fetches tiles from the live OpenFreeMap service, so run it sparingly.
// Usage: npm run bench:pipeline [-- --write]

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { renderProject, type RenderResult } from '../src/render/render.js'
import { getServer } from '../src/server/server.js'
import { createProject, saveProject } from '../src/server/store.js'
import { greekIslands } from '../test/fixtures/projects.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'test-output', 'bench')
const DOC = path.join(ROOT, 'docs', 'render-speed.md')
const SECTION = '## Pipeline (Task 13)'
/** Task 1's warm 4K figure for frame → CDP screenshot PNG → prores_ks. */
const TASK1_FPS = 9.29
const CLIP = { from: 0, to: 10 }
/** The frame extracted from the warm output to look at. */
const LOOK_AT_SECONDS = 5

const run = promisify(execFile)
const log = (message: string) => process.stderr.write(`${message}\n`)

interface Pass {
  label: string
  result: RenderResult
  wallSeconds: number
}

async function pass(label: string, folder: string): Promise<Pass> {
  log(`${label}: rendering ${CLIP.to - CLIP.from} s at 3840×2160 25p`)
  const start = performance.now()
  let lastLog = 0
  const result = await renderProject({
    folder,
    range: CLIP,
    onProgress: (p) => {
      if (p.frame - lastLog >= 50 || p.frame === p.totalFrames) {
        lastLog = p.frame
        log(`  ${p.frame}/${p.totalFrames} frames, ${p.fps} fps, ETA ${p.etaSeconds} s`)
      }
    },
  })
  const wallSeconds = (performance.now() - start) / 1000
  log(`${label}: ${result.renderFps} fps, ${wallSeconds.toFixed(1)} s wall`)
  return { label, result, wallSeconds }
}

async function ffprobe(file: string): Promise<Record<string, string | number>> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', file])
  return (JSON.parse(stdout) as { streams: Record<string, string | number>[] }).streams[0]!
}

async function extractFrame(video: string, out: string): Promise<void> {
  await run('ffmpeg', [
    '-v', 'error', '-y', '-ss', String(LOOK_AT_SECONDS), '-i', video, '-frames:v', '1',
    '-vf', 'scale=in_color_matrix=bt709:in_range=tv', out,
  ])
}

function section(passes: Pass[], probe: Record<string, string | number>, framePath: string): string {
  const warm = passes[passes.length - 1]!
  const change = (warm.result.renderFps / TASK1_FPS - 1) * 100
  const vsTask1 = `${change >= 0 ? '+' : '−'}${Math.abs(change).toFixed(0)}%`
  const rows = passes.map(
    ({ label, result, wallSeconds }) =>
      `| ${label} | ${result.frames} | ${result.renderFps.toFixed(2)} fps | ${wallSeconds.toFixed(1)} s | ${(wallSeconds / (CLIP.to - CLIP.from)).toFixed(1)}× |`,
  )
  return [
    SECTION,
    '',
    `- Date: ${new Date().toISOString().slice(0, 10)}`,
    '- Script: `npm run bench:pipeline` (`bench/pipeline.ts`)',
    `- Clip: \`greekIslands()\` fixture, \`look.theme: 'paper'\`, 3840×2160 at 25 fps, range ${CLIP.from}–${CLIP.to} s ` +
      `(${CLIP.to - CLIP.from} s, ${warm.result.frames} frames), ProRes 422 HQ`,
    '- Path: `renderProject`: browser per render, `RenderPage.capturePng()` (CDP PNG) → `prores_ks`, frame n+1 ' +
      'rendering while frame n is written',
    '- Cold: empty tile cache (a fresh `MAPPER_CACHE_DIR`), tiles from the live OpenFreeMap service. Warm: the same cache, second run.',
    '- `renderFps` is frames ÷ time from the first `renderFrame` to ffmpeg finishing. Wall time is the whole ' +
      '`renderProject` call, including Chrome launch and map load.',
    '',
    '| Run | Frames | renderFps | Wall time | Wall ÷ clip length |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    `Warm \`renderFps\` against Task 1's 9.29 fps CDP end-to-end figure: ${vsTask1}.`,
    '',
    `ffprobe of the warm output: codec \`${probe.codec_name}\`, profile \`${probe.profile}\`, ` +
      `pix_fmt \`${probe.pix_fmt}\`, ${probe.width}×${probe.height}, r_frame_rate \`${probe.r_frame_rate}\`, ` +
      `nb_frames ${probe.nb_frames}, color_space \`${probe.color_space}\`, color_transfer \`${probe.color_transfer}\`, ` +
      `color_primaries \`${probe.color_primaries}\`, color_range \`${probe.color_range}\`.`,
    '',
    `Frame at ${LOOK_AT_SECONDS} s extracted to \`${path.relative(ROOT, framePath)}\` (not committed).`,
  ].join('\n')
}

function writeDoc(text: string): void {
  const current = readFileSync(DOC, 'utf8')
  const start = current.indexOf(SECTION)
  let next: string
  if (start === -1) {
    next = `${current.trimEnd()}\n\n${text}\n`
  } else {
    const after = current.indexOf('\n## ', start + SECTION.length)
    next = `${current.slice(0, start)}${text}\n${after === -1 ? '' : current.slice(after)}`
  }
  writeFileSync(DOC, next)
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { write: { type: 'boolean', default: false } } })
  if (!existsSync(path.join(ROOT, 'dist', 'studio', 'index.html'))) throw new Error('Run npm run build first.')
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'mapper-pipeline-'))
  // Set before the server starts, so the first run really is cold.
  process.env.MAPPER_CACHE_DIR = path.join(tempDir, 'cache')
  try {
    const base = greekIslands()
    const project = {
      ...base,
      id: randomUUID(),
      look: { ...base.look, theme: 'paper' as const },
      output: { aspect: '16:9' as const, height: 2160 as const, fps: { num: 25, den: 1 } },
    }
    const folder = path.join(tempDir, 'greek-islands')
    await createProject(folder, project.name)
    await saveProject(folder, project)

    const passes = [await pass('Cold', folder), await pass('Warm', folder)]
    const warm = passes[1]!.result
    const video = warm.video
    if (!video) throw new Error('The benchmark render made no flattened clip.')
    const probe = await ffprobe(video)
    await mkdir(OUT_DIR, { recursive: true })
    const framePath = path.join(OUT_DIR, 'pipeline-frame.png')
    await extractFrame(video, framePath)

    const text = section(passes, probe, framePath)
    process.stdout.write(`${text}\n`)
    if (values.write) writeDoc(text)
  } finally {
    await (await getServer()).close()
    await rm(tempDir, { recursive: true, force: true })
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`)
  process.exit(1)
})
