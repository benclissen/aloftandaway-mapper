import type { Browser, BrowserContext, Page } from 'playwright'
import { layoutSize, MAP_DATA_ERROR, type Aspect, type Project, type RenderPageOptions } from '../core/index.js'
import { EnvironmentError } from '../server/errors.js'
import { getServer } from '../server/server.js'
import { capturePng } from './capture.js'

/**
 * How long loading a scene into a page may take. The page gives up on its own style after 60 s with a message that says
 * what failed, so this is longer, to let that message arrive first.
 */
export const LOAD_TIMEOUT_MS = 70_000

/**
 * The fix for a map-data failure, by the source that failed. The message names the failing URL, and the local tile
 * proxy keeps each source under its own path: `/tiles/satellite/` (EOX) and `/tiles/terrain/` (AWS Terrarium). Anything
 * else is the OpenFreeMap vector tiles, glyphs or style.
 */
export function mapDataFix(message: string): string {
  if (message.includes('/tiles/satellite/')) {
    return 'Check the internet connection. Satellite imagery comes from tiles.maps.eox.at, and Mapper caches it after the first load.'
  }
  if (message.includes('/tiles/terrain/')) {
    return 'Check the internet connection. Terrain comes from the elevation tiles on s3.amazonaws.com, and Mapper caches them after the first load.'
  }
  return 'Check the internet connection. Map tiles come from tiles.openfreemap.org, and Mapper caches them after the first load.'
}

/**
 * Errors from the page reach Node as text. This turns render mode's map-data failure back into a typed error with a
 * fix, keeping the line from its message on, and passes anything else on as it is.
 */
export function pageError(e: unknown): unknown {
  if (!(e instanceof Error)) return e
  const at = e.message.indexOf(MAP_DATA_ERROR)
  if (at < 0) return e
  const message = e.message.slice(at).split('\n', 1)[0]!
  return new EnvironmentError(message, mapDataFix(message))
}

const rethrowTyped = (e: unknown): never => {
  throw pageError(e)
}

/** The slice of `window` that render mode exposes. This module is type-checked without the DOM library. */
interface MapperHandle {
  ready: Promise<void>
  load(
    project: Project,
    opts: { pixelRatio: number } & RenderPageOptions,
  ): Promise<{ frameCount: number }>
  renderFrame(n: number): Promise<{ settled: boolean }>
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
  private closing: Promise<void> | undefined
  private transparent = false

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
   * that lose the WebGL context while that frame is rendered, or just after it has been painted; `forceUnsettledAt`
   * makes that frame report `settled: false`.
   */
  async load(
    project: Project,
    pixelRatio: number,
    opts: RenderPageOptions = {},
  ): Promise<number> {
    const { frameCount } = await this.page
      .evaluate(
        async ([input, ratio, options]) => {
          const mapper = (globalThis as unknown as { mapper: MapperHandle }).mapper
          await mapper.ready
          return mapper.load(input, { pixelRatio: ratio, ...options })
        },
        [project, pixelRatio, opts] as const,
      )
      .catch(rethrowTyped)
    this.pixelRatio = pixelRatio
    this.transparent = opts.layer === 'route' || opts.layer === 'signs'
    return frameCount
  }

  /**
   * Shows frame `n` and resolves once it is fully painted. `settled` is false when the camera's height over terrain
   * never held still, so the frame may differ slightly between renders. Rejects with an `EnvironmentError` if map data
   * failed to load.
   */
  async renderFrame(n: number): Promise<{ settled: boolean }> {
    return this.page
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
    return capturePng(this.page, { ...layoutSize(this.aspect), pixelRatio: this.pixelRatio, transparent: this.transparent })
  }

  /** Calls `cb` when the page crashes or its WebGL context is lost. */
  onCrash(cb: () => void): void {
    this.crashHandlers.push(cb)
  }

  /** Closes the page's browser context. Every call resolves once it is closed, also when a close is already under way. */
  close(): Promise<void> {
    this.closing ??= this.context.close().catch(() => undefined)
    return this.closing
  }

  private crashed(): void {
    for (const cb of this.crashHandlers) cb()
  }
}
