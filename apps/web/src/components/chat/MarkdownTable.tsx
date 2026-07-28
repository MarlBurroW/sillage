import { Sheet } from 'lucide-react'
import { downloadText, toCsv } from '../../lib/download'
import { ToolbarButton } from './CodeBlock'
import { useTranslate } from '../../lib/i18n'

/**
 * Tableau markdown, sur toute la largeur disponible, avec export CSV.
 *
 * Le défilement horizontal est porté par l'enveloppe et non par le tableau lui-même :
 * un `display: block` sur `<table>` casse la mise en page en colonnes, et les
 * cellules cessent de s'aligner dès qu'une ligne est plus longue que les autres.
 */
export function MarkdownTable({ html, rows }: { html: string; rows: string[][] }) {
  const t = useTranslate()
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

      <div className="sg-table-scroll overflow-x-auto" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
