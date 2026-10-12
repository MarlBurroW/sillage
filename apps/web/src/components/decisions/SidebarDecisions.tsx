import { CircleHelp } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { openDecision, useDecisions } from '../../lib/decisions'
import { useTranslate } from '../../lib/i18n'
import { decisionDue } from './DecisionSource'

/** Au-delà, la section renvoie à l'historique : la sidebar ne doit pas devenir la file. */
const SHOWN = 5

/**
 * « À décider » : les décisions demandées par les sessions autonomes. La section
 * n'existe que s'il y en a ; c'est ce qui la rend visible quand elle apparaît.
 */
export function SidebarDecisions({ onNavigate }: { onNavigate: () => void }) {
  const t = useTranslate()
  const { data: decisions } = useDecisions('pending')
  if (!decisions || decisions.length === 0) return null

  return (
    <section aria-label={t('decision.sidebar.heading')} className="mb-2 rounded-xl border border-accent/35 bg-accent-wash/40 p-1.5">
      <div className="flex items-center gap-1.5 px-1.5 py-1 text-[0.6875rem] font-semibold tracking-wider text-accent uppercase">
        <CircleHelp size={12} className="shrink-0" />
        <span className="flex-1">{t('decision.sidebar.heading')}</span>
        <span className="tabular-nums">{decisions.length}</span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {decisions.slice(0, SHOWN).map((decision) => (
          <li key={decision.id}>
            <button
              type="button"
              onClick={() => openDecision(decision.id)}
              className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-surface-high"
            >
              <span className="line-clamp-2 text-sm text-ink">{decision.question}</span>
              <span className="truncate text-[0.6875rem] text-ink-faint">
                {decision.source.label} · {decisionDue(decision, t)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <NavLink to="/decisions" onClick={onNavigate} className="block px-2 pt-1 pb-0.5 text-[0.6875rem] text-ink-faint hover:text-accent">
        {decisions.length > SHOWN ? t('decision.sidebar.more', { count: decisions.length - SHOWN }) : t('decision.sidebar.history')}
      </NavLink>
    </section>
  )
}
