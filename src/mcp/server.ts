import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { cancelAll } from '../render/jobs.js'
import { closePreviews } from '../render/preview.js'
import { closeServerIfStarted } from '../server/server.js'
import { callTool, TOOLS, ToolError } from './tools.js'

/** Gives up waiting for cleanup after this long and exits anyway. */
const SHUTDOWN_LIMIT_MS = 15_000

/**
 * An MCP server with the stage-1 tools. The SDK would answer bad input with a protocol error, so tool calls go
 * through `callTool` instead, which turns every failure into a tool error with a fix.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'mapper', version: '0.0.0' })
  for (const def of TOOLS) {
    server.registerTool(def.name, { description: def.description, inputSchema: def.input }, (args: unknown) => callTool(def, args))
  }
  server.server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const def = TOOLS.find((t) => t.name === params.name)
    if (def) return callTool(def, params.arguments)
    const error = new ToolError(`No tool is called '${params.name}'.`, `Use one of: ${TOOLS.map((t) => t.name).join(', ')}.`)
    return { isError: true, content: [{ type: 'text', text: `Error: ${error.message}\nFix: ${error.fix}` }] }
  })
  return server
}

/** How long to wait for a reader to take buffered output before exiting anyway. */
const DRAIN_LIMIT_MS = 5_000

/**
 * Exits once stdout and stderr have written everything. `process.exit` straight after a large `console.log` cuts the
 * output off when stdout is a pipe (on macOS at 64 KB).
 */
export async function exitAfterDrain(exitCode: number): Promise<never> {
  const drain = (stream: NodeJS.WriteStream) => new Promise<void>((resolve) => stream.write('', () => resolve()))
  await Promise.race([Promise.all([drain(process.stdout), drain(process.stderr)]), new Promise((resolve) => setTimeout(resolve, DRAIN_LIMIT_MS))])
  return process.exit(exitCode)
}

/**
 * Makes SIGINT, SIGTERM and SIGHUP shut the process down: `extra` runs first, then renders are cancelled and the
 * preview browser and studio server are closed, then the process exits with `signalExitCode`. Returns the shutdown
 * function, which a command calls to exit when it is done (with its own exit code). Only the first call does anything.
 * A second signal while it runs kills the process the usual way.
 */
export function installShutdown(extra?: () => Promise<void>, signalExitCode = 0): (exitCode?: number) => Promise<void> {
  let shuttingDown: Promise<void> | undefined
  const shutdown = (exitCode = signalExitCode): Promise<void> => {
    shuttingDown ??= (async () => {
      setTimeout(() => process.exit(1), SHUTDOWN_LIMIT_MS).unref()
      try {
        await extra?.()
        await cancelAll()
        await closePreviews()
        await closeServerIfStarted()
      } catch (e) {
        console.error('Mapper shutdown error:', e)
      }
      await exitAfterDrain(exitCode)
    })()
    return shuttingDown
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, () => void shutdown())
  return shutdown
}

/**
 * Serves MCP on stdin and stdout until stdin ends or the process gets SIGINT, SIGTERM or SIGHUP. Then it shuts down
 * as `installShutdown` describes. Stdout carries only protocol.
 */
export async function runStdio(): Promise<void> {
  // Anything that logs to stdout would corrupt the protocol.
  console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args)

  const server = createMcpServer()
  const shutdown = installShutdown()
  server.server.onclose = () => void shutdown()
  // The SDK's stdio transport doesn't notice stdin ending.
  process.stdin.on('end', () => void shutdown())
  await server.connect(new StdioServerTransport())
}
