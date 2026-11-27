import type { ReactNode } from 'react'
import { Bot, FilePen, Flame, Globe, Snowflake, Timer, TriangleAlert, Wrench } from 'lucide-react'
import type { StatusBarFormat, UsageWindow } from '@sillage/protocol'
import { AGENT_LABELS, AgentIcon } from '../../AgentIcon'
import { WORKTREE_STATE_TEXT, WorktreeStateIcon } from '../../WorktreeTag'
import { cx } from '../../ui'
import { formatUsd } from '../../../lib/consumption'
import type { Locale, MessageKey, MessageParams } from '../../../lib/i18n'
import { useNow } from '../../../lib/now'
import type { StatusData } from '../../../lib/status-data'
import type { StatusItem } from '../../../lib/status-bar'
import { formatTokens } from '../../../lib/tokens'
import { quotaWindowLabel } from '../../../lib/usage'
import { CRITICAL_RATIO, WARN_RATIO } from '../ContextMeter'
import { untilReset } from '../UsageBar'

/** Where a piece leads when chosen: a dialog of the conversation, or a panel tab. */
export type StatusPlace = 'usage' | 'details' | 'agents' | 'git' | 'preview'

/** One piece of the line. A quota showing every window yields one piece per window. */
export interface StatusPiece {
  id: string
  /** Inline content of the line. */
  node: ReactNode
  /** Row label in the full list (phone sheet, "+N"). */
  name: string
  /** Row value in the full list, roomier than the inline one. */
  value: ReactNode
  /** Tooltip on computers, second line in the list. */
  detail: string
  opens?: StatusPlace
  /** Kept at the far right, and the first to go: the shortcut reminder. */
  end?: boolean
}

export interface PieceContext {
  /** Phones: bars fold into rings and labels shorten, to keep one line. */
  compact: boolean
  t: (key: MessageKey, params?: MessageParams) => string
  locale: Locale
}

type Tone = 'accent' | 'caution' | 'critical'
const TONE_TEXT: Record<Tone, string> = { accent: 'text-ink-soft', caution: 'text-caution', critical: 'text-critical' }
const TONE_BG: Record<Tone, string> = { accent: 'bg-accent', caution: 'bg-caution', critical: 'bg-critical' }
const TONE_RING: Record<Tone, string> = { accent: 'text-accent', caution: 'text-caution', critical: 'text-critical' }

/** The context gauge's thresholds, which the usage panel's bars share. */
function toneOf(ratio: number): Tone {
  return ratio >= CRITICAL_RATIO ? 'critical' : ratio >= WARN_RATIO ? 'caution' : 'accent'
}

export function StatusBarGauge({ ratio, width = 'w-12' }: { ratio: number; width?: string }) {
  return (
    <span aria-hidden className={cx('inline-block h-1.5 shrink-0 overflow-hidden rounded-full bg-surface-high', width)}>
      <span className={cx('block h-full rounded-full', TONE_BG[toneOf(ratio)])} style={{ width: `${Math.round(Math.min(Math.max(ratio, 0), 1) * 100)}%` }} />
    </span>
  )
}

export function StatusBarRing({ ratio }: { ratio: number }) {
  const radius = 5
  const circumference = 2 * Math.PI * radius
  return (
    <svg aria-hidden width={13} height={13} viewBox="0 0 14 14" className={cx('shrink-0', TONE_RING[toneOf(ratio)])}>
      <circle cx="7" cy="7" r={radius} fill="none" stroke="currentColor" strokeWidth="2" opacity="0.22" />
      {/* Rotated to start at noon and fill clockwise, like the composer's gauge. */}
      <circle cx="7" cy="7" r={radius} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
        strokeDasharray={circumference} strokeDashoffset={circumference * (1 - Math.min(Math.max(ratio, 0), 1))} transform="rotate(-90 7 7)" />
    </svg>
  )
}

/** A proportion in the chosen format; phones fold bars into rings. */
function Proportion({ ratio, label, text, format, compact }: { ratio: number; label?: string; text?: string; format: StatusBarFormat; compact: boolean }) {
  const shown = compact && format === 'bar' ? 'ring' : format
  return (
    <span className="flex items-center gap-1.5">
      {label ? <span>{label}</span> : null}
      {shown === 'bar' ? <StatusBarGauge ratio={ratio} /> : null}
      {shown === 'ring' ? <StatusBarRing ratio={ratio} /> : null}
      <span className={cx('tabular-nums', TONE_TEXT[toneOf(ratio)])}>{shown === 'text' && text ? text : `${Math.round(ratio * 100)} %`}</span>
    </span>
  )
}

function ListGauge({ ratio }: { ratio: number }) {
  return (
    <span className="flex items-center gap-2">
      <StatusBarGauge ratio={ratio} width="w-20" />
      <span className={cx('tabular-nums', TONE_TEXT[toneOf(ratio)])}>{Math.round(ratio * 100)} %</span>
    </span>
  )
}

/** A clock face, `2:14` or `1:02:14`: tool durations' `12.0 s` would flicker at each tick. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

/** Ticks only while mounted, that is while a turn runs and the clock is on the line. */
function TurnClock({ startedAt }: { startedAt: number }) {
  const now = useNow(1000)
  return <>{formatClock(now - startedAt)}</>
}

const plural = (count: number, one: MessageKey, many: MessageKey, t: PieceContext['t']) => t(count === 1 ? one : many, { count })

function quotaPiece(window: UsageWindow & { utilization: number }, item: StatusItem, { compact, t }: PieceContext): StatusPiece {
  const label = quotaWindowLabel(window.id, window.label)
  const reset = untilReset(window.resetsAt)
  const percent = Math.round(window.utilization * 100)
  return {
    id: `quota:${window.id}`,
    node: <Proportion ratio={window.utilization} label={label} format={item.format ?? 'bar'} compact={compact} />,
    name: t('statusBar.quota.name', { window: label }),
    value: <ListGauge ratio={window.utilization} />,
    detail: [t('statusBar.quota.detail', { window: window.label, percent }), reset ? t('statusBar.quota.reset', { reset }) : null].filter(Boolean).join(' · '),
    opens: 'usage',
  }
}

/** The pieces an item shows for this session at this moment; none when it has nothing to say. */
export function statusPieces(item: StatusItem, data: StatusData, context: PieceContext): StatusPiece[] {
  if (!item.on) return []
  const { compact, t, locale } = context

  switch (item.key) {
    case 'cli': {
      const warm = data.warm === true
      const state = t(warm ? 'composer.status.warm.label' : 'composer.status.cold.label')
      const icon = warm ? <Flame size={11} /> : <Snowflake size={11} />
      return [{
        id: 'cli',
        node: (
          <span className="flex items-center gap-1.5">
            <AgentIcon agent={data.agent} size={11} />
            {data.warm === null ? null : <span className="flex items-center gap-1">{icon}{compact ? null : state}</span>}
          </span>
        ),
        name: AGENT_LABELS[data.agent],
        value: data.warm === null ? '' : <span className="flex items-center gap-1">{icon}{state}</span>,
        detail: data.warm === null ? AGENT_LABELS[data.agent] : t(warm ? 'composer.status.warm.title' : 'composer.status.cold.title'),
      }]
    }
    case 'quota': {
      const windows = data.windows.filter((window): window is UsageWindow & { utilization: number } => window.utilization !== null)
      if (windows.length === 0) return []
      const shown = item.windows === 'all' ? windows : [windows.reduce((busiest, window) => (window.utilization > busiest.utilization ? window : busiest))]
      return shown.map((window) => quotaPiece(window, item, context))
    }
    case 'context': {
      if (!data.context || data.context.maxTokens <= 0) return []
      const ratio = Math.min(Math.max(data.context.ratio, 0), 1)
      const used = formatTokens(data.context.usedTokens)
      const max = formatTokens(data.context.maxTokens)
      const name = t('statusBar.item.context.name')
      return [{
        id: 'context',
        node: <Proportion ratio={ratio} label={compact ? undefined : name} text={`${used} / ${max}`} format={item.format ?? 'ring'} compact={compact} />,
        name,
        value: <span className="flex items-center gap-2"><ListGauge ratio={ratio} /><span className="text-ink-faint">{used} / {max}</span></span>,
        detail: t('statusBar.context.detail', { used, max }),
      }]
    }
    case 'tokens': {
      const { input, output, cacheWrite, cacheRead } = data.tokens
      // Cache dominates real usage: leaving it out would show hundreds instead of a million.
      const total = input + output + cacheWrite + cacheRead
      if (total === 0) return []
      const text = t('usage.tokens.total', { count: formatTokens(total) })
      return [{
        id: 'tokens',
        node: <span className="tabular-nums">{text}</span>,
        name: t('statusBar.item.tokens.name'),
        value: <span className="tabular-nums">{text}</span>,
        detail: t('usage.tokens.breakdown', { input: formatTokens(input), output: formatTokens(output), cacheWrite: formatTokens(cacheWrite), cacheRead: formatTokens(cacheRead) }),
        opens: 'details',
      }]
    }
    case 'lastTurn': {
      if (!data.lastTurnTokens) return []
      const count = formatTokens(data.lastTurnTokens)
      return [{
        id: 'lastTurn',
        node: <span className="tabular-nums">{compact ? count : t('statusBar.lastTurn.short', { count })}</span>,
        name: t('statusBar.item.lastTurn.name'),
        value: <span className="tabular-nums">{t('usage.tokens.total', { count })}</span>,
        detail: t('statusBar.lastTurn.detail'),
      }]
    }
    case 'cost': {
      if (data.costUsd === null || data.costUsd <= 0) return []
      const amount = formatUsd(data.costUsd, locale)
      return [{
        id: 'cost',
        node: <span className="tabular-nums">{amount}</span>,
        name: t('statusBar.item.cost.name'),
        value: <span className="tabular-nums">{amount}</span>,
        detail: t('statusBar.cost.detail'),
      }]
    }
    case 'agents': {
      const agents = data.subAgents.length
      const tasks = data.background.length
      if (agents + tasks === 0) return []
      const parts = [
        agents ? plural(agents, 'statusBar.agents.subAgents.one', 'statusBar.agents.subAgents.many', t) : null,
        tasks ? plural(tasks, 'statusBar.agents.background.one', 'statusBar.agents.background.many', t) : null,
      ].filter((part): part is string => part !== null)
      return [{
        id: 'agents',
        node: (
          <span className="flex items-center gap-1 text-ink-soft">
            <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-accent" />
            <Bot size={11} />
            {compact ? agents + tasks : parts.join(' · ')}
          </span>
        ),
        name: t('statusBar.item.agents.name'),
        value: parts.join(' · '),
        detail: [...data.subAgents, ...data.background].join('\n'),
        opens: 'agents',
      }]
    }
    case 'clock': {
      if (data.turnStartedAt === null) return []
      const clock = <TurnClock startedAt={data.turnStartedAt} />
      return [{
        id: 'clock',
        node: <span className="flex items-center gap-1 tabular-nums"><Timer size={11} />{clock}</span>,
        name: t('statusBar.item.clock.name'),
        value: <span className="tabular-nums">{clock}</span>,
        detail: t('statusBar.clock.detail'),
      }]
    }
    case 'model': {
      if (!data.model) return []
      return [{
        id: 'model',
        node: <span className="max-w-48 truncate font-mono">{data.model}</span>,
        name: t('statusBar.item.model.name'),
        value: <span className="font-mono">{data.model}</span>,
        detail: t('statusBar.model.detail'),
        opens: 'details',
      }]
    }
    case 'version': {
      if (!data.cliVersion) return []
      return [{
        id: 'version',
        node: <span className="flex items-center gap-1 font-mono">{data.versionGap ? <TriangleAlert size={11} className="text-caution" /> : null}{data.cliVersion}</span>,
        name: t('statusBar.item.version.name'),
        value: <span className="font-mono">{data.cliVersion}</span>,
        detail: data.versionGap ?? t('statusBar.version.detail'),
        opens: 'details',
      }]
    }
    case 'worktree': {
      const tree = data.worktree
      if (!tree) return []
      const state = t(`worktrees.state.${tree.state}`)
      const ahead = tree.state === 'unmerged' && tree.ahead > 0 ? t('statusBar.worktree.ahead', { count: tree.ahead }) : null
      const pull = tree.pullRequest ? t('statusBar.worktree.pullRequest', { number: tree.pullRequest.number }) : null
      const summary = [state, ahead, pull].filter(Boolean).join(' · ')
      return [{
        id: 'worktree',
        node: (
          <span className={cx('flex items-center gap-1', WORKTREE_STATE_TEXT[tree.state])}>
            <WorktreeStateIcon state={tree.state} size={11} />
            {compact ? (tree.state === 'unmerged' && tree.ahead > 0 ? tree.ahead : null) : summary}
          </span>
        ),
        name: t('statusBar.item.worktree.name'),
        value: <span className={WORKTREE_STATE_TEXT[tree.state]}>{summary}</span>,
        detail: [tree.branch ?? tree.name, summary].join(' · '),
        opens: 'git',
      }]
    }
    case 'files': {
      if (data.files === 0) return []
      const text = plural(data.files, 'statusBar.files.one', 'statusBar.files.many', t)
      return [{
        id: 'files',
        node: <span className="flex items-center gap-1 tabular-nums"><FilePen size={11} />{compact ? data.files : text}</span>,
        name: t('statusBar.item.files.name'),
        value: text,
        detail: t('statusBar.files.detail'),
        opens: 'git',
      }]
    }
    case 'tools': {
      if (!data.tools || data.tools.calls === 0) return []
      const { calls, errors } = data.tools
      return [{
        id: 'tools',
        node: (
          <span className="flex items-center gap-1 tabular-nums">
            <Wrench size={11} />{compact ? calls : t('statusBar.tools.calls', { count: calls })}
            {errors > 0 ? <span className="text-critical">· {errors}</span> : null}
          </span>
        ),
        name: t('statusBar.item.tools.name'),
        value: <span>{calls}{errors > 0 ? <span className="text-critical"> · {errors}</span> : null}</span>,
        detail: t('statusBar.tools.detail', { count: calls, errors }),
      }]
    }
    case 'previews': {
      if (data.previews.length === 0) return []
      const ports = data.previews.map((preview) => `:${preview.port}`).join(' ')
      return [{
        id: 'previews',
        node: <span className="flex items-center gap-1 tabular-nums"><Globe size={11} />{ports}</span>,
        name: t('statusBar.item.previews.name'),
        value: ports,
        detail: [t('statusBar.previews.detail'), ...data.previews.map((preview) => `:${preview.port}${preview.title ? ` · ${preview.title}` : ''}`)].join('\n'),
        opens: 'preview',
      }]
    }
    case 'shortcuts': {
      // Keys have no meaning on touch screens.
      if (compact) return []
      const text = t('composer.status.shortcut')
      return [{ id: 'shortcuts', node: <span>{text}</span>, name: t('statusBar.item.shortcuts.name'), value: '', detail: text, end: true }]
    }
  }
}
