import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

/**
 * Right-side panel state shared outside React. Same structure and rationale as `sidebar.ts`: the
 * conversation header holds the toggle while the panel lives beside the thread, so passing props
 * would cross the entire view for a single boolean.
 */

const OPEN_KEY = 'sillage.panelOpen'
/**
 * Separate key from the old `sillage.panelWidth`: width now describes an overlay sheet rather than
 * a column taking space from the thread. Reusing the old preference would reopen it just as narrow
 * as before, without benefiting the thread.
 */
const WIDTH_KEY = 'sillage.sheetWidth'
const DOCKED_WIDTH_KEY = 'sillage.panelDockedWidth'
const EXPANDED_KEY = 'sillage.panelExpanded'
const TREE_KEY = 'sillage.panelTree'
const TREE_WIDTH_KEY = 'sillage.treeWidth'

/** Below this width the tree and editor no longer fit side by side. */
const MIN_WIDTH = 280

/** Thread space left visible behind the panel so it remains accessible. */
const MIN_THREAD = 160

function maxWidth(): number {
  return Math.max(MIN_WIDTH, window.innerWidth - MIN_THREAD)
}

/**
 * Opening width when no preference is saved. Start wide: the panel overlays the thread instead of
 * taking its column, so narrowness no longer benefits the thread. It needs room for both explorer
 * and editor or the Files tab has little purpose.
 */
function defaultWidth(): number {
  return Math.min(1040, Math.round(window.innerWidth * 0.72))
}

let open = localStorage.getItem(OPEN_KEY) === '1'
// Temporary overlays in focus mode must not overwrite the normal panel layout.
let concentrationOpen: boolean | null = null
export function setPanelConcentration(active: boolean): void {
  if (active === (concentrationOpen !== null)) return
  concentrationOpen = active ? false : null
  for (const listener of listeners) listener()
}
let expanded = localStorage.getItem(EXPANDED_KEY) === '1'
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setPanelExpanded(next: boolean): void {
  expanded = next
  localStorage.setItem(EXPANDED_KEY, next ? '1' : '0')
  for (const notify of listeners) notify()
}

/** Actual space remaining after the sidebar determines whether the thread and changes fit. */
export function usePanelLayout() {
  const [width, setWidth] = useState(0)
  const isExpanded = useSyncExternalStore(subscribe, () => expanded || concentrationOpen !== null, () => false)
  const concentration = useSyncExternalStore(subscribe, () => concentrationOpen !== null, () => false)
  const containerRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    setWidth(node.clientWidth)
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const canDock = width >= 960 && !concentration
  return { containerRef, canDock, docked: canDock && !isExpanded }
}

export function usePanelOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => concentrationOpen ?? open,
    () => false,
  )
}

/**
 * Opening transition duration; keep in sync with the panel class. Also delays unmounting, which
 * would otherwise remove the panel before its exit animation plays.
 */
export const PANEL_TRANSITION_MS = 200

/**
 * Panel presence in the document, separate from its open state. It stays mounted while sliding out,
 * then disappears: live terminals and tree requests should not remain behind a closed panel.
 */
export function usePanelPresence(): { mounted: boolean; open: boolean } {
  const open = usePanelOpen()
  const [mounted, setMounted] = useState(open)

  useEffect(() => {
    if (open) {
      setMounted(true)
      return
    }

    const timer = setTimeout(() => setMounted(false), PANEL_TRANSITION_MS)
    return () => clearTimeout(timer)
  }, [open])

  return { mounted, open }
}

export function setPanelOpen(next: boolean): void {
  if (concentrationOpen !== null) {
    if (concentrationOpen === next) return
    concentrationOpen = next
    for (const listener of listeners) listener()
    return
  }
  if (next === open) return
  open = next
  localStorage.setItem(OPEN_KEY, next ? '1' : '0')
  for (const listener of listeners) listener()
}

export type PanelTab = 'files' | 'git' | 'history' | 'terminals' | 'actions' | 'agents' | 'mcp' | 'card'

/**
 * Displayed tab and selected subagent. Stored here because the thread controls them: opening a diff
 * file switches to Files, and clicking a banner subagent must open the panel, choose its tab, and
 * select the subagent in one action.
 */
let tab: PanelTab = 'files'
let subAgentId: string | null = null

export function usePanelTab(): PanelTab {
  return useSyncExternalStore(
    subscribe,
    () => tab,
    () => 'files' as const,
  )
}

export function setPanelTab(next: PanelTab): void {
  if (next === tab) return
  tab = next
  // Clicking the tab means show subagents rather than reopen the previously viewed one: selection
  // survives thread navigation but not switching tabs. Likewise, returning to Git shows the
  // repository rather than the previously selected turn.
  subAgentId = null
  checkpointKey = null
  for (const listener of listeners) listener()
}

/**
 * Turn whose changes the Git tab displays, selected from the thread. Stored here for the same
 * reason as subagent selection: a single thread action must open the panel, choose the tab, and
 * select the turn.
 */
let checkpointKey: string | null = null

export function usePanelCheckpoint(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => checkpointKey,
    () => null,
  )
}

/** Show a turn's changes in the Git tab with the panel open. */
export function showCheckpoint(key: string): void {
  setPanelOpen(true)
  tab = 'git'
  subAgentId = null
  checkpointKey = key
  for (const listener of listeners) listener()
}

export function clearCheckpoint(): void {
  if (checkpointKey === null) return
  checkpointKey = null
  for (const listener of listeners) listener()
}

/**
 * Terminal to select when it next appears in the list: an action just opened it, and the terminal
 * panel must update its own selection accordingly.
 */
let focusedTerminal: string | null = null

export function useFocusedTerminal(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => focusedTerminal,
    () => null,
  )
}

/** Open the panel on a specific terminal from anywhere in the view. */
export function showTerminal(id: string): void {
  focusedTerminal = id
  tab = 'terminals'
  setPanelOpen(true)
  for (const listener of listeners) listener()
}

/** The terminal panel has applied the requested selection. */
export function clearFocusedTerminal(): void {
  focusedTerminal = null
}

/** Spawning call of the selected subagent, or null for the list. */
export function useSelectedSubAgent(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => subAgentId,
    () => null,
  )
}

/** Open the panel on a subagent thread from anywhere in the view. */
export function showSubAgent(id: string): void {
  subAgentId = id
  tab = 'agents'
  // After both assignments: `setPanelOpen` notifies subscribers, which must find the tab and
  // selection already set.
  setPanelOpen(true)
  for (const listener of listeners) listener()
}

/**
 * Return to the list. Also called on conversation changes: a spawning call exists only in its own
 * thread, so retaining the selection would display an empty thread.
 */
export function clearSubAgent(): void {
  if (subAgentId === null) return
  subAgentId = null
  for (const listener of listeners) listener()
}

/**
 * Panel width published as a CSS variable. As with the sidebar, dragging emits an event per frame;
 * rerendering the tree each time would make resizing sluggish. Write `localStorage` only on
 * release.
 */
export function setPanelWidth(px: number, persist: boolean): number {
  const width = Math.round(Math.min(maxWidth(), Math.max(MIN_WIDTH, px)))
  document.documentElement.style.setProperty('--panel-width', `${width}px`)
  if (persist) localStorage.setItem(WIDTH_KEY, String(width))
  return width
}

export function restorePanelWidth(): void {
  const stored = Number(localStorage.getItem(WIDTH_KEY))
  setPanelWidth(Number.isFinite(stored) && stored > 0 ? stored : defaultWidth(), false)
  const docked = Number(localStorage.getItem(DOCKED_WIDTH_KEY))
  if (Number.isFinite(docked) && docked > 0) setDockedPanelWidth(docked, false)
}

export function setDockedPanelWidth(px: number, persist: boolean): number {
  const width = Math.round(Math.max(320, Math.min(window.innerWidth - 416, px)))
  document.documentElement.style.setProperty('--panel-docked-width', `${width}px`)
  if (persist) localStorage.setItem(DOCKED_WIDTH_KEY, String(width))
  return width
}

/**
 * Tree column in the Files tab. A setting rather than a tab: tree and editor form one view, and
 * collapsing the tree gives space back to the editor without switching context. In a narrow panel
 * it overlays the editor and closes when a file is selected.
 */
let treeOpen = localStorage.getItem(TREE_KEY) !== '0'

export function usePanelTree(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => treeOpen,
    () => true,
  )
}

/**
 * Set `persist` to false for automatic narrow-panel closure: available space imposes it rather than
 * user choice. Saving it would keep the tree collapsed on returning to a large screen.
 */
export function setPanelTree(next: boolean, persist = true): void {
  if (next === treeOpen) return
  treeOpen = next
  if (persist) localStorage.setItem(TREE_KEY, next ? '1' : '0')
  for (const listener of listeners) listener()
}

/** Below this width a filename no longer fits beside its icon. */
const MIN_TREE_WIDTH = 150

/** Space reserved for the editor: any less makes a code line unreadable. */
const MIN_EDITOR_WIDTH = 220

/** Original column width before it became adjustable. */
const DEFAULT_TREE_WIDTH = 240

/**
 * Maximum fraction of the container the column may occupy. Keep in sync with `FilesPane`'s
 * `min(var(--tree-width,15rem),60%)`. CSS protects the editor when the panel shrinks afterward;
 * this limit prevents saving a width larger than displayed, which would make the column jump when
 * widened again.
 */
const MAX_TREE_SHARE = 0.6

/**
 * Tree column width published as a CSS variable. `available` is the width of the tree/editor
 * container, not the window: the enclosing panel resizes independently and alone knows the
 * available space.
 */
export function setTreeWidth(px: number, available: number, persist: boolean): number {
  const max = Math.max(
    MIN_TREE_WIDTH,
    Math.min(available * MAX_TREE_SHARE, available - MIN_EDITOR_WIDTH),
  )
  const width = Math.round(Math.min(max, Math.max(MIN_TREE_WIDTH, px)))
  document.documentElement.style.setProperty('--tree-width', `${width}px`)
  if (persist) localStorage.setItem(TREE_WIDTH_KEY, String(width))
  return width
}

export function restoreTreeWidth(): void {
  const stored = Number(localStorage.getItem(TREE_WIDTH_KEY))
  const width = Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_TREE_WIDTH
  // Unlike dragging, no upper bound here: the panel has not been laid out yet. The column's CSS
  // prevents a width saved on a large screen from squeezing the editor in a narrow panel.
  document.documentElement.style.setProperty(
    '--tree-width',
    `${Math.max(MIN_TREE_WIDTH, width)}px`,
  )
}
