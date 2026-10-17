import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { DecisionDto, DecisionStatus } from '@sillage/protocol'
import { MobileNavigationButton } from '../components/MobileNavigation'
import { DecisionSourceLine, decisionDue } from '../components/decisions/DecisionSource'
import { Badge, EmptyState, cx } from '../components/ui'
import { openDecision, useDecisions } from '../lib/decisions'
import { useTranslate, type MessageKey } from '../lib/i18n'
import { decisionOption, decisionQuestion } from '../components/decisions/decision-text'

const STATUS: Record<DecisionStatus, { label: MessageKey; tone: 'accent' | 'positive' | 'neutral' | 'caution' }> = {
  pending: { label: 'decision.status.pending', tone: 'accent' },
  answered: { label: 'decision.status.answered', tone: 'positive' },
  expired: { label: 'decision.status.expired', tone: 'caution' },
  withdrawn: { label: 'decision.status.withdrawn', tone: 'neutral' },
}

/**
 * Les décisions du compte : celles qui attendent, puis l'historique de ce qui a été
 * tranché, par qui, ou laissé à l'échéance. `?open=` ouvre une décision : c'est
 * l'adresse que suivent les notifications.
 */
export function DecisionsPage() {
  const t = useTranslate()
  const [params, setParams] = useSearchParams()
  const [view, setView] = useState<'pending' | 'all'>('pending')
  const { data: decisions, isPending } = useDecisions(view)

  useEffect(() => {
    const open = params.get('open')
    if (!open) return
    openDecision(open)
    const next = new URLSearchParams(params)
    next.delete('open')
    setParams(next, { replace: true })
  }, [params, setParams])

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6 md:px-8">
      <header className="flex items-center gap-3">
        <MobileNavigationButton />
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight">{t('decision.page.title')}</h1>
          <p className="text-sm text-ink-faint">{t('decision.page.description')}</p>
        </div>
      </header>
      <div role="tablist" className="flex gap-5 border-b border-line">
        {(['pending', 'all'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={view === value}
            onClick={() => setView(value)}
            className={cx('min-h-11 border-b-2 text-sm font-medium transition-colors', view === value ? 'border-accent text-accent' : 'border-transparent text-ink-faint hover:text-ink')}
          >
            {t(value === 'pending' ? 'decision.page.pending' : 'decision.page.all')}
          </button>
        ))}
      </div>
      {isPending ? null : !decisions || decisions.length === 0 ? (
        <EmptyState title={t(view === 'pending' ? 'decision.page.emptyPending' : 'decision.page.empty')} description={t('decision.page.emptyHint')} />
      ) : (
        <ul className="flex flex-col gap-2">
          {decisions.map((decision) => <DecisionRow key={decision.id} decision={decision} />)}
        </ul>
      )}
    </div>
  )
}

function DecisionRow({ decision }: { decision: DecisionDto }) {
  const t = useTranslate()
  const status = STATUS[decision.status]
  return (
    <li>
      <button type="button" onClick={() => openDecision(decision.id)} className="surface flex w-full flex-col gap-1.5 rounded-xl border border-line px-4 py-3 text-left hover:border-line-strong">
        <span className="flex items-start gap-2">
          <span className="min-w-0 flex-1 text-sm font-medium text-ink">{decisionQuestion(decision, t)}</span>
          <Badge tone={status.tone}>{t(status.label)}</Badge>
        </span>
        <DecisionSourceLine decision={decision} />
        {decision.status === 'pending' ? <span className="text-xs text-ink-faint">{decisionDue(decision, t)}</span> : null}
        {decision.answer && (decision.answer.option || decision.answer.text) ? (
          <span className="truncate text-xs text-ink-soft">→ {[decision.answer.option ? decisionOption(decision, decision.answer.option, t) : null, decision.answer.text].filter(Boolean).join(' — ')}</span>
        ) : null}
      </button>
    </li>
  )
}
