import { useThreadLayout } from '../../lib/use-thread-layout'
import { PanelEmptyState } from './PanelEmptyState'
import { TooltipButton } from '../ui/Tooltip'
import { AGENT_CAPABILITIES, type AgentKind } from '@sillage/protocol'
import { ArrowLeft, Bot, Radio, Square, SquareTerminal, Waves } from 'lucide-react'
import { useRef, useMemo, useState, type ReactNode } from 'react'
import type { BackgroundWork } from '../../lib/background'
import { stopBackgroundTask } from '../../lib/conversations'
import { useTranslate, type MessageKey } from '../../lib/i18n'
import { clearSubAgent, showSubAgent } from '../../lib/panel'
import { subAgentLabel, type SubAgent } from '../../lib/subagents'
import { formatTokens } from '../../lib/tokens'
import { buildRows } from '../../lib/tool-rows'
import { ChatThread } from '../chat/ChatThread'
import { SubAgentRow } from '../chat/SubAgentRow'
import { EmptyState, cx } from '../ui'

/**
 * Conversation subagents: list and selected thread. Share rendering with the main thread: messages,
 * reasoning, and calls are the same content and should not require synchronized duplicate views.
 */
export function AgentsPane({
  conversationId,
  agent,
  agents,
  background,
  selectedId,
}: {
  conversationId: string
  /** Conversation CLI determining whether background tasks can be stopped. */
  agent: AgentKind
  agents: SubAgent[]
  /** Work continuing outside turns without openable threads because the CLI supplies no content. */
  background: BackgroundWork[]
  selectedId: string | null
}) {
  const t = useTranslate()
  const selected = agents.find((agent) => agent.id === selectedId) ?? null

  if (selected) {
    return (
      <SubAgentThread conversationId={conversationId} agent={selected} onBack={clearSubAgent} />
    )
  }

  if (agents.length === 0 && background.length === 0) {
    return (
      <PanelEmptyState>
        <EmptyState
          title={t('subagent.pane.empty.title')}
          description={t('subagent.pane.empty.description')}
        />
      </PanelEmptyState>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
      <BackgroundList conversationId={conversationId} agent={agent} tasks={background} />
      {agents.map((agent) => (
        <div key={agent.id} className={cx(agent.parentId && 'pl-3')}>
          <SubAgentRow agent={agent} onSelect={() => showSubAgent(agent.id)} />
        </div>
      ))}
    </div>
  )
}

type BackgroundFamily = 'workflow' | 'shell' | 'subagent' | 'monitor'

/**
 * CLI names for task families. SDK documents readable names (shell, subagent), while version 2.1
 * emits raw discriminants (local_bash, local_agent). Strip local_ before lookup to cover both.
 */
const KIND_ALIASES: Record<string, BackgroundFamily | undefined> = {
  workflow: 'workflow',
  bash: 'shell',
  shell: 'shell',
  agent: 'subagent',
  subagent: 'subagent',
  mcp_task: 'monitor',
  monitor: 'monitor',
}

const KIND_ICONS: Record<BackgroundFamily, ReactNode> = {
  workflow: <Waves size={13} />,
  shell: <SquareTerminal size={13} />,
  subagent: <Bot size={13} />,
  monitor: <Radio size={13} />,
}

const KIND_LABELS: Record<BackgroundFamily, MessageKey> = {
  workflow: 'panel.background.kind.workflow',
  shell: 'panel.background.kind.shell',
  subagent: 'panel.background.kind.subagent',
  monitor: 'panel.background.kind.monitor',
}

/**
 * Background work above rather than mixed with subagents. The CLI reports activity but no written
 * output, so inert rows accurately avoid promising nonexistent detail.
 */
function BackgroundList({
  conversationId,
  agent,
  tasks,
}: {
  conversationId: string
  agent: AgentKind
  tasks: BackgroundWork[]
}) {
  const t = useTranslate()
  const canStop = AGENT_CAPABILITIES[agent].stopBackgroundTask
  /**
   * Stop replies do not confirm termination: tasks disappear on the next background.updated. Keep
   * the button pending meanwhile to avoid repeated stop requests.
   */
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set())
  if (tasks.length === 0) return null

  const stop = async (taskId: string) => {
    setStopping((prev) => new Set(prev).add(taskId))
    try {
      await stopBackgroundTask(conversationId, taskId)
    } catch {
      // Server rejection (session ended or task already closed) restores interaction; the log keeps
      // the list authoritative.
      setStopping((prev) => {
        const next = new Set(prev)
        next.delete(taskId)
        return next
      })
    }
  }

  return (
    <section className="mb-1 flex flex-col gap-1">
      <h2 className="px-1 text-[0.6875rem] font-medium uppercase tracking-wide text-ink-faint">
        {t('panel.background.title')}
      </h2>
      {tasks.map((task) => {
        // Display unknown types unchanged rather than forcing a family because CLI versions add new kinds.
        const family = KIND_ALIASES[task.kind.replace(/^local_/, '')]
        return (
          <div
            key={task.id}
            className="flex items-center gap-2 rounded-md border border-line bg-surface-high px-2 py-1.5"
          >
            <span className="shrink-0 text-accent">
              {family ? KIND_ICONS[family] : <Waves size={13} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs text-ink">{task.description}</span>
              <span className="block truncate text-[0.6875rem] text-ink-faint">
                {/* Family identifies work kind; activity describes its current action. Both fit on the row. */}
                {task.activity
                  ? `${family ? t(KIND_LABELS[family]) : task.kind} · ${task.activity}`
                  : family
                    ? t(KIND_LABELS[family])
                    : task.kind}
              </span>
            </span>

            {task.toolUses > 0 ? (
              <span className="shrink-0 text-[0.6875rem] tabular-nums text-ink-faint">
                {t(task.toolUses > 1 ? 'panel.background.tools.many' : 'panel.background.tools.one', {
                  count: task.toolUses,
                })}
              </span>
            ) : null}

            {canStop ? (
              <TooltipButton
                type="button"
                onClick={() => void stop(task.id)}
                disabled={stopping.has(task.id)}
                title={t('panel.background.stop')}
                aria-label={t('panel.background.stop')}
                className="shrink-0 rounded p-1 text-ink-faint transition-colors hover:bg-surface hover:text-critical disabled:cursor-default disabled:opacity-40"
              >
                <Square size={11} fill="currentColor" />
              </TooltipButton>
            ) : null}
          </div>
        )
      })}
    </section>
  )
}

function SubAgentThread({
  conversationId,
  agent,
  onBack,
}: {
  conversationId: string
  agent: SubAgent
  onBack: () => void
}) {
  const t = useTranslate()
  const scroller = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  useThreadLayout(scroller, following)
  const rows = useMemo(() => buildRows(agent.items, agent.id, agent.status === 'running'), [agent.items, agent.id, agent.status])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1.5">
        <TooltipButton
          type="button"
          onClick={onBack}
          aria-label={t('subagent.pane.back')}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-faint hover:text-ink"
        >
          <ArrowLeft size={15} />
        </TooltipButton>
        <Bot size={14} className={cx('shrink-0', agent.status === 'running' ? 'text-accent' : 'text-ink-faint')} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-ink">{subAgentLabel(agent)}</span>
          <span className="block truncate text-[0.6875rem] text-ink-faint">
            {agent.activity ? `${agent.type} · ${agent.activity}` : agent.type}
          </span>
        </span>

        {/* Subagent tokens appear nowhere else: turn usage includes only the main agent. */}
        {agent.totalTokens > 0 ? (
          <span className="shrink-0 text-[0.6875rem] tabular-nums text-ink-faint">
            {t('subagent.tokens', { count: formatTokens(agent.totalTokens) })}
          </span>
        ) : null}
      </div>

      <div ref={scroller} className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3" onScroll={(event) => {
        const node = event.currentTarget
        setFollowing(node.scrollHeight - node.scrollTop - node.clientHeight < 48)
      }}><div className="flex flex-col gap-3">
        {rows.length === 0 ? (
          <p className="text-xs text-ink-faint">
            {/* CLI streams subagent work; there is nothing to show before its first output. */}
            {agent.status === 'running'
              ? t('subagent.pane.starting')
              : t('subagent.pane.silent')}
          </p>
        ) : (
          <ChatThread rows={rows} conversationId={conversationId} mayCollapseTools={following} />
        )}
      </div></div>
    </div>
  )
}
