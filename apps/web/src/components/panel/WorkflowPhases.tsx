import type { WorkflowAgent, WorkflowAgentState, WorkflowProgress } from '@sillage/protocol'
import { ChevronRight, Circle, CircleCheck, CircleDot, CircleX } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslate, type MessageKey } from '../../lib/i18n'
import { formatTokens } from '../../lib/tokens'
import { workflowPhaseGroups } from '../../lib/workflows'
import { Tooltip } from '../ui/Tooltip'
import { cx } from '../ui'

/**
 * `stopped` is the panel's own: a workflow that ended leaves its last snapshot, where agents cut
 * short still read as running or queued.
 */
type ShownState = WorkflowAgentState | 'stopped'

function shownState(agent: WorkflowAgent, ended: boolean): ShownState {
  return ended && (agent.state === 'running' || agent.state === 'queued') ? 'stopped' : agent.state
}

const STATE_ICONS: Record<ShownState, ReactNode> = {
  stopped: <Circle size={11} className="text-ink-faint" />,
  queued: <Circle size={11} className="text-ink-faint" />,
  running: <CircleDot size={11} className="animate-pulse text-accent" />,
  done: <CircleCheck size={11} className="text-positive" />,
  error: <CircleX size={11} className="text-critical" />,
}

const STATE_LABELS: Record<ShownState, MessageKey> = {
  stopped: 'panel.workflow.agent.stopped',
  queued: 'panel.workflow.agent.queued',
  running: 'panel.workflow.agent.running',
  done: 'panel.workflow.agent.done',
  error: 'panel.workflow.agent.error',
}

/**
 * A workflow's phases in script order, each with its agents. Upcoming phases stay listed, dimmed:
 * they answer "what is left", which the CLI's single rotating description cannot. With
 * `onOpenAgent`, agents whose transcript is known open their thread.
 */
export function WorkflowPhases({ progress, ended = false, onOpenAgent }: {
  progress: WorkflowProgress
  /** The workflow is over: agents its snapshot still shows working were stopped. */
  ended?: boolean
  onOpenAgent?: (agentId: string) => void
}) {
  const t = useTranslate()
  return (
    <div className="flex flex-col gap-1.5">
      {workflowPhaseGroups(progress).map((group) => (
        <section key={group.index ?? 'loose'} className="flex flex-col gap-0.5">
          <h3
            className={cx(
              'flex items-baseline gap-1.5 px-1 text-[0.625rem] font-medium uppercase tracking-wide',
              group.agents.length > 0 ? 'text-ink-soft' : 'text-ink-faint opacity-70',
            )}
          >
            <span className="truncate">{group.title ?? t('panel.workflow.loose')}</span>
            {group.agents.length === 0 ? (
              <span className="shrink-0 font-normal normal-case tracking-normal">
                {t('panel.workflow.upcoming')}
              </span>
            ) : null}
          </h3>
          {group.agents.map((agent) => (
            <AgentLine key={agent.index} agent={agent} ended={ended} onOpen={onOpenAgent && agent.agentId && agent.state !== 'queued' ? () => onOpenAgent(agent.agentId!) : undefined} />
          ))}
        </section>
      ))}
    </div>
  )
}

/** What an agent is doing and its state line, shared by its row and its thread's header. */
export function workflowAgentDetails(agent: WorkflowAgent, t: ReturnType<typeof useTranslate>, ended = false): { doing: string; details: string } {
  // The error replaces the last tool: once failed, why matters more than what it was doing.
  const doing = agent.state === 'error' && agent.error
    ? agent.error
    : [agent.lastTool, agent.lastToolSummary].filter(Boolean).join(' · ')
  const details = [
    t(STATE_LABELS[shownState(agent, ended)]),
    agent.model,
    agent.attempt > 1 ? t('panel.workflow.attempt', { count: agent.attempt }) : null,
    agent.toolCalls > 0 ? t('panel.workflow.agent.calls', { count: agent.toolCalls }) : null,
    agent.tokens > 0 ? t('panel.workflow.agent.tokens', { count: formatTokens(agent.tokens) }) : null,
  ].filter(Boolean).join(' · ')
  return { doing, details }
}

function AgentLine({ agent, ended, onOpen }: { agent: WorkflowAgent; ended: boolean; onOpen?: () => void }) {
  const t = useTranslate()
  // Tooltips do not open on touch screens: a tap unfolds the same details in place.
  const [open, setOpen] = useState(false)
  const shown = shownState(agent, ended)
  const state = t(STATE_LABELS[shown])
  const { doing, details } = workflowAgentDetails(agent, t, ended)

  return (
    <div className="flex flex-col">
      <Tooltip
        disabled={open}
        label={<><span className="block">{details}</span>{doing ? <span className="block break-all font-mono text-ink-faint">{doing}</span> : null}</>}
      >
        {/* An agent with a thread opens it, whose header repeats these details for touch screens. */}
        <button
          type="button"
          onClick={onOpen ?? (() => setOpen(!open))}
          aria-expanded={onOpen ? undefined : open}
          aria-label={`${agent.label} — ${details}${doing ? ` — ${doing}` : ''}`}
          className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[0.6875rem] hover:bg-surface focus-visible:bg-surface"
        >
          <span className="shrink-0" role="img" aria-label={state}>{STATE_ICONS[shown]}</span>
          <span className={cx('shrink-0 font-medium', agent.state === 'queued' ? 'text-ink-faint' : 'text-ink')}>
            {agent.label}
          </span>
          <span
            className={cx(
              'min-w-0 flex-1 truncate',
              agent.state === 'error' ? 'text-critical' : 'font-mono text-ink-faint',
            )}
          >
            {doing}
          </span>
          {agent.attempt > 1 ? (
            <span className="shrink-0 text-caution">{t('panel.workflow.attempt', { count: agent.attempt })}</span>
          ) : null}
          {agent.tokens > 0 ? (
            <span className="shrink-0 tabular-nums text-ink-faint">{formatTokens(agent.tokens)}</span>
          ) : null}
          {onOpen ? <ChevronRight size={12} className="shrink-0 text-ink-faint" /> : null}
        </button>
      </Tooltip>
      {open ? (
        <div className="ml-[1.125rem] flex flex-col gap-0.5 px-1 pb-1 text-[0.6875rem] text-ink-faint">
          <span>{details}</span>
          {doing ? (
            <span className={cx('break-all', agent.state === 'error' ? 'text-critical' : 'font-mono')}>{doing}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
