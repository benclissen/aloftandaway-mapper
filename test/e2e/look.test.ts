import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { PNG } from 'pngjs'
import { afterAll, describe, expect, test } from 'vitest'
import { buildRoute, buildTimeline, cameraAt, layoutSize, sceneCredit, TILE_SIZE, toXY, type LngLat, type Project } from '../../src/core/index.js'
import { CREDIT, CREDIT_FONT } from '../../src/studio/stage/overlay.js'
import { alpine, greekIslands, sceneOf } from '../fixtures/projects.js'
import { closeAll, openRenderPage, snapshot } from './helpers.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const MAIN = path.join(ROOT, 'dist', 'cli', 'main.js')

afterAll(closeAll)

/** The layout-px position of `at` on `frame`, for a shot with no bearing or pitch. */
function layoutPx(project: Project, frame: number, at: LngLat): [number, number] {
  const scene = sceneOf(project)
  const route = buildRoute(scene)
  const shot = cameraAt(scene, project.output.aspect, route, buildTimeline(scene, project.output.fps, route), frame)
  const { width, height } = layoutSize(project.output.aspect)
  const scale = TILE_SIZE * 2 ** shot.zoom
  const [x, y] = toXY(at)
  const [cx, cy] = toXY(shot.center)
  return [width / 2 + (x - cx) * scale, height / 2 + (y - cy) * scale]
}

const rgb = (png: PNG, x: number, y: number): [number, number, number] => {
  const i = (Math.round(y) * png.width + Math.round(x)) * 4
  return [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!]
}

const near = (a: number[], b: number[], tolerance: number) => a.every((v, i) => Math.abs(v - b[i]!) <= tolerance)

/**
 * Renders satellite with terrain twice on stubbed tiles, with the credit burned in and left to the description, so the
 * two frames differ only by the credit's ink. Checks that ink sits in the credit box at the frame's right and bottom.
 */
async function expectBurnedCreditFits(aspect: '16:9' | '9:16'): Promise<void> {
  // Satellite with terrain is the three-line credit.
  const withCredit = alpine()
  withCredit.output = { ...withCredit.output, aspect }
  const scene = sceneOf(withCredit)
  scene.look = { ...scene.look, theme: 'satellite' }
  withCredit.credit = 'burned'
  const without: Project = { ...withCredit, credit: 'description' }
  const lines = sceneCredit(scene, 'burned')
  expect(lines).toHaveLength(3)

  const burned = await openRenderPage(withCredit, 1, { stubTiles: true })
  const plain = await openRenderPage(without, 1, { stubTiles: true })
  try {
    const a = PNG.sync.read(await snapshot(burned.page, 0))
    const b = PNG.sync.read(await snapshot(plain.page, 0))
    expect([a.width, a.height]).toEqual(aspect === '16:9' ? [1920, 1080] : [1080, 1920])

    // The widest line, measured in the page with the credit font, bounds the box from the left. The halo and rounding
    // get 4 px.
    const widest = await burned.page.evaluate(
      async ([font, texts]) => {
        await document.fonts.load(font)
        const ctx = document.createElement('canvas').getContext('2d')!
        ctx.font = font
        return Math.max(...texts.map((text) => ctx.measureText(text).width))
      },
      [CREDIT_FONT, lines] as const,
    )
    const boxLeft = a.width - CREDIT.margin - widest - 4
    const boxTop = a.height - CREDIT.margin - 2 * CREDIT.lineHeight - 20

    // Every pixel the credit changed, as the rows and columns it covers. Any change outside the box is not the credit.
    const rows = new Set<number>()
    let minX = a.width
    let maxX = -1
    for (let y = 0; y < a.height; y++) {
      for (let x = 0; x < a.width; x++) {
        const i = (y * a.width + x) * 4
        if (a.data[i] === b.data[i] && a.data[i + 1] === b.data[i + 1] && a.data[i + 2] === b.data[i + 2]) continue
        expect(
          x >= boxLeft && y >= boxTop,
          `pixel (${x}, ${y}) changed outside the credit box (x >= ${boxLeft.toFixed(1)}, y >= ${boxTop})`,
        ).toBe(true)
        rows.add(y)
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
      }
    }
    expect(rows.size, 'the credit is not on the picture').toBeGreaterThan(0)
    const top = Math.min(...rows)
    const bottom = Math.max(...rows)
    // Right-aligned: the ink ends at the margin (the halo adds about a pixel and a half), and the longest line still
    // starts inside the frame. The last baseline is a margin above the bottom edge; descenders drop a few px below.
    expect(maxX).toBeLessThanOrEqual(a.width - CREDIT.margin + 2)
    expect(minX).toBeGreaterThanOrEqual(CREDIT.margin)
    expect(bottom).toBeLessThan(a.height - CREDIT.margin + 8)
    expect(bottom).toBeGreaterThan(a.height - CREDIT.margin - 8)
    // Three lines, one per baseline: each has ink in the band that holds its letters.
    for (const line of [0, 1, 2]) {
      const baseline = a.height - CREDIT.margin - (2 - line) * CREDIT.lineHeight
      const band = [...rows].filter((y) => y >= baseline - 12 && y <= baseline + 2)
      expect(band.length, `credit line ${line + 1} has no ink`).toBeGreaterThan(4)
    }
    expect(top).toBeGreaterThanOrEqual(boxTop)
    // Nothing went past the stubs, so no network was needed.
    expect(burned.leaks, 'the burned page made requests the stubs do not answer').toEqual([])
    expect(plain.leaks, 'the plain page made requests the stubs do not answer').toEqual([])
  } finally {
    await burned.close()
    await plain.close()
  }
}

describe('look', () => {
  test('burned credit fits a 16:9 frame', () => expectBurnedCreditFits('16:9'))

  // The narrowest frame (1080 wide): the longest line still fits.
  test('burned credit fits a 9:16 frame', () => expectBurnedCreditFits('9:16'))
})

describe.skipIf(process.env.MAPPER_NET !== '1')('look (MAPPER_NET only)', () => {
  test('aloftandaway preview renders', async () => {
    // Framed on the whole route and still, so the Cretan Sea and the Greek mainland are both in view.
    const project = greekIslands({
      look: { ...sceneOf(greekIslands()).look, theme: 'aloftandaway' },
      camera: { mode: 'fixed', easing: 'smooth' },
    })
    const { page, close } = await openRenderPage(project, 0.5)
    try {
      const png = PNG.sync.read(await snapshot(page, 0))
      const WATER = [0xee, 0xf2, 0xf4]
      const LAND = [0xd4, 0xda, 0xdf]
      // Open sea south of the Cyclades paints the style's water, not the land colour behind it.
      const [wx, wy] = layoutPx(project, 0, [25.0, 36.0]).map((v) => v * 0.5)
      expect(near(rgb(png, wx!, wy!), WATER, 6), `sea pixel ${rgb(png, wx!, wy!)}`).toBe(true)
      // The Peloponnese paints land: land colour, and land cover or coast hairlines that depart from it.
      const [lx, ly] = layoutPx(project, 0, [22.2, 37.4]).map((v) => v * 0.5)
      let landLike = 0
      let detail = 0
      for (let y = ly! - 12; y <= ly! + 12; y++) {
        for (let x = lx! - 12; x <= lx! + 12; x++) {
          const p = rgb(png, x, y)
          if (near(p, WATER, 6)) continue
          landLike++
          if (!near(p, LAND, 2)) detail++
        }
      }
      expect(landLike, 'no land around the Peloponnese').toBeGreaterThan(300)
      expect(detail, 'land is a flat fill').toBeGreaterThan(0)
    } finally {
      await close()
    }
  })

  test('MCP: set look options and preview', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'mapper-look-e2e-'))
    const client = new Client({ name: 'e2e', version: '0.0.0' })
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [MAIN, 'mcp'],
        env: { ...(process.env as Record<string, string>), MAPPER_CACHE_DIR: path.join(tmp, 'cache') },
        stderr: 'inherit',
      }),
    )
    const text = (r: CallToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
    const call = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult
      expect(result.isError, `${name}: ${text(result)}`).toBeFalsy()
      return result
    }
    try {
      const folder = path.join(tmp, 'Alps')
      await call('create_project', { folder, name: 'Alps' })
      await call('set_stops', {
        folder,
        stops: [
          { name: 'Chamonix', at: [6.8694, 45.9237] },
          { name: 'Courmayeur', at: [6.9724, 45.7967] },
          { name: 'Zermatt', at: [7.7491, 46.0207] },
        ],
      })
      const updated = await call('update_project', {
        folder,
        set: { output: { height: 1080 } },
        sceneSet: {
          look: { theme: 'outdoor', terrain: true, symbol: 'car', symbolStyle: 'icon' },
          // A partial follow: only zoom and pitch are given; the rest fill in from defaults.
          camera: { mode: 'follow', follow: { zoom: 10, pitch: 40 } },
        },
      })
      const scene = (updated.structuredContent as { project: { scenes: { look: Record<string, unknown>; camera: Record<string, unknown> }[] } })
        .project.scenes[0]!
      expect(scene.look).toMatchObject({ theme: 'outdoor', terrain: true, symbol: 'car', symbolStyle: 'icon' })
      expect(scene.camera).toMatchObject({ mode: 'follow', follow: { zoom: 10, pitch: 40 } })

      const validation = await call('validate_project', { folder })
      expect((validation.structuredContent as { errors: unknown[] }).errors).toEqual([])

      const frame = await call('preview_frame', { folder, at: { progress: 0.3 }, width: 640 })
      const image = frame.content.find((c) => c.type === 'image') as { data: string } | undefined
      expect(image, text(frame)).toBeDefined()
      const png = PNG.sync.read(Buffer.from(image!.data, 'base64'))
      expect(png.width).toBe(640)
      // The map drew: more than a flat colour.
      const colours = new Set<number>()
      for (let i = 0; i < png.data.length; i += 4 * 97) colours.add((png.data[i]! << 16) | (png.data[i + 1]! << 8) | png.data[i + 2]!)
      expect(colours.size).toBeGreaterThan(50)
    } finally {
      await client.close()
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
