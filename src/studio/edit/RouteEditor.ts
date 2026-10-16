import { Marker, type Map as MapLibreMap, type MapMouseEvent } from 'maplibre-gl'
import {
  clampLat,
  nearestOnLeg,
  unwrapLng,
  type LngLat,
  type Project,
  type ProjectPatch,
  type Route,
  type Scene,
} from '../../core/index.js'
import { EDIT_ROUTE_LAYER, type MapStage } from '../stage/MapStage.js'

/** A point on the route the user can act on: a stop, or a via point of a leg. */
export type PointTarget = { kind: 'stop'; id: string } | { kind: 'via'; leg: number; index: number }

/** A point whose menu was asked for, in the scene whose handles were on screen when it was. */
export interface PointMenuTarget {
  /** The id of the scene the point is in. During a tab switch it is not the active scene until the new one loads. */
  scene: string
  point: PointTarget
}

export interface RouteEditorCallbacks {
  onSelectLeg(leg: number | undefined): void
  /**
   * Applies an edit. Resolves to whether it was saved. `label` names the edit for undo. `seen` is the `updatedAt` of
   * the project on screen when the gesture began, which an edit that finds a point by index is checked against.
   */
  onEdit(patch: ProjectPatch, label: string, seen?: string): Promise<boolean>
  /** The user asked for a point's menu at this position in the window, on the project version `seen`. */
  onPointMenu(target: PointMenuTarget, client: { x: number; y: number }, seen?: string): void
}

export interface Edit {
  patch: ProjectPatch
  label: string
}

/** Half the click hit box, in screen px. */
const HIT_PX = 8

const round5 = (value: number) => Math.round(value * 1e5) / 1e5

/** A coordinate as the studio saves it: longitude wrapped to ±180, both rounded to 5 places, latitude clamped. */
export function savedAt([lng, lat]: LngLat): LngLat {
  const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180
  return [round5(wrapped), clampLat(round5(lat))]
}

/** Whether the point is sharp, or undefined if the scene has no such point. */
export function isSharp(scene: Scene, target: PointTarget): boolean | undefined {
  if (target.kind === 'stop') {
    const stop = scene.stops.find((s) => s.id === target.id)
    return stop && stop.sharp === true
  }
  const via = scene.legs[target.leg]?.via[target.index]
  return via && via.sharp === true
}

/**
 * The edit that switches the point between a sharp corner and a curve, or undefined if it no longer exists. The patch
 * names `scene`, so it goes to that scene whichever tab is active.
 */
export function sharpEdit(scene: Scene, target: PointTarget): Edit | undefined {
  const sharp = isSharp(scene, target)
  if (sharp === undefined) return undefined
  // `null` removes the key, which is the same as curving through.
  const value = sharp ? null : true
  if (target.kind === 'stop') {
    const name = scene.stops.find((s) => s.id === target.id)!.name
    return {
      patch: { scene: scene.id, ops: [{ op: 'update_stop', id: target.id, changes: { sharp: value } }] },
      label: sharp ? `Curve through ${name}` : `Make ${name} sharp`,
    }
  }
  return {
    patch: { scene: scene.id, ops: [{ op: 'update_via', leg: target.leg, index: target.index, changes: { sharp: value } }] },
    label: sharp ? 'Curve through a via point' : 'Make a via point sharp',
  }
}

/** The edit that removes via `index` of leg `leg` in the scene with id `sceneId`. */
export function removeViaEdit(sceneId: string, leg: number, index: number): Edit {
  return { patch: { scene: sceneId, ops: [{ op: 'remove_via', leg, index }] }, label: 'Remove a via point' }
}

/**
 * The studio's editing on the map: stop handles, via handles for the selected leg, and clicks on the route. Reads
 * the route from the stage, so it always edits what is on screen. Owns no state the app needs: selection comes in
 * through `setSelectedLeg` and every change goes out through the callbacks.
 */
export class RouteEditor {
  private readonly map: MapLibreMap
  private project: Project | undefined
  /** The scene whose handles are on screen. */
  private sceneId: string | undefined
  /** The scene the stage is loading, or has loaded. Until it is `sceneId`, the old scene's handles aren't rebuilt. */
  private loadingId: string | undefined
  private selectedLeg: number | undefined
  private stopMarkers = new Map<string, Marker>()
  /** Handles for the via points of `viaLeg`, in order. */
  private viaMarkers: Marker[] = []
  private viaLeg: number | undefined
  /** Handles being dragged; incoming projects don't move them. */
  private dragging = new Set<Marker>()
  /** A drag ends with a click on the handle; that click is not an Alt-click. */
  private justDragged = new Set<Marker>()
  /** The project version each handle being dragged was picked up on. */
  private dragSeen = new Map<Marker, string | undefined>()

  constructor(
    private readonly stage: MapStage,
    private readonly cb: RouteEditorCallbacks,
  ) {
    this.map = stage.map
    this.map.on('click', this.onMapClick)
  }

  /**
   * The stage has started loading scene `sceneId`. While it loads another scene than the one on screen, the old
   * scene's via handles go and none are built, since a selected leg is the new scene's, and map clicks are ignored.
   * Its stop handles stay, and edit the old scene, until `sync` shows the new one.
   */
  loading(sceneId: string): void {
    this.loadingId = sceneId
    this.syncVias()
  }

  /** Shows the handles for scene `sceneId` of `project`, which the stage has just loaded. */
  sync(project: Project, sceneId: string): void {
    this.project = project
    this.sceneId = sceneId
    this.loadingId = sceneId
    this.syncStops()
    this.syncVias()
  }

  /** Whether the stage is loading a scene other than the one whose handles are on screen. */
  private get switching(): boolean {
    return this.loadingId !== this.sceneId
  }

  setSelectedLeg(leg: number | undefined): void {
    this.selectedLeg = leg
    this.stage.setSelectedLeg(leg)
    this.syncVias()
  }

  destroy(): void {
    this.map.off('click', this.onMapClick)
    for (const marker of [...this.stopMarkers.values(), ...this.viaMarkers]) marker.remove()
    this.stopMarkers.clear()
    this.viaMarkers = []
    this.dragging.clear()
    this.dragSeen.clear()
  }

  private get scene(): Scene | undefined {
    return this.project?.scenes.find((s) => s.id === this.sceneId)
  }

  /**
   * Sends an edit to the scene whose handles are on screen, which during a tab switch is still the old one until the
   * new scene has loaded. `seen` is the project version the gesture began on: by default the one on screen now.
   */
  private edit(patch: ProjectPatch, label: string, seen = this.project?.updatedAt): Promise<boolean> {
    return this.cb.onEdit(this.sceneId === undefined ? patch : { ...patch, scene: this.sceneId }, label, seen)
  }

  /** Ends a drag of `marker`, returning the project version it was picked up on. */
  private endDrag(marker: Marker): string | undefined {
    const seen = this.dragSeen.get(marker)
    this.dragging.delete(marker)
    this.dragSeen.delete(marker)
    return seen
  }

  private readonly onMapClick = (e: MapMouseEvent): void => {
    // Handles stop their own clicks; this is a second guard.
    if (e.originalEvent.target instanceof Element && e.originalEvent.target.closest('.edit-handle')) return
    // The route on the map is the old scene's, and the legs panel already shows the new one.
    if (this.switching) return
    const route = this.stage.route
    if (!route || !this.map.getLayer(EDIT_ROUTE_LAYER)) return
    const { x, y } = e.point
    // The stage is scaled down to fit the window; the hit box is HIT_PX on screen, so wider in layout px.
    const container = this.map.getContainer()
    const scale = container.offsetWidth > 0 ? container.getBoundingClientRect().width / container.offsetWidth : 1
    const reach = HIT_PX / Math.max(scale, 0.05)
    const hits = this.map.queryRenderedFeatures(
      [
        [x - reach, y - reach],
        [x + reach, y + reach],
      ],
      { layers: [EDIT_ROUTE_LAYER] },
    )
    const legs = hits.map((f) => f.properties.leg as number).filter((leg) => route.legs[leg] !== undefined)
    if (legs.length === 0) return
    const selected = this.selectedLeg
    if (selected === undefined || !legs.includes(selected)) {
      this.cb.onSelectLeg(legs[0])
      return
    }
    const { at, insertIndex } = nearestOnLeg(route, selected, [e.lngLat.lng, e.lngLat.lat])
    void this.edit({ ops: [{ op: 'insert_via', leg: selected, index: insertIndex, point: { at: savedAt(at) } }] }, 'Add a via point')
  }

  private syncStops(): void {
    const scene = this.scene
    if (!scene) return
    const ids = new Set(scene.stops.map((s) => s.id))
    for (const [id, marker] of this.stopMarkers) {
      if (ids.has(id)) continue
      marker.remove()
      this.stopMarkers.delete(id)
    }
    for (const stop of scene.stops) {
      let marker = this.stopMarkers.get(stop.id)
      if (!marker) {
        marker = this.createStopMarker(stop.id)
        marker.setLngLat(stop.at).addTo(this.map)
        this.stopMarkers.set(stop.id, marker)
      } else if (!this.dragging.has(marker)) {
        marker.setLngLat(stop.at)
      }
      const element = marker.getElement()
      element.title = stop.name
      element.setAttribute('aria-label', stop.name)
      element.classList.toggle('sharp', stop.sharp === true)
    }
  }

  /** Where via `index` of `leg` sits on the drawn route, in the world copy nearest the view. */
  private viaPosition(route: Route, leg: number, index: number): LngLat | undefined {
    const routeLeg = route.legs[leg]
    const knot = routeLeg?.knots[index + 1]
    const at = knot === undefined ? undefined : routeLeg!.path[knot]
    if (!at) return undefined
    return [unwrapLng(this.map.getCenter().lng, at[0]), at[1]]
  }

  private syncVias(): void {
    const scene = this.scene
    const route = this.stage.route
    const leg = this.selectedLeg
    const via = leg === undefined ? [] : (scene?.legs[leg]?.via ?? [])
    // The route must be the one for this scene; a leg whose knots don't match is mid-reload. A selected leg belongs to
    // the scene being loaded, so the old scene shows no via handles for it.
    const ready =
      !this.switching && route !== undefined && leg !== undefined && route.legs[leg]?.knots.length === via.length + 2
    if (leg !== this.viaLeg || !ready) {
      for (const marker of this.viaMarkers) marker.remove()
      this.viaMarkers = []
      this.viaLeg = leg
    }
    if (!ready) return
    while (this.viaMarkers.length > via.length) this.viaMarkers.pop()!.remove()
    for (let i = 0; i < via.length; i++) {
      let marker = this.viaMarkers[i]
      if (!marker) {
        marker = this.createViaMarker()
        marker.setLngLat(this.viaPosition(route, leg, i)!).addTo(this.map)
        this.viaMarkers.push(marker)
      } else if (!this.dragging.has(marker)) {
        marker.setLngLat(this.viaPosition(route, leg, i)!)
      }
      const element = marker.getElement()
      element.dataset.testid = `via-marker-${leg}-${i}`
      element.setAttribute('aria-label', `Via point ${i + 1} of leg ${leg + 1}`)
      element.title = `Via point ${i + 1}`
      element.classList.toggle('sharp', via[i]!.sharp === true)
    }
  }

  /** A draggable handle whose clicks and right-clicks stay off the map. */
  private createHandle(className: string, target: () => PointTarget | undefined): Marker {
    const element = document.createElement('div')
    element.className = `edit-handle ${className}`
    // Subpixel positioning keeps the handle exactly over its point, so a drag starts and ends where it looks.
    const marker = new Marker({ element, draggable: true, anchor: 'center', subpixelPositioning: true })
    element.addEventListener('mousedown', (e) => {
      // Only the left button drags; others must not start a map rotate.
      if (e.button !== 0) e.stopPropagation()
    })
    element.addEventListener('click', (e) => {
      e.stopPropagation()
      if (this.justDragged.delete(marker) || !e.altKey) return
      const t = target()
      const edit = t && this.scene && sharpEdit(this.scene, t)
      if (edit) void this.edit(edit.patch, edit.label)
    })
    element.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const point = target()
      if (point && this.sceneId !== undefined) {
        this.cb.onPointMenu({ scene: this.sceneId, point }, { x: e.clientX, y: e.clientY }, this.project?.updatedAt)
      }
    })
    marker.on('dragstart', () => {
      this.dragging.add(marker)
      this.dragSeen.set(marker, this.project?.updatedAt)
      this.justDragged.add(marker)
    })
    // The click that ends a drag comes straight after the mouseup; anything later is a new click.
    marker.on('dragend', () => setTimeout(() => this.justDragged.delete(marker), 0))
    return marker
  }

  private createStopMarker(id: string): Marker {
    const marker = this.createHandle('stop-handle', () => ({ kind: 'stop', id }))
    marker.getElement().dataset.testid = `stop-marker-${id}`
    marker.on('dragend', () => {
      const seen = this.endDrag(marker)
      const name = this.scene?.stops.find((s) => s.id === id)?.name ?? id
      const { lng, lat } = marker.getLngLat()
      const patch: ProjectPatch = { ops: [{ op: 'update_stop', id, changes: { at: savedAt([lng, lat]) } }] }
      void this.edit(patch, `Move ${name}`, seen).then((saved) => {
        // Nothing was saved, so no new project will move the marker: put it back over the stop.
        const stop = this.scene?.stops.find((s) => s.id === id)
        if (!saved && stop && this.stopMarkers.get(id) === marker && !this.dragging.has(marker)) marker.setLngLat(stop.at)
      })
    })
    return marker
  }

  private createViaMarker(): Marker {
    const where = (): { leg: number; index: number } | undefined => {
      const index = this.viaMarkers.indexOf(marker)
      return index < 0 || this.viaLeg === undefined ? undefined : { leg: this.viaLeg, index }
    }
    const marker = this.createHandle('via-handle', () => {
      const w = where()
      return w && { kind: 'via', ...w }
    })
    const element = marker.getElement()
    element.tabIndex = 0
    element.setAttribute('role', 'button')
    element.addEventListener('keydown', (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      e.preventDefault()
      e.stopPropagation()
      const w = where()
      if (!w || this.sceneId === undefined) return
      const edit = removeViaEdit(this.sceneId, w.leg, w.index)
      void this.edit(edit.patch, edit.label)
    })
    marker.on('dragend', () => {
      // An agent write during the drag can make this handle's index point at another via point; `seen` catches that.
      const seen = this.endDrag(marker)
      const w = where()
      if (!w) return
      const { lng, lat } = marker.getLngLat()
      const patch: ProjectPatch = { ops: [{ op: 'update_via', leg: w.leg, index: w.index, changes: { at: savedAt([lng, lat]) } }] }
      void this.edit(patch, 'Move a via point', seen).then((saved) => {
        const route = this.stage.route
        const at = route && this.viaMarkers[w.index] === marker && this.viaLeg === w.leg && this.viaPosition(route, w.leg, w.index)
        if (!saved && at && !this.dragging.has(marker)) marker.setLngLat(at)
      })
    })
    return marker
  }
}
