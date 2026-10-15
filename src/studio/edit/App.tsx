import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  applyPatch,
  buildRoute,
  buildTimeline,
  fpsValue,
  invertPatch,
  type PatchResponse,
  type Project,
  type ProjectPatch,
} from '../../core/index.js'
import { CLIENT_ID, getProject, patch, RequestError, subscribe } from './api.js'
import { EditHistory, EditQueue, type Entry } from './history.js'
import { LegsPanel } from './LegsPanel.js'
import { PointMenu } from './PointMenu.js'
import { isSharp, removeViaEdit, sharpEdit, type PointTarget } from './RouteEditor.js'
import { Scrubber, type Tick } from './Scrubber.js'
import { ShotPanel } from './ShotPanel.js'
import { StylePicker } from './StylePicker.js'
import { Stage, type StageHandle } from './Stage.js'
import './edit.css'

type Notice = { kind: 'info' | 'error'; text: string }

const INFO_NOTICE_MS = 2500

const newer = (a: Project, b: Project) => Date.parse(a.updatedAt) > Date.parse(b.updatedAt)

const HISTORY_CLEARED = 'Your agent changed the project. Undo history cleared.'

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
  const [loadError, setLoadError] = useState<string>()
  const [frame, setFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [freeView, setFreeView] = useState(false)
  const [notice, setNotice] = useState<Notice>()
  const [selectedLeg, setSelectedLeg] = useState<number>()
  const [pointMenu, setPointMenu] = useState<{ target: PointTarget; at: { x: number; y: number } }>()
  const stage = useRef<StageHandle | null>(null)
  /** The project on screen, readable outside a render. */
  const current = useRef<Project | undefined>(undefined)
  const [history] = useState(() => new EditHistory())
  const [queue] = useState(() => new EditQueue(patch))
  // EditHistory isn't React state; this re-renders the undo and redo buttons when it changes.
  const [, historyChanged] = useReducer((n: number) => n + 1, 0)

  /**
   * Keeps the newest project; an older or equal one (such as the echo of our own patch) is ignored. Returns whether
   * `incoming` was newer.
   */
  const accept = useCallback((incoming: Project): boolean => {
    if (current.current && !newer(incoming, current.current)) return false
    current.current = incoming
    setProject(incoming)
    return true
  }, [])

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
      setNotice({ kind: 'info', text: HISTORY_CLEARED })
    },
    [history],
  )

  /**
   * Takes a saved response. When the server applied the patch to a version other than the one the studio sent it
   * against, something outside the studio wrote in between and the history no longer lines up, so it's cleared.
   * Returns whether the base matched.
   */
  const settle = useCallback(
    (response: PatchResponse, held: string): boolean => {
      accept(response.project)
      if (response.previousUpdatedAt === held) return true
      clearHistory()
      return false
    },
    [accept, clearHistory],
  )

  useEffect(() => {
    getProject().then(accept, (e: Error) => setLoadError(e.message))
    try {
      // A newer version that this page didn't patch came from outside: the agent or the CLI.
      const onMessage = ({ project: incoming, origin }: { project: Project; origin?: string }) => {
        if (accept(incoming) && origin !== CLIENT_ID) clearHistory()
      }
      return subscribe(onMessage, () =>
        setNotice({ kind: 'error', text: "Lost the connection to Mapper. Reload to see your agent's changes." }),
      )
    } catch (e) {
      setLoadError((e as Error).message)
      return undefined
    }
  }, [accept, clearHistory])

  useEffect(() => {
    if (notice?.kind !== 'info') return
    const timer = setTimeout(() => setNotice(undefined), INFO_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const scene = project?.scenes[0]
  // A leg that no longer exists can't stay selected.
  const legCount = scene?.legs.length ?? 0
  const selected = selectedLeg !== undefined && selectedLeg < legCount ? selectedLeg : undefined
  useEffect(() => {
    if (scene && selectedLeg !== undefined && selectedLeg >= legCount) setSelectedLeg(undefined)
  }, [scene, selectedLeg, legCount])

  // Escape deselects. An open menu catches Escape first and closes instead.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape in a field (closing a picker, say) belongs to the field.
      if (e.key === 'Escape' && !inField(e.target)) setSelectedLeg(undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const route = useMemo(() => (scene ? buildRoute(scene) : undefined), [scene])
  const timeline = useMemo(
    () => (project && scene && route ? buildTimeline(scene, project.output.fps, route) : undefined),
    [project, scene, route],
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
   */
  const edit = useCallback(
    (body: ProjectPatch, label: string, saved?: string): Promise<boolean> => {
      let held = ''
      let sentIn = 0
      let inverse: ProjectPatch | undefined
      let problem = ''
      const make = (base: Project): ProjectPatch | undefined => {
        held = base.updatedAt
        sentIn = generation.current
        try {
          // Applying it here first turns a patch that doesn't fit the project into a readable error.
          applyPatch(base, body)
          inverse = invertPatch(base, body)
          return body
        } catch (e) {
          problem = (e as Error).message
          return undefined
        }
      }
      return queue.run(make, () => current.current!).then(
        (response) => {
          if (!response || !inverse) {
            setNotice({ kind: 'error', text: `Not saved. ${problem}` })
            return false
          }
          // An outside change seen while this was saving cleared the history; recording it now would undo onto that.
          if (settle(response, held) && generation.current === sentIn) {
            history.push({ label, forward: body, inverse })
            historyChanged()
            setNotice(saved ? { kind: 'info', text: saved } : undefined)
          }
          return true
        },
        (e: Error) => {
          setNotice({ kind: 'error', text: `Not saved. ${e.message}` })
          return false
        },
      )
    },
    [queue, history, settle],
  )

  /**
   * Undoes or redoes the latest step, in turn with any edit still saving. The server applies it only if the project
   * is still the version the studio holds, so it never overwrites a write the studio hasn't seen yet; a refusal
   * clears the history. A step that fails to save is dropped.
   */
  const step = useCallback(
    (direction: 'undo' | 'redo') => {
      let entry: Entry | undefined
      let held = ''
      let sentIn = 0
      const make = (base: Project): ProjectPatch | undefined => {
        entry = direction === 'undo' ? history.takeUndo() : history.takeRedo()
        historyChanged()
        held = base.updatedAt
        sentIn = generation.current
        return entry && (direction === 'undo' ? entry.inverse : entry.forward)
      }
      void queue.run(make, () => current.current!, { conditional: true }).then(
        (response) => {
          if (response && settle(response, held) && generation.current === sentIn) setNotice(undefined)
        },
        (e: Error) => {
          if (entry) history.discard(entry)
          historyChanged()
          if (e instanceof RequestError && e.status === 409) clearHistory(true)
          else setNotice({ kind: 'error', text: `Couldn't ${direction}. ${e.message}` })
        },
      )
    },
    [queue, history, settle, clearHistory],
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

  const onEdit = useCallback((body: ProjectPatch, label: string) => edit(body, label), [edit])
  const onPointMenu = useCallback((target: PointTarget, at: { x: number; y: number }) => setPointMenu({ target, at }), [])
  const closePointMenu = useCallback(() => setPointMenu(undefined), [])
  const onUserMove = useCallback(() => setFreeView(true), [])
  const onStageError = useCallback((message: string) => setNotice({ kind: 'error', text: message }), [])

  if (loadError) return <p className="studio-message">{loadError}</p>
  if (!project || !scene || !route || !timeline) return <p className="studio-message">Loading the project…</p>

  const saveShot = (which: 'start' | 'end') => {
    const shot = stage.current?.shot()
    if (!shot) return
    if (which === 'start') void edit({ sceneSet: { camera: { start: shot } } }, 'Set the start shot', 'Start shot saved')
    else void edit({ sceneSet: { camera: { end: shot } } }, 'Set the end shot', 'End shot saved')
  }

  return (
    <div className="studio">
      <div className="workspace">
        <Stage
          project={project}
          frame={shown}
          freeView={freeView}
          handle={stage}
          selectedLeg={selected}
          onUserMove={onUserMove}
          onSelectLeg={setSelectedLeg}
          onEdit={onEdit}
          onPointMenu={onPointMenu}
          onError={onStageError}
        />
        <LegsPanel scene={scene} route={route} selectedLeg={selected} onSelectLeg={setSelectedLeg} onEdit={onEdit} />
      </div>
      {pointMenu && isSharp(scene, pointMenu.target) !== undefined && (
        <PointMenu
          target={pointMenu.target}
          at={pointMenu.at}
          sharp={isSharp(scene, pointMenu.target)!}
          onToggleSharp={() => {
            const edit = sharpEdit(scene, pointMenu.target)
            if (edit) void onEdit(edit.patch, edit.label)
          }}
          onRemove={() => {
            const { target } = pointMenu
            if (target.kind !== 'via') return
            const edit = removeViaEdit(target.leg, target.index)
            void onEdit(edit.patch, edit.label)
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
              void edit({ sceneSet: { camera: { start: null, end: null } } }, 'Fit to route', 'Camera fits the route')
            }}
          />
          <StylePicker theme={scene.look.theme} onEdit={onEdit} />
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
