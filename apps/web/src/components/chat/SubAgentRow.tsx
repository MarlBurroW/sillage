import { Bot, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SubAgent } from '../../lib/subagents'
import { subAgentLabel } from '../../lib/subagents'
import { cx } from '../ui'
import { ToolStatusIcon, formatDuration } from './ToolCall'

/** Une seconde : au-delà le chronomètre paraît figé, en deçà il ne dit rien de plus. */
const TICK_MS = 1000

/**
 * Temps écoulé depuis le lancement, réévalué tant que le sous-agent tourne.
 *
 * Un chronomètre qui avance est le signal le plus direct qu'il se passe encore
 * quelque chose : la durée n'est publiée par le CLI qu'à la fin de l'appel, donc
 * jusque-là c'est à l'affichage de la tenir.
 */
function useElapsed(startedAt: number, running: boolean): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [running])

  return Math.max(now - startedAt, 0)
}

/**
 * Une ligne de sous-agent, dans le bandeau du fil comme dans la liste du panneau.
 *
 * Les deux montrent la même chose et mènent au même endroit : un seul composant, pour
 * qu'un sous-agent se reconnaisse à l'identique d'une vue à l'autre.
 */
export function SubAgentRow({ agent, onSelect }: { agent: SubAgent; onSelect: () => void }) {
  const running = agent.status === 'running'
  const elapsed = useElapsed(agent.startedAt, running)

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cx(
        'flex w-full items-center gap-2 rounded-md border border-line bg-surface/60',
        'px-2 py-1.5 text-left text-xs transition-colors hover:border-line-strong',
      )}
    >
      <Bot size={14} className={cx('shrink-0', running ? 'text-accent' : 'text-ink-faint')} />

      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-ink">{subAgentLabel(agent)}</span>
        <span className="truncate text-[0.6875rem] text-ink-faint">
          {/* Le type dit quel agent travaille, l'activité ce qu'il fait à l'instant :
              les deux tiennent sur la ligne et se complètent. */}
          {agent.activity ? `${agent.type} · ${agent.activity}` : agent.type}
        </span>
      </span>

      {agent.toolCount > 0 ? (
        <span className="shrink-0 text-[0.6875rem] text-ink-faint">
          {agent.toolCount} outil{agent.toolCount > 1 ? 's' : ''}
        </span>
      ) : null}

      <span className="shrink-0 text-[0.6875rem] tabular-nums text-ink-faint">
        {formatDuration(running ? elapsed : (agent.durationMs ?? elapsed))}
      </span>

      <ToolStatusIcon status={agent.status} />

      <ChevronRight size={14} className="shrink-0 text-ink-faint" />
    </button>
  )
}
