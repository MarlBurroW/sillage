import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { findRanges, supportsHighlight } from '../../lib/find-in-page'
import { useTranslate } from '../../lib/i18n'
import { cx } from '../ui'

/** Noms des registres de surlignage, à tenir en accord avec `::highlight()` dans le CSS. */
const ALL = 'sg-find'
const CURRENT = 'sg-find-current'

/** Marge au-dessus d'une occurrence atteinte : collée en haut, on perd son contexte. */
const SCROLL_MARGIN_PX = 96

function clearHighlights(): void {
  if (!supportsHighlight()) return
  CSS.highlights.delete(ALL)
  CSS.highlights.delete(CURRENT)
}

/**
 * Recherche dans la conversation ouverte.
 *
 * Tout se passe côté client : le fil est déjà chargé en entier, donc interroger le
 * serveur reviendrait à redemander ce qu'on a sous les yeux.
 *
 * Le surlignage passe par l'API Custom Highlight, qui colore des plages sans modifier
 * le document. Insérer des balises casserait le rendu markdown et les blocs de code ;
 * là où l'API manque, le défilement et l'anneau du message suffisent à situer
 * l'occurrence.
 */
export function ThreadSearch({
  scroller,
  open,
  onClose,
  /** Change à chaque événement reçu : les occurrences sont alors recalculées. */
  revision,
}: {
  scroller: RefObject<HTMLDivElement | null>
  open: boolean
  onClose: () => void
  revision: number
}) {
  const [query, setQuery] = useState('')
  const [count, setCount] = useState(0)
  const [index, setIndex] = useState(0)
  const ranges = useRef<Range[]>([])
  const input = useRef<HTMLInputElement>(null)
  const t = useTranslate()

  // Les plages appartiennent au DOM du fil : elles ne survivent ni à sa fermeture ni à
  // un changement de conversation.
  useEffect(() => clearHighlights, [])

  /**
   * Échap ferme depuis n'importe où, pas seulement depuis le champ : après un clic sur
   * « suivant », le focus est sur le bouton, et la barre restait ouverte.
   */
  useEffect(() => {
    if (!open) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  useEffect(() => {
    if (open) input.current?.focus()
    else {
      clearHighlights()
      setQuery('')
      setCount(0)
      setIndex(0)
      ranges.current = []
    }
  }, [open])

  /** Relit les occurrences dans le fil tel qu'il est affiché à cet instant. */
  const refresh = useCallback((): Range[] => {
    const container = scroller.current
    const found = container ? findRanges(container, query) : []

    ranges.current = found
    setCount(found.length)
    // La position est conservée tant qu'elle existe encore : un tour qui se termine
    // pendant qu'on lit ne doit pas ramener à la première occurrence.
    setIndex((current) => (current < found.length ? current : 0))

    if (supportsHighlight()) {
      if (found.length === 0) clearHighlights()
      else CSS.highlights.set(ALL, new Highlight(...found))
    }

    return found
  }, [query, scroller])

  useEffect(() => {
    if (open) refresh()
  }, [open, refresh, revision])

  /** Met une occurrence au premier plan et l'amène dans la zone visible. */
  useEffect(() => {
    const container = scroller.current
    if (!open || !container) return

    // Une plage repliée signale que le fil a été redessiné depuis la dernière lecture :
    // le navigateur réancre alors la plage sur le parent, et la position est perdue.
    const range = ranges.current[index]?.collapsed ? refresh()[index] : ranges.current[index]
    if (!range) return

    if (supportsHighlight()) CSS.highlights.set(CURRENT, new Highlight(range))

    const target = range.getBoundingClientRect()
    const view = container.getBoundingClientRect()
    if (target.top < view.top + SCROLL_MARGIN_PX || target.bottom > view.bottom) {
      container.scrollBy({ top: target.top - view.top - SCROLL_MARGIN_PX })
    }
  }, [index, count, open, refresh, scroller])

  if (!open) return null

  const step = (direction: 1 | -1) => {
    if (count === 0) return
    setIndex((current) => (current + direction + count) % count)
    // Le focus revient au champ : après un clic sur les flèches, la frappe suivante
    // doit continuer la recherche plutôt que se perdre.
    input.current?.focus()
  }

  return (
    <div
      className={cx(
        'surface sticky top-[var(--header-height)] z-10 flex shrink-0 items-center gap-2',
        'border-b border-line px-3 py-1.5',
      )}
    >
      <Search size={15} className="shrink-0 text-ink-faint" />
      <input
        ref={input}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            step(event.shiftKey ? -1 : 1)
          }
        }}
        placeholder={t('thread.search.placeholder')}
        className="h-8 min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
      />

      <span className="shrink-0 text-xs text-ink-faint tabular-nums">
        {query.trim() === ''
          ? ''
          : count === 0
            ? t('thread.search.noResults')
            : t('thread.search.position', { index: index + 1, count })}
      </span>

      <button
        type="button"
        onClick={() => step(-1)}
        disabled={count === 0}
        aria-label={t('thread.search.previous')}
        className="flex size-7 shrink-0 items-center justify-center rounded text-ink-faint hover:text-ink disabled:opacity-40"
      >
        <ChevronUp size={15} />
      </button>
      <button
        type="button"
        onClick={() => step(1)}
        disabled={count === 0}
        aria-label={t('thread.search.next')}
        className="flex size-7 shrink-0 items-center justify-center rounded text-ink-faint hover:text-ink disabled:opacity-40"
      >
        <ChevronDown size={15} />
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label={t('thread.search.close')}
        className="flex size-7 shrink-0 items-center justify-center rounded text-ink-faint hover:text-ink"
      >
        <X size={15} />
      </button>
    </div>
  )
}
