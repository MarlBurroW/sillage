import { Copy } from 'lucide-react'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ConversationShareDto } from '@sillage/protocol'
import { api } from '../../../lib/api'
import { locale, useTranslate } from '../../../lib/i18n'
import { useCopy } from '../../../lib/clipboard'
import { Banner, Button, ConfirmDialog, IconButton } from '../../ui'

export function SharedLinks({ conversationId }: { conversationId: string }) {
  const t = useTranslate()
  const client = useQueryClient()
  const [removing, setRemoving] = useState<ConversationShareDto | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const shares = useQuery({ queryKey: ['conversation-shares', conversationId], queryFn: () => api.get<ConversationShareDto[]>('/api/conversations/' + conversationId + '/shares') })
  const revoke = async () => {
    if (!removing) return
    setBusy(true)
    try {
      await api.delete('/api/conversation-shares/' + removing.id)
      setRemoving(null)
      await client.invalidateQueries({ queryKey: ['conversation-shares', conversationId] })
    } catch (error) { setError(error instanceof Error ? error.message : t('export.failed')) }
    finally { setBusy(false) }
  }
  return <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
    <p className="mx-auto mb-4 max-w-3xl text-sm leading-relaxed text-ink-faint">{t('export.links.hint')}</p>
    {(error || shares.error) && <Banner>{error || shares.error?.message}</Banner>}
    {shares.error && <Button size="sm" variant="ghost" onClick={() => void shares.refetch()}>{t('export.retry')}</Button>}
    {shares.isPending && <p role="status" className="text-sm text-ink-faint">{t('export.preparing')}</p>}
    {!shares.isPending && !shares.error && !shares.data?.length && <p className="py-10 text-center text-sm text-ink-faint">{t('export.links.none')}</p>}
    <div className="mx-auto max-w-3xl divide-y divide-line">
      {shares.data?.map(share => {
        const status = share.revokedAt ? 'revoked' : share.expiresAt && share.expiresAt <= Date.now() ? 'expired' : 'active'
        return <article key={share.id} className="flex flex-wrap items-center gap-3 py-4">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-medium">{share.title}</h3>
            <p className="mt-1 text-xs text-ink-faint">{t(('export.links.' + status) as 'export.links.active')} · {t('export.links.created', { date: new Date(share.createdAt).toLocaleDateString(locale()) })}</p>
            {status === 'active' && share.url && <a href={share.url} target="_blank" rel="noreferrer" className="mt-1 block truncate text-xs text-accent">{share.url}</a>}
            <p className="mt-1 text-xs text-ink-faint">{t('export.expiry')}: {share.expiresAt ? new Date(share.expiresAt).toLocaleDateString(locale()) : t('export.expiry.never')}</p>
          </div>
          {status === 'active' && <>
            {share.url && <CopyLink url={share.url} />}
            <Button variant="danger" size="sm" onClick={() => setRemoving(share)}>{t('export.revoke')}</Button>
          </>}
        </article>
      })}
    </div>
    <ConfirmDialog open={!!removing} onOpenChange={open => { if (!open) setRemoving(null) }} title={t('export.revoke.title')} confirmLabel={t('export.revoke')} tone="critical" busy={busy} onConfirm={() => void revoke()}>
      {t('export.revoke.description')}
    </ConfirmDialog>
  </div>
}

function CopyLink({ url }: { url: string }) {
  const t = useTranslate()
  const copy = useCopy()
  return <span className="flex flex-col items-end gap-1">
    <IconButton label={t(copy.state === 'copied' ? 'export.copied' : 'export.copy')} onClick={() => copy.copy(url)}><Copy size={17} /></IconButton>
    {copy.state !== 'idle' && <span role="status" className="max-w-44 text-xs text-ink-faint">{t(copy.state === 'copied' ? 'export.copied' : 'export.copyFailed')}</span>}
  </span>
}
