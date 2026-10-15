import { THEMES, type ProjectPatch, type ThemeId } from '../../core/index.js'
import { THEME_LABELS } from './labels.js'

interface StylePickerProps {
  theme: ThemeId
  onEdit(patch: ProjectPatch, label: string): unknown
}

/** Chooses the map style for the whole scene. */
export function StylePicker({ theme, onEdit }: StylePickerProps) {
  return (
    <label className="style-picker">
      <span>Map style</span>
      <select
        data-testid="theme-picker"
        value={theme}
        onChange={(e) => {
          const next = e.target.value as ThemeId
          void onEdit({ sceneSet: { look: { theme: next } } }, `Map style: ${THEME_LABELS[next]}`)
        }}
      >
        {THEMES.map((t) => (
          <option key={t} value={t}>
            {THEME_LABELS[t]}
          </option>
        ))}
      </select>
    </label>
  )
}
