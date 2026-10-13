import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildRoute, buildTimeline, fpsValue, type LngLat, type Project, type ProjectPatch } from '../../core/index.js'
import { getProject, patch, subscribe } from './api.js'
import { Scrubber, type Tick } from './Scrubber.js'
import { ShotPanel } from './ShotPanel.js'
import { Stage, type StageHandle } from './Stage.js'
import './edit.css'

type Notice = { kind: 'info' | 'error'; text: string }

const INFO_NOTICE_MS = 2500

const newer = (a: Project, b: Project) => Date.parse(a.updatedAt) > Date.parse(b.updatedAt)

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
  const stage = useRef<StageHandle | null>(null)

  /** Keeps the newest project; an older or equal one (such as the echo of our own patch) is ignored. */
  const accept = useCallback((incoming: Project) => {
    setProject((current) => (!current || newer(incoming, current) ? incoming : current))
  }, [])

  useEffect(() => {
    getProject().then(accept, (e: Error) => setLoadError(e.message))
    try {
      return subscribe(accept, () =>
        setNotice({ kind: 'error', text: "Lost the connection to Mapper. Reload to see your agent's changes." }),
      )
    } catch (e) {
      setLoadError((e as Error).message)
      return undefined
    }
  }, [accept])

  useEffect(() => {
    if (notice?.kind !== 'info') return
    const timer = setTimeout(() => setNotice(undefined), INFO_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const timeline = useMemo(() => (project ? buildTimeline(project, buildRoute(project)) : undefined), [project])
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
    if (!project || !timeline) return []
    return timeline.arrivals.map((a) => ({ stopId: a.stopId, frame: a.frame, name: project.stops[a.index]?.name ?? '' }))
  }, [project, timeline])

  const send = useCallback(
    async (body: ProjectPatch, saved?: string) => {
      try {
        accept(await patch(body))
        setNotice(saved ? { kind: 'info', text: saved } : undefined)
      } catch (e) {
        setNotice({ kind: 'error', text: `Not saved. ${(e as Error).message}` })
      }
    },
    [accept],
  )

  const onStopMoved = useCallback(
    (id: string, at: LngLat) => void send({ ops: [{ op: 'update_stop', id, changes: { at } }] }),
    [send],
  )
  const onUserMove = useCallback(() => setFreeView(true), [])
  const onStageError = useCallback((message: string) => setNotice({ kind: 'error', text: message }), [])

  if (loadError) return <p className="studio-message">{loadError}</p>
  if (!project || !timeline) return <p className="studio-message">Loading the project…</p>

  const saveShot = (which: 'start' | 'end') => {
    const shot = stage.current?.shot()
    if (shot) void send({ set: { camera: { [which]: shot } } }, which === 'start' ? 'Start shot saved' : 'End shot saved')
  }

  return (
    <div className="studio">
      <Stage
        project={project}
        frame={shown}
        freeView={freeView}
        handle={stage}
        onUserMove={onUserMove}
        onStopMoved={onStopMoved}
        onError={onStageError}
      />
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
          <ShotPanel
            mode={project.camera.mode}
            freeView={freeView}
            onMode={(mode) => {
              setFreeView(false)
              void send({ set: { camera: { mode } } })
            }}
            onUseStart={() => saveShot('start')}
            onUseEnd={() => saveShot('end')}
            onFit={() => {
              setFreeView(false)
              void send({ set: { camera: { start: null, end: null } } }, 'Camera fits the route')
            }}
          />
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
