import type { CurrentUser } from '@sillage/protocol'
import { useQueryClient } from '@tanstack/react-query'
import { openTab, restoreTabs } from './editor-tabs'
import { selectExplorerFolder } from './explorer-folders'
import { setPanelOpen, setPanelTab, setPanelTree } from './panel'
import { ME_KEY } from './session'
import { decodeScope, type WorkspaceScope } from './workspace-scope'

/** A link or search result belongs to the workspace where its path was resolved. */
export function useOpenPanelFile() {
  const client = useQueryClient()
  return (scope: WorkspaceScope, path: string) => {
    const user = client.getQueryData<CurrentUser | null>(ME_KEY)
    const { kind } = decodeScope(scope)
    if (user && (kind === 'project' || kind === 'conversation')) selectExplorerFolder(client, user.id, scope, null)
    // The panel may be closed or showing another folder when the link is clicked.
    restoreTabs(scope)
    openTab(scope, path)
    setPanelTab('files')
    setPanelOpen(true)
    const panel = document.querySelector<HTMLElement>('[data-panel="workspace"]')
    if (panel ? panel.clientWidth < 560 : !window.matchMedia('(min-width: 48rem)').matches) {
      setPanelTree(false, false)
    }
  }
}

/** Palettes may close before the panel or its network-loaded file has appeared. */
export function focusEditorFile(scope: WorkspaceScope, path: string): void {
  const focus = () => {
    const panel = document.querySelector<HTMLElement>('[data-panel="workspace"]')
    if (panel?.dataset.filesScope !== scope) return false
    const file = Array.from(panel.querySelectorAll<HTMLElement>('[data-editor-file]'))
      .find((node) => node.dataset.editorFile === path)
    if (!file) return false
    // The tree overlays narrow panels even on desktop; keyboard selection must expose the file.
    if (panel.clientWidth < 560) setPanelTree(false, false)
    const target = file.querySelector<HTMLElement>('.cm-content') ?? file
    target.focus({ preventScroll: true })
    return document.activeElement === target
  }
  if (focus()) return
  const observer = new MutationObserver(() => {
    if (!focus()) return
    observer.disconnect()
    clearTimeout(timer)
  })
  const timer = setTimeout(() => observer.disconnect(), 3000)
  // Visibility changes when the overlaid tree closes, after the editor's DOM already exists.
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'inert'] })
}
