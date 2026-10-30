import { useSyncExternalStore } from 'react'
import { api } from './api'
import { workspaceApiBase } from './workspace-scope'

/**
 * Open editor tabs per conversation. Outside React because the explorer opens tabs displayed by the
 * editor across separate panel tabs; lifting state would propagate every tree keystroke through the
 * parent. Persisted per conversation so a reload finds them again; files that disappeared in the
 * meantime are dropped on return rather than reopened as errors.
 */

interface Tabs {
  paths: string[]
  active: string | null
  /**
   * Preview tab opened by a single click. Only one exists; the next single click replaces it rather
   * than accumulating ten tabs while browsing ten files. Double-clicking or editing promotes it to
   * a regular tab.
   */
  preview: string | null
}

const EMPTY: Tabs = { paths: [], active: null, preview: null }

const byConversation = new Map<string, Tabs>()
const listeners = new Set<() => void>()

const STORAGE_KEY = 'sillage.editorTabs'
/** Conversations whose tabs are kept, most recent last: older ones are forgotten. */
const MAX_STORED = 30

function emit(): void {
  for (const listener of listeners) listener()
}

function stored(): Array<[string, Tabs]> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? (parsed as Array<[string, Tabs]>) : []
  } catch {
    return []
  }
}

/** Every change goes through here: memory first, then storage when available. */
function commit(conversationId: string, tabs: Tabs): void {
  byConversation.set(conversationId, tabs)
  emit()
  try {
    const kept = stored().filter(([id]) => id !== conversationId)
    if (tabs.paths.length > 0) kept.push([conversationId, tabs])
    localStorage.setItem(STORAGE_KEY, JSON.stringify(kept.slice(-MAX_STORED)))
  } catch {
    /* Without storage, tabs last as long as the page. */
  }
}

/**
 * Reopens a conversation's tabs after a reload, once per page, then drops those whose file no
 * longer exists. Called by the editor when it shows a conversation.
 */
export function restoreTabs(conversationId: string): void {
  if (byConversation.has(conversationId)) return
  const saved = stored().find(([id]) => id === conversationId)?.[1]
  if (!saved || !Array.isArray(saved.paths) || saved.paths.length === 0) return
  commit(conversationId, {
    paths: saved.paths.filter((path) => typeof path === 'string'),
    active: typeof saved.active === 'string' ? saved.active : null,
    preview: typeof saved.preview === 'string' ? saved.preview : null,
  })
  const paths = saved.paths.slice(0, 50)
  void api
    .post<{ files: string[] }>(`${workspaceApiBase(conversationId)}/files/exist`, { paths })
    .then(({ files }) => {
      const present = new Set(files)
      for (const path of paths) if (!present.has(path)) closeTab(conversationId, path)
    })
    // Unreachable server: the tabs stay, and a missing file says so when shown.
    .catch(() => undefined)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useEditorTabs(conversationId: string): Tabs {
  return useSyncExternalStore(
    subscribe,
    () => byConversation.get(conversationId) ?? EMPTY,
    () => EMPTY,
  )
}

/**
 * Whether `path` is the active tab. Rows of the explorer each read this rather than the whole tab
 * list, so opening a file redraws two rows instead of all of them.
 */
export function useIsActiveTab(conversationId: string, path: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => byConversation.get(conversationId)?.active === path,
    () => false,
  )
}

/**
 * Open a file or activate its existing tab. `preview` means a browsing open from a tree
 * single-click; explicit opens retain their place.
 */
export function openTab(
  conversationId: string,
  path: string,
  { preview = false }: { preview?: boolean } = {},
): void {
  const current = byConversation.get(conversationId) ?? EMPTY

  if (current.paths.includes(path)) {
    commit(conversationId, {
      ...current,
      active: path,
      // Explicitly reopening a preview means choosing to keep it.
      preview: !preview && current.preview === path ? null : current.preview,
    })
    return
  }

  // Replace the preview in place rather than at the end: earlier tabs must not move while browsing files.
  const replacing = preview && current.preview !== null ? current.paths.indexOf(current.preview) : -1
  const paths = [...current.paths]
  if (replacing === -1) paths.push(path)
  else paths[replacing] = path

  commit(conversationId, {
    paths,
    active: path,
    preview: preview ? path : current.preview,
  })
}

/** Promote a preview to a regular tab so the next preview cannot replace it. */
export function pinTab(conversationId: string, path: string): void {
  const current = byConversation.get(conversationId) ?? EMPTY
  if (current.preview !== path) return
  commit(conversationId, { ...current, preview: null })
}

export function activateTab(conversationId: string, path: string): void {
  const current = byConversation.get(conversationId) ?? EMPTY
  if (current.active === path) return
  commit(conversationId, { ...current, active: path })
}

/**
 * Move a tab to a position. Default order follows opening time, but users may want related files
 * grouped together.
 */
export function reorderTabs(conversationId: string, from: string, toIndex: number): void {
  const current = byConversation.get(conversationId) ?? EMPTY
  const fromIndex = current.paths.indexOf(from)
  if (fromIndex === -1 || fromIndex === toIndex) return

  const paths = current.paths.filter((entry) => entry !== from)
  paths.splice(Math.max(0, Math.min(toIndex, paths.length)), 0, from)
  commit(conversationId, { ...current, paths })
}

/** Close all except the given path, or everything when no path is supplied. */
export function closeOtherTabs(conversationId: string, keep: string | null): void {
  const current = byConversation.get(conversationId) ?? EMPTY
  const paths = keep === null ? [] : [keep]
  commit(conversationId, {
    paths,
    active: keep,
    preview: current.preview === keep ? keep : null,
  })
}

export function closeTab(conversationId: string, path: string): void {
  const current = byConversation.get(conversationId) ?? EMPTY
  const index = current.paths.indexOf(path)
  if (index === -1) return

  const paths = current.paths.filter((entry) => entry !== path)
  commit(conversationId, {
    paths,
    // Closing the active tab selects its right neighbor, then left, like a browser: jumping to the
    // first tab loses reading context.
    active:
      current.active === path ? (paths[index] ?? paths[index - 1] ?? null) : current.active,
    preview: current.preview === path ? null : current.preview,
  })
}

/**
 * Apply explorer renames or moves, including parent directories: tabs follow their files instead of
 * retaining nonexistent paths.
 */
export function moveTabs(conversationId: string, from: string, to: string): void {
  const current = byConversation.get(conversationId)
  const move = (path: string) =>
    path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : path
  if (!current?.paths.some((path) => move(path) !== path)) return

  commit(conversationId, {
    paths: current.paths.map(move),
    active: current.active === null ? null : move(current.active),
    preview: current.preview === null ? null : move(current.preview),
  })
}
