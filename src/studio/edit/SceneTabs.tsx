import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { swallowNextClick } from './PointMenu.js'

/** What a tab shows about one scene. */
export interface SceneSummary {
  id: string
  name: string
  /** Length of the scene's clip, in whole seconds. */
  seconds: number
}

interface SceneTabsProps {
  scenes: SceneSummary[]
  activeId: string
  onSelect(id: string): void
  onAdd(): void
  /** `name` is already trimmed and differs from the old one. */
  onRename(id: string, name: string): void
  onDuplicate(id: string): void
  onMove(id: string, direction: 'left' | 'right'): void
  onDelete(id: string): void
}

/** Gap kept between the menu and the window's edges, in CSS px. */
const EDGE = 8

interface MenuProps {
  at: { x: number; y: number }
  canMoveLeft: boolean
  canMoveRight: boolean
  canDelete: boolean
  onRename(): void
  onDuplicate(): void
  onMoveLeft(): void
  onMoveRight(): void
  onDelete(): void
  onClose(): void
}

/** The menu for one scene tab. Closes on Escape, a click outside it, or a choice. */
function SceneMenu({ at, canMoveLeft, canMoveRight, canDelete, onRename, onDuplicate, onMoveLeft, onMoveRight, onDelete, onClose }: MenuProps) {
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
    // Captured first, so Escape closes the menu and goes no further.
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return
      onClose()
      swallowNextClick()
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
      className="point-menu scene-menu"
      role="menu"
      data-testid="scene-menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button type="button" role="menuitem" data-testid="scene-menu-rename" onClick={choose(onRename)}>
        Rename
      </button>
      <button type="button" role="menuitem" data-testid="scene-menu-duplicate" onClick={choose(onDuplicate)}>
        Duplicate
      </button>
      <button type="button" role="menuitem" data-testid="scene-menu-left" disabled={!canMoveLeft} onClick={choose(onMoveLeft)}>
        Move left
      </button>
      <button type="button" role="menuitem" data-testid="scene-menu-right" disabled={!canMoveRight} onClick={choose(onMoveRight)}>
        Move right
      </button>
      <button type="button" role="menuitem" data-testid="scene-menu-delete" disabled={!canDelete} onClick={choose(onDelete)}>
        Delete
      </button>
    </div>
  )
}

/** The name field that replaces a tab's label. Enter saves; Escape, an empty name or leaving the field cancels. */
function RenameField({ initial, onDone }: { initial: string; onDone(name: string | undefined): void }) {
  const [value, setValue] = useState(initial)
  // Enter and Escape finish the edit, and removing the field then blurs it; that blur is not a second answer.
  const done = useRef(false)
  const finish = (name: string | undefined) => {
    if (done.current) return
    done.current = true
    onDone(name)
  }
  return (
    <input
      className="scene-rename"
      data-testid="scene-rename"
      aria-label="Scene name"
      autoFocus
      value={value}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          const name = value.trim()
          finish(name === '' ? undefined : name)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          // Escape in the field is its own; it must not also deselect the leg.
          e.stopPropagation()
          finish(undefined)
        }
      }}
      onBlur={() => finish(undefined)}
    />
  )
}

/** One tab per scene above the stage, with a `+` to add a scene. Scrolls sideways when the tabs don't fit. */
export function SceneTabs({ scenes, activeId, onSelect, onAdd, onRename, onDuplicate, onMove, onDelete }: SceneTabsProps) {
  const [menu, setMenu] = useState<{ id: string; at: { x: number; y: number } }>()
  const [renaming, setRenaming] = useState<string>()
  const list = useRef<HTMLDivElement>(null)
  const closeMenu = useCallback(() => setMenu(undefined), [])

  // Keeps the active tab in view, such as the one just added at the far end.
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [activeId, scenes.length])

  const menuIndex = menu ? scenes.findIndex((s) => s.id === menu.id) : -1
  const menuScene = scenes[menuIndex]

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    if (!(e.target instanceof HTMLElement) || e.target.getAttribute('role') !== 'tab') return
    const at = scenes.findIndex((s) => s.id === activeId)
    const next = scenes[at + (e.key === 'ArrowRight' ? 1 : -1)]
    if (!next) return
    e.preventDefault()
    onSelect(next.id)
    // The newly active tab is the one that takes focus.
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus())
  }

  return (
    <div className="scene-bar">
      <div className="scene-tabs" role="tablist" aria-label="Scenes" ref={list} onKeyDown={onKeyDown}>
        {scenes.map((scene) => {
          const label = scene.name || 'Untitled'
          const active = scene.id === activeId
          return (
            <div key={scene.id} className="scene-tab" data-active={active} role="presentation">
              {renaming === scene.id ? (
                <RenameField
                  initial={scene.name}
                  onDone={(name) => {
                    setRenaming(undefined)
                    if (name !== undefined && name !== scene.name) onRename(scene.id, name)
                  }}
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  data-testid="scene-tab"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  onClick={() => onSelect(scene.id)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setMenu({ id: scene.id, at: { x: e.clientX, y: e.clientY } })
                  }}
                >
                  {label} · {scene.seconds} s
                </button>
              )}
              <button
                type="button"
                className="scene-more"
                aria-label="Scene menu"
                aria-haspopup="menu"
                onClick={(e) => {
                  const box = e.currentTarget.getBoundingClientRect()
                  setMenu({ id: scene.id, at: { x: box.left, y: box.bottom + 4 } })
                }}
              >
                ⋯
              </button>
            </div>
          )
        })}
      </div>
      <button type="button" className="scene-add" data-testid="scene-add" aria-label="Add a scene" onClick={onAdd}>
        +
      </button>
      {menu && menuScene && (
        <SceneMenu
          at={menu.at}
          canMoveLeft={menuIndex > 0}
          canMoveRight={menuIndex < scenes.length - 1}
          canDelete={scenes.length > 1}
          onRename={() => setRenaming(menuScene.id)}
          onDuplicate={() => onDuplicate(menuScene.id)}
          onMoveLeft={() => onMove(menuScene.id, 'left')}
          onMoveRight={() => onMove(menuScene.id, 'right')}
          onDelete={() => onDelete(menuScene.id)}
          onClose={closeMenu}
        />
      )}
    </div>
  )
}
