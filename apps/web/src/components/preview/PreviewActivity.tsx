import { useState } from 'react'
import { Check, Copy, ExternalLink, MonitorOff, MonitorPlay, Share2, X } from 'lucide-react'
import type { PreviewTargetDto } from '@sillage/protocol'
import { copyText } from '../../lib/clipboard'
import { useConversationPreviews, useDismissStoppedPreview, useOpenPreviewInTab, usePreviews } from '../../lib/previews'
import { useTranslate } from '../../lib/i18n'
import { showPreview } from '../../lib/panel'
import { Button, IconButton } from '../ui'
import { PreviewShareDialog } from './PreviewShareDialog'

/**
 * Thread-bottom shortcut to the dev servers this conversation started. Nobody discovers the
 * Preview tab on their own: as soon as one of the conversation's servers listens, this line says so
 * and opens it. The agent titles its servers, points at a page and leaves out those nobody opens
 * (APIs, workers) with `describe_preview`, so the card that matters is not lost among others. A
 * titled server that stops leaves a line saying so, until dismissed or started again; untitled ones
 * (often throwaway helpers) just disappear.
 */
export function PreviewActivity({ conversationId }: { conversationId: string }) {
  const { data } = usePreviews()
  const enabled = !!data && data.mode !== 'unconfigured'
  const { data: seen } = useConversationPreviews(conversationId, enabled)
  if (!enabled) return null
  const own = data.targets.filter((target) => target.conversationId === conversationId)
  const running = own.filter((target) => !target.hidden)
  const stopped = (seen ?? []).filter((entry) => !own.some((target) => target.port === entry.port))
  if (running.length === 0 && stopped.length === 0) return null
  return (
    <div data-preview-activity className="flex flex-col gap-2 py-1.5">
      {running.map((target) => <RunningCard key={target.port} target={target} proxy={data.mode === 'proxy'} />)}
      {stopped.map((entry) => <StoppedLine key={entry.port} conversationId={conversationId} port={entry.port} title={entry.title} />)}
    </div>
  )
}

function RunningCard({ target, proxy }: { target: PreviewTargetDto; proxy: boolean }) {
  const t = useTranslate()
  const openTab = useOpenPreviewInTab()
  const [copied, setCopied] = useState(false)
  const [sharing, setSharing] = useState(false)
  const address = target.address
  return (
    // The actions go under the text when the card is narrow, so the address keeps its width.
    <div data-preview-card className="flex max-w-xl flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent"><MonitorPlay size={18} /></span>
      <div className="min-w-0 flex-1 basis-52">
        <p className="line-clamp-2 break-words text-sm font-medium text-ink">{target.title ?? t('preview.activity.ready')}</p>
        {address ? (
          // A real link, so it can be copied; a click goes through the signed sign-in link, which
          // the bare address lacks the first time.
          <a href={address} target="_blank" rel="noreferrer" title={t('preview.activity.openTab')}
            className="flex min-w-0 items-center gap-1 text-xs text-ink-soft hover:text-accent hover:underline"
            onClick={(event) => {
              event.preventDefault()
              openTab.open(target.port, target.path)
            }}>
            <span className="truncate font-mono">{address.replace(/^https?:\/\//, '').replace(/\/$/, '')}</span>
            <ExternalLink size={11} className="shrink-0" />
          </a>
        ) : null}
        <p className="truncate text-xs text-ink-faint">:{target.port} · {target.label}</p>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {address ? (
          <IconButton label={copied ? t('preview.copied') : t('preview.copy')} size="sm"
            onClick={() => void copyText(address).then((ok) => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500) } })}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </IconButton>
        ) : null}
        {/* Public demo links need the proxy: Desktop has no public address to hand out. */}
        {proxy ? <IconButton label={t('preview.share')} size="sm" onClick={() => setSharing(true)}><Share2 size={14} /></IconButton> : null}
        <Button onClick={() => showPreview(target.port)}>{t('preview.activity.open')}</Button>
      </div>
      {sharing ? <PreviewShareDialog port={target.port} label={target.title ?? target.label} onClose={() => setSharing(false)} /> : null}
    </div>
  )
}

function StoppedLine({ conversationId, port, title }: { conversationId: string; port: number; title: string }) {
  const t = useTranslate()
  const dismiss = useDismissStoppedPreview(conversationId)
  return (
    <div data-preview-stopped className="flex max-w-xl items-center gap-2 rounded-lg border border-dashed border-line px-3 py-1.5 text-xs text-ink-faint">
      <MonitorOff size={14} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-ink-soft">{title}</span> · {t('preview.activity.stopped')} · :{port}
      </span>
      <IconButton label={t('preview.activity.dismiss')} size="sm" className="shrink-0" disabled={dismiss.isPending} onClick={() => dismiss.mutate(port)}><X size={12} /></IconButton>
    </div>
  )
}
