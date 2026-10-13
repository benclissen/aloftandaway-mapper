import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec'
import type { Feature, FeatureCollection, LineString, Point } from 'geojson'
import { GeoJSONSource, Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import {
  buildRoute,
  buildTimeline,
  cameraAt,
  layoutSize,
  MAP_CREDIT,
  MAP_DATA_ERROR,
  slicePath,
  unwrapLng,
  type FrameState,
  type LngLat,
  type Look,
  type Project,
  type Route,
  type Timeline,
} from '../../core/index.js'
import { CREDIT_FONT, drawOverlay, SIGN_FONT, signText } from './overlay.js'
import { buildStyle } from './themes.js'

// MapLibre finds its worker next to its own module, which bundling moves. Point it at the emitted copy.
setWorkerUrl(workerUrl)

export interface MapStageOptions {
  /** Device px per layout px. */
  pixelRatio: number
  interactive: boolean
  /** `<server base>tiles/`, ending in a slash. */
  tileBase: string
}

const ROUTE_SOURCE = 'mapper-route'
const HEAD_SOURCE = 'mapper-head'
const IDLE_TIMEOUT_MS = 60_000

interface Loaded {
  project: Project
  route: Route
  timeline: Timeline
}

const emptyCollection = (): FeatureCollection => ({ type: 'FeatureCollection', features: [] })

function lineFeature(path: LngLat[]): Feature<LineString> | FeatureCollection {
  if (path.length === 0) return emptyCollection()
  // A line needs two points; before the head moves it is a zero-length line at the start.
  const coordinates = path.length === 1 ? [path[0]!, path[0]!] : path
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } }
}

const pointFeature = (at: LngLat): Feature<Point> => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: at } })

/** Route line, outline, glow and head layers for a look, bottom to top. */
function routeLayers(look: Look): LayerSpecification[] {
  const { color, width, dash, outline, glow } = look.line
  const cap = dash === 'dashed' ? 'butt' : 'round'
  const layers: LayerSpecification[] = []
  if (glow) {
    layers.push({
      id: 'mapper-route-glow',
      type: 'line',
      source: ROUTE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': color, 'line-width': width * 3, 'line-opacity': 0.4, 'line-blur': width * 1.5 },
    })
  }
  if (outline) {
    layers.push({
      id: 'mapper-route-outline',
      type: 'line',
      source: ROUTE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': width * 2 },
    })
  }
  layers.push({
    id: 'mapper-route-line',
    type: 'line',
    source: ROUTE_SOURCE,
    layout: { 'line-cap': cap, 'line-join': 'round' },
    paint: {
      'line-color': color,
      'line-width': width,
      ...(dash === 'dashed' ? { 'line-dasharray': [2, 1.5] } : dash === 'dotted' ? { 'line-dasharray': [0.1, 1.6] } : {}),
    },
  })
  if (look.symbol !== 'none') {
    layers.push({
      id: 'mapper-head',
      type: 'circle',
      source: HEAD_SOURCE,
      paint: {
        'circle-color': color,
        'circle-radius': Math.max(5, width * 1.5),
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      },
    })
  }
  return layers
}

const nextAnimationFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

/**
 * The map and its 2D overlay, laid out at the project's layout size and driven frame by frame from `core`.
 * Shared by the studio, previews and renders, so a frame looks the same in all three.
 */
export class MapStage {
  readonly map: MapLibreMap
  private readonly container: HTMLElement
  private readonly overlay: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly opts: MapStageOptions
  private loaded: Loaded | undefined
  private styleKey: string | undefined
  private routeLayerIds: string[] = []
  /** The first map error since the last frame: a tile, TileJSON or glyph request that failed. */
  private mapError: Error | undefined
  /** Frames are shown one at a time, in call order. */
  private queue: Promise<void> = Promise.resolve()
  /** The state the overlay was last drawn with. */
  private overlayState: FrameState | undefined

  constructor(container: HTMLElement, opts: MapStageOptions) {
    this.container = container
    this.opts = opts
    // The map and overlay are absolutely positioned inside the container.
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative'
    container.style.overflow = 'hidden'
    this.setLayoutSize(layoutSize('16:9'))

    const mapDiv = document.createElement('div')
    mapDiv.style.cssText = 'position:absolute;inset:0'
    this.overlay = document.createElement('canvas')
    this.overlay.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none'
    container.append(mapDiv, this.overlay)
    const ctx = this.overlay.getContext('2d')
    if (!ctx) throw new Error('The browser could not create a 2D canvas for the overlay.')
    this.ctx = ctx

    this.map = new MapLibreMap({
      container: mapDiv,
      pixelRatio: opts.pixelRatio,
      maxCanvasSize: [8192, 8192],
      fadeDuration: 0,
      attributionControl: false,
      interactive: opts.interactive,
      // MapLibre allows zoom −2; the schema starts at 0, so a view the user saves must too.
      ...(opts.interactive ? { minZoom: 0 } : {}),
      // Draw CJK labels from the server's glyphs rather than a system font, so every machine renders the same.
      localIdeographFontFamily: false,
    })
    // Registered first, so it runs before the listener in `settled`.
    this.map.on('error', ({ error }) => {
      this.mapError ??= error instanceof Error ? error : new Error(String(error))
    })
    this.sizeOverlay()
  }

  get frameCount(): number {
    return this.require().timeline.totalFrames
  }

  get timeline(): Timeline {
    return this.require().timeline
  }

  /** Lays the stage out for `project`. Rebuilds the map style only when the theme or label language changes. */
  async load(project: Project): Promise<void> {
    await this.enqueue(async () => {
      const route = buildRoute(project)
      const timeline = buildTimeline(project, route)
      const { width, height } = layoutSize(project.output.aspect)
      if (this.container.clientWidth !== width || this.container.clientHeight !== height) {
        this.setLayoutSize({ width, height })
        this.map.resize()
        this.sizeOverlay()
      }

      const styleKey = `${project.look.theme}/${project.look.labels}`
      if (styleKey !== this.styleKey) {
        this.mapError = undefined
        const styled = new Promise<void>((resolve) => this.map.once('style.load', () => resolve()))
        this.map.setStyle(buildStyle(project.look.theme, { tileBase: this.opts.tileBase, labels: project.look.labels }), {
          diff: false,
        })
        await styled
        this.styleKey = styleKey
        this.map.addSource(ROUTE_SOURCE, { type: 'geojson', data: emptyCollection() })
        this.map.addSource(HEAD_SOURCE, { type: 'geojson', data: emptyCollection() })
        this.routeLayerIds = []
      }
      for (const id of this.routeLayerIds) this.map.removeLayer(id)
      const layers = routeLayers(project.look)
      for (const layer of layers) this.map.addLayer(layer)
      this.routeLayerIds = layers.map((l) => l.id)

      await this.loadFonts(project)
      this.loaded = { project, route, timeline }
    })
  }

  /**
   * Shows frame `n`: the route drawn up to the head, the camera (unless `camera: false`) and the overlay. Resolves
   * once the map has every tile loaded and the frame is painted. Rejects if map data failed to load since the last
   * frame, since the frame would then be missing part of the map.
   */
  showFrame(n: number, opts: { camera?: boolean } = {}): Promise<void> {
    return this.enqueue(async () => {
      const { project, route, timeline } = this.require()
      const state = timeline.stateAt(n)
      this.throwMapError()
      // Listen before changing anything, so an idle from this frame can't be missed.
      const settled = this.settled()
      this.source(ROUTE_SOURCE).setData(lineFeature(slicePath(route, state.distance)))
      this.source(HEAD_SOURCE).setData(pointFeature(state.head.at))
      if (opts.camera !== false) this.map.jumpTo(cameraAt(project, route, timeline, n))
      // Makes the map render, and so go idle, even when nothing above changed.
      this.map.triggerRepaint()
      await settled
      this.drawOverlay(state)
      // Let the compositor take the overlay before anyone captures the page.
      await nextAnimationFrame()
    })
  }

  /**
   * Redraws the overlay for the last frame shown, at the map's current view. For interactive stages, where the user
   * can move the map between frames.
   */
  redrawOverlay(): void {
    if (this.overlayState && this.loaded) this.drawOverlay(this.overlayState)
  }

  /** The map and overlay composited into one canvas at device resolution. */
  composite(): HTMLCanvasElement {
    const mapCanvas = this.map.getCanvas()
    const out = document.createElement('canvas')
    out.width = mapCanvas.width
    out.height = mapCanvas.height
    const ctx = out.getContext('2d')
    if (!ctx) throw new Error('The browser could not create a 2D canvas.')
    // The WebGL drawing buffer is only readable during the task that drew it, so draw now.
    this.map.redraw()
    ctx.drawImage(mapCanvas, 0, 0)
    ctx.drawImage(this.overlay, 0, 0, out.width, out.height)
    return out
  }

  destroy(): void {
    this.map.remove()
    this.container.replaceChildren()
  }

  private require(): Loaded {
    if (!this.loaded) throw new Error('Load a project into the stage first.')
    return this.loaded
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task)
    this.queue = run.catch(() => undefined)
    return run
  }

  private source(id: string): GeoJSONSource {
    const source = this.map.getSource<GeoJSONSource>(id)
    if (!source) throw new Error(`The map has no '${id}' source.`)
    return source
  }

  /** Resolves when the map next goes idle, or rejects on a map error or after the timeout. */
  private settled(): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer)
        this.map.off('idle', finish)
        this.map.off('error', finish)
        try {
          this.throwMapError()
          resolve()
        } catch (e) {
          reject(e as Error)
        }
      }
      const timer = setTimeout(() => {
        this.map.off('idle', finish)
        this.map.off('error', finish)
        reject(new Error(`The map did not finish loading within ${IDLE_TIMEOUT_MS / 1000} s.`))
      }, IDLE_TIMEOUT_MS)
      this.map.on('idle', finish)
      this.map.on('error', finish)
    })
  }

  private throwMapError(): void {
    const error = this.mapError
    if (!error) return
    this.mapError = undefined
    throw new Error(`${MAP_DATA_ERROR}: ${error.message}`)
  }

  private setLayoutSize({ width, height }: { width: number; height: number }): void {
    this.container.style.width = `${width}px`
    this.container.style.height = `${height}px`
  }

  private sizeOverlay(): void {
    const { width, height } = this.map.getCanvas()
    this.overlay.width = width
    this.overlay.height = height
  }

  private drawOverlay(state: FrameState): void {
    const { project } = this.require()
    this.overlayState = state
    const center = this.map.getCenter().lng
    drawOverlay(this.ctx, {
      project,
      state,
      // Stops keep their stored longitude; take the world copy nearest the view.
      project2px: ([lng, lat]) => {
        const p = this.map.project([unwrapLng(center, lng), lat])
        return [p.x, p.y]
      },
      pixelRatio: this.opts.pixelRatio,
    })
  }

  /** Loads exactly the Inter subsets this project's text needs, so nothing falls back while drawing. */
  private async loadFonts(project: Project): Promise<void> {
    const texts = project.stops.map(signText)
    await Promise.all([
      ...texts.map((text) => document.fonts.load(SIGN_FONT, text)),
      document.fonts.load(CREDIT_FONT, MAP_CREDIT),
    ])
  }
}
