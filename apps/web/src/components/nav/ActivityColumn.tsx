import { benchmarkPath, type BenchmarkDto } from '@sillage/protocol'
import type { ClaudeHostLoginDto, ConversationDto, DecisionDto, ProjectDto } from '@sillage/protocol'
import { CircleHelp, FlaskConical, History, KeyRound, LayoutGrid } from 'lucide-react'
import { NavLink, useLocation, useSearchParams } from 'react-router-dom'
import { activitySectionOf, activityWallPath, type ActivityEntry, type ActivitySection } from '../../lib/activity'
import { openDecision } from '../../lib/decisions'
import { locale, useTranslate } from '../../lib/i18n'
import { shadowedBySection, useSessionViews, viewName } from '../../lib/session-views'
import { decisionQuestion } from '../decisions/decision-text'
import { Tooltip } from '../ui/Tooltip'
import { cx } from '../ui'
import { ColumnHead, ColumnHeading, useNavChrome } from './chrome'
import { SessionRow, type FavoriteMutation } from './SessionRow'

/**
 * Everything that asks for attention across projects, in one list: what waits on the user, what
 * works, what changed unseen, and the sessions kept at hand. A new kind of attention becomes a row
 * here, never another counter elsewhere in the navigation.
 *
 * Beside the page, the list drives the wall: a heading fills it with its section, a row brings its
 * tile forward. In a phone drawer the wall cannot stand beside the list, so rows open their
 * conversation and headings lead to the wall.
 */
export function ActivityColumn({ awaiting, running, runningBenchmarks, unread, decisions, hostExpiry, favorites, projects, toggleFavorite }: {
  awaiting: ActivityEntry[]
  running: ActivityEntry[]
  runningBenchmarks: BenchmarkDto[]
  unread: ActivityEntry[]
  decisions: DecisionDto[]
  hostExpiry: ClaudeHostLoginDto | null
  /** Account bookmarks across projects, archived threads included: archiving must not hide them. */
  favorites: ConversationDto[]
  projects: ProjectDto[]
  toggleFavorite: FavoriteMutation
}) {
  const t = useTranslate()
  const { wide, onNavigate } = useNavChrome()
  const { pathname } = useLocation()
  const [params] = useSearchParams()
  const { views } = useSessionViews()
  const savedViews = views.filter((view) => !shadowedBySection(view))
  const onWall = pathname === '/wall'
  const shownView = onWall ? params.get('view') : null
  const shownSection = onWall && !shownView ? activitySectionOf(params) : null
  const live = onWall && !shownView && shownSection === null
  const tile = onWall ? params.get('tile') : null

  // A project the account can no longer read leaves the row without a second line.
  const projectOf = (conversation: ConversationDto) => conversation.projectId === null ? null : projects.find((project) => project.id === conversation.projectId)
  const rows = (section: ActivitySection, entries: ConversationDto[]) => entries.map((conversation) => {
    // An archived favorite has no tile to bring forward: it opens as a conversation.
    const onTile = wide && conversation.archivedAt === null
    // Stay on what the wall shows when the session is already part of it.
    const keep = shownSection === section || (live && (section === 'awaiting' || section === 'running'))
    return (
      <SessionRow key={conversation.id} conversation={conversation} project={projectOf(conversation)} toggleFavorite={toggleFavorite} draggable={false} onNavigate={onNavigate}
        to={onTile ? activityWallPath({ section: keep ? shownSection : section, tile: conversation.id }) : undefined}
        current={onTile ? tile === conversation.id : undefined} />
    )
  })
  // Pressing the section already shown returns to the live wall.
  const heading = (section: ActivitySection) => ({
    to: activityWallPath({ section: shownSection === section ? null : section }),
    current: shownSection === section,
    onClick: onNavigate,
  })
  const blocked = awaiting.length + decisions.length + (hostExpiry ? 1 : 0)
  const runningCount = running.length + runningBenchmarks.length
  const quiet = blocked === 0 && runningCount === 0 && unread.length === 0

  return (
    <>
      <ColumnHead title={t('shell.overview.heading')} actions={<>
        {/* Beside the page the wall is already there; a drawer covers it. */}
        {wide ? null : <Tooltip label={t('shell.activity.wall')} side="bottom">
          <NavLink to="/wall" end onClick={onNavigate} aria-label={t('shell.activity.wall')} className="sidebar-add-session"><LayoutGrid size={15} /></NavLink>
        </Tooltip>}
        <Tooltip label={t('decision.sidebar.history')} side="bottom">
          <NavLink to="/decisions" onClick={onNavigate} aria-label={t('decision.sidebar.history')} className="sidebar-add-session"><History size={15} /></NavLink>
        </Tooltip>
      </>} />
      <div className="nav-column-scroll nav-column-sections" data-nav-activity>
        {quiet ? <p role="status" className="px-3 py-3 text-xs text-ink-faint">{t('shell.activity.quiet')}</p> : null}
        {blocked > 0 ? <section aria-label={t('shell.activity.awaiting')} data-activity-section="awaiting">
          <ColumnHeading label={t('shell.activity.awaiting')} count={blocked} tone="caution" link={heading('awaiting')} />
          <ul className="flex flex-col gap-px">
            {hostExpiry?.loginExpiresAt ? <li className="sidebar-session sidebar-session-wide">
              <NavLink to="/settings/comptes-claude" className="sidebar-session-link" onClick={onNavigate}>
                <KeyRound size={16} className="text-caution" />
                <span className="sidebar-session-text">
                  <span className="sidebar-session-title">{t('claudeAccounts.host.attention')}</span>
                  <span className="sidebar-session-project"><span>{t('claudeAccounts.host.expires', { date: new Date(hostExpiry.loginExpiresAt).toLocaleDateString(locale()) })}</span></span>
                </span>
              </NavLink>
            </li> : null}
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
            {rows('awaiting', awaiting.map((entry) => entry.conversation))}
          </ul>
        </section> : null}
        {runningCount > 0 ? <section aria-label={t('shell.activity.running')} data-activity-section="running">
          <ColumnHeading label={t('shell.activity.running')} count={runningCount} link={running.length ? heading('running') : undefined} />
          <ul className="flex flex-col gap-px">
            {runningBenchmarks.map((benchmark) => (
              <li key={benchmark.id} className="sidebar-session sidebar-session-wide">
                <NavLink to={benchmarkPath(benchmark.id)} className="sidebar-session-link" onClick={onNavigate}>
                  <FlaskConical size={16} className="text-accent" />
                  <span className="sidebar-session-text">
                    <span className="sidebar-session-title">{benchmark.name}</span>
                    <span className="sidebar-session-project">{t('benchmark.title')}</span>
                  </span>
                </NavLink>
              </li>
            ))}
            {rows('running', running.map((entry) => entry.conversation))}
          </ul>
        </section> : null}
        {unread.length > 0 ? <section aria-label={t('shell.activity.unread')} data-activity-section="unread">
          <ColumnHeading label={t('shell.activity.unread')} count={unread.length} link={heading('unread')} />
          <ul className="flex flex-col gap-px">{rows('unread', unread.map((entry) => entry.conversation))}</ul>
        </section> : null}
        <section aria-label={t('shell.favorites.heading')} id="sidebar-favorites" className="sidebar-favorites" data-activity-section="favorites">
          <ColumnHeading label={t('shell.favorites.heading')} count={favorites.length} link={favorites.length ? heading('favorites') : undefined} />
          <ul className="flex flex-col gap-px">
            {rows('favorites', favorites)}
            {!favorites.length && <li className="px-3 py-3 text-xs text-ink-faint">{t('shell.favorites.empty')}</li>}
          </ul>
        </section>
        {savedViews.length > 0 ? <section aria-label={t('shell.activity.views')} data-activity-views>
          <ColumnHeading label={t('shell.activity.views')} />
          <ul className="sidebar-project-links">
            {savedViews.map((view) => (
              <li key={view.id}>
                <NavLink to={activityWallPath({ view: view.id })} onClick={onNavigate} className={cx('sidebar-project-link', shownView === view.id && 'sidebar-current')} aria-current={shownView === view.id ? 'page' : undefined}>
                  <LayoutGrid size={14} /><span className="flex-1 truncate">{viewName(view, t)}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </section> : null}
      </div>
    </>
  )
}
