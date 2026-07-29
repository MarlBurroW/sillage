import { Clock, Paperclip, X } from 'lucide-react'
import { useState } from 'react'
import type { QueuedMessage } from '../../lib/chat-fold'
import { cancelQueuedMessage } from '../../lib/conversations'
import { IconButton, cx } from '../ui'
import { useTranslate } from '../../lib/i18n'

/**
 * Messages écrits pendant qu'un tour est en cours.
 *
 * Affichés sous l'indicateur d'activité, et non dans le fil : leur position dit ce
 * qu'ils sont, c'est-à-dire ce que l'agent n'a pas encore lu. Un message posé au-dessus
 * de l'indicateur laisserait croire qu'il est déjà pris en compte.
 */
export function QueuedMessages({
  conversationId,
  messages,
  canCancel,
}: {
  conversationId: string
  messages: QueuedMessage[]
  canCancel: boolean
}) {
  const t = useTranslate()
  const [busy, setBusy] = useState<string | null>(null)

  if (messages.length === 0) return null

  const cancel = async (queueId: string) => {
    setBusy(queueId)
    try {
      await cancelQueuedMessage(conversationId, queueId)
    } finally {
      // L'événement `message.dequeued` retire l'entrée : on ne l'anticipe pas ici,
      // sinon l'affichage cesserait d'être un pur fold du journal.
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <p className="flex items-center gap-1.5 text-[0.6875rem] text-ink-faint">
        <Clock size={11} />
        {messages.length === 1
          ? 'En attente de la fin du tour'
          : `${messages.length} messages en attente de la fin du tour`}
      </p>

      {messages.map((message) => (
        <div
          key={message.queueId}
          className={cx(
            'group flex max-w-[85%] items-start gap-1 rounded-lg rounded-br-sm',
            'border border-dashed border-line-strong bg-surface/40 px-3 py-2',
            busy === message.queueId && 'opacity-50',
          )}
        >
          <div className="min-w-0">
            <p className="text-sm whitespace-pre-wrap text-ink-soft">{message.text}</p>
            {message.attachmentCount > 0 ? (
              <p className="mt-1 flex items-center gap-1 text-[0.6875rem] text-ink-faint">
                <Paperclip size={11} />
                {t(
                  message.attachmentCount > 1
                    ? 'queued.attachments.many'
                    : 'queued.attachments.one',
                  { count: message.attachmentCount },
                )}
              </p>
            ) : null}
          </div>

          {canCancel ? (
            <IconButton
              label={t('queued.remove')}
              size="sm"
              disabled={busy !== null}
              onClick={() => void cancel(message.queueId)}
              className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
            >
              <X size={14} />
            </IconButton>
          ) : null}
        </div>
      ))}
    </div>
  )
}
