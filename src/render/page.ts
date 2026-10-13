import type { Browser, BrowserContext, Page } from 'playwright'
import { layoutSize, MAP_DATA_ERROR, type Aspect, type Project } from '../core/index.js'
import { EnvironmentError } from '../server/errors.js'
import { getServer } from '../server/server.js'
import { capturePng } from './capture.js'

const MAP_DATA_FIX =
  'Check the internet connection. Map tiles come from tiles.openfreemap.org, and Mapper caches them after the first load.'

/**
 * Errors from the page reach Node as text. This turns render mode's map-data failure back into a typed error with a
 * fix, keeping the line from its message on, and passes anything else on as it is.
 */
export function pageError(e: unknown): unknown {
  if (!(e instanceof Error)) return e
  const at = e.message.indexOf(MAP_DATA_ERROR)
  if (at < 0) return e
  return new EnvironmentError(e.message.slice(at).split('\n', 1)[0]!, MAP_DATA_FIX)
}

const rethrowTyped = (e: unknown): never => {
  throw pageError(e)
}

/** The slice of `window` that render mode exposes. This module is type-checked without the DOM library. */
interface MapperHandle {
  ready: Promise<void>
  load(
    project: Project,
    opts: { pixelRatio: number; faultAtFrame?: number; faultAfterRenderFrame?: number },
  ): Promise<{ frameCount: number }>
  renderFrame(n: number): Promise<void>
  contextLost(): boolean
}

/**
 * A headless page showing the studio in render mode, laid out at the aspect's layout size. Previews and renders
 * drive it the same way: `load` a project, `renderFrame`, then `capturePng`. Render mode takes its project from
 * `load`, so one page can show any number of projects of its aspect, one after another.
 */
export class RenderPage {
  private readonly aspect: Aspect
  private readonly context: BrowserContext
  private readonly page: Page
  private readonly crashHandlers: (() => void)[] = []
  private pixelRatio: number | undefined
  private closed = false

  private constructor(args: { aspect: Aspect; context: BrowserContext; page: Page }) {
    this.aspect = args.aspect
    this.context = args.context
    this.page = args.page
  }

  /** Opens a page at the layout size and waits for render mode to be ready. */
  static async open(args: { browser: Browser; aspect: Aspect }): Promise<RenderPage> {
    const context = await args.browser.newContext({ viewport: layoutSize(args.aspect), deviceScaleFactor: 1 })
    try {
      const page = await context.newPage()
      const renderPage = new RenderPage({ aspect: args.aspect, context, page })
      page.on('crash', () => renderPage.crashed())
      page.on('pageerror', (error) => process.stderr.write(`Render page error: ${error.message}\n`))
      // Render mode calls this when the map canvas loses its WebGL context.
      await page.exposeFunction('__mapperContextLost', () => renderPage.crashed())
      await page.goto(`${(await getServer()).base}studio/?mode=render`)
      await page.waitForFunction("'mapper' in window")
      return renderPage
    } catch (e) {
      await context.close().catch(() => undefined)
      throw e
    }
  }

  /**
   * Loads the project into the map. Resolves to the frame count. `faultAtFrame` and `faultAfterRenderFrame` are test hooks
   * that lose the WebGL context while that frame is rendered, or just after it has been painted.
   */
  async load(
    project: Project,
    pixelRatio: number,
    opts: { faultAtFrame?: number; faultAfterRenderFrame?: number } = {},
  ): Promise<number> {
    const { frameCount } = await this.page
      .evaluate(
        async ([input, ratio, fault, faultAfter]) => {
          const mapper = (globalThis as unknown as { mapper: MapperHandle }).mapper
          await mapper.ready
          return mapper.load(input, { pixelRatio: ratio, faultAtFrame: fault, faultAfterRenderFrame: faultAfter })
        },
        [project, pixelRatio, opts.faultAtFrame, opts.faultAfterRenderFrame] as const,
      )
      .catch(rethrowTyped)
    this.pixelRatio = pixelRatio
    return frameCount
  }

  /** Shows frame `n` and resolves once it is fully painted. Rejects with an `EnvironmentError` if map data failed to load. */
  async renderFrame(n: number): Promise<void> {
    await this.page
      .evaluate((frame) => (globalThis as unknown as { mapper: MapperHandle }).mapper.renderFrame(frame), n)
      .catch(rethrowTyped)
  }

  /** True when the map's WebGL context is lost, which makes a frame captured now untrustworthy. */
  async contextLost(): Promise<boolean> {
    return this.page.evaluate(() => (globalThis as unknown as { mapper: MapperHandle }).mapper.contextLost())
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

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.context.close().catch(() => undefined)
  }

  private crashed(): void {
    for (const cb of this.crashHandlers) cb()
  }
}
