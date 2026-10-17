import * as Dialog from '@radix-ui/react-dialog'
import { ArrowUpRight, Check, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { DecisionDto } from '@sillage/protocol'
import { openDecision, useAnswerDecision, useDecision, useOpenDecision } from '../../lib/decisions'
import { useTranslate } from '../../lib/i18n'
import { Markdown } from '../chat/Markdown'
import { Badge, Banner, Button, IconButton, cx } from '../ui'
import { DecisionSourceLine, decisionDue } from './DecisionSource'
import { decisionContext, decisionOption, decisionQuestion } from './decision-text'

/**
 * La réponse à une décision, d'où qu'on l'ouvre : la sidebar, un toast, l'historique ou
 * une notification. On tranche ici sans entrer dans la conversation, qui reste à un clic.
 */
export function DecisionDialog() {
  const t = useTranslate()
  const id = useOpenDecision()
  const { data: decision, isError } = useDecision(id)

  return (
    <Dialog.Root open={id !== null} onOpenChange={(next) => { if (!next) openDecision(null) }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          className="surface fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-2xl border border-line shadow-pop sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:w-[min(620px,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
        >
          <header className="flex items-start gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-accent">
                {t(!decision || decision.status === 'pending' ? 'decision.dialog.kicker' : `decision.status.${decision.status}`)}
              </p>
              <Dialog.Title className="mt-1 text-lg leading-snug font-semibold text-ink">
                {decision ? decisionQuestion(decision, t) : isError ? t('decision.dialog.missing') : '…'}
              </Dialog.Title>
              {decision ? <DecisionSourceLine decision={decision} className="mt-1.5" /> : null}
            </div>
            <IconButton label={t('common.close')} onClick={() => openDecision(null)}><X size={18} /></IconButton>
          </header>
          {decision ? <DecisionBody key={decision.id} decision={decision} /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function DecisionBody({ decision }: { decision: DecisionDto }) {
  const t = useTranslate()
  const answer = useAnswerDecision()
  const [option, setOption] = useState<string | null>(null)
  const [text, setText] = useState('')
  const pending = decision.status === 'pending'
  // Une proposition de nettoyage se tranche par un choix : pas d'agent à qui écrire.
  const worktree = decision.source.kind === 'worktree'
  const context = decisionContext(decision, t)
  // Tranchée ailleurs pendant qu'on hésitait : on le dit plutôt que d'échouer à l'envoi.
  useEffect(() => { if (!pending) answer.reset() }, [pending]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = () => {
    if (!pending || answer.isPending || (option === null && !text.trim())) return
    answer.mutate({ id: decision.id, option, text: text.trim() })
  }

  return (
    <form className="flex min-h-0 flex-col" onSubmit={(event) => { event.preventDefault(); submit() }}>
      <div className="flex min-h-0 flex-col gap-5 overflow-y-auto p-5 sm:p-6">
        {context ? (
          <div className="min-w-0 rounded-xl border border-line bg-sunken/50 px-4 py-3 text-sm leading-relaxed break-words text-ink-soft">
            <Markdown text={context} />
          </div>
        ) : null}

        {pending ? (
          <>
            {decision.options.length > 0 ? (
              <div role="radiogroup" aria-label={t('decision.dialog.options')} className="flex flex-col gap-2">
                {decision.options.map((entry) => (
                  <button
                    key={entry}
                    type="button"
                    role="radio"
                    aria-checked={option === entry}
                    onClick={() => setOption((current) => (current === entry ? null : entry))}
                    className={cx(
                      'flex min-h-11 items-center gap-2.5 rounded-lg border px-3.5 py-2 text-left text-sm transition-colors',
                      option === entry ? 'border-accent bg-accent-wash text-ink' : 'border-line text-ink-soft hover:border-line-strong hover:bg-surface-high',
                    )}
                  >
                    <span className="min-w-0 flex-1">{decisionOption(decision, entry, t)}</span>
                    {decision.defaultOption === entry ? <Badge>{t('decision.dialog.default')}</Badge> : null}
                    {option === entry ? <Check size={15} className="shrink-0 text-accent" /> : null}
                  </button>
                ))}
              </div>
            ) : null}
            {worktree ? null : <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-soft">
              {t(decision.options.length > 0 ? 'decision.dialog.note' : 'decision.dialog.free')}
              <textarea
                value={text}
                rows={3}
                maxLength={4000}
                placeholder={t('decision.dialog.notePlaceholder')}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit() }}
                className="w-full resize-y rounded-md border border-line bg-sunken px-3 py-2 text-sm font-normal text-ink outline-none placeholder:text-ink-faint focus:border-accent"
              />
            </label>}
            <p className="text-xs text-ink-faint">
              {decisionDue(decision, t)}
              {worktree
                ? ` ${t('decision.worktree.expiry')}`
                : decision.defaultOption
                  ? ` ${t('decision.dialog.fallback', { option: decision.defaultOption })}`
                  : ` ${t('decision.dialog.noFallback')}`}
            </p>
            {answer.isError ? <Banner>{answer.error.message}</Banner> : null}
          </>
        ) : (
          <DecisionOutcome decision={decision} />
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-4">
        <Link
          to={worktree ? `/p/${decision.projectId}#worktrees` : `/p/${decision.projectId}/c/${decision.conversationId}`}
          onClick={() => openDecision(null)}
          className="inline-flex min-h-9 items-center gap-1 text-sm text-ink-faint hover:text-accent"
        >
          {t(worktree ? 'decision.worktree.open' : 'decision.dialog.openSession')}
          <ArrowUpRight size={14} />
        </Link>
        <div className="flex-1" />
        <Button type="button" variant="ghost" onClick={() => openDecision(null)}>{t(pending ? 'decision.dialog.later' : 'common.close')}</Button>
        {pending ? (
          <Button type="submit" disabled={answer.isPending || (option === null && !text.trim())}>
            {t(answer.isPending ? 'decision.dialog.sending' : 'decision.dialog.send')}
          </Button>
        ) : null}
      </footer>
    </form>
  )
}

/** Ce qu'il est advenu d'une décision fermée : la réponse, l'échéance ou le retrait. */
export function DecisionOutcome({ decision }: { decision: DecisionDto }) {
  const t = useTranslate()
  if (decision.status === 'withdrawn') {
    return <Banner tone="info">{decision.withdrawnReason ? t('decision.outcome.withdrawnBecause', { reason: decision.withdrawnReason }) : t('decision.outcome.withdrawn')}</Banner>
  }
  const answer = decision.answer
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-line px-4 py-3 text-sm">
      <p className="text-xs text-ink-faint">
        {decision.status === 'expired'
          ? t('decision.outcome.expired')
          : t('decision.outcome.answered', { name: answer?.byName ?? '?' })}
      </p>
      {answer?.option ? <p className="font-medium text-ink">{decisionOption(decision, answer.option, t)}</p> : null}
      {answer?.text ? <p className="whitespace-pre-wrap text-ink-soft">{answer.text}</p> : null}
      {decision.status === 'expired' && !answer?.option ? <p className="text-ink-soft">{t('decision.outcome.noAnswer')}</p> : null}
    </div>
  )
}
