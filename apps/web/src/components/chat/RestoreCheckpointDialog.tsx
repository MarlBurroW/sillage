import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { TurnCheckpoint } from '../../lib/chat-fold'
import { restoreCheckpoint } from '../../lib/checkpoints'
import { forkConversation } from '../../lib/conversations'
import { useRefreshGit } from '../../lib/git'
import { useTranslate } from '../../lib/i18n'
import { Banner, ConfirmDialog } from '../ui'

/**
 * Confirm restoring workspace state before a turn. Files change without the agent knowing, so offer
 * forking immediately before its message: the new agent never saw those files and the original
 * message becomes an editable draft.
 */
export function RestoreCheckpointDialog({
  conversationId,
  checkpoint,
  openerText,
  onClose,
}: {
  conversationId: string
  /** Null when closed. */
  checkpoint: TurnCheckpoint | null
  /** Opening message text reused as the fork draft. */
  openerText: string
  onClose: () => void
}) {
  const t = useTranslate()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const refresh = useRefreshGit(conversationId)
  const [fork, setFork] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset on every opening: a checkbox choice for one turn does not apply to the next.
  useEffect(() => {
    if (checkpoint) {
      setFork(false)
      setError(null)
    }
  }, [checkpoint])

  const confirm = async () => {
    if (!checkpoint) return
    setBusy(true)
    setError(null)
    try {
      await restoreCheckpoint(conversationId, checkpoint.key)
      refresh()
      if (fork) {
        // Cut immediately before the turn message, after its preceding before-snapshot.
        const branch = await forkConversation(conversationId, checkpoint.seq)
        void queryClient.invalidateQueries({ queryKey: ['conversations'] })
        onClose()
        navigate(`/p/${branch.projectId}/c/${branch.id}`, { state: { draft: openerText } })
        return
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('checkpoint.restore.error'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ConfirmDialog
      open={checkpoint !== null}
      onOpenChange={(next) => {
        if (!next && !busy) onClose()
      }}
      title={t('checkpoint.restore.confirm.title')}
      confirmLabel={t('checkpoint.restore.confirm.action')}
      tone="critical"
      busy={busy}
      onConfirm={() => void confirm()}
    >
      <p>
        {checkpoint && checkpoint.files.length > 1
          ? t('checkpoint.restore.confirm.body.many', { count: checkpoint.files.length })
          : t('checkpoint.restore.confirm.body.one')}
      </p>
      <p>{t('checkpoint.restore.confirm.commits')}</p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={fork}
          disabled={busy}
          onChange={(event) => setFork(event.target.checked)}
        />
        <span>
          <span className="font-medium">{t('checkpoint.restore.fork.label')}</span>
          <br />
          <span className="text-ink-faint">{t('checkpoint.restore.fork.hint')}</span>
        </span>
      </label>
      {error ? <Banner>{error}</Banner> : null}
    </ConfirmDialog>
  )
}
