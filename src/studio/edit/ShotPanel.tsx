import type { Camera } from '../../core/index.js'

type Mode = Camera['mode']

interface ShotPanelProps {
  mode: Mode
  freeView: boolean
  onMode(mode: Mode): void
  onUseStart(): void
  onUseEnd(): void
  onFit(): void
}

const MODES: { mode: Mode; label: string; hint: string }[] = [
  { mode: 'fixed', label: 'Fixed', hint: 'The camera holds the start shot' },
  { mode: 'glide', label: 'Glide', hint: 'The camera moves from the start shot to the end shot' },
]

/** The camera controls: fixed or glide, and the start and end shots. */
export function ShotPanel({ mode, freeView, onMode, onUseStart, onUseEnd, onFit }: ShotPanelProps) {
  return (
    <div className="shot-panel">
      <div className="segmented" role="group" aria-label="Camera" data-testid="camera-mode">
        {MODES.map((m) => (
          <button
            key={m.mode}
            type="button"
            aria-pressed={mode === m.mode}
            title={m.hint}
            onClick={() => mode !== m.mode && onMode(m.mode)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <button type="button" data-testid="use-start" title="Save what the map shows now as the first shot" onClick={onUseStart}>
        Use as start shot
      </button>
      <button type="button" data-testid="use-end" title="Save what the map shows now as the last shot" onClick={onUseEnd}>
        Use as end shot
      </button>
      <button type="button" data-testid="fit-shots" title="Clear both shots so the camera frames the whole route" onClick={onFit}>
        Fit to route
      </button>
      {freeView && (
        <span className="free-view" data-testid="free-view" role="status" title="Scrub or press play to follow the camera again">
          Free view
        </span>
      )}
    </div>
  )
}
