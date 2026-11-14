import type { ConversationDto } from '@sillage/protocol'
import { Archive, Brain, ChevronRight, FolderOpen, Plus } from 'lucide-react'
import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useTranslate } from '../../lib/i18n'
import { Tooltip } from '../ui/Tooltip'
import { cx } from '../ui'
import { ColumnHead, ColumnHeading, useNavChrome } from './chrome'
import { SessionRow, type FavoriteMutation } from './SessionRow'

/** Discussions outside any project, laid out like a project: their views, then the list. */
export function DiscussionsColumn({ conversations, toggleFavorite }: { conversations: ConversationDto[]; toggleFavorite: FavoriteMutation }) {
  const t = useTranslate()
  const { onNavigate } = useNavChrome()
  const [archiveOpen, setArchiveOpen] = useState(false)
  const personal = conversations.filter((entry) => entry.projectId === null && !entry.benchmarkId)
  const active = personal.filter((entry) => entry.archivedAt === null)
  const archived = personal.filter((entry) => entry.archivedAt !== null)
  const link = ({ isActive }: { isActive: boolean }) => cx('sidebar-project-link', isActive && 'sidebar-current')
  const rows = (entries: ConversationDto[]) => entries.map((conversation) => (
    <SessionRow key={conversation.id} conversation={conversation} toggleFavorite={toggleFavorite} draggable={false} onNavigate={onNavigate} />
  ))

  return (
    <>
      <ColumnHead title={t('discussions.title')} actions={
        <Tooltip label={t('discussions.new')} side="bottom">
          <NavLink to="/discussions/new" onClick={onNavigate} aria-label={t('discussions.new')} className="sidebar-add-session"><Plus size={16} /></NavLink>
        </Tooltip>
      } />
      <ul className="sidebar-project-links">
        <li><NavLink to="/discussions/memory" onClick={onNavigate} className={link}><Brain size={14} /><span className="flex-1">{t('discussions.memory')}</span><span /></NavLink></li>
        <li><NavLink to="/discussions/files" onClick={onNavigate} className={link}><FolderOpen size={14} /><span className="flex-1">{t('discussions.files')}</span><span /></NavLink></li>
      </ul>
      <ColumnHeading label={t('discussions.title')} count={active.length} />
      <div className="nav-column-scroll sidebar-personal">
        <ul className="flex flex-col gap-px">
          {rows(active)}
          {!active.length ? <li className="px-3 py-3 text-xs text-ink-faint">{t('discussions.empty')}</li> : null}
        </ul>
      </div>
      {archived.length > 0 && <div className="sidebar-archives">
        <button type="button" onClick={() => setArchiveOpen((value) => !value)} aria-expanded={archiveOpen} aria-controls="sidebar-archives-discussions"><Archive size={14} /><span>{t('shell.conversations.archived', { count: String(archived.length) })}</span><ChevronRight size={12} className={cx('ml-auto', archiveOpen && 'rotate-90')} /></button>
        {archiveOpen && <ul id="sidebar-archives-discussions">{rows(archived)}</ul>}
      </div>}
    </>
  )
}
