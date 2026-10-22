import { Info, Star, X } from 'lucide-react'
import { useRef, useState, type ComponentPropsWithRef, type ReactElement, type ReactNode } from 'react'
import type { ConversationDto, ConversationMetrics } from '@sillage/protocol'
import { formatBytes } from '../lib/attachments'
import { relativeDate } from '../lib/dates'
import { locale, useTranslate } from '../lib/i18n'
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
  const tree = useConversationWorktree(conversation)
  const git: WorktreePreviewState | null = tree?.state ?? (conversation.worktreeId ? 'unknown' : null)
  const { data: projects } = useProjects()
  const project = projects?.find(item => item.id === conversation.projectId)
  const timestamp = new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(conversation.updatedAt)
  return <div className="session-preview-content">
    <div className="session-preview-cli"><AgentIcon agent={conversation.agent} size={16} /><span>{AGENT_LABELS[conversation.agent]}</span><span className="ml-auto truncate">{project?.name}</span></div>
    <h3>{conversation.title}</h3>
    {conversation.card && <p className="session-preview-card">{conversation.card.title}</p>}
    <dl className="session-preview-facts">
      <div><dt>{t('shell.overview.heading')}</dt><dd>{signals.length ? <SignalRow signals={signals} /> : t('composer.status.cold.label')}</dd></div>
      <div><dt>{t('shell.preview.updated')}</dt><dd><time dateTime={new Date(conversation.updatedAt).toISOString()}>{relativeDate(conversation.updatedAt)}</time><span className="block text-ink-faint">{timestamp}</span></dd></div>
    </dl>
    <section className="session-preview-worktree">
      <h4>{t('shell.preview.worktree')}</h4>
      {git ? <><div data-preview-git={git} className={cx('flex items-center gap-2 font-medium', WORKTREE_STATE_TEXT[git])}><WorktreeStateIcon state={git} /><span>{t(`worktrees.state.${git}`)}</span></div><p>{t(`shell.preview.git.${git}`)}</p>{tree && <><code>{tree.branch || tree.name}</code><span className="mt-1 block break-all text-[0.625rem] text-ink-faint">{tree.path}</span></>}</> : <p>{t('shell.preview.mainTree')}</p>}
    </section>
    <dl className="session-preview-facts">
      {metrics.model && <div><dt>{t('composer.setting.model')}</dt><dd className="break-words">{metrics.model}</dd></div>}
      <div><dt>{t('shell.preview.usage')}</dt><dd>{t('shell.conversation.turns', { count: metrics.turnCount })} · {formatBytes(metrics.journalBytes)}</dd></div>
      {metrics.context && metrics.context.maxTokens > 0 && <div className="col-span-2"><dt>{t('shell.preview.context')}</dt><dd>{t('shell.conversation.contextTitle', { used: formatTokens(metrics.context.usedTokens), max: formatTokens(metrics.context.maxTokens) })}</dd></div>}
    </dl>
    {conversation.origin && <p className="text-ink-faint">{t('shell.conversation.origin', { label: conversation.origin.label })}</p>}
    {conversation.favorite && <p className="flex items-center gap-1.5 text-ink-faint"><Star size={12} />{t('shell.favorites.heading')}</p>}
  </div>
}
