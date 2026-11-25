import { MonitorPlay } from 'lucide-react'
import { usePreviews } from '../../lib/previews'
import { useTranslate } from '../../lib/i18n'
import { showPreview } from '../../lib/panel'
import { Button } from '../ui'

/**
 * Thread-bottom shortcut to the dev servers this conversation started. Nobody discovers the
 * Preview tab on their own: as soon as one of the conversation's servers listens, this line says so
 * and opens it, until the server stops.
 */
export function PreviewActivity({ conversationId }: { conversationId: string }) {
  const t = useTranslate()
  const { data } = usePreviews()
  if (!data || data.mode === 'unconfigured') return null
  const own = data.targets.filter((target) => target.conversationId === conversationId)
  if (own.length === 0) return null
  return (
    <div data-preview-activity className="flex flex-col gap-2 py-1.5">
      {own.map((target) => (
        <div key={target.port} className="flex max-w-xl items-center gap-3 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent"><MonitorPlay size={18} /></span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink">{t('preview.activity.ready')}</p>
            <p className="truncate text-xs text-ink-faint">:{target.port} · {target.label}</p>
          </div>
          <Button onClick={() => showPreview(target.port)}>{t('preview.activity.open')}</Button>
        </div>
      ))}
    </div>
  )
}
