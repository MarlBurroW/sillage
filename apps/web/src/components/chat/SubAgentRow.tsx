import { Bot, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslate } from '../../lib/i18n'
import type { SubAgent } from '../../lib/subagents'
import { subAgentLabel } from '../../lib/subagents'
import { cx } from '../ui'
import { ToolStatusIcon, formatDuration } from './ToolCall'

/** One second: slower ticks look frozen, faster ones add no information. */
const TICK_MS = 1000

/**
 * Elapsed time recalculated while running. Moving timers directly convey liveness; CLI duration
 * arrives only on completion so display must maintain it meanwhile.
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
 * Subagent row shared by thread banners and panel lists. Identical content and destinations need
 * one recognizable component.
 */
export function SubAgentRow({ agent, onSelect }: { agent: SubAgent; onSelect: () => void }) {
  const running = agent.status === 'running'
  const elapsed = useElapsed(agent.startedAt, running)
  const t = useTranslate()

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
          {/*
           * Type identifies the working agent; activity says what it is doing now. Both fit and
           * complement each other.
           */}
          {agent.activity ? `${agent.type} · ${agent.activity}` : agent.type}
        </span>
      </span>

      {agent.toolCount > 0 ? (
        <span className="shrink-0 text-[0.6875rem] text-ink-faint">
          {t(agent.toolCount > 1 ? 'subagent.row.toolCount.other' : 'subagent.row.toolCount.one', {
            count: agent.toolCount,
          })}
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
