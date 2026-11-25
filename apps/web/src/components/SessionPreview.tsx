import { Info, Star, X } from 'lucide-react'
import { useRef, useState, type ComponentPropsWithRef, type ReactElement, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { CardLinkDto, ConversationDto, ConversationMetrics, ConversationStatsDto, WorktreeStatusDto } from '@sillage/protocol'
import { formatBytes } from '../lib/attachments'
import { cardHref } from '../lib/card-refs'
import { formatCount, formatUsd } from '../lib/consumption'
import { useConversationStats } from '../lib/conversation-stats'
import { COLUMN_DOTS, columnLabel } from './board/columns'
import { relativeDate } from '../lib/dates'
import { translate, useLocale, useTranslate, type Locale } from '../lib/i18n'
import { toolLabel } from '../lib/tool-presentation'
import { CRITICAL_RATIO, WARN_RATIO } from './chat/ContextMeter'
import { useProjects } from '../lib/projects'
import type { Signal } from '../lib/signals'
import { formatTokens } from '../lib/tokens'
import { useConversationWorktree } from '../lib/worktrees'
import { useMediaQuery } from '../lib/viewport'
import { AgentIcon, AGENT_LABELS } from './AgentIcon'
import { SignalRow } from './chat/Signals'
import { cx, IconButton, Popover } from './ui'
import { Tooltip } from './ui/Tooltip'
import { WORKTREE_STATE_TEXT, WorktreeStateIcon, type WorktreePreviewState } from './WorktreeTag'
import { WorktreePullRequest } from './WorktreePullRequest'

/** Keep Git details independent of navigation, including when opening them on a touch device. */
export function SessionPreview({ conversation, metrics, signals, trigger, children, disabled = false }: {
  conversation: ConversationDto
  metrics: ConversationMetrics
  signals: Signal[]
  trigger: ReactElement
  children?: ReactNode
  disabled?: boolean
}) {
  const t = useTranslate()
  const narrow = useMediaQuery('(max-width: 767px)')
  const tree = useConversationWorktree(conversation)
  const git: WorktreePreviewState | null = tree?.state ?? (conversation.worktreeId ? 'unknown' : null)
  const [pinned, setPinned] = useState(false)
  const detailsButton = useRef<HTMLButtonElement>(null)
  const returningFocus = useRef(false)
  const label = t('shell.preview.open', { title: conversation.title })
  const details = <SessionDetails conversation={conversation} metrics={metrics} signals={signals} />
  return <>
    <Tooltip label={details} side="right" sideOffset={72} className="session-preview-tooltip" disabled={pinned || disabled}>{trigger}</Tooltip>
    {children}
    <Popover open={pinned} onOpenChange={setPinned} label={label} side={narrow ? 'bottom' : 'right'} align={narrow ? 'end' : 'start'}
      className="session-preview-popover"
      onEscapeKeyDown={(event) => event.stopPropagation()}
      onCloseAutoFocus={(event) => {
        event.preventDefault()
        returningFocus.current = true
        detailsButton.current?.focus({ preventScroll: true })
        returningFocus.current = false
      }}
      trigger={<DetailsTrigger details={details} pinned={pinned || disabled} type="button" data-session-details={conversation.id}
        data-worktree-state={git ?? undefined}
        ref={detailsButton}
        onFocus={(event) => { if (returningFocus.current) event.preventDefault() }}
        aria-label={git ? `${label}. ${t(`worktrees.state.${git}`)}` : label}
        onPointerDown={(event) => event.stopPropagation()}
        className={cx('sidebar-session-details', !git && 'sidebar-session-info')}>
        {git ? <WorktreeStateIcon state={git} /> : <Info size={15} />}
      </DetailsTrigger>}>
      <div className="session-preview-close"><IconButton label={t('common.close')} onClick={() => setPinned(false)}><X size={15} /></IconButton></div>
      {details}
    </Popover>
  </>
}

/** Forward Radix's trigger handlers and ref through the optional hover preview. */
function DetailsTrigger({ details, pinned, ...props }: ComponentPropsWithRef<'button'> & { details: ReactNode; pinned: boolean }) {
  return <Tooltip label={details} side="right" className="session-preview-tooltip" disabled={pinned}><button {...props} /></Tooltip>
}

export function SessionDetails({ conversation, metrics, signals }: {
  conversation: ConversationDto
  metrics: ConversationMetrics
  signals: Signal[]
}) {
  const t = useTranslate()
  const lang = useLocale()
  const tree = useConversationWorktree(conversation)
  const git: WorktreePreviewState | null = tree?.state ?? (conversation.worktreeId ? 'unknown' : null)
  const { data: projects } = useProjects()
  const { data: stats } = useConversationStats(conversation.id)
  const project = projects?.find(item => item.id === conversation.projectId)
  const timestamp = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(conversation.updatedAt)
  const card = conversation.card
  return <div className="session-preview-content">
    <header className="session-preview-head">
      <div className="session-preview-cli">
        <AgentIcon agent={conversation.agent} size={14} /><span>{AGENT_LABELS[conversation.agent]}</span>
        {project && <><span aria-hidden className="session-preview-sep" /><span className="truncate">{project.name}</span></>}
        {conversation.favorite && <Star size={12} className="ml-auto shrink-0 fill-current text-caution" aria-label={t('shell.favorites.heading')} />}
      </div>
      <h3>{conversation.title}</h3>
      <div className="session-preview-status">
        {signals.length ? <SignalRow signals={signals} /> : <span>{t('composer.status.cold.label')}</span>}
        <time dateTime={new Date(conversation.updatedAt).toISOString()} title={`${t('shell.preview.updated')} · ${timestamp}`}>{relativeDate(conversation.updatedAt)}</time>
      </div>
    </header>

    {card && <CardChip card={card} projectId={conversation.projectId} />}

    <dl className="session-preview-tiles">
      <Tile label={t('shell.preview.cost')} title={stats ? costTitle(stats, lang) : undefined}
        value={stats ? (stats.costUsd === null ? '—' : formatUsd(stats.costUsd, lang)) : null} />
      <Tile label={t('shell.preview.tools')} value={stats ? formatCount(stats.toolCalls, lang) : null}
        detail={stats && stats.toolErrors > 0 ? <span className="text-critical">{t('shell.preview.toolErrors', { count: stats.toolErrors })}</span> : undefined} />
      <Tile label={t('shell.preview.turns')} value={formatCount(metrics.turnCount, lang)} />
    </dl>

    {metrics.context && metrics.context.maxTokens > 0 && <ContextGauge used={metrics.context.usedTokens} max={metrics.context.maxTokens} />}
    {stats && stats.tools.length > 0 && <ToolBreakdown stats={stats} />}

    <section className="session-preview-worktree">
      <h4>{t('shell.preview.worktree')}</h4>
      {git ? <>
        <div className="flex min-w-0 items-center gap-2">
          <span data-preview-git={git} className={cx('flex shrink-0 items-center gap-1.5 font-medium', WORKTREE_STATE_TEXT[git])}><WorktreeStateIcon state={git} /><span>{t(`worktrees.state.${git}`)}</span></span>
          {tree && <code className="truncate" title={tree.path}>{tree.branch || tree.name}</code>}
        </div>
        <p>{t(`shell.preview.git.${git}`)}</p>
        {tree && tree.state === 'leftovers' && <LeftoverFiles tree={tree} />}
        {tree && tree.kept > 0 && <p>{translate(tree.kept > 1 ? 'worktrees.kept.many' : 'worktrees.kept.one', { count: tree.kept })}</p>}
      </> : <p className="text-ink-soft">{t('shell.preview.mainTree')}</p>}
    </section>
    <WorktreePullRequest pull={tree?.pullRequest} />

    <footer className="session-preview-foot">
      {metrics.model && <span className="font-mono">{metrics.model}</span>}
      <span>{formatBytes(metrics.journalBytes)}</span>
      {conversation.origin && <span>{t('shell.conversation.origin', { label: conversation.origin.label })}</span>}
    </footer>
  </div>
}

/** One figure per tile; a null value is still loading and keeps the tile's height. */
function Tile({ label, value, detail, title }: { label: string; value: string | null; detail?: ReactNode; title?: string }) {
  return <div title={title}>
    <dt>{label}</dt>
    <dd>{value ?? <span aria-hidden className="session-preview-skeleton" />}</dd>
    {detail && <dd className="session-preview-tile-detail">{detail}</dd>}
  </div>
}

/** The cost alone hides what it is made of: cached reads dominate long sessions. */
function costTitle(stats: ConversationStatsDto, lang: Locale): string {
  const parts = [
    translate('shell.preview.tokens.input', { count: formatCount(stats.tokens.input, lang) }),
    translate('shell.preview.tokens.output', { count: formatCount(stats.tokens.output, lang) }),
    translate('shell.preview.tokens.cache', { count: formatCount(stats.tokens.cacheRead + stats.tokens.cacheWrite, lang) }),
  ]
  return `${translate('shell.preview.cost.detail')}\n${parts.join(' · ')}`
}

function CardChip({ card, projectId }: { card: CardLinkDto; projectId: string | null }) {
  const body = <>
    <span className="session-preview-card-number">#{card.number}</span>
    <span className="min-w-0 flex-1 truncate text-ink">{card.title}</span>
    <span className="flex shrink-0 items-center gap-1.5"><span aria-hidden className={cx('size-1.5 rounded-full', COLUMN_DOTS[card.column])} />{columnLabel(card.column)}</span>
  </>
  return projectId
    ? <Link to={cardHref(projectId, card.number)} className="session-preview-card" title={card.title}>{body}</Link>
    : <div className="session-preview-card" title={card.title}>{body}</div>
}

/** Same thresholds as the composer ring, so a session reads the same in both places. */
function ContextGauge({ used, max }: { used: number; max: number }) {
  const t = useTranslate()
  const ratio = Math.min(Math.max(used / max, 0), 1)
  const tone = ratio >= CRITICAL_RATIO ? 'critical' : ratio >= WARN_RATIO ? 'caution' : 'accent'
  return <div className="session-preview-gauge" data-tone={tone}>
    <div className="flex items-baseline justify-between gap-2">
      <span className="session-preview-label">{t('shell.preview.context')}</span>
      <span className="tabular-nums"><span className="font-medium text-ink">{formatTokens(used)}</span> / {formatTokens(max)} · {Math.round(ratio * 100)} %</span>
    </div>
    <div className="session-preview-bar" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={used} aria-label={t('shell.preview.context')}>
      <span style={{ width: `${Math.max(ratio * 100, 1)}%` }} />
    </div>
  </div>
}

/** One hue fading with rank: tools are ranked, not categories, and a rainbow would suggest meaning. */
const TOOL_SHADES = [1, 0.78, 0.6, 0.46, 0.36]

function ToolBreakdown({ stats }: { stats: ConversationStatsDto }) {
  const t = useTranslate()
  const lang = useLocale()
  const rest = stats.toolCalls - stats.tools.reduce((sum, tool) => sum + tool.count, 0)
  const rows = [
    ...stats.tools.map((tool, index) => ({ key: tool.name, label: toolLabel(tool.name), count: tool.count, opacity: TOOL_SHADES[index] ?? 0.2, other: false })),
    ...(rest > 0 ? [{ key: '', label: t('shell.preview.tools.other'), count: rest, opacity: 1, other: true }] : []),
  ]
  return <div className="session-preview-tools">
    <span className="session-preview-label">{t('shell.preview.toolsUsed')}</span>
    <div className="session-preview-stack" aria-hidden>
      {rows.map(row => <span key={row.key} className={cx(row.other && 'is-other')} style={{ flexGrow: row.count, opacity: row.other ? undefined : row.opacity }} />)}
    </div>
    <ul>
      {rows.map(row => <li key={row.key}>
        <span aria-hidden className={cx('session-preview-swatch', row.other && 'is-other')} style={row.other ? undefined : { opacity: row.opacity }} />
        <span className="min-w-0 flex-1 truncate" title={row.key || undefined}>{row.label}</span>
        <span className="tabular-nums text-ink-faint">{formatCount(row.count, lang)}</span>
      </li>)}
    </ul>
  </div>
}

/** A few names are enough to tell a forgotten file from a demo leftover; the dialog lists the rest. */
function LeftoverFiles({ tree }: { tree: WorktreeStatusDto }) {
  const t = useTranslate()
  const shown = tree.files.slice(0, 3)
  const hidden = tree.modified + tree.untracked - shown.length
  return <ul className="mb-1 flex flex-col text-[0.6875rem]">
    {shown.map(file => <li key={file.path} className="truncate"><span className="text-ink-faint">{t(`worktrees.file.${file.kind}`)}</span> <span className="font-mono">{file.path}</span></li>)}
    {hidden > 0 && <li className="text-ink-faint">{t('worktrees.files.more', { count: hidden })}</li>}
  </ul>
}
