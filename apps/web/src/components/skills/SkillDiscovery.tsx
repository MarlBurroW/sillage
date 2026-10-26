import { Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { LibrarySkillScope } from '@sillage/protocol'
import { useTranslate } from '../../lib/i18n'
import { useSavedSkillSearch, useSkillSearch, type DiscoverableSkill } from '../../lib/skill-sources'
import { Badge, Banner, Button, EmptyState, Field, Select } from '../ui'
import { InstallSkillDialog } from './InstallSkillDialog'
import { useSkillPermissions } from './permissions'

export function SkillDiscovery({ scope, projectId }: { scope: LibrarySkillScope; projectId: string | null }) {
  const t = useTranslate()
  const permissions = useSkillPermissions()
  const [where, setWhere] = useState('directory')
  const directory = permissions.isAdmin && where === 'directory'
  const [query, setQuery] = useState('')
  const [settled, setSettled] = useState('')
  const [chosen, setChosen] = useState<DiscoverableSkill | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(query), 300)
    return () => clearTimeout(timer)
  }, [query])
  const remote = useSkillSearch(settled, directory)
  const saved = useSavedSkillSearch(query, !directory)
  const results: DiscoverableSkill[] = directory
    ? (remote.data?.results ?? []).map((result) => ({ kind: 'directory', result }))
    : saved.results
  const waiting = directory && (query !== settled || remote.isFetching)
  const loading = waiting || (!directory && saved.loading)
  return <section className="flex flex-col gap-4">
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(180px,auto)]">
      <Field label={t('skills.discovery.search')} icon={<Search size={15} />} value={query} maxLength={100}
        onChange={(event) => setQuery(event.target.value)} placeholder={t('skills.search.placeholder')} />
      <Select label={t('skills.discovery.where')} value={directory ? 'directory' : 'sources'} onChange={setWhere}
        options={[
          ...(permissions.isAdmin ? [{ value: 'directory', label: t('skills.discovery.directory') }] : []),
          { value: 'sources', label: t('skills.discovery.sources') },
        ]} />
    </div>
    <p className="text-sm text-ink-faint">{t(directory ? 'skills.discovery.directoryHint' : 'skills.discovery.sourcesHint')}</p>
    {!directory && saved.unfetched > 0 ? <Banner tone="info">{t('skills.discovery.unfetched', { count: saved.unfetched })}</Banner> : null}
    {directory && remote.error ? <Banner>{remote.error.message}</Banner> : null}
    {!directory ? saved.errors.map((error, index) => <Banner key={index}>{error.message}</Banner>) : null}
    {directory && remote.data?.available === false ? <Banner tone="caution">{t('skills.discovery.unavailable')}</Banner> : null}
    {loading ? <p role="status" className="text-sm text-ink-faint">{t('skills.search.loading')}</p> : null}
    {directory && query.trim().length < 2 ? <EmptyState icon={<Search size={22} />}
      title={t('skills.discovery.prompt')} description={t('skills.discovery.promptHint')} /> : !waiting ? <>
      <ul className="divide-y divide-line">
        {results.map((candidate) => {
          const name = candidate.kind === 'source' ? candidate.skill.name : candidate.result.name
          const repository = candidate.kind === 'source' ? candidate.source.name : candidate.result.repository
          const installed = candidate.kind === 'source' && candidate.skill.installed.some((entry) => entry.scope === scope && entry.projectId === projectId)
          return <li key={candidate.kind === 'source' ? `${candidate.source.id}:${candidate.skill.path}` : `${repository}:${name}`}
            className="flex items-start gap-3 py-4">
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-medium">{name}</p>
              <p className="mt-1 break-words text-xs text-ink-faint">{repository}</p>
              {candidate.kind === 'source' ? <p className="mt-2 line-clamp-2 text-sm text-ink-soft">{candidate.skill.description}</p> : null}
              {candidate.kind === 'directory' && candidate.result.sourceId ? <Badge>{t('skills.discovery.knownSource')}</Badge> : null}
              {installed ? <Badge tone="positive">{t('skills.catalog.installed')}</Badge> : null}
            </div>
            <Button size="sm" variant="secondary" className="shrink-0" onClick={() => setChosen(candidate)}
              disabled={permissions.destinations.length === 0 || (candidate.kind === 'source' && candidate.skill.problem === 'skill_unreadable')}>
              {t('skills.search.install')}
            </Button>
          </li>
        })}
      </ul>
      {!loading && results.length === 0 && !(directory && remote.data?.available === false) ? <p className="py-8 text-center text-sm text-ink-faint">{t('skills.search.empty')}</p> : null}
    </> : null}
    {chosen ? <InstallSkillDialog candidate={chosen} scope={scope} projectId={projectId} onClose={() => setChosen(null)} /> : null}
  </section>
}
