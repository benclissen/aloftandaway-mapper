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

/**
 * Serves MCP on stdin and stdout until stdin ends or the process gets SIGINT, SIGTERM or SIGHUP. Then it cancels renders,
 * closes the preview browser and the studio server, and exits. Stdout carries only protocol.
 */
export async function runStdio(): Promise<void> {
  // Anything that logs to stdout would corrupt the protocol.
  console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args)

  const server = createMcpServer()
  let shuttingDown: Promise<void> | undefined
  const shutdown = (): Promise<void> => {
    shuttingDown ??= (async () => {
      setTimeout(() => process.exit(1), SHUTDOWN_LIMIT_MS).unref()
      try {
        await cancelAll()
        await closePreviews()
        await closeServerIfStarted()
      } catch (e) {
        console.error('Mapper shutdown error:', e)
      }
      process.exit(0)
    })()
    return shuttingDown
  }

  server.server.onclose = () => void shutdown()
  // The SDK's stdio transport doesn't notice stdin ending.
  process.stdin.on('end', () => void shutdown())
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, () => void shutdown())
  await server.connect(new StdioServerTransport())
}
