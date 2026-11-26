import { ExternalLink, MonitorPlay } from 'lucide-react'
import { useOpenPreviewInTab, usePreviews } from '../../lib/previews'
import { useTranslate } from '../../lib/i18n'
import { showPreview } from '../../lib/panel'
import { Button } from '../ui'

/**
 * Thread-bottom shortcut to the dev servers this conversation started. Nobody discovers the
 * Preview tab on their own: as soon as one of the conversation's servers listens, this line says so
 * and opens it, until the server stops. The agent titles its servers and leaves out those nobody
 * opens (APIs, workers) with `describe_preview`, so the card that matters is not lost among others.
 */
export function PreviewActivity({ conversationId }: { conversationId: string }) {
  const t = useTranslate()
  const { data } = usePreviews()
  const openTab = useOpenPreviewInTab()
  if (!data || data.mode === 'unconfigured') return null
  const own = data.targets.filter((target) => target.conversationId === conversationId && !target.hidden)
  if (own.length === 0) return null
  return (
    <div data-preview-activity className="flex flex-col gap-2 py-1.5">
      {own.map((target) => (
        <div key={target.port} className="flex max-w-xl items-center gap-3 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent"><MonitorPlay size={18} /></span>
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 break-words text-sm font-medium text-ink">{target.title ?? t('preview.activity.ready')}</p>
            {target.address ? (
              // A real link, so it can be copied; a click goes through the signed sign-in link, which the
              // bare address lacks the first time.
              <a href={target.address} target="_blank" rel="noreferrer" title={t('preview.activity.openTab')}
                className="flex min-w-0 items-center gap-1 text-xs text-ink-soft hover:text-accent hover:underline"
                onClick={(event) => {
                  event.preventDefault()
                  openTab.open(target.port)
                }}>
                <span className="truncate font-mono">{target.address.replace(/^https?:\/\//, '').replace(/\/$/, '')}</span>
                <ExternalLink size={11} className="shrink-0" />
              </a>
            ) : null}
            <p className="truncate text-xs text-ink-faint">:{target.port} · {target.label}</p>
          </div>
          <Button onClick={() => showPreview(target.port)}>{t('preview.activity.open')}</Button>
        </div>
      ))}
    </div>
  )
}
