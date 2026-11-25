import * as Dialog from '@radix-ui/react-dialog'
import { Check, Copy, Link2, X } from 'lucide-react'
import { useState } from 'react'
import { PREVIEW_SHARE_HOURS, type PreviewShareDto } from '@sillage/protocol'
import { copyText } from '../../lib/clipboard'
import { useCreatePreviewShare, usePreviewShares, useRevokePreviewShare } from '../../lib/previews'
import { formatDateTime } from '../../lib/schedules'
import { useTranslate } from '../../lib/i18n'
import { Banner, Button, IconButton, Segmented } from '../ui'

type Hours = (typeof PREVIEW_SHARE_HOURS)[number]

/**
 * Public demo links to a dev server, for people without a Sillage account: create one with a
 * lifetime, copy it, revoke it. The link only works while the server runs.
 */
export function PreviewShareDialog({ port, label, onClose }: { port: number; label: string; onClose: () => void }) {
  const t = useTranslate()
  const { data: shares = [] } = usePreviewShares()
  const create = useCreatePreviewShare()
  const revoke = useRevokePreviewShare()
  const [hours, setHours] = useState<Hours>(24)
  const now = Date.now()
  const forPort = shares.filter((share) => share.port === port)
  const active = forPort.filter((share) => share.revokedAt === null && share.expiresAt > now)
  const ended = forPort.filter((share) => !active.includes(share))

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby="preview-share-description"
          data-preview-share-dialog
          className="surface fixed inset-x-3 top-[max(1rem,10vh)] z-50 mx-auto flex max-h-[80vh] max-w-lg flex-col overflow-hidden rounded-lg border border-line shadow-pop"
        >
          <header className="flex items-start gap-3 border-b border-line px-4 py-3">
            <Link2 size={18} className="mt-0.5 shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-sm font-semibold">{t('previewShare.title')}</Dialog.Title>
              <p id="preview-share-description" className="text-xs text-ink-faint">{t('previewShare.description', { port, label })}</p>
            </div>
            <Dialog.Close asChild><IconButton label={t('previewShare.close')} size="sm"><X size={15} /></IconButton></Dialog.Close>
          </header>
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-ink-soft">{t('previewShare.lifetime')}</span>
              <Segmented<string>
                label={t('previewShare.lifetime')}
                value={String(hours)}
                onChange={(value) => setHours(Number(value) as Hours)}
                options={PREVIEW_SHARE_HOURS.map((value) => ({ value: String(value), label: t(`previewShare.hours.${value}`), text: t(`previewShare.hours.${value}`) }))}
              />
              <Button onClick={() => create.mutate({ port, hours })} disabled={create.isPending}>{t('previewShare.create')}</Button>
            </div>
            {create.error ? <Banner tone="critical">{create.error.message}</Banner> : null}
            <Banner tone="caution">{t('previewShare.warning')}</Banner>

            {active.length ? (
              <section className="flex flex-col gap-2" aria-label={t('previewShare.active')}>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{t('previewShare.active')}</h3>
                {active.map((share) => <ShareRow key={share.id} share={share} onRevoke={() => revoke.mutate(share.id)} revoking={revoke.isPending} />)}
              </section>
            ) : null}
            {ended.length ? (
              <section className="flex flex-col gap-2" aria-label={t('previewShare.ended')}>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{t('previewShare.ended')}</h3>
                {ended.map((share) => <ShareRow key={share.id} share={share} />)}
              </section>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ShareRow({ share, onRevoke, revoking }: { share: PreviewShareDto; onRevoke?: () => void; revoking?: boolean }) {
  const t = useTranslate()
  const [copied, setCopied] = useState(false)
  const status = share.revokedAt !== null
    ? t('previewShare.revokedAt', { date: formatDateTime(share.revokedAt) })
    : share.expiresAt <= Date.now()
      ? t('previewShare.expiredAt', { date: formatDateTime(share.expiresAt) })
      : t('previewShare.expiresAt', { date: formatDateTime(share.expiresAt) })
  return (
    <div data-preview-share className="flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className={onRevoke ? 'truncate font-mono text-xs text-ink' : 'truncate font-mono text-xs text-ink-faint line-through'}>{share.url}</p>
        <p className="text-[11px] text-ink-faint">{status}</p>
      </div>
      {onRevoke ? (
        <>
          <IconButton label={copied ? t('previewShare.copied') : t('previewShare.copy')} size="sm"
            onClick={() => { void copyText(share.url).then((ok) => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500) } }) }}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </IconButton>
          <Button variant="ghost" disabled={revoking} onClick={onRevoke}>{t('previewShare.revoke')}</Button>
        </>
      ) : null}
    </div>
  )
}
