import { Menu, useMenuChoice } from './Menu.js'
import type { PointTarget } from './RouteEditor.js'

interface PointMenuProps {
  target: PointTarget
  /** Window position to open at. */
  at: { x: number; y: number }
  sharp: boolean
  onToggleSharp(): void
  /** Only offered for via points. */
  onRemove(): void
  onClose(): void
}

/** A small menu for one stop or via point. Closes on Escape, a click outside it, or a choice. */
export function PointMenu({ target, at, sharp, onToggleSharp, onRemove, onClose }: PointMenuProps) {
  const choose = useMenuChoice(onClose)

  return (
    <Menu at={at} onClose={onClose} data-testid="point-menu">
      <button type="button" role="menuitem" data-testid="point-menu-sharp" onClick={choose(onToggleSharp)}>
        {sharp ? 'Curve through' : 'Sharp corner'}
      </button>
      {target.kind === 'via' && (
        <button type="button" role="menuitem" data-testid="point-menu-remove" onClick={choose(onRemove)}>
          Remove
        </button>
      )}
    </Menu>
  )
}
