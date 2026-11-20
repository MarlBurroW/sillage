import { useEffect, useRef } from 'react'
import { useProjects } from '../../lib/projects'
import type { ConversationDto } from '@sillage/protocol'
import { relativeDate } from '../../lib/dates'
import { useTranslate } from '../../lib/i18n'
import { AgentIcon, AGENT_LABELS } from '../AgentIcon'
import { cx } from '../ui'

export function SessionPicker({ sessions, projectId, anyProject = false, active, loading, onPick, onHover }: {
  sessions: ConversationDto[]
  /** Current project: sessions of other projects (reachable under “Act on my other projects”) name theirs. */
  projectId?: string | null
  /** Sessions come from every project of the account, not just this one. */
  anyProject?: boolean
  active: number
  loading: boolean
  onPick: (session: ConversationDto) => void
  onHover: (index: number) => void
}) {
  const t = useTranslate()
  const { data: projects } = useProjects()
  const projectName = (id: string | null) => id && id !== projectId ? projects?.find(project => project.id === id)?.name : undefined
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => { list.current?.children[active]?.scrollIntoView({ block: 'nearest' }) }, [active])
  return <div className="surface mb-1.5 rounded-lg border border-line p-1 shadow-float">
    <div className="px-2 py-1 text-xs text-ink-faint">{t(anyProject ? 'sessionRef.picker.all' : 'sessionRef.picker')}</div>
    {!sessions.length && <p role="status" className="p-2 text-xs text-ink-faint">{t(loading ? 'sessionRef.loading' : 'sessionRef.empty')}</p>}
    <ul ref={list} role="listbox" id="session-suggestions" aria-label={t(anyProject ? 'sessionRef.picker.all' : 'sessionRef.picker')} className="max-h-56 overflow-y-auto">
      {sessions.map((session, index) => <li key={session.id}>
        <button type="button" role="option" id={`session-option-${index}`} aria-selected={index === active}
          onMouseDown={event => event.preventDefault()} onClick={() => onPick(session)} onMouseEnter={() => onHover(index)}
          className={cx('flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm', index === active ? 'bg-accent-wash text-ink' : 'text-ink-soft')}>
          <AgentIcon agent={session.agent} />
          <span className="min-w-0 flex-1"><span className="block truncate">{session.title}</span>
            <span className="block text-[0.6875rem] text-ink-faint">{projectName(session.projectId) ? `${projectName(session.projectId)} · ` : ''}{AGENT_LABELS[session.agent]} · {relativeDate(session.updatedAt)}{session.archivedAt !== null && ` · ${t('sessionRef.archived')}`}</span>
          </span>
        </button>
      </li>)}
    </ul>
  </div>
}
