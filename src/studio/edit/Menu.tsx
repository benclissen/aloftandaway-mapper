import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/** Gap kept between the menu and the window's edges, in CSS px. */
const EDGE = 8

/** How long a dismissing press may take to become a click before the click is let through again. */
const SWALLOW_MS = 1000

/**
 * Stops the click that follows the press which dismissed a menu, so dismissing never also edits the map (MapLibre's
 * click comes from the DOM click). The guard goes on the next press or after a while, so it never eats a later click.
 */
export function swallowNextClick(): void {
  const stop = (e: MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    done()
  }
  const done = () => {
    clearTimeout(timer)
    window.removeEventListener('click', stop, true)
    window.removeEventListener('mousedown', done, true)
  }
  const timer = setTimeout(done, SWALLOW_MS)
  window.addEventListener('click', stop, true)
  // Added while this press is being dispatched, so it first hears the next one.
  window.addEventListener('mousedown', done, true)
}

interface MenuProps {
  /** Window position to open at. */
  at: { x: number; y: number }
  onClose(): void
  /** A CSS selector for the elements whose press is left to them, such as the button that toggles this menu. */
  keepOpenFor?: string
  /** `menuitem` buttons. */
  children: ReactNode
  /** Extra class for the wrapper. */
  className?: string
  'data-testid'?: string
}

/**
 * The shell of a small popup menu: kept inside the window, first item focused, closed by Escape or a press outside it.
 * A press on the map that closes it does not also edit the route.
 */
export function Menu({ at, onClose, keepOpenFor, children, className, 'data-testid': testId }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(at)

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
      const target = e.target instanceof Element ? e.target : undefined
      if (ref.current?.contains(e.target as Node)) return
      if (keepOpenFor && target?.closest(keepOpenFor)) return
      onClose()
      // A press on the map must not also edit the route. Anywhere else (another tab, say) it does its job.
      if (target?.closest('.stage')) swallowNextClick()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onDown, true)
    }
  }, [onClose, keepOpenFor])

  return (
    <div
      ref={ref}
      className={className ? `point-menu ${className}` : 'point-menu'}
      role="menu"
      data-testid={testId}
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>
  )
}

/** `choose(action)` makes a click handler that closes the menu first, then runs `action`. */
export function useMenuChoice(onClose: () => void): (action: () => void) => () => void {
  return (action) => () => {
    onClose()
    action()
  }
}
