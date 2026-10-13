import type { Browser, BrowserContext, Page } from 'playwright'
import { layoutSize, type Aspect, type Project } from '../core/index.js'
import { getServer } from '../server/server.js'
import { capturePng } from './capture.js'

/** The slice of `window` that render mode exposes. This module is type-checked without the DOM library. */
interface MapperHandle {
  ready: Promise<void>
  load(project: Project, opts: { pixelRatio: number }): Promise<{ frameCount: number }>
  renderFrame(n: number): Promise<void>
}

/**
 * A headless page showing the studio in render mode, laid out at the aspect's layout size. Previews and renders
 * drive it the same way: `load` a project, `renderFrame`, then `capturePng`.
 */
export class RenderPage {
  /** The project id the page is showing. */
  projectId: string
  private readonly aspect: Aspect
  private readonly context: BrowserContext
  private readonly page: Page
  private readonly crashHandlers: (() => void)[] = []
  private pixelRatio: number | undefined
  private closed = false

  private constructor(args: { aspect: Aspect; projectId: string; context: BrowserContext; page: Page }) {
    this.aspect = args.aspect
    this.projectId = args.projectId
    this.context = args.context
    this.page = args.page
  }

  /** Opens a page at the layout size and waits for render mode to be ready. */
  static async open(args: { browser: Browser; projectId: string; aspect: Aspect }): Promise<RenderPage> {
    const context = await args.browser.newContext({ viewport: layoutSize(args.aspect), deviceScaleFactor: 1 })
    try {
      const page = await context.newPage()
      const renderPage = new RenderPage({ aspect: args.aspect, projectId: args.projectId, context, page })
      page.on('crash', () => renderPage.crashed())
      page.on('pageerror', (error) => process.stderr.write(`Render page error: ${error.message}\n`))
      // Render mode calls this when the map canvas loses its WebGL context.
      await page.exposeFunction('__mapperContextLost', () => renderPage.crashed())
      await renderPage.navigate(args.projectId)
      return renderPage
    } catch (e) {
      await context.close().catch(() => undefined)
      throw e
    }
  }

  /** Shows `projectId`'s studio URL in render mode. The next `load` builds a fresh stage. */
  async navigate(projectId: string): Promise<void> {
    const server = await getServer()
    await this.page.goto(server.studioUrl(projectId, { mode: 'render' }))
    await this.waitForRenderMode()
    this.projectId = projectId
    this.pixelRatio = undefined
  }

  /** Loads the project into the map. Resolves to the frame count. */
  async load(project: Project, pixelRatio: number): Promise<number> {
    const { frameCount } = await this.page.evaluate(
      async ([input, ratio]) => {
        const mapper = (globalThis as unknown as { mapper: MapperHandle }).mapper
        await mapper.ready
        return mapper.load(input, { pixelRatio: ratio })
      },
      [project, pixelRatio] as const,
    )
    this.pixelRatio = pixelRatio
    return frameCount
  }

  /** Shows frame `n` and resolves once it is fully painted. Rejects if map data failed to load. */
  async renderFrame(n: number): Promise<void> {
    await this.page.evaluate((frame) => (globalThis as unknown as { mapper: MapperHandle }).mapper.renderFrame(frame), n)
  }

  /** The current frame as a PNG at the pixel ratio of the last `load`. */
  async capturePng(): Promise<Buffer> {
    if (this.pixelRatio === undefined) throw new Error('Call load() before capturePng().')
    return capturePng(this.page, { ...layoutSize(this.aspect), pixelRatio: this.pixelRatio })
  }

  /** Calls `cb` when the page crashes or its WebGL context is lost. */
  onCrash(cb: () => void): void {
    this.crashHandlers.push(cb)
  }

  /** Reloads the page, which drops the map and any tiles it failed to fetch. Call `load` again afterwards. */
  async reload(): Promise<void> {
    await this.page.reload()
    await this.waitForRenderMode()
    this.pixelRatio = undefined
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.context.close().catch(() => undefined)
  }

  private crashed(): void {
    for (const cb of this.crashHandlers) cb()
  }

  private async waitForRenderMode(): Promise<void> {
    await this.page.waitForFunction("'mapper' in window")
  }
}
