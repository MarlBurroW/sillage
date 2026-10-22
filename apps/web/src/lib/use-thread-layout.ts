import { useLayoutEffect, type RefObject } from 'react'

/**
 * Les variations tardives (repli, image, coloration) gardent le contenu lu au même endroit.
 * On observe le contenu plutôt que le viewport, dont les dimensions ne changent pas au repli.
 */
export function useThreadLayout(scroller: RefObject<HTMLElement | null>, follow: boolean, enabled = true) {
  useLayoutEffect(() => {
    const node = scroller.current
    const content = node?.firstElementChild
    if (!node || !content || !enabled) return
    let anchors: { element: HTMLElement; offset: number }[] = []
    let capturedHeight = node.scrollHeight
    const capture = () => {
      capturedHeight = node.scrollHeight
      const bounds = node.getBoundingClientRect()
      anchors = Array.from(node.querySelectorAll<HTMLElement>('[data-seq], [data-tool-id], [data-tool-sequence][data-folded="true"]'))
        .map((element) => ({ element, offset: element.getBoundingClientRect().top - bounds.top }))
        .filter(({ element, offset }) => element.getBoundingClientRect().bottom > bounds.top && offset < node.clientHeight)
        .slice(0, 4)
    }
    const restore = () => {
      if (follow) node.scrollTop = node.scrollHeight - node.clientHeight
      else {
        const anchor = anchors.find(({ element }) => element.isConnected && element.getClientRects().length > 0)
        if (anchor) {
          const delta = anchor.element.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.offset
          if (Math.abs(delta) > 0.5) node.scrollTop += delta
        }
      }
      capture()
    }
    capture()
    const observer = new ResizeObserver(restore)
    observer.observe(content)
    // Un scroll causé par le changement de hauteur peut précéder ResizeObserver.
    // Garder le repère précédent jusqu’à sa correction, plutôt que mémoriser le saut.
    const onScroll = () => { if (node.scrollHeight === capturedHeight) capture() }
    node.addEventListener('scroll', onScroll, { passive: true })
    return () => { observer.disconnect(); node.removeEventListener('scroll', onScroll) }
  }, [scroller, follow, enabled])
}
