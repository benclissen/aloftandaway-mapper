import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { PNG } from 'pngjs'
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { Fps } from '../../src/core/index.js'
import { concatList, Encoder, ffmpegArgs, joinSegments, pickH264Encoder, type Codec } from '../../src/render/encode.js'

const run = promisify(execFile)
let tempDir: string

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'mapper-encode-'))
})

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const png = new PNG({ width, height })
  for (let i = 0; i < png.data.length; i += 4) png.data.set(rgba, i)
  return PNG.sync.write(png)
}

async function encode(args: { codec: Codec; fps: Fps; frames: number; out: string }): Promise<void> {
  const h264Encoder = args.codec === 'h264' ? await pickH264Encoder() : undefined
  const encoder = Encoder.start(ffmpegArgs({ codec: args.codec, width: 256, height: 144, fps: args.fps, out: args.out, h264Encoder }))
  const frame = solidPng(256, 144, [217, 71, 43, 255])
  for (let i = 0; i < args.frames; i++) await encoder.write(frame)
  await encoder.finish()
}

async function ffprobe(file: string): Promise<Record<string, string | number>> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_streams', '-of', 'json', file])
  return (JSON.parse(stdout) as { streams: Record<string, string | number>[] }).streams[0]!
}

test('prores args match the spec', () => {
  const a = ffmpegArgs({ codec: 'prores', width: 3840, height: 2160, fps: { num: 25, den: 1 }, out: '/x/all.mov' })
  const joined = a.join(' ')
  expect(joined).toContain('-f image2pipe -c:v png -framerate 25/1 -i pipe:0')
  expect(joined).toContain('-c:v prores_ks -profile:v 3 -vendor apl0 -pix_fmt yuv422p10le')
  expect(joined).toContain('-color_primaries bt709 -color_trc bt709 -colorspace bt709')
  expect(joined).toContain(
    'scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709',
  )
  expect(joined).toContain('-r 25/1')
  expect(a.at(-1)).toBe('/x/all.mov')
})

test('h264 args match the spec', () => {
  const fps = { num: 30000, den: 1001 }
  const vt = ffmpegArgs({ codec: 'h264', width: 1920, height: 1080, fps, out: '/x/all.mp4', h264Encoder: 'h264_videotoolbox' }).join(' ')
  expect(vt).toContain('-c:v h264_videotoolbox -b:v 40M')
  expect(vt).toContain('-pix_fmt yuv420p -tag:v avc1 -movflags +faststart')
  expect(vt).toContain('-r 30000/1001')
  const x264 = ffmpegArgs({ codec: 'h264', width: 1920, height: 1080, fps, out: '/x/all.mp4', h264Encoder: 'libx264' }).join(' ')
  expect(x264).toContain('-c:v libx264 -crf 16 -preset medium')
})

test.each(['prores', 'h264'] as const)('round-trips colour through BT.709 (%s)', async (codec) => {
  const out = path.join(tempDir, `colour.${codec === 'prores' ? 'mov' : 'mp4'}`)
  await encode({ codec, fps: { num: 25, den: 1 }, frames: 10, out })
  const { stdout } = await run(
    'ffmpeg',
    ['-v', 'error', '-i', out, '-frames:v', '1', '-vf', 'scale=in_color_matrix=bt709:in_range=tv', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 },
  )
  expect(stdout.length).toBe(256 * 144 * 3)
  const centre = (72 * 256 + 128) * 3
  const rgb = [...stdout.subarray(centre, centre + 3)]
  ;[217, 71, 43].forEach((expected, i) => expect(Math.abs(rgb[i]! - expected), `channel ${i}: ${rgb.join(',')}`).toBeLessThanOrEqual(3))
})

test('tags 30000/1001', async () => {
  const out = path.join(tempDir, 'ntsc.mov')
  await encode({ codec: 'prores', fps: { num: 30000, den: 1001 }, frames: 30, out })
  const stream = await ffprobe(out)
  expect(stream.r_frame_rate).toBe('30000/1001')
  expect(Number(stream.nb_read_frames)).toBe(30)
  expect(Number(stream.nb_frames)).toBe(30)
  expect(stream.color_space).toBe('bt709')
  expect(stream.color_transfer).toBe('bt709')
  expect(stream.color_primaries).toBe('bt709')
})

test('encoder failure surfaces ffmpeg stderr', async () => {
  const out = path.join(tempDir, 'missing', 'dir', 'all.mov')
  const encoder = Encoder.start(ffmpegArgs({ codec: 'prores', width: 256, height: 144, fps: { num: 25, den: 1 }, out }))
  // ffmpeg may exit before it reads the frame, so the write is allowed to fail too.
  await encoder.write(solidPng(256, 144, [0, 0, 0, 255])).catch(() => undefined)
  await expect(encoder.finish()).rejects.toThrow(/No such file or directory/)
})

test('kill stops ffmpeg', async () => {
  const encoder = Encoder.start(ffmpegArgs({ codec: 'prores', width: 256, height: 144, fps: { num: 25, den: 1 }, out: path.join(tempDir, 'killed.mov') }))
  await encoder.write(solidPng(256, 144, [0, 0, 0, 255]))
  encoder.kill()
  await expect(encoder.finish()).rejects.toThrow(/stopped/)
  await expect(encoder.write(solidPng(256, 144, [0, 0, 0, 255]))).rejects.toThrow(/stopped/)
})

test('picks an H.264 encoder', async () => {
  expect(['h264_videotoolbox', 'libx264']).toContain(await pickH264Encoder())
})

test('concat list quotes every path and escapes single quotes', () => {
  expect(concatList(['/a/Bob\'s Trip/all.part1.mov', '/b/plain.mov'])).toBe(
    "file '/a/Bob'\\''s Trip/all.part1.mov'\nfile '/b/plain.mov'\n",
  )
  expect(concatList(["/x/''/y.mov"])).toBe("file '/x/'\\'''\\''/y.mov'\n")
})

test.each(['prores', 'h264'] as const)('joins segments in a folder with a space and an apostrophe (%s)', async (codec) => {
  const ext = codec === 'prores' ? 'mov' : 'mp4'
  const dir = path.join(tempDir, `Bob's Trip ${codec}`)
  await mkdir(dir)
  const parts = [path.join(dir, `all.part1.${ext}`), path.join(dir, `all.part2.${ext}`)]
  await encode({ codec, fps: { num: 25, den: 1 }, frames: 7, out: parts[0]! })
  await encode({ codec, fps: { num: 25, den: 1 }, frames: 5, out: parts[1]! })
  const out = path.join(dir, `all.${ext}`)
  await joinSegments({ parts, out, codec })
  expect(Number((await ffprobe(out)).nb_read_frames)).toBe(12)
  expect((await ffprobe(out)).color_space).toBe('bt709')
  // The list file is a scratch file; nothing is left behind but the parts and the output.
  expect(existsSync(path.join(dir, 'concat.txt'))).toBe(false)
})
