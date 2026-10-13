#!/usr/bin/env node
import { runStdio } from '../mcp/server.js'

const [command] = process.argv.slice(2)

if (command === 'mcp') {
  await runStdio()
} else {
  console.error('Usage: mapper mcp')
  process.exit(command ? 1 : 0)
}
