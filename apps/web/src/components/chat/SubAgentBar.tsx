import { Bot, ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { useTranslate } from '../../lib/i18n'
import { showSubAgent } from '../../lib/panel'
import type { SubAgent } from '../../lib/subagents'
import { cx } from '../ui'
import { SubAgentRow } from './SubAgentRow'

/**
 * Sous-agents en cours, posés juste au-dessus de la barre de saisie.
 *
 * Hors du fil et non à sa fin : un sous-agent tourne pendant des minutes, et le fil
 * principal n'avance pas pendant ce temps. Placé dans le flux, l'indicateur partait
 * hors de l'écran dès qu'on remontait lire ce qui précède, et la conversation avait
 * alors toutes les apparences d'une session au repos.
 */
export function SubAgentBar({ agents }: { agents: SubAgent[] }) {
  const [open, setOpen] = useState(false)
  const t = useTranslate()
  if (agents.length === 0) return null

  const label = t(
    agents.length > 1 ? 'subagent.bar.count.other' : 'subagent.bar.count.one',
    { count: agents.length },
  )

  return (
    <div className="border-t border-line bg-surface-high/60">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-ink-soft"
      >
        <span className="relative flex size-4 shrink-0 items-center justify-center text-accent">
          <Bot size={14} />
          <span className="absolute -top-0.5 -right-0.5 size-1.5 animate-pulse rounded-full bg-accent" />
        </span>
        <span className="font-medium text-ink">{label}</span>
        {/* Ce que fait le premier suffit quand il n'y en a qu'un ; au-delà, la liste
            dépliée est le seul endroit où l'information reste attribuable. */}
        {agents.length === 1 && agents[0]?.activity ? (
          <span className="min-w-0 flex-1 truncate text-ink-faint">{agents[0].activity}</span>
        ) : (
          <span className="flex-1" />
        )}
        <ChevronDown
          size={14}
          className={cx('shrink-0 text-ink-faint transition-transform', open && 'rotate-180')}
        />
      </button>

      {open ? (
        <div className="flex flex-col gap-1 px-2 pb-2">
          {agents.map((agent) => (
            <SubAgentRow key={agent.id} agent={agent} onSelect={() => showSubAgent(agent.id)} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
