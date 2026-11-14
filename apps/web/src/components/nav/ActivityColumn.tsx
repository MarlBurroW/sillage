import type { ConversationDto, DecisionDto, ProjectDto } from '@sillage/protocol'
import { CircleHelp, History } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import type { ActivityEntry } from '../../lib/activity'
import { openDecision } from '../../lib/decisions'
import { useTranslate } from '../../lib/i18n'
import { decisionQuestion } from '../decisions/decision-text'
import { Tooltip } from '../ui/Tooltip'
import { ColumnHead, ColumnHeading, useNavChrome } from './chrome'
import { SessionRow, type FavoriteMutation } from './SessionRow'

/**
 * Everything that asks for attention across projects, in one list: what waits on the user, what
 * works, what changed unseen, and the sessions kept at hand. A new kind of attention becomes a row
 * here, never another counter elsewhere in the navigation.
 */
export function ActivityColumn({ awaiting, running, unread, decisions, favorites, projects, toggleFavorite }: {
  awaiting: ActivityEntry[]
  running: ActivityEntry[]
  unread: ActivityEntry[]
  decisions: DecisionDto[]
  /** Account bookmarks across projects, archived threads included: archiving must not hide them. */
  favorites: ConversationDto[]
  projects: ProjectDto[]
  toggleFavorite: FavoriteMutation
}) {
  const t = useTranslate()
  const { onNavigate } = useNavChrome()
  // A project the account can no longer read leaves the row without a second line.
  const projectOf = (conversation: ConversationDto) => conversation.projectId === null ? null : projects.find((project) => project.id === conversation.projectId)
  const rows = (entries: ConversationDto[]) => entries.map((conversation) => (
    <SessionRow key={conversation.id} conversation={conversation} project={projectOf(conversation)} toggleFavorite={toggleFavorite} draggable={false} onNavigate={onNavigate} />
  ))
  const blocked = awaiting.length + decisions.length
  const quiet = blocked === 0 && running.length === 0 && unread.length === 0

  return (
    <>
      <ColumnHead title={t('shell.overview.heading')} actions={
        <Tooltip label={t('decision.sidebar.history')} side="bottom">
          <NavLink to="/decisions" onClick={onNavigate} aria-label={t('decision.sidebar.history')} className="sidebar-add-session"><History size={15} /></NavLink>
        </Tooltip>
      } />
      <div className="nav-column-scroll nav-column-sections" data-nav-activity>
        {quiet ? <p role="status" className="px-3 py-3 text-xs text-ink-faint">{t('shell.activity.quiet')}</p> : null}
        {blocked > 0 ? <section aria-label={t('shell.activity.awaiting')}>
          <ColumnHeading label={t('shell.activity.awaiting')} count={blocked} tone="caution" />
          <ul className="flex flex-col gap-px">
            {decisions.map((decision) => (
              <li key={decision.id} className="sidebar-session sidebar-session-wide">
                <button type="button" className="sidebar-session-link" onClick={() => { openDecision(decision.id); onNavigate() }}>
                  <CircleHelp size={16} className="text-caution" />
                  <span className="sidebar-session-text">
                    <span className="sidebar-session-title">{decisionQuestion(decision, t)}</span>
                    <span className="sidebar-session-project"><span>{[t('decision.sidebar.heading'), decision.projectName].filter(Boolean).join(' · ')}</span></span>
                  </span>
                </button>
              </li>
            ))}
            {rows(awaiting.map((entry) => entry.conversation))}
          </ul>
        </section> : null}
        {running.length > 0 ? <section aria-label={t('shell.activity.running')}>
          <ColumnHeading label={t('shell.activity.running')} count={running.length} />
          <ul className="flex flex-col gap-px">{rows(running.map((entry) => entry.conversation))}</ul>
        </section> : null}
        {unread.length > 0 ? <section aria-label={t('shell.activity.unread')}>
          <ColumnHeading label={t('shell.activity.unread')} count={unread.length} />
          <ul className="flex flex-col gap-px">{rows(unread.map((entry) => entry.conversation))}</ul>
        </section> : null}
        <section aria-label={t('shell.favorites.heading')} id="sidebar-favorites" className="sidebar-favorites">
          <ColumnHeading label={t('shell.favorites.heading')} count={favorites.length} />
          <ul className="flex flex-col gap-px">
            {rows(favorites)}
            {!favorites.length && <li className="px-3 py-3 text-xs text-ink-faint">{t('shell.favorites.empty')}</li>}
          </ul>
        </section>
      </div>
    </>
  )
}
