import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Writable } from 'node:stream'
import { promisify } from 'node:util'
import type { Fps } from '../core/index.js'
import { EnvironmentError } from '../server/errors.js'

export type Codec = 'prores' | 'h264'
export type H264Encoder = 'h264_videotoolbox' | 'libx264'

const noFfmpeg = () => new EnvironmentError('ffmpeg is not installed or not on the PATH.', 'brew install ffmpeg')
const isNotFound = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT'

/** Lines of ffmpeg's stderr kept for error messages. */
const STDERR_LINES = 20
/** Bytes of stderr kept while ffmpeg runs, enough for the last lines. */
const STDERR_KEEP = 16 * 1024

/**
 * RGB to Rec.709 limited range, then tag the frames. ffmpeg 9 takes primaries and transfer from the frames, so the
 * `-color_primaries`/`-color_trc` output flags alone leave them untagged.
 */
const COLOUR_FILTER =
  'scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709'
const COLOUR_TAGS = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709']

/**
 * ffmpeg arguments that read PNG frames from stdin and write `out`. ffmpeg reads the frame size from each PNG, so
 * `width` and `height` aren't passed on; the render loop checks every PNG against them before writing it.
 */
export function ffmpegArgs(args: {
  codec: Codec
  width: number
  height: number
  fps: Fps
  out: string
  h264Encoder?: H264Encoder
}): string[] {
  const rate = `${args.fps.num}/${args.fps.den}`
  const codecArgs =
    args.codec === 'prores'
      ? ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le']
      : [
          ...((args.h264Encoder ?? 'h264_videotoolbox') === 'h264_videotoolbox'
            ? ['-c:v', 'h264_videotoolbox', '-b:v', '40M']
            : ['-c:v', 'libx264', '-crf', '16', '-preset', 'medium']),
          '-pix_fmt',
          'yuv420p',
          '-tag:v',
          'avc1',
          '-movflags',
          '+faststart',
        ]
  return [
    '-hide_banner',
    '-nostats',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'image2pipe',
    '-c:v',
    'png',
    '-framerate',
    rate,
    '-i',
    'pipe:0',
    '-vf',
    COLOUR_FILTER,
    ...codecArgs,
    ...COLOUR_TAGS,
    '-r',
    rate,
    args.out,
  ]
}

/** The concat demuxer's list file: one `file '<path>'` line per segment, each single quote written as `'\''`. */
export function concatList(files: string[]): string {
  return files.map((file) => `file '${file.replaceAll("'", "'\\''")}'\n`).join('')
}

/**
 * Joins `parts` into `out` without re-encoding, using ffmpeg's concat demuxer. The list file sits next to `out` and
 * is deleted afterwards. The parts are left for the caller to delete.
 */
export async function joinSegments(args: { parts: string[]; out: string; codec: Codec }): Promise<void> {
  const list = path.join(path.dirname(args.out), 'concat.txt')
  await writeFile(list, concatList(args.parts))
  try {
    await promisify(execFile)('ffmpeg', [
      '-hide_banner',
      '-nostats',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-c',
      'copy',
      ...(args.codec === 'h264' ? ['-movflags', '+faststart'] : []),
      args.out,
    ])
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr?.trim()
    throw new Error(`Could not join the render's segments${stderr ? `:\n${stderr}` : '.'}`, { cause: e })
  } finally {
    await rm(list, { force: true })
  }
}

type Exit = { code: number | null; signal: NodeJS.Signals | null } | { error: Error }

/** An ffmpeg process fed frames on stdin. */
export class Encoder {
  private readonly process: ChildProcess
  private readonly stdin: Writable
  private readonly exited: Promise<Exit>
  private exit: Exit | undefined
  private stderr = ''
  private killed = false
  private finishing: Promise<void> | undefined

  private constructor(args: string[]) {
    this.process = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] })
    this.stdin = this.process.stdin!
    // A broken pipe shows up as ffmpeg's exit, which write() and finish() report.
    this.stdin.on('error', () => undefined)
    this.process.stderr!.setEncoding('utf8')
    this.process.stderr!.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_KEEP)
    })
    // Never rejects, so nothing is left unhandled when no one is waiting on it.
    this.exited = new Promise<Exit>((resolve) => {
      const exited = (exit: Exit) => {
        this.exit ??= exit
        resolve(this.exit)
      }
      this.process.once('error', (error) => exited({ error }))
      this.process.once('close', (code, signal) => exited({ code, signal }))
    })
  }

  /** Spawns ffmpeg with `args`, usually from `ffmpegArgs`. */
  static start(args: string[]): Encoder {
    return new Encoder(args)
  }

  /** Writes one PNG frame. Resolves once ffmpeg can take more, and rejects if ffmpeg has exited. */
  write(frame: Buffer): Promise<void> {
    if (this.exit) return Promise.reject(this.failure(this.exit, 'before the last frame'))
    if (this.stdin.write(frame)) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        this.process.off('close', onClose)
        resolve()
      }
      const onClose = () => {
        this.stdin.off('drain', onDrain)
        // The constructor's listener ran first and set `exit`.
        reject(this.failure(this.exit!, 'before the last frame'))
      }
      this.stdin.once('drain', onDrain)
      this.process.once('close', onClose)
    })
  }

  /** Closes stdin and waits for ffmpeg. Rejects with the end of ffmpeg's stderr if it fails. Safe to call twice. */
  finish(): Promise<void> {
    this.finishing ??= (async () => {
      if (!this.stdin.destroyed && !this.stdin.writableEnded) this.stdin.end()
      const exit = await this.exited
      if ('error' in exit || exit.code !== 0) throw this.failure(exit, 'with an error')
    })()
    return this.finishing
  }

  /** Stops ffmpeg at once (SIGKILL). The output file is left unfinished. */
  kill(): void {
    if (this.exit) return
    this.killed = true
    this.stdin.destroy()
    this.process.kill('SIGKILL')
  }

  private failure(exit: Exit, when: string): Error {
    if ('error' in exit) {
      return isNotFound(exit.error) ? noFfmpeg() : new Error(`Could not run ffmpeg: ${exit.error.message}`)
    }
    if (this.killed) return new Error('ffmpeg was stopped.')
    const tail = this.stderr.trimEnd().split('\n').slice(-STDERR_LINES).join('\n')
    const how = exit.signal ? `was killed by ${exit.signal}` : `exited with code ${exit.code}`
    return new Error(`ffmpeg ${how} ${when}${tail ? `:\n${tail}` : '.'}`)
  }
}

let h264Encoder: Promise<H264Encoder> | undefined

/** The H.264 encoder to use: VideoToolbox when this ffmpeg has it, otherwise libx264. The answer is cached. */
export function pickH264Encoder(): Promise<H264Encoder> {
  if (!h264Encoder) {
    const picking = promisify(execFile)('ffmpeg', ['-hide_banner', '-encoders']).then(
      ({ stdout }) => {
        const names = new Set(stdout.split('\n').map((line) => line.trim().split(/\s+/)[1]))
        if (names.has('h264_videotoolbox')) return 'h264_videotoolbox' as const
        if (names.has('libx264')) return 'libx264' as const
        throw new EnvironmentError(
          'This ffmpeg has no H.264 encoder (h264_videotoolbox or libx264).',
          'Install an ffmpeg build with h264_videotoolbox or libx264: brew reinstall ffmpeg',
        )
      },
      (e: unknown) => {
        throw isNotFound(e) ? noFfmpeg() : e
      },
    )
    h264Encoder = picking
    picking.catch(() => {
      if (h264Encoder === picking) h264Encoder = undefined
    })
  }
  return h264Encoder
}
