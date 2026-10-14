#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { renderProject, type RenderResult } from '../render/render.js'
import { getServer } from '../server/server.js'
import { assertAbsolute } from '../server/store.js'
import { exitAfterDrain, installShutdown, runStdio } from '../mcp/server.js'
import { callTool, creditLine, errorText, etaText, TOOLS, type ToolDef } from '../mcp/tools.js'
import { doctorExitCode, formatChecks, runDoctor } from './doctor.js'

/** Exit code for bad commands and flags. */
const USAGE_EXIT = 2
/** Exit code after SIGINT, SIGTERM or SIGHUP. */
const SIGNAL_EXIT = 130
const PROGRESS_INTERVAL_MS = 1000

/** Bad command line. Printed with usage; exit code 2. */
class UsageError extends Error {
  readonly fix: string

  constructor(message: string, fix: string) {
    super(message)
    this.fix = fix
  }
}

/** Cleans up through the shutdown installed for this command, which then exits the process with `code`. */
async function exit(shutdown: (code?: number) => Promise<void>, code: number): Promise<number> {
  await shutdown(code)
  return code
}

// Commands

interface ToolCommand {
  /** The command name: the tool name with hyphens. */
  name: string
  def: ToolDef<any>
}

/**
 * Left out: `open_studio`, which `mapper studio` replaces, and the render job tools. A job lives in one process, so
 * from a shell `mapper render` does the job.
 */
const SHELL_SKIPS = new Set(['open_studio', 'render', 'render_status', 'cancel_render'])
const TOOL_COMMANDS: ToolCommand[] = TOOLS.filter((t) => !SHELL_SKIPS.has(t.name)).map((def) => ({
  name: def.name.replaceAll('_', '-'),
  def,
}))

const firstSentence = (text: string) => text.split(/(?<=\.)\s/)[0] ?? text

const OWN_COMMANDS: [usage: string, summary: string][] = [
  ['mcp', 'Serve MCP on stdin and stdout, for an AI agent'],
  ['studio <folder>', 'Open the studio for a project and keep it running until Ctrl-C (--no-open skips the browser)'],
  ['render <folder>', 'Render the clip and wait for it. Options: --codec prores|h264, --from <s> --to <s>'],
  ['doctor', 'Check this machine and print a fix for anything missing'],
]

function usage(): string {
  const width = Math.max(...OWN_COMMANDS.map(([u]) => u.length), ...TOOL_COMMANDS.map((c) => c.name.length)) + 2
  const row = (left: string, right: string) => `  ${left.padEnd(width)}${right}`
  return [
    'Usage: mapper <command> [options]',
    '',
    'Commands:',
    ...OWN_COMMANDS.map(([u, s]) => row(u, s)),
    '',
    'Tool commands, one per MCP tool. Pass the input with --json \'{"folder":"/abs/path"}\' or --json-file <path>:',
    ...TOOL_COMMANDS.map((c) => row(c.name, firstSentence(c.def.description))),
    '',
    'Tool commands print the result as JSON on stdout and a summary on stderr. Folders must be absolute paths.',
    'The MCP render tools (render, render_status, cancel_render) have no tool commands: a render job lives in one',
    'process. From a shell, use `mapper render`, which waits for the render.',
    'Run mapper <command> --help for a command\'s options.',
  ].join('\n')
}

function toolHelp({ name, def }: ToolCommand): string {
  let schema = ''
  try {
    schema = `\n\nInput (JSON):\n${JSON.stringify(z.toJSONSchema(def.input, { io: 'input' }), null, 2)}`
  } catch {
    // Not every schema converts; the description still helps.
  }
  return `Usage: mapper ${name} [--json '<input>' | --json-file <path>]\n\n${def.description}\n\nWith neither flag the input is {}.${schema}`
}

const OWN_HELP: Record<string, string> = {
  mcp: 'Usage: mapper mcp\n\nServes MCP on stdin and stdout until stdin closes or the process gets a signal.',
  studio:
    'Usage: mapper studio <folder> [--no-open]\n\nRegisters the project, prints the studio URL on stdout and opens it (macOS) unless --no-open.\nKeeps running until Ctrl-C.',
  render:
    'Usage: mapper render <folder> [--codec prores|h264] [--from <s> --to <s>]\n\nRenders and waits. Progress goes to stderr, the result as JSON to stdout.\nCtrl-C cancels the render cleanly (exit 130).',
  doctor: 'Usage: mapper doctor\n\nChecks Node, ffmpeg and its encoders, Chrome and WebGL, and free disk space. Exit code 1 if something required is missing.',
}

function parse<O extends NonNullable<Parameters<typeof parseArgs>[0]>['options']>(args: string[], options: O, positionals: boolean) {
  try {
    return parseArgs({ args, options: { ...options, help: { type: 'boolean', short: 'h' } }, allowPositionals: positionals, strict: true })
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e), 'Run mapper --help to see the options.')
  }
}

// mapper mcp

async function mcpCommand(args: string[]): Promise<number | undefined> {
  const { values } = parse(args, {}, false)
  if (values.help) return help('mcp')
  await runStdio()
  return undefined // Keeps running until stdin ends or a signal arrives.
}

// Tool commands

async function readInput(values: { json?: string; 'json-file'?: string }): Promise<unknown> {
  if (values.json !== undefined && values['json-file'] !== undefined) {
    throw new UsageError('Give --json or --json-file, not both.', 'Pass the input once.')
  }
  let text = values.json
  if (values['json-file'] !== undefined) {
    const file = path.resolve(values['json-file'])
    try {
      text = await readFile(file, 'utf8')
    } catch {
      throw new UsageError(`Could not read ${file}.`, 'Check the --json-file path.')
    }
  }
  if (text === undefined) return {}
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new UsageError(`The input is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, 'Pass the tool input as one JSON object.')
  }
}

async function toolCommand(command: ToolCommand, args: string[]): Promise<number> {
  const { values } = parse(args, { json: { type: 'string' }, 'json-file': { type: 'string' } }, false)
  if (values.help) return help(command)
  const input = await readInput(values)
  const shutdown = installShutdown(undefined, SIGNAL_EXIT)
  const result = await callTool(command.def, input)
  const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).filter(Boolean).join('\n')
  if (result.isError) {
    console.error(text)
  } else {
    // An image result's file path is in the data, so the bytes are left out.
    // The summary goes to stderr below; stdout stays the tool's data alone.
    const { summary: _summary, ...data } = result.structuredContent ?? {}
    console.log(JSON.stringify(data, null, 2))
    console.error(text)
  }
  return exit(shutdown, result.isError ? 1 : 0)
}

// mapper render

async function renderCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { codec: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } }, true)
  if (values.help) return help('render')
  const [folder, ...extra] = positionals
  if (!folder || extra.length) throw new UsageError('render takes one project folder.', 'Usage: mapper render <folder> [--codec prores|h264] [--from s --to s]')
  const codec = values.codec
  if (codec !== undefined && codec !== 'prores' && codec !== 'h264') {
    throw new UsageError(`--codec must be prores or h264, not '${codec}'.`, 'Use --codec prores or --codec h264.')
  }
  if ((values.from === undefined) !== (values.to === undefined)) {
    throw new UsageError('--from and --to go together.', 'Give both, in seconds, or neither to render the whole clip.')
  }
  let range: { from: number; to: number } | undefined
  if (values.from !== undefined && values.to !== undefined) {
    range = { from: Number(values.from), to: Number(values.to) }
    if (values.from.trim() === '' || values.to.trim() === '' || !Number.isFinite(range.from) || !Number.isFinite(range.to)) {
      throw new UsageError('--from and --to must be numbers of seconds.', 'For example: --from 2 --to 10.')
    }
  }

  const controller = new AbortController()
  let rendering: Promise<unknown> = Promise.resolve()
  const shutdown = installShutdown(async () => {
    controller.abort()
    // renderProject writes the cancelled manifest and stops ffmpeg and Chrome before it settles.
    await rendering.catch(() => undefined)
  }, SIGNAL_EXIT)

  let lastProgress = 0
  let result: RenderResult
  try {
    assertAbsolute(folder)
    rendering = renderProject({
      folder,
      codec,
      range,
      signal: controller.signal,
      onProgress: (p) => {
        const now = Date.now()
        if (now - lastProgress < PROGRESS_INTERVAL_MS) return
        lastProgress = now
        console.error(`Frame ${p.frame}/${p.totalFrames} · ${p.fps.toFixed(1)} fps · ${etaText(p.etaSeconds)}`)
      },
    })
    result = (await rendering) as RenderResult
  } catch (e) {
    // A signal is shutting down; let it finish and exit 130.
    if (controller.signal.aborted) return exit(shutdown, SIGNAL_EXIT)
    console.error(errorText(e, 'render'))
    return exit(shutdown, 1)
  }
  console.log(JSON.stringify(result, null, 2))
  console.error(await creditLine(result.manifest))
  return exit(shutdown, 0)
}

// mapper studio

function openUrl(url: string): void {
  if (process.platform !== 'darwin') return
  const child = spawn('open', [url], { stdio: 'ignore', detached: true })
  child.on('error', () => undefined)
  child.unref()
}

async function studioCommand(args: string[]): Promise<number | undefined> {
  const { values, positionals } = parse(args, { 'no-open': { type: 'boolean' } }, true)
  if (values.help) return help('studio')
  const [folder, ...extra] = positionals
  if (!folder || extra.length) throw new UsageError('studio takes one project folder.', 'Usage: mapper studio <folder> [--no-open]')
  const shutdown = installShutdown(undefined, 0)
  try {
    assertAbsolute(folder)
    const server = await getServer()
    const url = server.studioUrl(await server.registerProject(folder))
    console.log(url)
    if (!values['no-open']) openUrl(url)
    console.error('Studio is running. Press Ctrl-C to stop.')
  } catch (e) {
    console.error(errorText(e, 'studio'))
    return exit(shutdown, 1)
  }
  return undefined // Keeps running until a signal arrives.
}

// mapper doctor

async function doctorCommand(args: string[]): Promise<number> {
  const { values } = parse(args, {}, false)
  if (values.help) return help('doctor')
  const checks = await runDoctor()
  console.log(formatChecks(checks))
  return doctorExitCode(checks)
}

// Dispatch

function help(command?: string | ToolCommand): 0 {
  if (!command) console.log(usage())
  else console.log(typeof command === 'string' ? OWN_HELP[command] : toolHelp(command))
  return 0
}

/** Returns the exit code, or undefined for a command that keeps the process running. */
async function main(argv: string[]): Promise<number | undefined> {
  const [command, ...args] = argv
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') return help()
  switch (command) {
    case 'mcp':
      return mcpCommand(args)
    case 'studio':
      return studioCommand(args)
    case 'render':
      return renderCommand(args)
    case 'doctor':
      return doctorCommand(args)
  }
  const tool = TOOL_COMMANDS.find((c) => c.name === command)
  if (tool) return toolCommand(tool, args)
  throw new UsageError(`Unknown command '${command}'.`, 'Run mapper --help to see the commands.')
}

try {
  const code = await main(process.argv.slice(2))
  if (code !== undefined) await exitAfterDrain(code)
} catch (e) {
  if (e instanceof UsageError) {
    console.error(`Error: ${e.message}\nFix: ${e.fix}\n\n${usage()}`)
    await exitAfterDrain(USAGE_EXIT)
  }
  console.error(errorText(e, 'mapper'))
  await exitAfterDrain(1)
}
