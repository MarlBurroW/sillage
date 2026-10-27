import { useState } from 'react'
import { Banner, Button } from '../ui'
import { useTranslate } from '../../lib/i18n'
import { Markdown } from './Markdown'

/** A prepared continuation already has context, even before its first user message. */
export function ContinuationIntro({ text, canStart, onStart }: { text: string; canStart: boolean; onStart: () => Promise<void> }) {
  const t = useTranslate()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(text.length <= 2000)
  const start = async () => {
    setPending(true)
    setError(null)
    try { await onStart() }
    catch (err) { setError(err instanceof Error ? err.message : t('conversation.handoff.error')) }
    finally { setPending(false) }
  }
  return <section className="flex flex-col gap-4 rounded-lg border border-line p-4 md:p-5">
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">{t('conversation.continuation.ready')}</h2>
      <p className="text-sm text-ink-soft">{t('conversation.continuation.description')}</p>
      {canStart ? <Button className="self-start" disabled={pending} onClick={() => void start()}>
        {t(pending ? 'conversation.continuation.starting' : 'conversation.continuation.start')}
      </Button> : null}
    </div>
    {error ? <Banner>{error}</Banner> : null}
    <details open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm font-medium">{t('conversation.continuation.context')}</summary>
      {expanded ? <div className="mt-3 min-w-0 break-words"><Markdown text={text} /></div> : null}
    </details>
  </section>
}
