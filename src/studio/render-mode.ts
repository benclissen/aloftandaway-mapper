import { parseProject, type Project } from '../core/index.js'
import { CREDIT_FONT, SIGN_FONT } from './stage/overlay.js'
import { MapStage } from './stage/MapStage.js'

/** What render mode exposes to Node, which drives it over Playwright and captures frames over CDP. */
export interface MapperPage {
  /** Resolves once the page's fonts have loaded. */
  ready: Promise<void>
  /**
   * `faultAtFrame` is a test hook: the first time that frame is rendered, the map's WebGL context is lost on purpose,
   * as a crashing GPU would. It fires at most once per page load and is ignored when absent.
   */
  load(project: Project, opts: { pixelRatio: number; faultAtFrame?: number }): Promise<{ frameCount: number }>
  /** 0 until a project is loaded. */
  readonly frameCount: number
  /** Shows frame `n` and resolves once it is fully painted. */
  renderFrame(n: number): Promise<void>
}

declare global {
  interface Window {
    mapper: MapperPage
    /** Exposed by the Node side to hear about WebGL context loss. */
    __mapperContextLost?: () => void
  }
}

async function fontsReady(): Promise<void> {
  await document.fonts.load(SIGN_FONT)
  await document.fonts.load(CREDIT_FONT)
  await document.fonts.ready
}

/** Loses the canvas's WebGL context, the way a GPU reset would. */
function loseGlContext(canvas: HTMLCanvasElement): void {
  // getContext returns the context the canvas already has when the type matches.
  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
  const lose = gl?.getExtension('WEBGL_lose_context')
  if (!lose) throw new Error('faultAtFrame needs the WEBGL_lose_context extension.')
  lose.loseContext()
}

/** Sets up render mode in `root`: no UI, just the stage at the top-left of the page and `window.mapper`. */
export function startRenderMode(root: HTMLElement): void {
  root.style.cssText = 'position:absolute;left:0;top:0'
  // The page sits at `<base>studio/`; tiles are served next to it.
  const tileBase = new URL('../tiles/', location.href).href
  const ready = fontsReady()
  let stage: MapStage | undefined
  let stageRatio = 0
  // Destroying a stage loses its WebGL context on purpose; only an unexpected loss is a crash.
  let stopWatchingContext: (() => void) | undefined
  let faultAtFrame: number | undefined

  window.mapper = {
    ready,
    get frameCount() {
      return stage ? stage.frameCount : 0
    },
    async load(input, { pixelRatio, faultAtFrame: fault }) {
      if (!(pixelRatio > 0)) throw new RangeError(`pixelRatio must be positive, got ${pixelRatio}`)
      const project = parseProject(input)
      await ready
      if (!stage || stageRatio !== pixelRatio) {
        stopWatchingContext?.()
        stage?.destroy()
        stage = new MapStage(root, { pixelRatio, interactive: false, tileBase })
        stageRatio = pixelRatio
        const canvas = stage.map.getCanvas()
        const onLost = () => window.__mapperContextLost?.()
        canvas.addEventListener('webglcontextlost', onLost)
        stopWatchingContext = () => canvas.removeEventListener('webglcontextlost', onLost)
      }
      faultAtFrame = fault
      await stage.load(project)
      return { frameCount: stage.frameCount }
    },
    async renderFrame(n) {
      if (!stage) throw new Error('Call mapper.load(project) before renderFrame.')
      if (!Number.isInteger(n) || n < 0 || n >= stage.frameCount) {
        throw new RangeError(`Frame ${n} is outside 0 to ${stage.frameCount - 1}.`)
      }
      if (n === faultAtFrame) {
        faultAtFrame = undefined
        loseGlContext(stage.map.getCanvas())
      }
      await stage.showFrame(n)
    },
  }
}
