import type { Camera, CameraKey } from '../../core/index.js'

type Mode = Camera['mode']

interface ShotPanelProps {
  mode: Mode
  freeView: boolean
  /** The glide's camera keys, in time order. Only a glide uses them. */
  keys: CameraKey[]
  onMode(mode: Mode): void
  onUseStart(): void
  onUseEnd(): void
  onFit(): void
  onAddKey(): void
  /** Scrub to the key at `at` seconds. */
  onGoToKey(at: number): void
  onRemoveKey(at: number): void
  onClearKeys(): void
}

/** A key's time for a chip: "1.0 s", or two decimals when a tenth isn't enough. */
export function keyTime(at: number): string {
  return `${Number.isInteger(Math.round(at * 100) / 10) ? at.toFixed(1) : at.toFixed(2)} s`
}

const MODES: { mode: Mode; label: string; hint: string }[] = [
  { mode: 'fixed', label: 'Fixed', hint: 'The camera holds the start shot' },
  { mode: 'glide', label: 'Glide', hint: 'The camera moves from the start shot to the end shot, or from key to key' },
]

/** The camera controls: fixed or glide, and the start and end shots. */
export function ShotPanel({
  mode,
  freeView,
  keys,
  onMode,
  onUseStart,
  onUseEnd,
  onFit,
  onAddKey,
  onGoToKey,
  onRemoveKey,
  onClearKeys,
}: ShotPanelProps) {
  const keyed = mode === 'glide'
  // Keys win over the start and end shots, so those buttons wait until the keys are gone.
  const showShots = !(keyed && keys.length > 0)
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
      {showShots && (
        <>
          <button type="button" data-testid="use-start" title="Save what the map shows now as the first shot" onClick={onUseStart}>
            Use as start shot
          </button>
          <button type="button" data-testid="use-end" title="Save what the map shows now as the last shot" onClick={onUseEnd}>
            Use as end shot
          </button>
        </>
      )}
      {keyed && (
        <button type="button" data-testid="add-key" title="Save what the map shows now as a camera key at this time" onClick={onAddKey}>
          Add key
        </button>
      )}
      {keyed &&
        keys.map((key, i) => (
          <span className="camera-key" key={`${i}-${key.at}`}>
            <button
              type="button"
              data-testid="camera-key"
              aria-label={`Go to camera key at ${keyTime(key.at)}`}
              title={`Go to the camera key at ${keyTime(key.at)}`}
              onClick={() => onGoToKey(key.at)}
            >
              {keyTime(key.at)}
            </button>
            <button
              type="button"
              data-testid="remove-key"
              aria-label={`Remove the camera key at ${keyTime(key.at)}`}
              title="Remove this camera key"
              onClick={() => onRemoveKey(key.at)}
            >
              ×
            </button>
          </span>
        ))}
      {keyed && keys.length > 0 && (
        <button type="button" data-testid="clear-keys" title="Remove every camera key" onClick={onClearKeys}>
          Clear keys
        </button>
      )}
      <button type="button" data-testid="fit-shots" title="Clear the shots and keys so the camera frames the whole route" onClick={onFit}>
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
