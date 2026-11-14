import { setPanelTree } from './panel'

/** Palettes may close before the panel or its network-loaded file has appeared. */
export function focusEditorFile(path: string): void {
  const focus = () => {
    const panel = document.querySelector<HTMLElement>('[data-panel="workspace"]')
    const file = Array.from(panel?.querySelectorAll<HTMLElement>('[data-editor-file]') ?? [])
      .find((node) => node.dataset.editorFile === path)
    if (!panel || !file) return false
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
