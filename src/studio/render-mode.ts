import { parseProject, type Project, type RenderLayer, type RenderPageOptions } from '../core/index.js'
import { CREDIT_FONT, SIGN_FONT } from './stage/overlay.js'
import { MapStage } from './stage/MapStage.js'

/** What render mode exposes to Node, which drives it over Playwright and captures frames over CDP. */
export interface MapperPage {
  /** Resolves once the page's fonts have loaded. */
  ready: Promise<void>
  /**
   * `faultAtFrame` and `faultAfterRenderFrame` are test hooks that lose the map's WebGL context on purpose, as a crashing GPU
   * would: while that frame is being rendered, or just after it has been painted. Each fires at most once per page
   * load and is ignored when absent. `scene` is the id of the scene to show, the project's first when left out; an
   * unknown id rejects.
   */
  load(
    project: Project,
    opts: { pixelRatio: number } & RenderPageOptions,
  ): Promise<{ frameCount: number }>
  /** 0 until a project is loaded. */
  readonly frameCount: number
  /** Shows frame `n` and resolves once it is fully painted. */
  renderFrame(n: number): Promise<void>
  /** True when the map's WebGL context has been lost, so a frame captured now may be blank. */
  contextLost(): boolean
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

/** The canvas's existing WebGL context. getContext returns it when the type matches. */
function glContext(canvas: HTMLCanvasElement): WebGLRenderingContext | WebGL2RenderingContext | null {
  return canvas.getContext('webgl2') ?? canvas.getContext('webgl')
}

/** Loses the canvas's WebGL context, the way a GPU reset would. */
function loseGlContext(canvas: HTMLCanvasElement): void {
  const lose = glContext(canvas)?.getExtension('WEBGL_lose_context')
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
  let stageLayer: RenderLayer = 'all'
  // Destroying a stage loses its WebGL context on purpose; only an unexpected loss is a crash.
  let stopWatchingContext: (() => void) | undefined
  let faultAtFrame: number | undefined
  let faultAfterRenderFrame: number | undefined

  window.mapper = {
    ready,
    get frameCount() {
      return stage ? stage.frameCount : 0
    },
    async load(input, { pixelRatio, layer = 'all', scene: sceneId, seaPaths, faultAtFrame: fault, faultAfterRenderFrame: faultAfter }) {
      if (!(pixelRatio > 0)) throw new RangeError(`pixelRatio must be positive, got ${pixelRatio}`)
      const project = parseProject(input)
      // Checked before the stage is touched, so a bad id leaves the loaded scene as it was.
      if (sceneId !== undefined && !project.scenes.some((s) => s.id === sceneId)) {
        throw new Error(`No scene ${sceneId} in this project.`)
      }
      await ready
      if (!stage || stageRatio !== pixelRatio || stageLayer !== layer) {
        stopWatchingContext?.()
        stage?.destroy()
        stage = new MapStage(root, { pixelRatio, interactive: false, tileBase, layer })
        stageRatio = pixelRatio
        stageLayer = layer
        const canvas = stage.map.getCanvas()
        const onLost = () => window.__mapperContextLost?.()
        canvas.addEventListener('webglcontextlost', onLost)
        stopWatchingContext = () => canvas.removeEventListener('webglcontextlost', onLost)
      }
      faultAtFrame = fault
      faultAfterRenderFrame = faultAfter
      await stage.load(project, sceneId, seaPaths)
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
      if (n === faultAfterRenderFrame) {
        faultAfterRenderFrame = undefined
        // Unreported, as if the loss event were still on its way to Node: only contextLost() can show it.
        stopWatchingContext?.()
        loseGlContext(stage.map.getCanvas())
      }
    },
    contextLost() {
      if (!stage) throw new Error('Call mapper.load(project) before contextLost.')
      const gl = glContext(stage.map.getCanvas())
      return !gl || gl.isContextLost()
    },
  }
}
