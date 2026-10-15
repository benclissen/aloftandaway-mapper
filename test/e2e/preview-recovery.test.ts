import { randomUUID } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { MAP_DATA_ERROR } from '../../src/core/index.js'
import { callTool, TOOLS } from '../../src/mcp/tools.js'
import { closePreviews, contactSheet, previewFrame, previewStats } from '../../src/render/preview.js'
import { EnvironmentError } from '../../src/server/errors.js'
import type { MapperServer } from '../../src/server/server.js'
import { startServer } from '../../src/server/server.js'
import { createProject, saveProject } from '../../src/server/store.js'
import { greekIslands, sceneOf } from '../fixtures/projects.js'

// The process-wide server always proxies tiles from OpenFreeMap. This file swaps in a server whose tile proxy
// fetches from a local fake that can be told to fail, so a map error can be provoked and cleared on demand.
const held = vi.hoisted(() => ({ server: undefined as Promise<MapperServer> | undefined }))
vi.mock('../../src/server/server.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/server/server.js')>()),
  getServer: () => held.server!,
}))

let tempDir: string
let server: MapperServer
let upstream: http.Server
let failing = false
const hits: string[] = []

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'mapper-recovery-'))
  upstream = http.createServer((req, res) => {
    const url = req.url ?? ''
    hits.push(url)
    if (url === '/planet') {
      const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
      const body = JSON.stringify({ tilejson: '2.2.0', minzoom: 0, maxzoom: 14, tiles: [`${origin}/planet/test/{z}/{x}/{y}.pbf`] })
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
      res.end(body)
    } else if (failing && url.startsWith('/planet/')) {
      // MapLibre treats a 404 tile as empty, but a 403 is an error. The proxy doesn't retry 4xx or cache them.
      res.writeHead(403).end()
    } else {
      // Empty tiles and glyph ranges: valid, and nothing to draw.
      res.writeHead(200, { 'Content-Type': 'application/x-protobuf', 'Content-Length': 0 }).end()
    }
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  held.server = startServer({
    studioDir: path.resolve('dist', 'studio'),
    cacheDir: path.join(tempDir, 'cache'),
    tileUpstream: origin,
  })
  server = await held.server
})

afterAll(async () => {
  await closePreviews()
  await server.close()
  await new Promise((resolve) => upstream.close(resolve))
  await rm(tempDir, { recursive: true, force: true })
})

async function writeFolder(): Promise<string> {
  const folder = await mkdtemp(path.join(tempDir, 'project-'))
  const project = greekIslands({ look: { ...sceneOf(greekIslands()).look, theme: 'paper' } })
  await createProject(folder, project.name)
  await saveProject(folder, { ...project, id: randomUUID() })
  return folder
}

/** Empties the proxy's tile cache (the TileJSON stays), so the fake upstream is asked again. */
const forgetTiles = () => rm(path.join(tempDir, 'cache', 'tiles', 'planet'), { recursive: true, force: true })

test('a preview that fails on a map error rejects, and the next one gets a fresh page', async () => {
  await closePreviews()
  await forgetTiles()
  const folder = await writeFolder()

  failing = true
  await expect(previewFrame({ folder, at: { frame: 0 } })).rejects.toThrow(/could not load/i)
  expect(previewStats()).toEqual({ browserLaunches: 1, pageOpens: 1 })

  failing = false
  const result = await previewFrame({ folder, at: { frame: 0 } })
  expect(result.png.length).toBeGreaterThan(0)
  expect(previewStats()).toEqual({ browserLaunches: 1, pageOpens: 2 })

  // The fresh page is warm again.
  await previewFrame({ folder, at: { frame: 10 } })
  expect(previewStats().pageOpens).toBe(2)
})

test('map data that fails to load gives an error that says to check the connection', async () => {
  await closePreviews()
  await forgetTiles()
  const folder = await writeFolder()
  const fix =
    'Check the internet connection. Map tiles come from tiles.openfreemap.org, and Mapper caches them after the first load.'

  failing = true
  try {
    const error = await previewFrame({ folder, at: { frame: 0 } }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(EnvironmentError)
    expect((error as EnvironmentError).message.startsWith(MAP_DATA_ERROR)).toBe(true)
    expect((error as EnvironmentError).fix).toBe(fix)

    const tool = TOOLS.find((t) => t.name === 'preview_frame')!
    const result = await callTool(tool, { folder, at: { frame: 0 } })
    expect(result.isError).toBe(true)
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
    expect(text).toContain(`Error: ${MAP_DATA_ERROR}`)
    expect(text).toContain(`\nFix: ${fix}`)
    expect(text).not.toContain('bug in Mapper')
  } finally {
    failing = false
  }
})

test('a contact sheet that fails on a map error rejects, and the next one gets a fresh page', async () => {
  await closePreviews()
  await forgetTiles()
  const folder = await writeFolder()

  failing = true
  await expect(contactSheet({ folder, count: 4, width: 800 })).rejects.toThrow(/could not load/i)
  expect(previewStats().pageOpens).toBe(1)

  failing = false
  const sheet = await contactSheet({ folder, count: 4, width: 800 })
  expect(sheet.frames).toHaveLength(4)
  expect(previewStats().pageOpens).toBe(2)
})
