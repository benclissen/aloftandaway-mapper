import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

const ORANGE: [number, number, number] = [217, 71, 43]
/** Alpha of the three vertical bands in `alphaBandsPng`, left to right. */
const BAND_ALPHAS = [0, 128, 255]
/** The x of each band's centre; the bands split the 256 px width at 85 and 171. */
const BAND_CENTRES = [42, 128, 213]

/** Orange everywhere, in vertical bands of alpha 0, 128 and 255. */
function alphaBandsRgba(width: number, height: number): Buffer {
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const band = Math.min(2, Math.floor((x * 3) / width))
      data.set([...ORANGE, BAND_ALPHAS[band]!], (y * width + x) * 4)
    }
  }
  return data
}

function alphaBandsPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height })
  alphaBandsRgba(width, height).copy(png.data)
  return PNG.sync.write(png)
}

async function encode(args: {
  codec: Codec
  fps: Fps
  frames: number
  out: string
  proresProfile?: 'hq' | '4444'
  frame?: Buffer
}): Promise<void> {
  const h264Encoder = args.codec === 'h264' ? await pickH264Encoder() : undefined
  const encoder = Encoder.start(
    ffmpegArgs({
      codec: args.codec,
      proresProfile: args.proresProfile,
      width: 256,
      height: 144,
      fps: args.fps,
      out: args.out,
      h264Encoder,
    }),
  )
  const frame = args.frame ?? solidPng(256, 144, [...ORANGE, 255])
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

test('4444 explicitly keeps alpha', () => {
  const args = ffmpegArgs({ codec: 'prores', proresProfile: '4444',
    width: 256, height: 144, fps: { num: 24000, den: 1001 }, out: '/tmp/route.mov' })
  expect(args.join(' ')).toContain('-profile:v 4')
  expect(args.join(' ')).toContain('-pix_fmt yuva444p10le')
  expect(args.join(' ')).toContain('-alpha_bits 16')
})

test('4444 keeps the colour filter, tags and rate', () => {
  const joined = ffmpegArgs({ codec: 'prores', proresProfile: '4444', width: 256, height: 144, fps: { num: 24000, den: 1001 }, out: '/tmp/route.mov' }).join(' ')
  expect(joined).toContain('-c:v prores_ks -profile:v 4 -vendor apl0 -pix_fmt yuva444p10le -alpha_bits 16')
  expect(joined).toContain(
    'scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709',
  )
  expect(joined).toContain('-color_primaries bt709 -color_trc bt709 -colorspace bt709')
  expect(joined).toContain('-r 24000/1001')
  expect(joined).not.toContain('yuv422p10le')
})

test('prores defaults to HQ', () => {
  const fps = { num: 25, den: 1 }
  const implicit = ffmpegArgs({ codec: 'prores', width: 256, height: 144, fps, out: '/x/map.mov' })
  expect(ffmpegArgs({ codec: 'prores', proresProfile: 'hq', width: 256, height: 144, fps, out: '/x/map.mov' })).toEqual(implicit)
  expect(implicit.join(' ')).not.toContain('alpha_bits')
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

test('a failed join leaves nothing under the final name and no temporary file', async () => {
  const dir = path.join(tempDir, 'failed-join')
  const bin = path.join(tempDir, 'fake-bin')
  await mkdir(dir)
  await mkdir(bin)
  // An ffmpeg that writes a partial output to its last argument, then fails.
  await writeFile(path.join(bin, 'ffmpeg'), '#!/bin/sh\nfor last; do :; done\necho partial > "$last"\necho boom >&2\nexit 1\n', { mode: 0o755 })
  const parts = [path.join(dir, 'all.part1.mov'), path.join(dir, 'all.part2.mov')]
  const out = path.join(dir, 'all.mov')
  const savedPath = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${savedPath}`
  try {
    await expect(joinSegments({ parts, out, codec: 'prores' })).rejects.toThrow(/Could not join[\s\S]*boom/)
  } finally {
    process.env.PATH = savedPath
  }
  expect(existsSync(out)).toBe(false)
  expect(readdirSync(dir)).toEqual([])
})

test('a missing segment fails the join and leaves nothing under the final name', async () => {
  const dir = path.join(tempDir, 'missing-part')
  await mkdir(dir)
  const parts = [path.join(dir, 'all.part1.mov'), path.join(dir, 'all.part2.mov')]
  await encode({ codec: 'prores', fps: { num: 25, den: 1 }, frames: 7, out: parts[0]! })
  const out = path.join(dir, 'all.mov')
  await expect(joinSegments({ parts, out, codec: 'prores' })).rejects.toThrow(/Could not join/)
  expect(existsSync(out)).toBe(false)
  expect(readdirSync(dir)).toEqual(['all.part1.mov'])
})

/** Decodes the first frame of `file` to 8-bit RGBA with the inverse of the encoder's BT.709 conversion. */
async function decodeRgba(file: string): Promise<Buffer> {
  const { stdout } = await run(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=in_color_matrix=bt709:in_range=tv', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 },
  )
  return stdout
}

/** Straight-alpha RGBA `pixel` composited over an opaque `background`, per channel. */
function over(pixel: ArrayLike<number>, background: number): number[] {
  const a = pixel[3]! / 255
  return [0, 1, 2].map((i) => pixel[i]! * a + background * (1 - a))
}

test('ProRes 4444 round-trips straight alpha and colour', async () => {
  const out = path.join(tempDir, 'alpha.mov')
  await encode({ codec: 'prores', proresProfile: '4444', fps: { num: 25, den: 1 }, frames: 3, out, frame: alphaBandsPng(256, 144) })
  const decoded = await decodeRgba(out)
  expect(decoded.length).toBe(256 * 144 * 4)

  BAND_CENTRES.forEach((x, band) => {
    const at = (72 * 256 + x) * 4
    const pixel = [...decoded.subarray(at, at + 4)]
    expect(Math.abs(pixel[3]! - BAND_ALPHAS[band]!), `alpha in band ${band}: ${pixel.join(',')}`).toBeLessThanOrEqual(1)
    if (BAND_ALPHAS[band]! > 0) {
      ORANGE.forEach((expected, i) =>
        expect(Math.abs(pixel[i]! - expected), `channel ${i} in band ${band}: ${pixel.join(',')}`).toBeLessThanOrEqual(3),
      )
    }
  })

  // Compositing catches premultiplication mistakes that per-channel checks on opaque pixels miss.
  const original = alphaBandsRgba(256, 144)
  for (const background of [255, 0]) {
    let worst = 0
    for (let p = 0; p < original.length; p += 4) {
      const want = over(original.subarray(p, p + 4), background)
      const got = over(decoded.subarray(p, p + 4), background)
      for (let i = 0; i < 3; i++) worst = Math.max(worst, Math.abs(got[i]! - want[i]!))
    }
    expect(worst, `worst channel error over ${background}`).toBeLessThanOrEqual(4)
  }
})

test.each([
  { num: 25, den: 1 },
  { num: 24000, den: 1001 },
  { num: 30000, den: 1001 },
])('ProRes 4444 tags $num/$den', async (fps) => {
  const out = path.join(tempDir, `alpha-${fps.num}-${fps.den}.mov`)
  await encode({ codec: 'prores', proresProfile: '4444', fps, frames: 12, out, frame: alphaBandsPng(256, 144) })
  const stream = await ffprobe(out)
  expect(stream.codec_name).toBe('prores')
  expect(stream.profile).toBe('4444')
  // ProRes decoders may hand back 10- or 12-bit pixels; either way the format must carry alpha.
  expect(String(stream.pix_fmt)).toMatch(/^yuva444p1[02]le$/)
  expect(stream.r_frame_rate).toBe(`${fps.num}/${fps.den}`)
  expect(Number(stream.nb_read_frames)).toBe(12)
  expect(Number(stream.nb_frames)).toBe(12)
  expect(stream.color_space).toBe('bt709')
  expect(stream.color_transfer).toBe('bt709')
  expect(stream.color_primaries).toBe('bt709')
})

test('joins ProRes 4444 segments without losing alpha', async () => {
  const dir = path.join(tempDir, 'alpha join')
  await mkdir(dir)
  const parts = [path.join(dir, 'route.part1.mov'), path.join(dir, 'route.part2.mov')]
  const frame = alphaBandsPng(256, 144)
  const fps = { num: 24000, den: 1001 }
  await encode({ codec: 'prores', proresProfile: '4444', fps, frames: 7, out: parts[0]!, frame })
  await encode({ codec: 'prores', proresProfile: '4444', fps, frames: 5, out: parts[1]!, frame })
  const out = path.join(dir, 'route.mov')
  await joinSegments({ parts, out, codec: 'prores' })
  const stream = await ffprobe(out)
  expect(Number(stream.nb_read_frames)).toBe(12)
  expect(stream.profile).toBe('4444')
  expect(String(stream.pix_fmt)).toMatch(/^yuva444p1[02]le$/)
  expect(stream.r_frame_rate).toBe('24000/1001')
  expect(stream.color_space).toBe('bt709')
  const decoded = await decodeRgba(out)
  BAND_CENTRES.forEach((x, band) => {
    expect(Math.abs(decoded[(72 * 256 + x) * 4 + 3]! - BAND_ALPHAS[band]!)).toBeLessThanOrEqual(1)
  })
})
