import type { Map as MapLibreMap } from 'maplibre-gl'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { clampLat, layoutSize, type Project, type ProjectPatch, type SeaPaths, type Shot } from '../../core/index.js'
import { MapStage } from '../stage/MapStage.js'
import { RouteEditor, type PointTarget, type RouteEditorCallbacks } from './RouteEditor.js'

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
  /** The scene of `project` to show and edit. */
  sceneId: string
  /** The sea routes of the project's sea legs. */
  seaPaths: SeaPaths
  /** Frame to show. Must be within the project's timeline. */
  frame: number
  /** When true the camera stays where the user left it; frames update only the route and signs. */
  freeView: boolean
  handle: RefObject<StageHandle | null>
  /** The leg whose via points are shown and edited, if any. */
  selectedLeg: number | undefined
  /** The user panned, zoomed, rotated or tilted the map. */
  onUserMove(): void
  onSelectLeg(leg: number | undefined): void
  /**
   * Applies an edit made on the map and resolves to whether it was saved; if not, a dragged handle goes back. `seen`
   * is the project version the gesture began on.
   */
  onEdit(patch: ProjectPatch, label: string, seen?: string): Promise<boolean>
  onPointMenu(target: PointTarget, client: { x: number; y: number }, seen?: string): void
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

interface Callbacks extends RouteEditorCallbacks {
  onUserMove(): void
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

/** Owns the MapStage, its route editor and its frame driver, and rebuilds them when the pixel ratio changes a lot. */
class StageController {
  private stage: MapStage | undefined
  private driver: FrameDriver | undefined
  private editor: RouteEditor | undefined
  private ratio = 0
  private rebuildTimer: ReturnType<typeof setTimeout> | undefined
  private project: Project | undefined
  private sceneId: string | undefined
  private seaPaths: SeaPaths = {}
  private selectedLeg: number | undefined
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

  setProject(project: Project, sceneId: string, seaPaths: SeaPaths): void {
    this.project = project
    this.sceneId = sceneId
    this.seaPaths = seaPaths
    this.loadProject()
  }

  setSelectedLeg(leg: number | undefined): void {
    this.selectedLeg = leg
    this.editor?.setSelectedLeg(leg)
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
    const stage = new MapStage(this.container, { pixelRatio: ratio, interactive: true, tileBase, editing: true })
    if (view) stage.map.jumpTo(view)
    this.stage = stage
    this.ratio = ratio
    this.driver = new FrameDriver(stage, this.cb)
    this.editor = new RouteEditor(stage, this.cb)
    this.editor.setSelectedLeg(this.selectedLeg)
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
    this.editor?.destroy()
    this.editor = undefined
    this.stage?.destroy()
    this.stage = undefined
  }

  private loadProject(): void {
    const { stage, project, sceneId, seaPaths } = this
    if (!stage || !project || sceneId === undefined) return
    stage.load(project, sceneId, seaPaths).then(
      () => {
        if (this.stage === stage && this.project === project && this.sceneId === sceneId) this.editor?.sync(project, sceneId)
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
}

/**
 * The map at layout size, scaled with a CSS transform to fit the space it is given. Its pixel ratio matches the
 * screen at that scale, so the map stays sharp without laying out differently from a render.
 */
export function Stage(props: StageProps) {
  const { project, sceneId, seaPaths, frame, freeView, handle, selectedLeg } = props
  const areaRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<StageController | null>(null)
  const [area, setArea] = useState<{ width: number; height: number }>()
  const [shownFrame, setShownFrame] = useState<number>()
  // Callbacks change every render; the controller reads the latest through this ref.
  const callbacks = useRef(props)
  callbacks.current = props

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
      onSelectLeg: (leg) => callbacks.current.onSelectLeg(leg),
      onEdit: (patch, label, seen) => callbacks.current.onEdit(patch, label, seen),
      onPointMenu: (target, client, seen) => callbacks.current.onPointMenu(target, client, seen),
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
    controllerRef.current?.setProject(project, sceneId, seaPaths)
  }, [project, sceneId, seaPaths])

  useEffect(() => {
    controllerRef.current?.setSelectedLeg(selectedLeg)
  }, [selectedLeg])

  useEffect(() => {
    controllerRef.current?.show(frame, !freeView)
  }, [frame, freeView, project, sceneId])

  return (
    <div className="stage-area" ref={areaRef}>
      <div className="stage-frame" style={{ width: layout.width * fit, height: layout.height * fit }}>
        <div
          ref={containerRef}
          className="stage"
          data-testid="stage"
          data-shown-frame={shownFrame}
          data-selected-leg={selectedLeg}
          style={{ transform: `scale(${fit})`, transformOrigin: '0 0', '--stage-scale': fit } as CSSProperties}
        />
      </div>
    </div>
  )
}
