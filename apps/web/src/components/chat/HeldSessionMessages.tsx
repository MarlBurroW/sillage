import { Hand, Send, X } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { parseSessionMessage } from '@sillage/protocol'
import type { HeldSessionMessage } from '../../lib/chat-fold'
import { discardSessionMessage, releaseSessionMessage } from '../../lib/conversations'
import { useTranslate } from '../../lib/i18n'
import { Button, cx } from '../ui'
import { Markdown } from './Markdown'

/**
 * Messages d'autres sessions que Sillage a retenus au lieu de relancer celle-ci.
 *
 * Sous l'indicateur d'activité, comme la file : l'agent ne les a pas lus. Retenus parce
 * qu'un échange tournait en rond ou que la session avait déjà été trop relancée sans
 * personne pour regarder ; c'est donc à une personne de trancher, et ce bloc est le seul
 * endroit où elle l'apprend.
 */
export function HeldSessionMessages({
  conversationId,
  messages,
  canDecide,
}: {
  conversationId: string
  messages: HeldSessionMessage[]
  canDecide: boolean
}) {
  const t = useTranslate()
  const { projectId } = useParams()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (messages.length === 0) return null

  // L'événement `session_message.released` retire l'entrée : rien n'est anticipé ici.
  const run = async (messageId: string, action: () => Promise<unknown>, fallback: string) => {
    setBusy(messageId)
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
    <div className="flex flex-col items-start gap-1.5">
      {messages.map((message) => {
        const envelope = parseSessionMessage(message.text)
        const sender = envelope ? envelope.title || envelope.from : '?'
        return (
          <div
            key={message.messageId}
            className={cx(
              'flex max-w-[85%] min-w-0 flex-col gap-1.5 rounded-lg rounded-bl-sm',
              'border border-dashed border-line-strong bg-surface/40 px-3.5 py-2.5',
              busy === message.messageId && 'opacity-50',
            )}
          >
            <p className="flex min-w-0 items-center gap-1.5 text-xs text-ink-soft">
              <Hand size={13} className="shrink-0 text-ink-faint" />
              <span className="shrink-0">{t('sessionMessage.held.from')}</span>
              {envelope && projectId ? (
                <Link
                  to={`/p/${projectId}/c/${envelope.from}`}
                  className="min-w-0 truncate font-medium text-ink hover:text-accent hover:underline"
                >
                  {sender}
                </Link>
              ) : (
                <span className="min-w-0 truncate font-medium text-ink">{sender}</span>
              )}
            </p>
            <p className="text-[0.6875rem] text-ink-faint">
              {t(message.reason === 'loop' ? 'sessionMessage.held.loop' : 'sessionMessage.held.rate')}
            </p>
            <div className="text-ink-soft">
              <Markdown text={envelope?.body ?? message.text} />
            </div>

            {canDecide ? (
              <div className="flex items-center gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Send size={14} />}
                  disabled={busy !== null}
                  onClick={() =>
                    void run(
                      message.messageId,
                      () => releaseSessionMessage(conversationId, message.messageId),
                      t('sessionMessage.release.failed'),
                    )
                  }
                >
                  {t('sessionMessage.release')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<X size={14} />}
                  disabled={busy !== null}
                  onClick={() =>
                    void run(
                      message.messageId,
                      () => discardSessionMessage(conversationId, message.messageId),
                      t('sessionMessage.discard.failed'),
                    )
                  }
                >
                  {t('sessionMessage.discard')}
                </Button>
              </div>
            ) : null}
          </div>
        )
      })}

      {error ? (
        <p role="alert" className="max-w-[85%] text-[0.6875rem] text-critical">
          {error}
        </p>
      ) : null}
    </div>
  )
}
