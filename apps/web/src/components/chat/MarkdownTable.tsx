import { Sheet } from 'lucide-react'
import { useEffect, useRef, type RefObject } from 'react'
import { downloadText, toCsv } from '../../lib/download'
import { ToolbarButton } from './CodeBlock'
import { useTranslate } from '../../lib/i18n'

/**
 * Garde une sélection à la souris dans la cellule où elle a commencé.
 *
 * Dès que le curseur sort de la cellule, Chromium bascule en sélection de cellules
 * entières : on voulait trois mots, on se retrouve avec une grille, et la fin de la
 * sélection saute d'une case à l'autre sans suivre le curseur. `user-select: contain`
 * ferait exactement ce qu'on veut, mais Chromium ne le connaît pas (vérifié sur
 * Chromium 151) : on ramène donc la fin de la sélection au bord de la cellule tant que
 * le bouton reste enfoncé. Une sélection commencée hors du tableau n'est pas touchée,
 * et un tableau entier se copie toujours par le bouton CSV.
 */
function useContainedCellSelection(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current
    if (!root) return
    let cell: HTMLElement | null = null

    const clamp = () => {
      const selection = document.getSelection()
      if (!cell || !selection || selection.rangeCount === 0) return
      const { anchorNode, focusNode } = selection
      if (!anchorNode || !focusNode || !cell.contains(anchorNode) || cell.contains(focusNode)) return
      // La fin est sortie : au bord le plus proche de là où elle est partie.
      const after = Boolean(cell.compareDocumentPosition(focusNode) & Node.DOCUMENT_POSITION_FOLLOWING)
      selection.extend(cell, after ? cell.childNodes.length : 0)
    }
    const release = () => {
      cell = null
      document.removeEventListener('selectionchange', clamp)
      document.removeEventListener('mouseup', release)
    }
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return
      cell = event.target.closest('td, th')
      if (!cell) return
      document.addEventListener('selectionchange', clamp)
      document.addEventListener('mouseup', release)
    }

    root.addEventListener('mousedown', onMouseDown)
    return () => {
      root.removeEventListener('mousedown', onMouseDown)
      release()
    }
  }, [ref])
}

/**
 * Tableau markdown, sur toute la largeur disponible, avec export CSV.
 *
 * Le défilement horizontal est porté par l'enveloppe et non par le tableau lui-même :
 * un `display: block` sur `<table>` casse la mise en page en colonnes, et les
 * cellules cessent de s'aligner dès qu'une ligne est plus longue que les autres.
 */
export function MarkdownTable({ html, rows }: { html: string; rows: string[][] }) {
  const t = useTranslate()
  const scroll = useRef<HTMLDivElement>(null)
  useContainedCellSelection(scroll)
  return (
    <div className="overflow-hidden rounded-md border border-line">
      <div className="flex items-center gap-1 border-b border-line px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-[0.6875rem] text-ink-faint">
          {/* La première ligne est l'en-tête : elle ne compte pas comme donnée. */}
          {Math.max(rows.length - 1, 0)} ligne{rows.length > 2 ? 's' : ''}
        </span>
        <ToolbarButton
          label={t('markdown.table.downloadCsv')}
          onClick={() => downloadText('tableau.csv', toCsv(rows), 'text/csv')}
        >
          <Sheet size={13} />
        </ToolbarButton>
      </div>

      <div ref={scroll} className="sg-table-scroll overflow-x-auto" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
