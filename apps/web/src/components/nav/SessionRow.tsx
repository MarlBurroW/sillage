import { conversationPath, sessionReference } from '@sillage/protocol'
import type { ConversationDto, ProjectDto } from '@sillage/protocol'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Archive, ArchiveRestore, Link2, MoreHorizontal, Pencil, Star, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { NavLink, useMatch, useNavigate } from 'react-router-dom'
import { useCopy } from '../../lib/clipboard'
import {
  useArchiveConversation,
  useDeleteConversation,
  useRenameConversation,
  type useToggleFavorite,
} from '../../lib/conversations'
import { useLiveBackground, useLiveLoops, useLiveMetrics, useLiveSeq, useLiveStatus } from '../../lib/conversation-status'
import { compactRelativeDate, relativeDate } from '../../lib/dates'
import { useTranslate } from '../../lib/i18n'
import { projectViewPath, useProjectView } from '../../lib/project-view'
import { isUnread } from '../../lib/reads'
import { buildSidebarSignals, presentSignal } from '../../lib/signals'
import { AgentIcon } from '../AgentIcon'
import { SignalDot } from '../chat/Signals'
import { ProjectAvatar } from '../ProjectAvatar'
import { SessionPreview } from '../SessionPreview'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator, Menu, MenuItem, MenuSeparator, cx } from '../ui'
import { RenameInput, useContextMenuEnabled } from './shared'

export type FavoriteMutation = ReturnType<typeof useToggleFavorite>

/**
 * One session, wherever it is listed. Lists spanning projects pass `project` so the row names where
 * the session lives; a project's own list leaves it out.
 */
export function SessionRow({
  conversation,
  toggleFavorite,
  onNavigate,
  draggable = true,
  project,
}: {
  conversation: ConversationDto
  toggleFavorite: FavoriteMutation
  onNavigate: () => void
  /** Named under the title in lists that span projects; `null` stands for a personal discussion. */
  project?: ProjectDto | null
  /**
   * False in Favorites, outside drag contexts: order follows the list and a draggable row would
   * have no drop container.
   */
  draggable?: boolean
}) {
  const t = useTranslate()
  const rename = useRenameConversation()
  const isArchived = conversation.archivedAt !== null
  const projectMatch = useMatch('/p/:projectId/c/:conversationId')
  const personalMatch = useMatch('/discussions/:conversationId')
  const openMatch = projectMatch ?? personalMatch
  const contextMenu = useContextMenuEnabled()
  const [editing, setEditing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  // Socket status takes precedence over the load-time list snapshot.
  const status = useLiveStatus(conversation.id) ?? conversation.status
  const background = useLiveBackground(conversation.id)
  const loops = useLiveLoops(conversation.id)
  const pushedSeq = useLiveSeq(conversation.id)
  // Same precedence as status: pushed values override the load-time list. Cold threads have no
  // pushes yet, so list readings remain correct.
  const metrics = useLiveMetrics(conversation.id) ?? conversation.metrics
  const signals = useMemo(
    () => buildSidebarSignals({ status, background, loops }),
    [status, background, loops],
  )
  const present = presentSignal(signals)
  const loop = signals.find((signal) => signal.kind === 'loop') ?? null
  const sortable = draggable && !isArchived

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: conversation.id,
    // Renaming adds an input, so disable dragging to permit text selection. Archived and favorite
    // rows are outside drag contexts and register nothing.
    disabled: !sortable || editing,
  })

  const commit = (draft: string) => {
    setEditing(false)
    const value = draft.trim()
    if (value && value !== conversation.title) {
      rename.mutate({ id: conversation.id, title: value })
    }
  }

  const style = { transform: CSS.Transform.toString(transform), transition }

  if (editing) {
    return (
      <li ref={setNodeRef} style={style}>
        <RenameInput
          value={conversation.title}
          onCommit={commit}
          onCancel={() => setEditing(false)}
          className="h-9 w-full rounded-md border border-accent bg-sunken px-2 text-sm text-ink outline-none"
        />
      </li>
    )
  }

  const isActive = openMatch?.params.conversationId === conversation.id
  /*
   * Convey unread through ink and weight rather than a third dot: rows hold at most two, and
   * another would compete with current-state signals. New content simply promotes muted text to
   * full ink. Exclude the open thread immediately without awaiting the server because its read
   * cursor is sent later.
   */
  const unread = !isActive && isUnread(conversation, pushedSeq)

  return (
    <ContextMenu disabled={!contextMenu} onOpenChange={setContextOpen} trigger={
      <li ref={setNodeRef} style={style} {...(sortable ? attributes : {})} {...(sortable ? listeners : {})}
        data-sidebar-session={conversation.id}
        className={cx('group/row sidebar-session', project !== undefined && 'sidebar-session-wide', isDragging && 'relative z-10 bg-surface-high opacity-90', isActive && 'sidebar-current', unread && 'sidebar-unread')}>
        <SessionPreview conversation={conversation} metrics={metrics} signals={signals} disabled={menuOpen || contextOpen} trigger={
          <NavLink to={conversationPath(conversation)} onClick={onNavigate}
            onDoubleClick={event => { event.preventDefault(); if (conversation.isOwner) setEditing(true) }}
            className="sidebar-session-link">
            <AgentIcon agent={conversation.agent} size={16} />
            {project === undefined ? <span className="sidebar-session-title">{conversation.title}</span> : (
              <span className="sidebar-session-text">
                <span className="sidebar-session-title">{conversation.title}</span>
                <span className="sidebar-session-project">{project ? <ProjectAvatar project={project} className="size-3" /> : null}<span>{project?.name ?? t('discussions.title')}</span></span>
              </span>
            )}
            {/* The card number stays visible: it tells which board work a session carries. The preview names it. */}
            {conversation.card && <span className="sidebar-session-card" aria-label={t('shell.conversation.card', { number: conversation.card.number, title: conversation.card.title })}>#{conversation.card.number}</span>}
            {conversation.favorite && <Star size={10} aria-label={t('shell.favorites.heading')} className="shrink-0 text-ink-faint" />}
            <span className="sidebar-session-signals">{present && <SignalDot signal={present} />}{loop && <SignalDot signal={loop} />}</span>
          </NavLink>}>
          <span className="sidebar-session-actions">
            <time className="sidebar-session-age" dateTime={new Date(conversation.updatedAt).toISOString()} title={relativeDate(conversation.updatedAt)}>{compactRelativeDate(conversation.updatedAt)}</time>
            <Menu onOpenChange={setMenuOpen} trigger={<button type="button" aria-label={t('shell.conversation.actions')} className="sidebar-session-menu" onPointerDown={event => event.stopPropagation()}><MoreHorizontal size={15} /></button>}>
              <ConversationMenuItems variant="dropdown" conversation={conversation} toggleFavorite={toggleFavorite} onRename={() => setEditing(true)} />
            </Menu>
          </span>
        </SessionPreview>
      </li>}>
      <ConversationMenuItems variant="context" conversation={conversation} toggleFavorite={toggleFavorite} onRename={() => setEditing(true)} />
    </ContextMenu>
  )
}

/**
 * Conversation actions shared by ellipsis dropdown and row context menu: one list, two Radix
 * primitives with separate entries, like explorer actions.
 */
function ConversationMenuItems({
  variant,
  conversation,
  toggleFavorite,
  onRename,
}: {
  variant: 'context' | 'dropdown'
  conversation: ConversationDto
  toggleFavorite: FavoriteMutation
  onRename: () => void
}) {
  const t = useTranslate()
  const { copy, state: copyState } = useCopy()
  const remove = useDeleteConversation()
  const setArchived = useArchiveConversation()
  const isArchived = conversation.archivedAt !== null
  const navigate = useNavigate()
  const projectMatch = useMatch('/p/:projectId/c/:conversationId')
  const personalMatch = useMatch('/discussions/:conversationId')
  const openMatch = projectMatch ?? personalMatch
  const projectView = useProjectView(conversation.projectId ?? '')
  const Item = variant === 'context' ? ContextMenuItem : MenuItem
  const Separator = variant === 'context' ? ContextMenuSeparator : MenuSeparator

  return (
    <>
      <Item icon={<Star size={14} />} disabled={toggleFavorite.isPending} onSelect={() => toggleFavorite.mutate({ id: conversation.id, favorite: !conversation.favorite })}>
        {conversation.favorite ? t('shell.conversation.unfavorite') : t('shell.conversation.favorite')}
      </Item>
      <Item icon={<Link2 size={14} />} onSelect={event => { event.preventDefault(); copy(sessionReference(conversation.id)) }}>
        {t(copyState === 'copied' ? 'sessionRef.copied' : copyState === 'failed' ? 'sessionRef.copyFailed' : 'sessionRef.copy')}
      </Item>
      {conversation.isOwner ? (
        <>
          <Separator />
          <Item icon={<Pencil size={14} />} onSelect={onRename}>
            {t('shell.rename')}
          </Item>
          <Item
            icon={isArchived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            onSelect={() => setArchived.mutate({ id: conversation.id, archived: !isArchived })}
          >
            {isArchived ? t('shell.conversation.unarchive') : t('shell.conversation.archive')}
          </Item>
          <Separator />
          <Item
            icon={<Trash2 size={14} />}
            tone="critical"
            onSelect={() => {
              if (!confirm(t(conversation.projectId ? 'shell.conversation.deleteConfirm' : 'discussions.deleteConfirm', { title: conversation.title })))
                return
              const wasOpen = openMatch?.params.conversationId === conversation.id
              remove.mutate(conversation.id, {
                // Leave the view only if it is the deleted conversation, falling back to the
                // project's usual landing view rather than choosing a new home preference.
                onSuccess: () => {
                  if (wasOpen) navigate(conversation.projectId ? projectViewPath(conversation.projectId, projectView) : '/discussions/new')
                },
              })
            }}
          >
            {t('shell.delete')}
          </Item>
        </>
      ) : null}
    </>
  )
}
