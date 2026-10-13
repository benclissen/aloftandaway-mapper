import type { CSSProperties } from 'react'
import { formatTimecode, type Fps } from '../../core/index.js'

export interface Tick {
  stopId: string
  name: string
  frame: number
}

interface ScrubberProps {
  frame: number
  totalFrames: number
  fps: Fps
  /** One per arrival, in time order. */
  ticks: Tick[]
  playing: boolean
  onScrub(frame: number): void
  onTogglePlay(): void
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M4.5 2.8v10.4a.6.6 0 0 0 .9.5l8.2-5.2a.6.6 0 0 0 0-1L5.4 2.3a.6.6 0 0 0-.9.5Z" fill="currentColor" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <rect x="3.5" y="2.5" width="3" height="11" rx="0.8" fill="currentColor" />
      <rect x="9.5" y="2.5" width="3" height="11" rx="0.8" fill="currentColor" />
    </svg>
  )
}

/** Play/pause, a frame slider with a tick at each arrival, and the timecode. */
export function Scrubber({ frame, totalFrames, fps, ticks, playing, onScrub, onTogglePlay }: ScrubberProps) {
  const last = Math.max(0, totalFrames - 1)
  // Ticks line up with the slider thumb's centre, which travels the track less one thumb width.
  const at = (f: number): CSSProperties => ({ '--at': last > 0 ? f / last : 0 }) as CSSProperties

  return (
    <div className="scrubber">
      <button
        type="button"
        className="play"
        data-testid="play"
        aria-label={playing ? 'Pause' : 'Play'}
        title={playing ? 'Pause' : 'Play'}
        onClick={onTogglePlay}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <div className="track">
        <input
          type="range"
          data-testid="scrubber"
          aria-label="Position"
          aria-valuetext={formatTimecode(frame, fps)}
          min={0}
          max={last}
          step={1}
          value={frame}
          onChange={(e) => onScrub(Number(e.currentTarget.value))}
        />
        <div className="ticks" data-testid="scrubber-ticks">
          {ticks.map((tick) => (
            <button
              key={tick.stopId}
              type="button"
              className="tick"
              style={at(tick.frame)}
              title={tick.name}
              aria-label={`Go to ${tick.name}`}
              tabIndex={-1}
              onClick={() => onScrub(tick.frame)}
            />
          ))}
        </div>
      </div>
      <div className="time">
        <output data-testid="timecode">{formatTimecode(frame, fps)}</output>
        <span className="duration">{formatTimecode(totalFrames, fps)}</span>
      </div>
    </div>
  )
}
