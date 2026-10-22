import { useSyncExternalStore } from 'react'

/**
 * Open editor tabs per conversation. Outside React because the explorer opens tabs displayed by the
 * editor across separate panel tabs; lifting state would propagate every tree keystroke through the
 * parent. Deliberately not persisted: files may disappear between sessions, and starting empty is
 * preferable to reopening errors.
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

function emit(): void {
  for (const listener of listeners) listener()
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
    byConversation.set(conversationId, {
      ...current,
      active: path,
      // Explicitly reopening a preview means choosing to keep it.
      preview: !preview && current.preview === path ? null : current.preview,
    })
    emit()
    return
  }

  // Replace the preview in place rather than at the end: earlier tabs must not move while browsing files.
  const replacing = preview && current.preview !== null ? current.paths.indexOf(current.preview) : -1
  const paths = [...current.paths]
  if (replacing === -1) paths.push(path)
  else paths[replacing] = path

  byConversation.set(conversationId, {
    paths,
    active: path,
    preview: preview ? path : current.preview,
  })
  emit()
}

/** Promote a preview to a regular tab so the next preview cannot replace it. */
export function pinTab(conversationId: string, path: string): void {
  const current = byConversation.get(conversationId) ?? EMPTY
  if (current.preview !== path) return
  byConversation.set(conversationId, { ...current, preview: null })
  emit()
}

export function activateTab(conversationId: string, path: string): void {
  const current = byConversation.get(conversationId) ?? EMPTY
  if (current.active === path) return
  byConversation.set(conversationId, { ...current, active: path })
  emit()
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
  byConversation.set(conversationId, { ...current, paths })
  emit()
}

/** Close all except the given path, or everything when no path is supplied. */
export function closeOtherTabs(conversationId: string, keep: string | null): void {
  const current = byConversation.get(conversationId) ?? EMPTY
  const paths = keep === null ? [] : [keep]
  byConversation.set(conversationId, {
    paths,
    active: keep,
    preview: current.preview === keep ? keep : null,
  })
  emit()
}

export function closeTab(conversationId: string, path: string): void {
  const current = byConversation.get(conversationId) ?? EMPTY
  const index = current.paths.indexOf(path)
  if (index === -1) return

  const paths = current.paths.filter((entry) => entry !== path)
  byConversation.set(conversationId, {
    paths,
    // Closing the active tab selects its right neighbor, then left, like a browser: jumping to the
    // first tab loses reading context.
    active:
      current.active === path ? (paths[index] ?? paths[index - 1] ?? null) : current.active,
    preview: current.preview === path ? null : current.preview,
  })
  emit()
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

  byConversation.set(conversationId, {
    paths: current.paths.map(move),
    active: current.active === null ? null : move(current.active),
    preview: current.preview === null ? null : move(current.preview),
  })
  emit()
}
