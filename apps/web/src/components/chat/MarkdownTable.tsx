import { Sheet } from 'lucide-react'
import { useEffect, useRef, type RefObject } from 'react'
import { downloadText, toCsv } from '../../lib/download'
import { ToolbarButton } from './CodeBlock'
import { useTranslate } from '../../lib/i18n'

/**
 * Constrain mouse selection to its starting cell. Chromium otherwise switches to whole-cell
 * selection once pointers leave, turning three-word selection into a jumping grid.
 * user-select:contain is unsupported (verified Chromium 151), so clamp the selection end to the
 * cell edge while pressed. Preserve selections starting outside tables; full tables remain copyable
 * through CSV.
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
      // Selection left the cell: clamp to the nearest exit edge.
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
 * Full-width Markdown table with CSV export. Wrapper owns horizontal scrolling: display:block on
 * table breaks column layout and cells stop aligning with differently sized rows.
 */
export function MarkdownTable({ html, rows }: { html: string; rows: string[][] }) {
  const t = useTranslate()
  const scroll = useRef<HTMLDivElement>(null)
  useContainedCellSelection(scroll)
  return (
    <div className="overflow-hidden rounded-md border border-line">
      <div className="flex items-center gap-1 border-b border-line px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-[0.6875rem] text-ink-faint">
          {/* The first row is the header, not data. */}
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
