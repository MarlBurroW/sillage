import { FocusScope } from '@radix-ui/react-focus-scope'
import { cloneElement, useEffect, useRef, type HTMLAttributes, type ReactElement } from 'react'

// Seul le panneau plein écran au premier plan neutralise le reste de l'interface.
// Recalculer la pile évite que deux panneaux ouverts rendent chacun l'autre inerte.
const modals: HTMLElement[] = []
let restoreOutside = () => {}

function updateModalBackground() {
  restoreOutside()
  const changed: Array<[HTMLElement, boolean]> = []
  let current = modals.at(-1)
  while (current && current.parentElement && current.parentElement !== document.body) {
    for (const sibling of current.parentElement.children) {
      if (!(sibling instanceof HTMLElement) || sibling === current) continue
      changed.push([sibling, sibling.inert])
      sibling.inert = true
    }
    current = current.parentElement
  }
  restoreOutside = () => {
    for (const [element, inert] of changed) element.inert = inert
  }
}

/** Même contenu en panneau libre ou plein écran, sans remonter l'éditeur au redimensionnement. */
export function PanelFocus({ open, modal, onClose, fallbackFocus, protectEditor = false, children }: {
  open: boolean
  modal: boolean
  onClose: () => void
  fallbackFocus?: string
  protectEditor?: boolean
  children: ReactElement<HTMLAttributes<HTMLElement>>
}) {
  const container = useRef<HTMLDivElement>(null)
  const returnTo = useRef<HTMLElement | null>(null)
  const fallback = useRef(fallbackFocus)
  fallback.current = fallbackFocus

  useEffect(() => {
    const node = container.current
    if (!node || !open) return
    const previous = document.activeElement
    if (previous instanceof HTMLElement && previous !== document.body && !node.contains(previous)) returnTo.current = previous
    if (!node.contains(document.activeElement)) {
      node.querySelector<HTMLElement>('[data-panel-initial-focus]')?.focus({ preventScroll: true })
    }
    return () => {
      // Laisser la désactivation du piège de focus et de l'arrière-plan se terminer.
      queueMicrotask(() => {
        const focused = document.activeElement
        if (focused !== document.body && focused?.isConnected && !node.contains(focused)) return
        const candidates = [returnTo.current, ...document.querySelectorAll<HTMLElement>(fallback.current ?? '[data-navigation-trigger]')]
        candidates.find((target) => target?.isConnected && !target.closest('[inert]') && target.getClientRects().length > 0)?.focus({ preventScroll: true })
      })
    }
  }, [open])

  useEffect(() => {
    const node = container.current
    if (!node || !open || !modal) return
    if (!node.contains(document.activeElement)) {
      node.querySelector<HTMLElement>('[data-panel-initial-focus]')?.focus({ preventScroll: true })
    }
    modals.push(node)
    updateModalBackground()
    return () => {
      const index = modals.indexOf(node)
      if (index !== -1) modals.splice(index, 1)
      updateModalBackground()
    }
  }, [open, modal])

  return (
    <FocusScope
      asChild
      ref={container}
      trapped={open && modal}
      loop={open && modal}
      onMountAutoFocus={(event) => event.preventDefault()}
      onUnmountAutoFocus={(event) => event.preventDefault()}
    >
      {cloneElement(children, { onKeyDown: (event) => {
        children.props.onKeyDown?.(event)
        if (!open || event.key !== 'Escape' || event.defaultPrevented) return
        const target = event.target
        if (!(target instanceof HTMLElement) || !container.current?.contains(target)) return
        // Échap reste disponible pour l'autocomplétion et les programmes du terminal.
        if (protectEditor && target.closest('input, textarea, [contenteditable="true"], .cm-editor, .xterm')) return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      } })}
    </FocusScope>
  )
}
