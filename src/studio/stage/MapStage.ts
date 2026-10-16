import type { FilterSpecification, LayerSpecification } from '@maplibre/maplibre-gl-style-spec'
import type { Feature, FeatureCollection, LineString } from 'geojson'
import { GeoJSONSource, Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import {
  buildRoute,
  buildTimeline,
  cameraAt,
  legFlipped,
  layoutSize,
  pointAt,
  sceneCredit,
  screenAngle,
  joinCredit,
  MAP_DATA_ERROR,
  MAX_TERRAIN_SETTLES,
  slicePath,
  TILE_SIZE,
  unwrapLng,
  type FrameState,
  type LngLat,
  type Look,
  type Project,
  type Route,
  type RenderLayer,
  type Scene,
  type SeaPaths,
  type Shot,
  type Timeline,
} from '../../core/index.js'
import { CREDIT_FONT, drawOverlay, SIGN_FONT, signText } from './overlay.js'
import { waitForStyleLoad } from './style-load.js'
import { dropElevationTiles, redrawTerrain } from './terrain-internals.js'
import { buildStyle } from './themes.js'

// MapLibre finds its worker next to its own module, which bundling moves. Point it at the emitted copy.
setWorkerUrl(workerUrl)

export interface MapStageOptions {
  layer?: RenderLayer
  /** Device px per layout px. */
  pixelRatio: number
  interactive: boolean
  /** `<server base>tiles/`, ending in a slash. */
  tileBase: string
  /** Studio edit mode: draws the whole route faintly, and the selected leg, for clicking. Never set for renders. */
  editing?: boolean
  /**
   * Render mode: makes every terrain frame the same however it was reached, at the cost of reloading elevation tiles
   * and extra idles per frame. The studio leaves it off and keeps MapLibre's own terrain behaviour.
   */
  deterministicTerrain?: boolean
  /** Test hook: draws the overlay on the CPU (a 2D context with `willReadFrequently`) rather than the GPU. */
  cpuOverlay?: boolean
}

const ROUTE_SOURCE = 'mapper-route'
const EDIT_SOURCE = 'mapper-edit'
/** The layer the studio queries for clicks on the route. */
export const EDIT_ROUTE_LAYER = 'mapper-edit-route'
const EDIT_SELECTED_LAYER = 'mapper-edit-selected'
const IDLE_TIMEOUT_MS = 60_000
/** How long a new style may take to load before the stage gives up on it. */
const STYLE_TIMEOUT_MS = 60_000
/** Turning symbols take their angle from the line this many layout px ahead of the head. */
const LOOK_AHEAD_PX = 4

interface Loaded {
  project: Project
  /** The scene the stage shows. */
  scene: Scene
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


/** Every leg's whole path, each tagged with its index as `leg`. */
function legsCollection(route: Route): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: route.legs.map((leg, i) => ({
      type: 'Feature',
      properties: { leg: i },
      geometry: { type: 'LineString', coordinates: leg.path.length === 1 ? [leg.path[0]!, leg.path[0]!] : leg.path },
    })),
  }
}

const selectedFilter = (leg: number | undefined): FilterSpecification => ['==', ['get', 'leg'], leg ?? -1]

/** The faint whole route and the selected leg, drawn under the route line in edit mode. */
function editLayers(look: Look, selected: number | undefined): LayerSpecification[] {
  const { color, width } = look.line
  return [
    {
      id: EDIT_ROUTE_LAYER,
      type: 'line',
      source: EDIT_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': color, 'line-width': width / 2, 'line-opacity': 0.35 },
    },
    {
      id: EDIT_SELECTED_LAYER,
      type: 'line',
      source: EDIT_SOURCE,
      filter: selectedFilter(selected),
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': color, 'line-width': width + 4, 'line-opacity': 0.5 },
    },
  ]
}

/** Route line, outline and glow layers for a look, bottom to top. */
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
  private baseVisibility = new Map<string, NonNullable<NonNullable<LayerSpecification['layout']>['visibility']>>()
  private routeLayerIds: string[] = []
  private editLayerIds: string[] = []
  private selectedLeg: number | undefined
  /** The first map error since the last frame: a tile, TileJSON or glyph request that failed. */
  private mapError: Error | undefined
  /** Frames are shown one at a time, in call order. */
  private queue: Promise<void> = Promise.resolve()
  /** The state the overlay was last drawn with. */
  private overlayState: FrameState | undefined
  private drawnScreenAngle: number | undefined

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
    const ctx = this.overlay.getContext('2d', opts.cpuOverlay ? { willReadFrequently: true } : undefined)
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
    if (opts.layer === 'signs') this.map.getCanvas().style.visibility = 'hidden'
    this.sizeOverlay()
  }

  get frameCount(): number {
    return this.require().timeline.totalFrames
  }

  get timeline(): Timeline {
    return this.require().timeline
  }

  /** The route of the scene last loaded, or undefined before the first load. */
  get route(): Route | undefined {
    return this.loaded?.route
  }

  /** Highlights leg `leg` in edit mode, or none. */
  setSelectedLeg(leg: number | undefined): void {
    this.selectedLeg = leg
    if (this.map.getLayer(EDIT_SELECTED_LAYER)) this.map.setFilter(EDIT_SELECTED_LAYER, selectedFilter(leg))
  }

  /**
   * Lays the stage out for the scene with id `sceneId` in `project`, or its first scene when `sceneId` is left out.
   * Rebuilds the map style only when the theme, label language or terrain changes. Rejects for an unknown scene id.
   */
  async load(project: Project, sceneId?: string, seaPaths?: SeaPaths): Promise<void> {
    await this.enqueue(async () => {
      const scene = sceneId === undefined ? project.scenes[0]! : project.scenes.find((s) => s.id === sceneId)
      if (!scene) throw new Error(`No scene ${sceneId} in this project.`)
      const route = buildRoute(scene, seaPaths)
      const timeline = buildTimeline(scene, project.output.fps, route)
      const { width, height } = layoutSize(project.output.aspect)
      if (this.container.clientWidth !== width || this.container.clientHeight !== height) {
        this.setLayoutSize({ width, height })
        this.map.resize()
        this.sizeOverlay()
      }

      const { theme, labels, terrain } = scene.look
      const styleKey = `${theme}/${labels}/${terrain}`
      if (styleKey !== this.styleKey) {
        this.mapError = undefined
        // A style that fails to load leaves the map with a half-built one, so the next load must rebuild it.
        this.styleKey = undefined
        const styled = waitForStyleLoad(this.map, STYLE_TIMEOUT_MS, () => this.throwMapError())
        this.map.setStyle(buildStyle(theme, { tileBase: this.opts.tileBase, labels, terrain }), { diff: false })
        await styled
        this.baseVisibility = new Map(
          this.map.getStyle().layers.map((layer) => [layer.id, layer.layout?.visibility ?? 'visible']),
        )
        this.styleKey = styleKey
        this.map.addSource(ROUTE_SOURCE, { type: 'geojson', data: emptyCollection() })
        if (this.opts.editing) this.map.addSource(EDIT_SOURCE, { type: 'geojson', data: emptyCollection() })
        this.routeLayerIds = []
        this.editLayerIds = []
      }
      for (const id of [...this.editLayerIds, ...this.routeLayerIds]) this.map.removeLayer(id)
      if (this.opts.editing) {
        this.source(EDIT_SOURCE).setData(legsCollection(route))
        const edit = editLayers(scene.look, this.selectedLeg)
        for (const layer of edit) this.map.addLayer(layer)
        this.editLayerIds = edit.map((l) => l.id)
      }
      const layers = routeLayers(scene.look)
      for (const layer of layers) this.map.addLayer(layer)
      this.routeLayerIds = layers.map((l) => l.id)
      this.applyLayerVisibility()

      await this.loadFonts(scene)
      this.loaded = { project, scene, route, timeline }
    })
  }

  /**
   * Shows frame `n`: the route drawn up to the head, the camera (unless `camera: false`) and the overlay. Resolves
   * once the map has every tile loaded and the frame is painted. Rejects if map data failed to load since the last
   * frame, since the frame would then be missing part of the map. `settled` is false when the camera's height over
   * terrain was still changing after every placement `settleOnTerrain` allows, so the frame may differ between renders.
   */
  showFrame(n: number, opts: { camera?: boolean } = {}): Promise<{ settled: boolean }> {
    return this.enqueue(async () => {
      const { project, scene, route, timeline } = this.require()
      const state = timeline.stateAt(n)
      this.throwMapError()
      const shot = opts.camera === false ? undefined : cameraAt(scene, project.output.aspect, route, timeline, n)
      const terrain = shot && this.opts.deterministicTerrain ? this.map.getTerrain() : null
      // Can throw, so it comes before the idle listener (whose timer would otherwise be left running).
      if (terrain) dropElevationTiles(this.map, terrain.source)
      // Listen before changing the map, so an idle from this frame can't be missed. The drop above is synchronous and
      // idle fires later, so nothing is lost.
      const settled = this.settled()
      this.source(ROUTE_SOURCE).setData(lineFeature(slicePath(route, state.distance)))
      if (shot) this.map.jumpTo(shot)
      // Makes the map render, and so go idle, even when nothing above changed.
      this.map.triggerRepaint()
      await settled
      const onTerrain = shot && terrain ? await this.settleOnTerrain(shot) : true
      this.drawOverlay(state)
      // Let the compositor take the overlay before anyone captures the page.
      await nextAnimationFrame()
      return { settled: onTerrain }
    })
  }

  /** The screen angle the overlay was last drawn with, for tests: undefined when it fell back to the heading. */
  get lastScreenAngle(): number | undefined {
    return this.drawnScreenAngle
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
    if (this.opts.layer !== 'signs') ctx.drawImage(mapCanvas, 0, 0)
    ctx.drawImage(this.overlay, 0, 0, out.width, out.height)
    return out
  }

  /**
   * The layout-px position of `at` in the current view. Over terrain it is the point on the ground, at the elevation
   * the map draws there, which is where the draped route line passes. Stops keep their stored longitude, so this takes
   * the world copy nearest the view, or nearest `centerLng` when given.
   */
  project([lng, lat]: LngLat, centerLng: number = this.map.getCenter().lng): [number, number] {
    const p = this.map.project([unwrapLng(centerLng, lng), lat])
    return [p.x, p.y]
  }

  destroy(): void {
    this.map.remove()
    this.container.replaceChildren()
  }

  private applyLayerVisibility(): void {
    const layer = this.opts.layer ?? 'all'
    for (const [id, visibility] of this.baseVisibility) {
      this.map.setLayoutProperty(id, 'visibility', layer === 'map' || layer === 'all' ? visibility : 'none')
    }
    for (const id of this.routeLayerIds) {
      this.map.setLayoutProperty(id, 'visibility', layer === 'route' || layer === 'all' ? 'visible' : 'none')
    }
  }

  private require(): Loaded {
    if (!this.loaded) throw new Error('Load a project into the stage first.')
    return this.loaded
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private source(id: string): GeoJSONSource {
    const source = this.map.getSource<GeoJSONSource>(id)
    if (!source) throw new Error(`The map has no '${id}' source.`)
    return source
  }

  /**
   * Makes a terrain frame the same however it was reached. Its elevation tiles were dropped before the camera moved,
   * since tiles kept from earlier frames choose the tiles drawn and where the centre sits. The centre sits on the
   * ground, at the elevation of whatever tiles were drawn when it moved, and tiles that load later move it again: so
   * place the camera again on the tiles now loaded, and again after the tiles that view needs, until the centre's
   * elevation holds. Then redraw the terrain from scratch: MapLibre keeps each terrain tile's drawing until that tile
   * changes, so a tile whose edges were filled in from a neighbour that loaded after it still shows its old edges.
   * Resolves false when the elevation was still changing after `MAX_TERRAIN_SETTLES` placements.
   */
  private async settleOnTerrain(shot: Shot): Promise<boolean> {
    let held = false
    for (let i = 0; i < MAX_TERRAIN_SETTLES && !held; i++) {
      const elevation = this.map.getCenterElevation()
      const settled = this.settled()
      this.map.jumpTo(shot)
      this.map.triggerRepaint()
      await settled
      held = this.map.getCenterElevation() === elevation
    }
    const redrawn = this.settled()
    redrawTerrain(this.map)
    this.map.triggerRepaint()
    await redrawn
    return held
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
    const { project, scene, route } = this.require()
    this.overlayState = state
    const center = this.map.getCenter().lng
    const project2px = (at: LngLat) => this.project(at, center)
    const legIndex = route.legs.length > 0 ? pointAt(route, state.distance).legIndex : 0
    this.drawnScreenAngle = route.legs.length > 0 ? this.lineAngle(route, state, project2px) : undefined
    drawOverlay(this.ctx, {
      scene,
      credit: project.credit,
      state,
      legIndex,
      flipped: legFlipped(route, legIndex),
      screenAngle: this.drawnScreenAngle,
      bearing: this.map.getBearing(),
      project2px,
      pixelRatio: this.opts.pixelRatio,
      layer: this.opts.layer,
    })
  }

  /**
   * The direction of the route at the head as drawn on screen, so it takes in pitch and terrain: towards the point
   * `LOOK_AHEAD_PX` further along, or from the point that far behind at the end of the route. The px become route
   * distance (Mercator units) at the current zoom, as an untilted map would draw them. Undefined when the two points
   * project within 0.01 px of each other.
   */
  private lineAngle(route: Route, state: FrameState, project2px: (at: LngLat) => [number, number]): number | undefined {
    const step = LOOK_AHEAD_PX / (TILE_SIZE * 2 ** this.map.getZoom())
    const head = project2px(state.head.at)
    if (state.distance + step <= route.length) return screenAngle(head, project2px(pointAt(route, state.distance + step).at))
    return screenAngle(project2px(pointAt(route, state.distance - step).at), head)
  }

  /** Loads exactly the Plus Jakarta Sans subsets this scene's text needs, so nothing falls back while drawing. */
  private async loadFonts(scene: Scene): Promise<void> {
    const texts = scene.stops.map(signText)
    await Promise.all([
      ...texts.map((text) => document.fonts.load(SIGN_FONT, text)),
      document.fonts.load(CREDIT_FONT, joinCredit(sceneCredit(scene))),
    ])
  }
}
