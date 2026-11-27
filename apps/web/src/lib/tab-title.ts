import { useEffect, useState } from 'react'
import { liveStatus, subscribeStatus } from './conversation-status'

/**
 * The browser tab says what waits without opening it: `(2)` for sessions waiting on the user, `✓`
 * when the open conversation finished while the tab was in the background, and a dot on the icon
 * for either. Desktop shows the same title in its window and ignores the icon.
 */

const BRAND = 'Sillage'

// The mark of public/favicon.svg, drawn again with a dot: an SVG keeps it sharp at every size.
const MARK = '<path d="M4 79C28 79 20 21 46 21H59C35 21 43 79 17 79Z"/><path d="M23 79C47 79 39 21 65 21H78C54 21 62 79 36 79Z"/><path d="M42 79C66 79 58 21 84 21H97C73 21 81 79 55 79Z"/>'
const DOT_COLORS = { awaiting: '#f59e0b', done: '#22c55e' } as const

function badgedIcon(dot: keyof typeof DOT_COLORS): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>:root{--mark:#535cda}@media (prefers-color-scheme: dark){:root{--mark:#8f9bff}}</style><g fill="var(--mark)" opacity="0.85">${MARK}</g><circle cx="78" cy="24" r="21" fill="${DOT_COLORS[dot]}" stroke="#fff" stroke-width="5"/></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/** Original links, restored when nothing is left to signal. */
const originals = new Map<HTMLLinkElement, { href: string; type: string }>()

function setIcon(dot: keyof typeof DOT_COLORS | null): void {
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')) {
    if (!originals.has(link)) originals.set(link, { href: link.getAttribute('href') ?? '', type: link.type })
    const original = originals.get(link)!
    // Every icon link carries the badge: browsers differ on which of the SVG and PNG they pick.
    const href = dot ? badgedIcon(dot) : original.href
    if (link.getAttribute('href') !== href) link.setAttribute('href', href)
    link.type = dot ? 'image/svg+xml' : original.type
  }
}

/** Whether the open conversation finished a turn since the tab was last seen. */
function useFinishedUnseen(openId: string | undefined): boolean {
  const [finished, setFinished] = useState(false)
  useEffect(() => {
    setFinished(false)
    if (!openId) return
    let previous = liveStatus(openId)
    const unsubscribe = subscribeStatus(() => {
      const current = liveStatus(openId)
      if (previous === 'running' && current === 'idle' && document.visibilityState === 'hidden') setFinished(true)
      previous = current
    })
    const onVisible = () => { if (document.visibilityState === 'visible') setFinished(false) }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      unsubscribe()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [openId])
  return finished
}

export function useTabTitle({ awaiting, title, openId }: { awaiting: number; title: string | null; openId: string | undefined }): void {
  const finished = useFinishedUnseen(openId)
  useEffect(() => {
    const marks = `${awaiting > 0 ? `(${awaiting}) ` : ''}${finished ? '✓ ' : ''}`
    document.title = `${marks}${title ? `${title} · ` : ''}${BRAND}`
  }, [awaiting, finished, title])
  useEffect(() => {
    setIcon(awaiting > 0 ? 'awaiting' : finished ? 'done' : null)
  }, [awaiting, finished])
  useEffect(() => () => {
    document.title = BRAND
    setIcon(null)
  }, [])
}
