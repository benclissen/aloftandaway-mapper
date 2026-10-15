import { SYMBOL_ICON, SYMBOLS, type LegMode, type ProjectPatch, type Route, type Scene, type SymbolKind } from '../../core/index.js'
import { ICONS, type IconName } from '../stage/icons.js'
import { MODE_LABELS, SYMBOL_LABELS } from './labels.js'

const MODES = Object.keys(MODE_LABELS) as LegMode[]

/** A transport's icon, drawn small beside its name. `none` and `dot` have no icon. */
function SymbolIcon({ symbol, testId }: { symbol: SymbolKind; testId: string }) {
  const name = (SYMBOL_ICON as Partial<Record<SymbolKind, string>>)[symbol]
  const icon = name ? ICONS[name as IconName] : undefined
  return (
    <span className="symbol-icon" data-testid={testId} aria-hidden="true">
      {icon ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {icon.paths.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </svg>
      ) : symbol === 'dot' ? (
        <svg width="18" height="18" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="4" fill="currentColor" />
        </svg>
      ) : null}
    </span>
  )
}

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
          {scene.legs.map((leg, i) => {
            const sea = route.legs[i]?.sea
            return (
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
                <SymbolIcon symbol={leg.symbol ?? scene.look.symbol} testId={`leg-icon-${i}`} />
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
              {sea?.status === 'fallback' && (
                <p className="leg-note">
                  {sea?.reason ? `No sea route found: ${sea?.reason}.` : 'No sea route found.'} Drawn as
                  a line.
                </p>
              )}
              {sea?.status === 'pending' && <p className="leg-note">Finding a sea route…</p>}
            </li>
            )
          })}
        </ul>
      )}
    </aside>
  )
}
