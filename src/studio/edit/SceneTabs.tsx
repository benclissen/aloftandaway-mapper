import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { sceneTitleOf } from '../../core/index.js'
import { Menu, useMenuChoice } from './Menu.js'

/** What a tab shows about one scene. */
export interface SceneSummary {
  id: string
  name: string
  /** Length of the scene's clip, in seconds. */
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

/** The menu for one scene tab. Closes on Escape, a click outside it, a ⋯ button, or a choice. */
function SceneMenu({ at, canMoveLeft, canMoveRight, canDelete, onRename, onDuplicate, onMoveLeft, onMoveRight, onDelete, onClose }: MenuProps) {
  const choose = useMenuChoice(onClose)

  return (
    // A press on a ⋯ is left to that button, which opens, moves or closes the menu.
    <Menu at={at} onClose={onClose} keepOpenFor=".scene-more" className="scene-menu" data-testid="scene-menu">
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
    </Menu>
  )
}

/** The name field that replaces a tab's label. Enter or leaving the field saves a changed, non-blank name; Escape cancels. */
function RenameField({ initial, onDone }: { initial: string; onDone(name: string | undefined): void }) {
  const [value, setValue] = useState(initial)
  // Enter and Escape finish the edit, and removing the field then blurs it; that blur is not a second answer.
  const done = useRef(false)
  const finish = (name: string | undefined) => {
    if (done.current) return
    done.current = true
    onDone(name)
  }
  const save = () => {
    const name = value.trim()
    finish(name === '' ? undefined : name)
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
          save()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          // Escape in the field is its own; it must not also deselect the leg.
          e.stopPropagation()
          finish(undefined)
        }
      }}
      onBlur={save}
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

  // A scene that goes away (an undo, the agent) takes its menu and rename field with it, for good.
  useEffect(() => {
    if (menu && !scenes.some((s) => s.id === menu.id)) setMenu(undefined)
    if (renaming && !scenes.some((s) => s.id === renaming)) setRenaming(undefined)
  }, [scenes, menu, renaming])

  const menuIndex = menu ? scenes.findIndex((s) => s.id === menu.id) : -1
  const menuScene = scenes[menuIndex]

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return
    if (!(e.target instanceof HTMLElement) || e.target.getAttribute('role') !== 'tab') return
    const at = scenes.findIndex((s) => s.id === activeId)
    const next =
      e.key === 'Home' ? scenes[0] : e.key === 'End' ? scenes[scenes.length - 1] : scenes[at + (e.key === 'ArrowRight' ? 1 : -1)]
    if (!next) return
    e.preventDefault()
    if (next.id !== activeId) onSelect(next.id)
    // The newly active tab is the one that takes focus.
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus())
  }

  return (
    <div className="scene-bar">
      <div className="scene-tabs" role="tablist" aria-label="Scenes" ref={list} onKeyDown={onKeyDown}>
        {scenes.map((scene, position) => {
          const label = sceneTitleOf(scene.name, position)
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
                  {label} · {scene.seconds.toFixed(1)} s
                </button>
              )}
              <button
                type="button"
                className="scene-more"
                aria-label="Scene menu"
                aria-haspopup="menu"
                aria-expanded={menu?.id === scene.id}
                onClick={(e) => {
                  const box = e.currentTarget.getBoundingClientRect()
                  setMenu((open) => (open?.id === scene.id ? undefined : { id: scene.id, at: { x: box.left, y: box.bottom + 4 } }))
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
          key={menuScene.id}
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
