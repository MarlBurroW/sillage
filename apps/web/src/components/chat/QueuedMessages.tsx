import { Clock, Paperclip, Waypoints, X } from 'lucide-react'
import { useState } from 'react'
import type { QueuedMessage } from '../../lib/chat-fold'
import { cancelQueuedMessage, steerQueuedMessage } from '../../lib/conversations'
import { IconButton, cx } from '../ui'
import { useTranslate } from '../../lib/i18n'

/**
 * Messages écrits pendant qu'un tour est en cours.
 *
 * Affichés sous l'indicateur d'activité, et non dans le fil : leur position dit ce
 * qu'ils sont, c'est-à-dire ce que l'agent n'a pas encore lu. Un message posé au-dessus
 * de l'indicateur laisserait croire qu'il est déjà pris en compte.
 *
 * Attendre la fin du tour reste le comportement par défaut. Infléchir est le geste qui
 * y déroge, donc il est proposé ici, sur le message déjà écrit et relu, plutôt qu'au
 * moment de la saisie où l'on ne sait pas encore si le tour va durer.
 */
export function QueuedMessages({
  conversationId,
  messages,
  canCancel,
  canSteer,
}: {
  conversationId: string
  messages: QueuedMessage[]
  canCancel: boolean
  canSteer: boolean
}) {
  const t = useTranslate()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (messages.length === 0) return null

  // L'événement `message.dequeued` retire l'entrée : on ne l'anticipe pas ici, sinon
  // l'affichage cesserait d'être un pur fold du journal.
  const run = async (queueId: string, action: () => Promise<unknown>, fallback: string) => {
    setBusy(queueId)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <p className="flex items-center gap-1.5 text-[0.6875rem] text-ink-faint">
        <Clock size={11} />
        {messages.length === 1
          ? t('queued.waiting.one')
          : t('queued.waiting.many', { count: messages.length })}
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

          {/* Visible sans survol, contrairement au retrait : c'est l'action qu'on vient
              chercher ici, et la teinte d'accent la distingue de la croix voisine. */}
          {canSteer ? (
            <IconButton
              label={t('queued.steer')}
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                void run(
                  message.queueId,
                  () => steerQueuedMessage(conversationId, message.queueId),
                  t('queued.steer.failed'),
                )
              }
              className="text-accent hover:bg-accent-wash hover:text-accent"
            >
              <Waypoints size={15} />
            </IconButton>
          ) : null}

          {canCancel ? (
            <IconButton
              label={t('queued.remove')}
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                void run(
                  message.queueId,
                  () => cancelQueuedMessage(conversationId, message.queueId),
                  t('queued.remove.failed'),
                )
              }
              className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
            >
              <X size={14} />
            </IconButton>
          ) : null}
        </div>
      ))}

      {error ? (
        <p role="alert" className="max-w-[85%] text-[0.6875rem] text-critical">
          {error}
        </p>
      ) : null}
    </div>
  )
}
