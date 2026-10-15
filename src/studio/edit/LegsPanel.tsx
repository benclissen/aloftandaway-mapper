import { SYMBOLS, type LegMode, type ProjectPatch, type Route, type Scene, type SymbolKind } from '../../core/index.js'
import { MODE_LABELS, SYMBOL_LABELS } from './labels.js'

const MODES = Object.keys(MODE_LABELS) as LegMode[]

interface LegsPanelProps {
  scene: Scene
  route: Route
  selectedLeg: number | undefined
  onSelectLeg(leg: number | undefined): void
  onEdit(patch: ProjectPatch, label: string): unknown
}

/** One row per leg: pick its transport and how its line is drawn. */
export function LegsPanel({ scene, route, selectedLeg, onSelectLeg, onEdit }: LegsPanelProps) {
  const name = (i: number) => scene.stops[i]?.name ?? ''
  return (
    <aside className="legs-panel" aria-label="Legs" data-testid="legs-panel">
      <h2>Legs</h2>
      {scene.legs.length === 0 ? (
        <p className="legs-empty">Add stops through your agent to see legs here.</p>
      ) : (
        <ul>
          {scene.legs.map((leg, i) => (
            <li
              key={i}
              className="leg-row"
              data-testid={`leg-row-${i}`}
              aria-selected={selectedLeg === i}
              tabIndex={0}
              onClick={() => onSelectLeg(i)}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault()
                  onSelectLeg(i)
                }
              }}
            >
              <div className="leg-title">
                {i + 1} · {name(i)} → {name(i + 1)}
              </div>
              <div className="leg-pickers">
                <select
                  data-testid={`leg-symbol-${i}`}
                  aria-label={`Change leg ${i + 1} transport`}
                  value={leg.symbol ?? ''}
                  onChange={(e) => {
                    const value = e.target.value as SymbolKind | ''
                    const label = value ? SYMBOL_LABELS[value] : 'Default'
                    void onEdit(
                      { ops: [{ op: 'update_leg', index: i, changes: { symbol: value || null } }] },
                      `Leg ${i + 1} transport: ${label}`,
                    )
                  }}
                >
                  <option value="">Default ({SYMBOL_LABELS[scene.look.symbol]})</option>
                  {SYMBOLS.map((s) => (
                    <option key={s} value={s}>
                      {SYMBOL_LABELS[s]}
                    </option>
                  ))}
                </select>
                <select
                  data-testid={`leg-mode-${i}`}
                  aria-label={`Change leg ${i + 1} mode`}
                  value={leg.mode}
                  onChange={(e) => {
                    const mode = e.target.value as LegMode
                    void onEdit(
                      { ops: [{ op: 'update_leg', index: i, changes: { mode } }] },
                      `Leg ${i + 1} mode: ${MODE_LABELS[mode]}`,
                    )
                  }}
                >
                  {MODES.map((m) => (
                    <option key={m} value={m}>
                      {MODE_LABELS[m]}
                    </option>
                  ))}
                </select>
              </div>
              {route.legs[i]?.notAvailable && <p className="leg-note">Drawn as a plain line for now.</p>}
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}
