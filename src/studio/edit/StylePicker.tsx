import { THEMES, type ProjectPatch, type ThemeId } from '../../core/index.js'
import { THEME_NAMES } from './labels.js'

interface StylePickerProps {
  theme: ThemeId
  terrain: boolean
  onEdit(patch: ProjectPatch, label: string): unknown
}

/** Chooses the map style for the whole scene, and whether the land is drawn with hills. */
export function StylePicker({ theme, terrain, onEdit }: StylePickerProps) {
  return (
    <div className="style-controls">
      <label className="style-picker">
        <span>Map style</span>
        <select
          data-testid="theme-picker"
          value={theme}
          onChange={(e) => {
            const next = e.target.value as ThemeId
            void onEdit({ sceneSet: { look: { theme: next } } }, `Map style: ${THEME_NAMES[next]}`)
          }}
        >
          {THEMES.map((t) => (
            <option key={t} value={t}>
              {THEME_NAMES[t]}
            </option>
          ))}
        </select>
      </label>
      <label className="style-picker">
        <input
          type="checkbox"
          data-testid="terrain-toggle"
          checked={terrain}
          onChange={(e) => {
            const next = e.target.checked
            void onEdit({ sceneSet: { look: { terrain: next } } }, `Terrain: ${next ? 'on' : 'off'}`)
          }}
        />
        <span>Hills</span>
      </label>
    </div>
  )
}
