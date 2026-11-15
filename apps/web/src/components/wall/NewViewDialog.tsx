import { evaluateSessionQuery, type ProjectDto, type SessionFacts } from '@sillage/protocol'
import { useMemo, useState } from 'react'
import { useTranslate } from '../../lib/i18n'
import { ConfirmDialog, Field } from '../ui'
import { describeQuery } from './describe-query'
import { WallFilters } from './WallFilters'

const PREVIEW = 4

/**
 * Composes a saved view without typing: the filter buttons write the query, and the dialog reads it
 * back in plain words with the sessions it would show right now. The query text stays visible as
 * what gets saved; editing it by hand belongs to the view itself.
 */
export function NewViewDialog({ open, onOpenChange, seed, facts, now, projects, onCreate }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Where the view starts from: what the wall shows when the dialog opens. */
  seed: string
  facts: readonly SessionFacts[]
  now: number
  projects: readonly ProjectDto[]
  onCreate: (name: string, query: string) => void
}) {
  const t = useTranslate()
  const [name, setName] = useState('')
  const [query, setQuery] = useState(seed)
  // Reset during render when the dialog opens: an effect would show the previous draft for a frame.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) { setName(''); setQuery(seed) }
  }
  const result = useMemo(() => evaluateSessionQuery(query, facts, now), [query, facts, now])
  const titles = useMemo(() => {
    const byId = new Map(facts.map((fact) => [fact.id, fact]))
    return result.ids.slice(0, PREVIEW).flatMap((id) => byId.get(id) ?? [])
  }, [result.ids, facts])

  return (
    <ConfirmDialog open={open} onOpenChange={onOpenChange} title={t('wall.views.newTitle')} confirmLabel={t('wall.views.create')}
      size="wide" confirmDisabled={!name.trim()} onConfirm={() => onCreate(name.trim(), query)}>
      <p>{t('wall.views.newHint')}</p>
      <Field label={t('wall.views.name')} value={name} onChange={(event) => setName(event.target.value)} maxLength={60} autoFocus placeholder={t('wall.compose.namePlaceholder')} />
      <div className="wall-compose">
        <p className="wall-compose-label">{t('wall.compose.which')}</p>
        <WallFilters query={query} onChange={setQuery} projects={projects} />
        <div className="wall-compose-preview" data-wall-compose-preview>
          <p role="status"><b>{t(result.ids.length === 1 ? 'wall.bar.count.one' : 'wall.bar.count', { count: result.ids.length })}</b>{' · '}{describeQuery(result.tokens, projects, t)}</p>
          {titles.length ? (
            <ul>
              {titles.map((fact) => <li key={fact.id}><span className="truncate">{fact.title}</span>{fact.projectName ? <span className="wall-compose-project">{fact.projectName}</span> : null}</li>)}
              {result.ids.length > titles.length ? <li className="text-ink-faint">{t('wall.compose.more', { count: result.ids.length - titles.length })}</li> : null}
            </ul>
          ) : <p className="text-ink-faint">{t('wall.compose.none')}</p>}
        </div>
        <p className="text-xs text-ink-faint">{t('wall.views.query')} <code className="font-mono text-ink-soft">{query.trim() || '—'}</code>{' · '}{t('wall.compose.byHand')}</p>
      </div>
    </ConfirmDialog>
  )
}
