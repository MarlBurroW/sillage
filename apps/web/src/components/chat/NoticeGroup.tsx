import { Info, TriangleAlert } from 'lucide-react'
import type { NoticeRow } from '../../lib/notice-rows'
import { noticeText } from '../../lib/chat-fold'
import { useTranslate } from '../../lib/i18n'
import { cx } from '../ui'

export function NoticeGroup({ row }: { row: NoticeRow }) {
  const t = useTranslate()
  const warning = row.level === 'warning'
  const Icon = warning ? TriangleAlert : Info
  const count = row.entries.length
  const label = warning
    ? count === 1 ? t('notice.warning') : t('notice.warnings', { count })
    : count === 1 ? t('notice.info') : t('notice.infos', { count })
  return (
    <details className="min-w-0 text-sm" data-agent-notices={row.level}>
      <summary className={cx(
        'flex min-h-9 cursor-pointer list-none items-center gap-2 py-1 outline-none [&::-webkit-details-marker]:hidden focus-visible:ring-2 focus-visible:ring-accent',
        warning ? 'text-caution' : 'text-ink-soft',
      )}>
        <Icon size={15} className="shrink-0" aria-hidden="true" />
        <span>{label}</span>
        <span className="text-xs text-ink-faint">· {t('notice.details')}</span>
      </summary>
      <div className="mt-1 space-y-3 border-l border-line py-1 pl-3 text-ink-soft">
        {row.entries.map(({ item, occurrences }) => (
          <div key={item.id} className="min-w-0">
            <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{noticeText(item)}</p>
            {occurrences > 1 && <p className="mt-1 text-xs text-ink-faint">{t('notice.occurrences', { count: occurrences })}</p>}
            {item.details != null && (
              <details className="mt-1 text-xs">
                <summary className="cursor-pointer">{t('notice.technicalDetails')}</summary>
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  {typeof item.details === 'string' ? item.details : JSON.stringify(item.details, null, 2)}
                </pre>
              </details>
            )}
          </div>
        ))}
      </div>
    </details>
  )
}
