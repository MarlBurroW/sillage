import { useThreadLayout } from '../../lib/use-thread-layout'
import { PanelEmptyState } from './PanelEmptyState'
import { TooltipButton } from '../ui/Tooltip'
import { AGENT_CAPABILITIES, type AgentKind } from '@sillage/protocol'
import { ArrowLeft, Bot, ChevronRight, Radio, Square, SquareTerminal, Waves } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useMemo, useState, type ReactNode } from 'react'
import { formatBytes } from '../../lib/attachments'
import {
  hasReadableOutput,
  plainTerminalText,
  useBackgroundTaskOutput,
  useStopBackgroundTask,
  type BackgroundWork,
} from '../../lib/background'
import { useTranslate, type MessageKey } from '../../lib/i18n'
import { clearSubAgent, showSubAgent } from '../../lib/panel'
import { subAgentLabel, type SubAgent } from '../../lib/subagents'
import { formatTokens } from '../../lib/tokens'
import { currentPhase } from '../../lib/workflows'
import { buildRows } from '../../lib/tool-rows'
import { ChatThread } from '../chat/ChatThread'
import { TurnActivity } from '../chat/TurnActivity'
import { SubAgentRow } from '../chat/SubAgentRow'
import { EmptyState, cx } from '../ui'
import { WorkflowPhases } from './WorkflowPhases'

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
      <SubAgentThread conversationId={conversationId} agent={selected} canStop={AGENT_CAPABILITIES[agent].stopBackgroundTask} onBack={clearSubAgent} />
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
 * Background work above rather than mixed with subagents. Shell rows open onto the output the CLI
 * kept for them; the others stay inert, since the CLI reports their activity but nothing they wrote.
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
  const canRead = AGENT_CAPABILITIES[agent].readBackgroundOutput
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const { stopping, stop } = useStopBackgroundTask(conversationId)
  const toggle = (taskId: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(taskId)) next.add(taskId)
      return next
    })
  if (tasks.length === 0) return null

  return (
    <section className="mb-1 flex flex-col gap-1">
      <h2 className="px-1 text-[0.6875rem] font-medium uppercase tracking-wide text-ink-faint">
        {t('panel.background.title')}
      </h2>
      {tasks.map((task) => {
        // Display unknown types unchanged rather than forcing a family because CLI versions add new kinds.
        const family = KIND_ALIASES[task.kind.replace(/^local_/, '')]
        const kindLabel = family ? t(KIND_LABELS[family]) : task.kind
        const phase = task.workflow ? currentPhase(task.workflow) : null
        // A workflow's CLI activity names whichever agent reported last, so it hops between them:
        // its script name and phase describe it, and its agents are listed below. CLIs that send no
        // snapshot keep the activity line.
        const subtitle = task.workflow
          ? [kindLabel, task.workflowName, phase ? t('panel.workflow.phase', phase) : null].filter(Boolean).join(' · ')
          : task.summary ?? task.activity ? `${kindLabel} · ${task.summary ?? task.activity}` : kindLabel
        const readable = canRead && hasReadableOutput(task.kind)
        const expanded = readable && open.has(task.id)
        const heading = (
          <>
            <span className="shrink-0 text-accent">
              {family ? KIND_ICONS[family] : <Waves size={13} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs text-ink">{task.description}</span>
              <span className="block truncate text-[0.6875rem] text-ink-faint">{subtitle}</span>
            </span>
          </>
        )
        return (
          <div key={task.id} className="flex flex-col gap-1.5 rounded-md border border-line bg-surface-high px-2 py-1.5">
            <div className="flex items-center gap-2">
              {readable ? (
                <button
                  type="button"
                  onClick={() => toggle(task.id)}
                  aria-expanded={expanded}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <ChevronRight
                    size={12}
                    className={cx('shrink-0 text-ink-faint transition-transform', expanded && 'rotate-90')}
                  />
                  {heading}
                </button>
              ) : (
                heading
              )}

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
            {task.workflow ? (
              <div className="border-t border-line pt-1.5">
                <WorkflowPhases progress={task.workflow} />
              </div>
            ) : null}
            {expanded ? <BackgroundOutput conversationId={conversationId} taskId={task.id} /> : null}
          </div>
        )
      })}
    </section>
  )
}

/**
 * Tail of a background shell, refreshed while open. Follows the end like a terminal unless the
 * reader scrolled up, so new lines never yank them away from what they are reading.
 */
function BackgroundOutput({ conversationId, taskId }: { conversationId: string; taskId: string }) {
  const t = useTranslate()
  const { data, isError, isPending } = useBackgroundTaskOutput(conversationId, taskId, true)
  const scroller = useRef<HTMLPreElement>(null)
  const following = useRef(true)
  const text = useMemo(() => (data ? plainTerminalText(data.output).replace(/\n+$/, '') : ''), [data])

  useLayoutEffect(() => {
    const node = scroller.current
    if (node && following.current) node.scrollTop = node.scrollHeight
  }, [text])
  // A fresh row starts at the end, whatever the previous one left behind.
  useEffect(() => {
    following.current = true
  }, [taskId])

  let body: ReactNode
  if (isError) body = <p className="text-[0.6875rem] text-ink-faint">{t('panel.background.output.unavailable')}</p>
  else if (isPending) body = <p className="text-[0.6875rem] text-ink-faint">{t('panel.background.output.loading')}</p>
  else if (!text) body = <p className="text-[0.6875rem] text-ink-faint">{t('panel.background.output.empty')}</p>
  else
    body = (
      <pre
        ref={scroller}
        onScroll={(event) => {
          const node = event.currentTarget
          following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 8
        }}
        className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[0.6875rem] leading-relaxed text-ink-muted"
      >
        {text}
      </pre>
    )

  return (
    <div className="flex flex-col gap-1 border-t border-line pt-1.5">
      {body}
      {data?.truncated ? (
        <p className="text-[0.625rem] text-ink-faint">
          {t('panel.background.output.truncated', {
            shown: formatBytes(new TextEncoder().encode(data.output).length),
            total: formatBytes(data.totalBytes),
          })}
        </p>
      ) : null}
    </div>
  )
}

function SubAgentThread({
  conversationId,
  agent,
  canStop,
  onBack,
}: {
  conversationId: string
  agent: SubAgent
  /** The conversation's CLI can stop one background task without ending the turn. */
  canStop: boolean
  onBack: () => void
}) {
  const t = useTranslate()
  const { stopping, stop } = useStopBackgroundTask(conversationId)
  const running = agent.status === 'running'
  // Only work detached from its call can be stopped alone: a subagent the turn is waiting on ends
  // with the turn's own stop.
  const stoppable = canStop && running && agent.detached && agent.taskId !== null
  const rows = useMemo(() => buildRows(agent.items, agent.id, running), [agent.items, agent.id, running])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PaneHeader
        onBack={onBack}
        icon={<Bot size={14} className={cx('shrink-0', running ? 'text-accent' : 'text-ink-faint')} />}
        title={subAgentLabel(agent)}
        // The model's own status says what it is after; the mechanical activity sits at the bottom of the thread.
        subtitle={agent.summary ? `${agent.type} · ${agent.summary}` : agent.type}
        subtitleTitle={agent.summary}
      >
        {/* Subagent tokens appear nowhere else: turn usage includes only the main agent. */}
        {agent.totalTokens > 0 ? (
          <span className="shrink-0 text-[0.6875rem] tabular-nums text-ink-faint">
            {t('subagent.tokens', { count: formatTokens(agent.totalTokens) })}
          </span>
        ) : null}

        {stoppable && agent.taskId ? (
          <TooltipButton
            type="button"
            onClick={() => void stop(agent.taskId!)}
            disabled={stopping.has(agent.taskId)}
            title={t('subagent.pane.stop')}
            aria-label={t('subagent.pane.stop')}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-surface hover:text-critical disabled:cursor-default disabled:opacity-40"
          >
            <Square size={12} fill="currentColor" />
          </TooltipButton>
        ) : null}
      </PaneHeader>

      <FollowedThread>
        {(following) => (
          <>
            {rows.length === 0 ? (
              <p className="text-xs text-ink-faint">
                {/* CLI streams subagent work; there is nothing to show before its first output. */}
                {running ? t('subagent.pane.starting') : t('subagent.pane.silent')}
              </p>
            ) : (
              <ChatThread rows={rows} conversationId={conversationId} mayCollapseTools={following} />
            )}
            {running && rows.length > 0 ? <TurnActivity label={agent.activity ?? t('message.thinking.label')} /> : null}
          </>
        )}
      </FollowedThread>
    </div>
  )
}

/** Back button, icon and two lines: the head every thread of the pane shares. */
function PaneHeader({
  onBack,
  icon,
  title,
  subtitle,
  subtitleTitle,
  children,
}: {
  onBack: () => void
  icon: ReactNode
  title: string
  subtitle: string
  /** Full text on hover when the subtitle is cut. */
  subtitleTitle?: string | null
  children?: ReactNode
}) {
  const t = useTranslate()
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1.5">
      <TooltipButton
        type="button"
        onClick={onBack}
        aria-label={t('subagent.pane.back')}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-faint hover:text-ink"
      >
        <ArrowLeft size={15} />
      </TooltipButton>
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-ink">{title}</span>
        {subtitle ? (
          <span className="block truncate text-[0.6875rem] text-ink-faint" title={subtitleTitle ?? undefined}>{subtitle}</span>
        ) : null}
      </span>
      {children}
    </div>
  )
}

/** Scrolling thread that follows its end until the reader scrolls up, like the conversation. */
function FollowedThread({ children }: { children: (following: boolean) => ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  useThreadLayout(scroller, following)
  return (
    <div ref={scroller} className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3" onScroll={(event) => {
      const node = event.currentTarget
      setFollowing(node.scrollHeight - node.scrollTop - node.clientHeight < 48)
    }}>
      <div className="flex flex-col gap-3">{children(following)}</div>
    </div>
  )
}
