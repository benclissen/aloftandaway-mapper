import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  applyPatch,
  buildRoute,
  buildTimeline,
  fpsValue,
  invertPatch,
  newSceneId,
  type PatchResponse,
  type SeaPaths,
  type Project,
  type ProjectPatch,
  type Scene,
} from '../../core/index.js'
import { CLIENT_ID, getProject, patch, RequestError, sceneParam, setSceneParam, subscribe } from './api.js'
import { EditHistory, EditQueue, OutsideWrites, redoPatch, SCENE_OPS, scenesAround, type Entry } from './history.js'
import { LegsPanel } from './LegsPanel.js'
import { PointMenu } from './PointMenu.js'
import { isSharp, removeViaEdit, sharpEdit, type PointMenuTarget } from './RouteEditor.js'
import { SceneTabs, type SceneSummary } from './SceneTabs.js'
import { Scrubber, type Tick } from './Scrubber.js'
import { ShotPanel } from './ShotPanel.js'
import { StylePicker } from './StylePicker.js'
import { Stage, type StageHandle } from './Stage.js'
import './edit.css'

/** `keep` stops a later notice from replacing this one. */
type Notice = { kind: 'info' | 'error'; text: string; keep?: boolean }

const INFO_NOTICE_MS = 2500

const newer = (a: Project, b: Project) => Date.parse(a.updatedAt) > Date.parse(b.updatedAt)

/** The ops that find a leg or via point by its index, which an unseen write can make point at the wrong one. */
const INDEX_OPS = new Set(['update_leg', 'insert_via', 'update_via', 'remove_via'])

const HISTORY_CLEARED = 'Your agent changed the project. Undo history cleared.'
const ROUTE_CHANGED = 'The route changed while you were editing. Try again.'

/** A leg, known by the stops at its ends so that it stays the same leg when stops are added or removed elsewhere. */
type LegPair = { from: string; to: string }

/** The index of the leg from `pair.from` to `pair.to` in `scene`, or undefined when they are no longer next to each other. */
function legIndex(scene: Scene | undefined, pair: LegPair | undefined): number | undefined {
  if (!scene || !pair) return undefined
  const i = scene.stops.findIndex((s, i) => s.id === pair.from && scene.stops[i + 1]?.id === pair.to)
  return i < 0 ? undefined : i
}

const MODE_NAMES = { fixed: 'Fixed', glide: 'Glide', follow: 'Follow' } as const

/** Whether a key press belongs to a form field, where Cmd-Z means the field's own undo. */
function inField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)
}

/**
 * Edit mode: preview and scrub the project, drag stops and set the camera's shots. Every edit is a patch to the
 * server, which saves it to mapper.json where the agent sees it; edits from the agent arrive over the WebSocket.
 */
export function App() {
  const [project, setProject] = useState<Project>()
  /** The sea routes of `project`; always replaced together with it. */
  const [seaPaths, setSeaPaths] = useState<SeaPaths>({})
  const [loadError, setLoadError] = useState<string>()
  const [frame, setFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [freeView, setFreeView] = useState(false)
  const [notice, setNotice] = useState<Notice>()
  const [selectedLeg, setSelectedLeg] = useState<LegPair>()
  /** The open point menu, and the project version it was opened on. */
  const [pointMenu, setPointMenu] = useState<{ target: PointMenuTarget; at: { x: number; y: number }; seen?: string }>()
  /** The scene on screen. It is a scene of `project` whenever `project` is. */
  const [activeSceneId, setActiveSceneId] = useState<string>()
  /** `activeSceneId`, readable outside a render and set at once. */
  const activeRef = useRef<string | undefined>(undefined)
  /** Scenes this studio is removing, so that seeing one go isn't reported as the agent's doing. */
  const deleting = useRef(new Set<string>())
  const stage = useRef<StageHandle | null>(null)
  /** The project on screen, readable outside a render. */
  const current = useRef<Project | undefined>(undefined)
  const [history] = useState(() => new EditHistory())
  const [queue] = useState(() => new EditQueue(patch))
  const [outside] = useState(() => new OutsideWrites())
  // EditHistory isn't React state; this re-renders the undo and redo buttons when it changes.
  const [, historyChanged] = useReducer((n: number) => n + 1, 0)

  /** Shows scene `id`, from its first frame, with free view off and nothing selected. */
  const showScene = useCallback((id: string) => {
    activeRef.current = id
    setActiveSceneId(id)
    setFrame(0)
    setPlaying(false)
    setFreeView(false)
    setSelectedLeg(undefined)
    setPointMenu(undefined)
  }, [])

  /**
   * Keeps the newest project; an older or equal one (such as the echo of our own patch) is ignored. Returns whether
   * `incoming` was newer. When it has no scene on screen, shows the scene now at that position, or the last one.
   */
  const accept = useCallback(
    (incoming: Project, paths: SeaPaths): boolean => {
      const before = current.current
      if (before && !newer(incoming, before)) return false
      current.current = incoming
      const active = activeRef.current
      if (!incoming.scenes.some((s) => s.id === active)) {
        const at = before && active !== undefined ? before.scenes.findIndex((s) => s.id === active) : -1
        if (at < 0) {
          // The first project: the link's scene if it names one, else the first.
          const linked = sceneParam()
          showScene((incoming.scenes.find((s) => s.id === linked) ?? incoming.scenes[0]!).id)
        } else {
          const next = incoming.scenes[Math.min(at, incoming.scenes.length - 1)]!
          showScene(next.id)
          if (!deleting.current.has(active!)) {
            setNotice({ kind: 'info', text: `That scene was removed. Showing ${next.name || 'Untitled'}.`, keep: true })
          }
        }
      }
      // A removal is done with once its scene is gone.
      for (const id of deleting.current) if (!incoming.scenes.some((s) => s.id === id)) deleting.current.delete(id)
      setProject(incoming)
      setSeaPaths(paths)
      return true
    },
    [showScene],
  )

  /**
   * Counts outside changes. An edit or step in flight when one is seen must not touch the history when it settles: its
   * inverse was worked out against a project that is no longer the base.
   */
  const generation = useRef(0)

  /**
   * Forgets every step, since the project changed under them. Says so when there was anything to forget, or always
   * with `tell`.
   */
  const clearHistory = useCallback(
    (tell = false) => {
      generation.current++
      if (!tell && !history.canUndo && !history.canRedo) return
      history.clear()
      historyChanged()
      setNotice((n) => (n?.keep ? n : { kind: 'info', text: HISTORY_CLEARED }))
    },
    [history],
  )

  /**
   * Something outside the studio wrote version `updatedAt`, and the studio now shows it or a later one. Index edits
   * begun on an older view will be refused, the point menu (which holds an index) closes, and the history is cleared.
   */
  const outsideChange = useCallback(
    (updatedAt: string) => {
      outside.saw(updatedAt)
      setPointMenu(undefined)
      clearHistory()
    },
    [outside, clearHistory],
  )

  /**
   * Takes a saved response. When the server applied the patch to a version other than the one the studio sent it
   * against, something outside the studio wrote in between and the history no longer lines up, so it's cleared.
   * Returns whether the base matched.
   */
  const settle = useCallback(
    (response: PatchResponse, held: string): boolean => {
      accept(response.project, response.seaPaths)
      if (response.previousUpdatedAt === held) return true
      // Edits go out one at a time, so the version the patch was applied to was written from outside.
      outsideChange(response.previousUpdatedAt)
      return false
    },
    [accept, outsideChange],
  )

  useEffect(() => {
    getProject().then(({ project: loaded, seaPaths: paths }) => accept(loaded, paths), (e: Error) => setLoadError(e.message))
    try {
      // A newer version that this page didn't patch came from outside: the agent or the CLI.
      const onMessage = ({ project: incoming, seaPaths: paths, origin }: { project: Project; seaPaths: SeaPaths; origin?: string }) => {
        if (accept(incoming, paths)) {
          if (origin !== CLIENT_ID) outsideChange(incoming.updatedAt)
        } else if (origin !== CLIENT_ID) {
          // Already seen through a newer response; still, a view older than it is stale.
          outside.saw(incoming.updatedAt)
        }
      }
      return subscribe(onMessage, () =>
        setNotice({ kind: 'error', text: "Lost the connection to Mapper. Reload to see your agent's changes." }),
      )
    } catch (e) {
      setLoadError((e as Error).message)
      return undefined
    }
  }, [accept, outside, outsideChange])

  useEffect(() => {
    if (notice?.kind !== 'info') return
    const timer = setTimeout(() => setNotice(undefined), INFO_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (activeSceneId !== undefined) setSceneParam(activeSceneId)
  }, [activeSceneId])

  const scene = project?.scenes.find((s) => s.id === activeSceneId)
  // The selected leg follows its stops; once they are no longer next to each other, nothing is selected.
  const selected = legIndex(scene, selectedLeg)
  useEffect(() => {
    if (scene && selectedLeg && selected === undefined) setSelectedLeg(undefined)
  }, [scene, selectedLeg, selected])

  /** Selects leg `leg` of the scene on screen, by its stops. */
  const selectLeg = useCallback((leg: number | undefined) => {
    const stops = current.current?.scenes.find((s) => s.id === activeRef.current)?.stops
    const from = leg === undefined ? undefined : stops?.[leg]
    const to = leg === undefined ? undefined : stops?.[leg + 1]
    setSelectedLeg(from && to ? { from: from.id, to: to.id } : undefined)
  }, [])

  // Escape deselects. An open menu catches Escape first and closes instead.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape in a field (closing a picker, say) belongs to the field.
      if (e.key === 'Escape' && !inField(e.target)) setSelectedLeg(undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const route = useMemo(() => (scene ? buildRoute(scene, seaPaths) : undefined), [scene, seaPaths])
  const timeline = useMemo(
    () => (project && scene && route ? buildTimeline(scene, project.output.fps, route) : undefined),
    [project, scene, route],
  )
  const summaries = useMemo<SceneSummary[]>(
    () =>
      project
        ? project.scenes.map((s) => ({
            id: s.id,
            name: s.name,
            seconds: Math.round(buildTimeline(s, project.output.fps, buildRoute(s, seaPaths)).durationSeconds),
          }))
        : [],
    [project, seaPaths],
  )
  const last = timeline ? timeline.totalFrames - 1 : 0
  const shown = Math.min(frame, last)
  const shownRef = useRef(shown)
  shownRef.current = shown

  // Playback follows the wall clock at the project's frame rate and skips frames the stage can't keep up with.
  useEffect(() => {
    if (!playing || !timeline) return
    const rate = fpsValue(timeline.fps)
    const end = timeline.totalFrames - 1
    const from = shownRef.current >= end ? 0 : shownRef.current
    const t0 = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const f = Math.min(end, from + Math.max(0, Math.floor(((now - t0) / 1000) * rate)))
      setFrame(f)
      if (f >= end) setPlaying(false)
      else raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, timeline])

  const ticks = useMemo<Tick[]>(() => {
    if (!scene || !timeline) return []
    return timeline.arrivals.map((a) => ({ stopId: a.stopId, frame: a.frame, name: scene.stops[a.index]?.name ?? '' }))
  }, [scene, timeline])

  /**
   * Every studio edit comes through here. It queues `body` behind any edit still saving, works out how to undo it
   * against the project it is sent against, and resolves to whether it was saved. A failure shows the reason. `label`
   * names the edit for undo; `saved`, when given, is shown once it's saved.
   *
   * An edit that finds a leg or via point by index may have had that index moved under it by a write from outside, so
   * it is refused when such a write came after `seen`, the version the user's gesture began on (by default the one on
   * screen now), even if it is still waiting behind another edit. It is also sent only if the project is still the
   * version the studio holds, so a write the studio hasn't heard of yet refuses it too. Stop and scene edits name what
   * they change by id and are always applied.
   */
  const edit = useCallback(
    (input: ProjectPatch, label: string, opts: { saved?: string; seen?: string } = {}): Promise<boolean> => {
      const { saved, seen = current.current?.updatedAt } = opts
      // An edit to a scene's contents names the scene it was made on, even if the tab changes before it is sent.
      const editsStops = input.ops?.some((op) => !SCENE_OPS.has(op.op)) ?? false
      const touchesScene = input.sceneSet !== undefined || editsStops
      const body: ProjectPatch =
        touchesScene && input.scene === undefined && activeRef.current !== undefined ? { ...input, scene: activeRef.current } : input
      // Undo comes back to the scene the edit was made on: the one a stop, leg or via edit names, else the one on screen.
      const madeOn = editsStops && typeof body.scene === 'string' ? body.scene : activeRef.current!
      const conditional = body.ops?.some((op) => INDEX_OPS.has(op.op)) ?? false
      let held = ''
      let sentIn = 0
      let inverse: ProjectPatch | undefined
      let around: { sceneBefore: string; sceneAfter: string } | undefined
      let problem = ''
      let stale = false
      const make = (base: Project): ProjectPatch | undefined => {
        held = base.updatedAt
        sentIn = generation.current
        if (conditional && seen !== undefined && outside.since(seen)) {
          stale = true
          return undefined
        }
        try {
          // Applying it here first turns a patch that doesn't fit the project into a readable error.
          applyPatch(base, body)
          inverse = invertPatch(base, body)
          around = scenesAround(base, body, madeOn)
          return body
        } catch (e) {
          problem = (e as Error).message
          return undefined
        }
      }
      return queue.run(make, () => current.current!, { conditional }).then(
        (response) => {
          if (!response && stale) {
            setNotice({ kind: 'error', text: ROUTE_CHANGED })
            return false
          }
          if (!response || !inverse || !around) {
            setNotice({ kind: 'error', text: `Not saved. ${problem}` })
            return false
          }
          // An outside change seen while this was saving cleared the history; recording it now would undo onto that.
          if (settle(response, held) && generation.current === sentIn) {
            history.push({ label, forward: redoPatch(body, response.project), inverse, ...around })
            historyChanged()
            setNotice(saved ? { kind: 'info', text: saved } : undefined)
          }
          return true
        },
        (e: Error) => {
          // Only a conditional edit can be refused as stale, here by a write the studio hadn't heard of when it sent it.
          if (e instanceof RequestError && e.status === 409) setNotice({ kind: 'error', text: ROUTE_CHANGED })
          else setNotice({ kind: 'error', text: `Not saved. ${e.message}` })
          return false
        },
      )
    },
    [queue, history, outside, settle],
  )

  /**
   * Undoes or redoes the latest step, in turn with any edit still saving. The server applies it only if the project
   * is still the version the studio holds, so it never overwrites a write the studio hasn't seen yet; a refusal
   * clears the history. A step that fails to save is dropped. Once saved, it shows the scene the step belongs to: the
   * one the edit was made on after an undo, the one the edit showed after a redo.
   */
  const step = useCallback(
    (direction: 'undo' | 'redo') => {
      let entry: Entry | undefined
      let held = ''
      let sentIn = 0
      // Scenes the step removes, such as the one an undone add made; their going isn't the agent's doing.
      let removes: string[] = []
      const done = () => {
        for (const id of removes) deleting.current.delete(id)
      }
      const make = (base: Project): ProjectPatch | undefined => {
        entry = direction === 'undo' ? history.takeUndo() : history.takeRedo()
        historyChanged()
        held = base.updatedAt
        sentIn = generation.current
        const patch = entry && (direction === 'undo' ? entry.inverse : entry.forward)
        removes = patch?.ops?.flatMap((op) => (op.op === 'remove_scene' ? [op.id] : [])) ?? []
        for (const id of removes) deleting.current.add(id)
        return patch
      }
      void queue.run(make, () => current.current!, { conditional: true }).then(
        (response) => {
          if (!response || !entry) return done()
          const matched = settle(response, held)
          // After settling, which has taken in the project without the removed scenes.
          done()
          if (matched && generation.current === sentIn) setNotice(undefined)
          const show = direction === 'undo' ? entry.sceneBefore : entry.sceneAfter
          if (show !== activeRef.current && current.current?.scenes.some((s) => s.id === show)) showScene(show)
        },
        (e: Error) => {
          done()
          if (entry) history.discard(entry)
          historyChanged()
          if (e instanceof RequestError && e.status === 409) clearHistory(true)
          else setNotice({ kind: 'error', text: `Couldn't ${direction}. ${e.message}` })
        },
      )
    },
    [queue, history, settle, clearHistory, showScene],
  )

  // Cmd-Z undoes and Shift-Cmd-Z redoes, except in a form field, which keeps its own undo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'z' || !(e.metaKey || e.ctrlKey) || e.altKey || inField(e.target)) return
      e.preventDefault()
      step(e.shiftKey ? 'redo' : 'undo')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step])

  const sceneName = (id: string) => current.current?.scenes.find((s) => s.id === id)?.name || 'Untitled'

  const addScene = () => {
    const scenes = current.current?.scenes ?? []
    const at = scenes.findIndex((s) => s.id === activeRef.current)
    const id = newSceneId()
    void edit({ ops: [{ op: 'add_scene', index: at + 1, copyLookFrom: activeRef.current!, id }] }, 'Add a scene').then((saved) => {
      if (saved && current.current?.scenes.some((s) => s.id === id)) showScene(id)
    })
  }

  const renameScene = (id: string, name: string) =>
    void edit({ scene: id, sceneSet: { name } }, `Rename ${sceneName(id)} to ${name}`)

  const duplicateScene = (id: string) => {
    const newId = newSceneId()
    void edit({ ops: [{ op: 'duplicate_scene', id, newId }] }, `Duplicate ${sceneName(id)}`).then((saved) => {
      if (saved && current.current?.scenes.some((s) => s.id === newId)) showScene(newId)
    })
  }

  const moveScene = (id: string, direction: 'left' | 'right') => {
    const at = current.current?.scenes.findIndex((s) => s.id === id) ?? -1
    if (at < 0) return
    void edit({ ops: [{ op: 'move_scene', id, index: direction === 'left' ? at - 1 : at + 1 }] }, `Move ${sceneName(id)} ${direction}`)
  }

  const deleteScene = (id: string) => {
    deleting.current.add(id)
    void edit({ ops: [{ op: 'remove_scene', id }] }, `Delete ${sceneName(id)}`).then(() => deleting.current.delete(id))
  }

  const onEdit = useCallback((body: ProjectPatch, label: string, seen?: string) => edit(body, label, { seen }), [edit])
  const onPointMenu = useCallback(
    (target: PointMenuTarget, at: { x: number; y: number }, seen?: string) => setPointMenu({ target, at, seen }),
    [],
  )
  const closePointMenu = useCallback(() => setPointMenu(undefined), [])
  const onUserMove = useCallback(() => setFreeView(true), [])
  const onStageError = useCallback((message: string) => setNotice({ kind: 'error', text: message }), [])

  if (loadError) return <p className="studio-message">{loadError}</p>
  if (!project || !scene || !route || !timeline) return <p className="studio-message">Loading the project…</p>

  // The menu acts on the scene its point is in. During a tab switch that is the old scene, whose handles are still up.
  const menuScene = pointMenu && project.scenes.find((s) => s.id === pointMenu.target.scene)
  const menuSharp = pointMenu && menuScene && isSharp(menuScene, pointMenu.target.point)

  const saveShot = (which: 'start' | 'end') => {
    const shot = stage.current?.shot()
    if (!shot) return
    if (which === 'start') void edit({ sceneSet: { camera: { start: shot } } }, 'Set the start shot', { saved: 'Start shot saved' })
    else void edit({ sceneSet: { camera: { end: shot } } }, 'Set the end shot', { saved: 'End shot saved' })
  }

  return (
    <div className="studio">
      <SceneTabs
        scenes={summaries}
        activeId={scene.id}
        onSelect={(id) => id !== scene.id && showScene(id)}
        onAdd={addScene}
        onRename={renameScene}
        onDuplicate={duplicateScene}
        onMove={moveScene}
        onDelete={deleteScene}
      />
      <div className="workspace">
        <Stage
          project={project}
          sceneId={scene.id}
          seaPaths={seaPaths}
          frame={shown}
          freeView={freeView}
          handle={stage}
          selectedLeg={selected}
          onUserMove={onUserMove}
          onSelectLeg={selectLeg}
          onEdit={onEdit}
          onPointMenu={onPointMenu}
          onError={onStageError}
        />
        <LegsPanel scene={scene} route={route} selectedLeg={selected} onSelectLeg={selectLeg} onEdit={onEdit} />
      </div>
      {pointMenu && menuScene && menuSharp !== undefined && (
        <PointMenu
          target={pointMenu.target.point}
          at={pointMenu.at}
          sharp={menuSharp}
          onToggleSharp={() => {
            const edit = sharpEdit(menuScene, pointMenu.target.point)
            if (edit) void onEdit(edit.patch, edit.label, pointMenu.seen)
          }}
          onRemove={() => {
            const { point } = pointMenu.target
            if (point.kind !== 'via') return
            const edit = removeViaEdit(menuScene.id, point.leg, point.index)
            void onEdit(edit.patch, edit.label, pointMenu.seen)
          }}
          onClose={closePointMenu}
        />
      )}
      <div className="controls">
        <Scrubber
          frame={shown}
          totalFrames={timeline.totalFrames}
          fps={timeline.fps}
          ticks={ticks}
          playing={playing}
          onScrub={(f) => {
            setPlaying(false)
            setFreeView(false)
            setFrame(f)
          }}
          onTogglePlay={() => {
            if (!playing) setFreeView(false)
            setPlaying(!playing)
          }}
        />
        <div className="controls-row">
          <div className="history-buttons" role="group" aria-label="History">
            <button
              type="button"
              data-testid="undo"
              disabled={!history.canUndo}
              title={history.undoLabel ? `Undo ${history.undoLabel} (⌘Z)` : 'Nothing to undo (⌘Z)'}
              onClick={() => step('undo')}
            >
              Undo
            </button>
            <button
              type="button"
              data-testid="redo"
              disabled={!history.canRedo}
              title={history.redoLabel ? `Redo ${history.redoLabel} (⇧⌘Z)` : 'Nothing to redo (⇧⌘Z)'}
              onClick={() => step('redo')}
            >
              Redo
            </button>
          </div>
          <ShotPanel
            mode={scene.camera.mode}
            freeView={freeView}
            onMode={(mode) => {
              setFreeView(false)
              void edit({ sceneSet: { camera: { mode } } }, `Camera mode: ${MODE_NAMES[mode]}`)
            }}
            onUseStart={() => saveShot('start')}
            onUseEnd={() => saveShot('end')}
            onFit={() => {
              setFreeView(false)
              void edit({ sceneSet: { camera: { start: null, end: null } } }, 'Fit to route', { saved: 'Camera fits the route' })
            }}
          />
          <StylePicker theme={scene.look.theme} terrain={scene.look.terrain} onEdit={onEdit} />
          {notice && (
            <p className={`notice notice-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
              <span title={notice.text}>{notice.text}</span>
              {notice.kind === 'error' && (
                <button type="button" className="dismiss" aria-label="Dismiss" onClick={() => setNotice(undefined)}>
                  ×
                </button>
              )}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
