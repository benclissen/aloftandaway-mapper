import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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

/** Gap kept between the menu and the window's edges, in CSS px. */
const EDGE = 8

/** A small menu for one stop or via point. Closes on Escape, a click outside it, or a choice. */
export function PointMenu({ target, at, sharp, onToggleSharp, onRemove, onClose }: PointMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(at)

  // Kept inside the window.
  useLayoutEffect(() => {
    const { width, height } = ref.current!.getBoundingClientRect()
    setPos({
      x: Math.max(EDGE, Math.min(at.x, window.innerWidth - width - EDGE)),
      y: Math.max(EDGE, Math.min(at.y, window.innerHeight - height - EDGE)),
    })
  }, [at])

  useEffect(() => {
    ref.current?.querySelector('button')?.focus()
    // Captured first, so Escape closes the menu and goes no further (it would otherwise deselect the leg).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onDown, true)
    }
  }, [onClose])

  const choose = (action: () => void) => () => {
    onClose()
    action()
  }

  return (
    <div
      ref={ref}
      className="point-menu"
      role="menu"
      data-testid="point-menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button type="button" role="menuitem" data-testid="point-menu-sharp" onClick={choose(onToggleSharp)}>
        {sharp ? 'Curve through' : 'Sharp corner'}
      </button>
      {target.kind === 'via' && (
        <button type="button" role="menuitem" data-testid="point-menu-remove" onClick={choose(onRemove)}>
          Remove
        </button>
      )}
    </div>
  )
}
