import { PNG } from 'pngjs'
import { afterAll, expect, test } from 'vitest'
import { buildRoute, buildTimeline, type Project } from '../../src/core/index.js'
import { launchBrowser } from '../../src/render/chrome.js'
import { RenderPage } from '../../src/render/page.js'
import { closeServerIfStarted } from '../../src/server/server.js'
import { capturePng } from '../../src/render/capture.js'
import type { MapperPage } from '../../src/studio/render-mode.js'
import { greekIslands, sceneOf } from '../fixtures/projects.js'
import { closeAll, openRenderPage, pixelDiff, snapshot } from './helpers.js'

afterAll(closeAll)

test('route has transparent background and visible geometry', async () => {
  const view = await openRenderPage(greekIslands(), 1, { layer: 'route' })
  try {
    const png = PNG.sync.read(await snapshot(view.page, 175))
    const alpha = Array.from(png.data).filter((_, i) => i % 4 === 3)
    expect(alpha[0]).toBe(0)
    expect(alpha.some(a => a === 255)).toBe(true)
    expect(alpha.some(a => a > 0 && a < 255)).toBe(true)
  } finally { await view.close() }
})

/** Source-over on unpremultiplied PNG channels, rounded once after each layer. */
function sourceOver(buffers: Buffer[]): Buffer {
  const images = buffers.map(buffer => PNG.sync.read(buffer))
  const first = images[0]!
  const out = new PNG({ width: first.width, height: first.height })
  for (const image of images) {
    expect([image.width, image.height]).toEqual([out.width, out.height])
    for (let i = 0; i < image.data.length; i += 4) {
      const srcA = image.data[i + 3]! / 255
      const dstA = out.data[i + 3]! / 255
      const outA = srcA + dstA * (1 - srcA)
      for (let c = 0; c < 3; c++) {
        out.data[i + c] = outA === 0 ? 0 : Math.round(
          (image.data[i + c]! * srcA + out.data[i + c]! * dstA * (1 - srcA)) / outA,
        )
      }
      out.data[i + 3] = Math.round(outA * 255)
    }
  }
  return PNG.sync.write(out)
}

function alphas(buffer: Buffer): number[] {
  const data = PNG.sync.read(buffer).data
  const values = new Set<number>()
  for (let i = 3; i < data.length; i += 4) values.add(data[i]!)
  return [...values].sort((a, b) => a - b)
}

async function comparePasses(project: Project, ratio: number, frameNumbers: number[]): Promise<void> {
  const captures: Buffer[][] = frameNumbers.map(() => [])
  for (const layer of ['map', 'route', 'signs', 'all'] as const) {
    const view = await openRenderPage(project, ratio, { layer })
    try {
      for (const [index, frame] of frameNumbers.entries()) {
        const png = await snapshot(view.page, frame)
        const { width, height } = PNG.sync.read(png)
        expect([width, height]).toEqual([1920 * ratio, 1080 * ratio])
        if (layer === 'map' || layer === 'all') expect(alphas(png)).toEqual([255])
        else expect(alphas(png)[0]).toBe(0)
        captures[index]!.push(png)
      }
    } finally { await view.close() }
  }
  for (const [index, pngs] of captures.entries()) {
    const combined = sourceOver(pngs.slice(0, 3))
    const { width, height } = PNG.sync.read(combined)
    const differing = pixelDiff(combined, pngs[3]!)
    expect(differing, `frame ${frameNumbers[index]}: ${differing} differing pixels`).toBeLessThanOrEqual(width * height * .005)
  }
}

for (const mode of ['fixed', 'glide'] as const) {
  for (const credit of ['burned', 'description'] as const) {
    test(`1080p passes composite to all with ${mode} camera and ${credit} credit`, async () => {
      const project = { ...greekIslands(), credit }
      sceneOf(project).look.line.glow = true
      sceneOf(project).camera = {
        mode, easing: 'smooth',
        start: { center: [25.8, 37.1], zoom: 6.5, bearing: 0, pitch: 0 },
        end: { center: [26.2, 36.9], zoom: 7, bearing: 10, pitch: 0 },
      }
      await comparePasses(project, 1, [0, 175, 349])
    })
  }
}

test('4K passes composite to all with glow and translucent signs', async () => {
  const project = greekIslands()
  project.output.height = 2160
  sceneOf(project).look.line.glow = true
  await comparePasses(project, 2, [175])
})

test('empty signs are fully transparent and an arriving sign keeps its fade', async () => {
  const project = greekIslands()
  sceneOf(project).stops.forEach(stop => { stop.sign = 'on-arrival' })
  const timeline = buildTimeline(sceneOf(project), project.output.fps, buildRoute(sceneOf(project)))
  const fadeFrame = timeline.arrivals[0]!.frame + 5
  expect(timeline.stateAt(fadeFrame).signs[0]!.opacity).toBe(.5)
  const view = await openRenderPage(project, 1, { layer: 'signs' })
  try {
    expect(alphas(await snapshot(view.page, 0))).toEqual([0])
    // An empty canvas proves capture resets the previous transparent override.
    const opaque = await capturePng(view.page, { width: 1920, height: 1080, pixelRatio: 1 })
    expect(alphas(opaque)).toEqual([255])
    expect(alphas(await snapshot(view.page, 0))).toEqual([0])
    const fadeAlpha = alphas(await snapshot(view.page, fadeFrame))
    expect(fadeAlpha[0]).toBe(0)
    expect(fadeAlpha.at(-1)).toBeGreaterThan(100)
    expect(fadeAlpha.at(-1)).toBeLessThan(255)
  } finally { await view.close() }
  await comparePasses(project, 1, [fadeFrame])
})

test('description credit is absent from map and all; isolated artwork never carries credit', async () => {
  for (const layer of ['map', 'all', 'route', 'signs'] as const) {
    const images: Buffer[] = []
    for (const credit of ['burned', 'description'] as const) {
      const view = await openRenderPage({ ...greekIslands(), credit }, 1, { layer })
      try { images.push(await snapshot(view.page, 175)) } finally { await view.close() }
    }
    const [burned, described] = images.map(buffer => PNG.sync.read(buffer))
    const creditCrop = (image: PNG) => {
      const out = new PNG({ width: 480, height: 40 })
      PNG.bitblt(image, out, 1440, 1040, 480, 40, 0, 0)
      return PNG.sync.write(out)
    }
    if (layer === 'map' || layer === 'all') {
      expect(pixelDiff(creditCrop(burned!), creditCrop(described!))).toBeGreaterThan(100)
      const region = PNG.sync.read(creditCrop(described!))
      for (let i = 0; i < region.data.length; i += 4) {
        expect([...region.data.subarray(i, i + 4)]).toEqual([233, 228, 218, 255])
      }
      // The only difference is the credit strip.
      for (const image of [burned!, described!]) {
        for (let y = 1040; y < 1080; y++) image.data.fill(0, (y * 1920 + 1440) * 4, (y * 1920 + 1920) * 4)
      }
      expect(pixelDiff(PNG.sync.write(burned!), PNG.sync.write(described!))).toBe(0)
    } else expect(pixelDiff(images[0]!, images[1]!)).toBe(0)
  }
})

test('warm route to all to signs loads restore visibility and reset capture alpha', async () => {
  const project = greekIslands()
  const view = await openRenderPage(project, 1, { layer: 'route' })
  try {
    expect(alphas(await snapshot(view.page, 175))[0]).toBe(0)
    for (const [layer, ratio] of [['all', 1], ['signs', 1], ['all', .5], ['route', .5]] as const) {
      await view.page.evaluate(async ([p, layer, pixelRatio]) => {
        const mapper = (window as unknown as { mapper: MapperPage }).mapper
        await mapper.load(p, layer === 'all' ? { pixelRatio } : { pixelRatio, layer })
        await mapper.renderFrame(175)
      }, [project, layer, ratio] as const)
      const warm = await capturePng(view.page, { width: 1920, height: 1080, pixelRatio: ratio, transparent: layer !== 'all' })
      const fresh = await openRenderPage(project, ratio, { layer })
      try { expect(pixelDiff(warm, await snapshot(fresh.page, 175))).toBe(0) } finally { await fresh.close() }
      expect(alphas(warm)[0]).toBe(layer === 'all' ? 255 : 0)
    }
    // Rebuilding route layers in the same pass must not reveal them in signs.
    sceneOf(project).look.line.glow = true
    sceneOf(project).look.line.outline = false
    await view.page.evaluate(async p => {
      const mapper = (window as unknown as { mapper: MapperPage }).mapper
      await mapper.load(p, { pixelRatio: 1, layer: 'signs' })
      await mapper.load(p, { pixelRatio: 1, layer: 'signs' })
      await mapper.renderFrame(175)
    }, project)
    const warm = await capturePng(view.page, { width: 1920, height: 1080, pixelRatio: 1, transparent: true })
    const fresh = await openRenderPage(project, 1, { layer: 'signs' })
    try { expect(pixelDiff(warm, await snapshot(fresh.page, 175))).toBe(0) } finally { await fresh.close() }
  } finally { await view.close() }
})

test.skipIf(process.env.MAPPER_NET !== '1')('real paper tiles composite to all (MAPPER_NET only)', async () => {
  const project = greekIslands()
  sceneOf(project).look.theme = 'paper'
  sceneOf(project).look.line.glow = true
  await comparePasses(project, 1, [175])
})


test('RenderPage carries pass selection and capture transparency through warm loads', async () => {
  const { browser } = await launchBrowser()
  const page = await RenderPage.open({ browser, aspect: '16:9' })
  try {
    const project = greekIslands()
    for (const layer of ['route', 'all', 'signs'] as const) {
      await page.load(project, .5, layer === 'all' ? {} : { layer })
      await page.renderFrame(175)
      const png = await page.capturePng()
      expect(alphas(png)[0]).toBe(layer === 'all' ? 255 : 0)
      const fresh = await openRenderPage(project, .5, { layer })
      try { expect(pixelDiff(png, await snapshot(fresh.page, 175))).toBe(0) } finally { await fresh.close() }
    }
  } finally {
    await page.close()
    await browser.close()
    await closeServerIfStarted()
  }
})
