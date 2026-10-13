import { Marker, type Map as MapLibreMap } from 'maplibre-gl'
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { clampLat, layoutSize, type LngLat, type Project, type Shot } from '../../core/index.js'
import { MapStage } from '../stage/MapStage.js'

declare global {
  interface Window {
    /** The live map, for tests and debugging. Replaced when the stage is rebuilt. */
    mapperStudio?: { map: MapLibreMap }
  }
}

export interface StageHandle {
  /** The map's current view as a shot, or undefined before the map exists. */
  shot(): Shot | undefined
}

interface StageProps {
  project: Project
  /** Frame to show. Must be within the project's timeline. */
  frame: number
  /** When true the camera stays where the user left it; frames update only the route and signs. */
  freeView: boolean
  handle: RefObject<StageHandle | null>
  /** The user panned, zoomed, rotated or tilted the map. */
  onUserMove(): void
  /** Resolves to whether the new position was saved; if not, the marker goes back to the stop. */
  onStopMoved(id: string, at: LngLat): Promise<boolean>
  onError(message: string): void
}

/** The stage is rebuilt at a new pixel ratio only when the ratio drifts this far from the one it was built at. */
const REBUILD_RATIO_CHANGE = 0.25
const REBUILD_DEBOUNCE_MS = 250
/** Gap between the frame and the edges of the stage area, in CSS px. */
const MARGIN = 16

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places

/** Bearing in (−180, 180]. */
function normaliseBearing(bearing: number): number {
  const b = ((((bearing + 180) % 360) + 360) % 360) - 180
  return b === -180 ? 180 : b
}

interface Callbacks {
  onUserMove(): void
  onStopMoved(id: string, at: LngLat): Promise<boolean>
  onError(message: string): void
  onShown(frame: number): void
}

/**
 * Shows frames on one stage, coalescing requests: while a frame is being drawn, newer requests replace each other
 * and only the latest is drawn next. Never queues more than one frame.
 */
class FrameDriver {
  private wanted: { frame: number; camera: boolean } | undefined
  private busy = false
  disposed = false

  constructor(
    private readonly stage: MapStage,
    private readonly cb: Callbacks,
  ) {}

  want(frame: number, camera: boolean): void {
    this.wanted = { frame, camera }
    if (!this.busy) void this.pump()
  }

  private async pump(): Promise<void> {
    this.busy = true
    while (this.wanted && !this.disposed) {
      const { frame, camera } = this.wanted
      this.wanted = undefined
      try {
        await this.stage.showFrame(frame, { camera })
        if (!this.disposed) this.cb.onShown(frame)
      } catch (e) {
        if (!this.disposed) this.cb.onError((e as Error).message)
      }
    }
    this.busy = false
  }
}

/** Owns the MapStage, its markers and its frame driver, and rebuilds them when the pixel ratio changes a lot. */
class StageController {
  private stage: MapStage | undefined
  private driver: FrameDriver | undefined
  private ratio = 0
  private rebuildTimer: ReturnType<typeof setTimeout> | undefined
  private markers = new Map<string, Marker>()
  /** Stops whose marker is being dragged; incoming projects don't move them. */
  private dragging = new Set<string>()
  private project: Project | undefined
  private frame = 0
  private camera = true
  /** The frame and camera last asked of the driver, so repeat requests are skipped. */
  private requested: { frame: number; camera: boolean } | undefined

  constructor(
    private readonly container: HTMLElement,
    private readonly cb: Callbacks,
  ) {}

  setRatio(ratio: number): void {
    if (!(ratio > 0)) return
    if (!this.stage) return this.build(ratio)
    clearTimeout(this.rebuildTimer)
    if (Math.abs(ratio / this.ratio - 1) <= REBUILD_RATIO_CHANGE) return
    this.rebuildTimer = setTimeout(() => this.build(ratio), REBUILD_DEBOUNCE_MS)
  }

  setProject(project: Project): void {
    this.project = project
    this.loadProject()
  }

  show(frame: number, camera: boolean): void {
    this.frame = frame
    this.camera = camera
    this.request()
  }

  shot(): Shot | undefined {
    const map = this.stage?.map
    if (!map) return undefined
    const { lng, lat } = map.getCenter().wrap()
    return {
      center: [round(lng, 6), clampLat(round(lat, 6))],
      zoom: round(map.getZoom(), 4),
      bearing: normaliseBearing(map.getBearing()),
      pitch: map.getPitch(),
    }
  }

  destroy(): void {
    clearTimeout(this.rebuildTimer)
    this.teardown()
  }

  private build(ratio: number): void {
    // A rebuild keeps the view, which matters in free view, where no frame puts the camera back.
    const old = this.stage?.map
    const view = old && { center: old.getCenter(), zoom: old.getZoom(), bearing: old.getBearing(), pitch: old.getPitch() }
    this.teardown()
    const tileBase = new URL('../tiles/', location.href).href
    const stage = new MapStage(this.container, { pixelRatio: ratio, interactive: true, tileBase })
    if (view) stage.map.jumpTo(view)
    this.stage = stage
    this.ratio = ratio
    this.driver = new FrameDriver(stage, this.cb)
    window.mapperStudio = { map: stage.map }
    // The overlay is drawn per frame; keep it on the map while the user moves it.
    stage.map.on('move', () => stage.redrawOverlay())
    // Moves the map makes itself (jumpTo for a frame) have no originalEvent; the user's drags, wheels and keys do.
    for (const type of ['movestart', 'zoomstart', 'rotatestart', 'pitchstart'] as const) {
      stage.map.on(type, (e: { originalEvent?: Event }) => {
        if (!e.originalEvent) return
        // The view on screen is no longer the camera's, so the next camera request for this frame must be drawn.
        if (this.requested) this.requested = { ...this.requested, camera: false }
        this.cb.onUserMove()
      })
    }
    this.loadProject()
  }

  private teardown(): void {
    if (this.driver) this.driver.disposed = true
    this.driver = undefined
    this.requested = undefined
    for (const marker of this.markers.values()) marker.remove()
    this.markers.clear()
    this.dragging.clear()
    this.stage?.destroy()
    this.stage = undefined
  }

  private loadProject(): void {
    const { stage, project } = this
    if (!stage || !project) return
    stage.load(project).then(
      () => {
        if (this.stage === stage && this.project === project) this.syncMarkers(stage.map, project)
      },
      (e: unknown) => {
        if (this.stage === stage) this.cb.onError((e as Error).message)
      },
    )
    // Queued behind the load, so it draws with the new project.
    this.requested = undefined
    this.request()
  }

  private request(): void {
    if (!this.driver || !this.project) return
    const { frame, camera, requested } = this
    // A free-view repeat of the same frame would change nothing on screen.
    if (requested && requested.frame === frame && (requested.camera === camera || !camera)) return
    this.requested = { frame, camera }
    this.driver.want(frame, camera)
  }

  private syncMarkers(map: MapLibreMap, project: Project): void {
    const ids = new Set(project.stops.map((s) => s.id))
    for (const [id, marker] of this.markers) {
      if (ids.has(id)) continue
      marker.remove()
      this.markers.delete(id)
    }
    for (const stop of project.stops) {
      let marker = this.markers.get(stop.id)
      if (!marker) {
        marker = this.createMarker(stop.id)
        marker.setLngLat(stop.at).addTo(map)
        this.markers.set(stop.id, marker)
      } else if (!this.dragging.has(stop.id)) {
        marker.setLngLat(stop.at)
      }
      const element = marker.getElement()
      element.title = stop.name
      element.setAttribute('aria-label', stop.name)
    }
  }

  private createMarker(id: string): Marker {
    const element = document.createElement('div')
    element.className = 'stop-handle'
    element.dataset.testid = `stop-marker-${id}`
    // Subpixel positioning keeps the handle exactly over the stop, so a drag starts and ends where it looks.
    const marker = new Marker({ element, draggable: true, anchor: 'center', subpixelPositioning: true })
    marker.on('dragstart', () => this.dragging.add(id))
    marker.on('dragend', () => {
      this.dragging.delete(id)
      const { lng, lat } = marker.getLngLat().wrap()
      void this.cb.onStopMoved(id, [round(lng, 5), clampLat(round(lat, 5))]).then((saved) => {
        // Nothing was saved, so no new project will move the marker: put it back over the stop.
        const stop = this.project?.stops.find((s) => s.id === id)
        if (!saved && stop && this.markers.get(id) === marker && !this.dragging.has(id)) marker.setLngLat(stop.at)
      })
    })
    return marker
  }
}

/**
 * The map at layout size, scaled with a CSS transform to fit the space it is given. Its pixel ratio matches the
 * screen at that scale, so the map stays sharp without laying out differently from a render.
 */
export function Stage({ project, frame, freeView, handle, onUserMove, onStopMoved, onError }: StageProps) {
  const areaRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<StageController | null>(null)
  const [area, setArea] = useState<{ width: number; height: number }>()
  const [shownFrame, setShownFrame] = useState<number>()
  // Callbacks change every render; the controller reads the latest through this ref.
  const callbacks = useRef({ onUserMove, onStopMoved, onError })
  callbacks.current = { onUserMove, onStopMoved, onError }

  const layout = layoutSize(project.output.aspect)
  const fit = area ? Math.max(0.05, Math.min((area.width - 2 * MARGIN) / layout.width, (area.height - 2 * MARGIN) / layout.height)) : 0

  useLayoutEffect(() => {
    const el = areaRef.current!
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect
      setArea({ width, height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const controller = new StageController(containerRef.current!, {
      onUserMove: () => callbacks.current.onUserMove(),
      onStopMoved: (id, at) => callbacks.current.onStopMoved(id, at),
      onError: (message) => callbacks.current.onError(message),
      onShown: setShownFrame,
    })
    controllerRef.current = controller
    handle.current = { shot: () => controller.shot() }
    return () => {
      controller.destroy()
      controllerRef.current = null
      handle.current = null
    }
  }, [handle])

  useEffect(() => {
    if (fit > 0) controllerRef.current?.setRatio(window.devicePixelRatio * fit)
  }, [fit])

  useEffect(() => {
    controllerRef.current?.setProject(project)
  }, [project])

  useEffect(() => {
    controllerRef.current?.show(frame, !freeView)
  }, [frame, freeView, project])

  return (
    <div className="stage-area" ref={areaRef}>
      <div className="stage-frame" style={{ width: layout.width * fit, height: layout.height * fit }}>
        <div
          ref={containerRef}
          className="stage"
          data-testid="stage"
          data-shown-frame={shownFrame}
          style={{ transform: `scale(${fit})`, transformOrigin: '0 0' }}
        />
      </div>
    </div>
  )
}
