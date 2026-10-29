import { ExternalLink, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { LibrarySkillScope } from '@sillage/protocol'
import { locale, useTranslate } from '../../lib/i18n'
import { useDiscoveryDescription, useSavedSkillSearch, useSkillSearch, type DiscoverableSkill } from '../../lib/skill-sources'
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
            className="flex flex-wrap items-start gap-3 py-5 sm:flex-nowrap">
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-medium">{name}</p>
              <p className="mt-1 break-words text-xs text-ink-faint">{repository}</p>
              <DiscoveryInfo candidate={candidate} />
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

function DiscoveryInfo({ candidate }: { candidate: DiscoverableSkill }) {
  const t = useTranslate()
  const result = candidate.kind === 'directory' ? candidate.result : null
  const details = useDiscoveryDescription(result)
  const [expanded, setExpanded] = useState(false)
  const description = candidate.kind === 'source' ? candidate.skill.description : details.data?.description
  const directoryUrl = result ? 'https://skills.sh/' + result.repository.split('/').map(encodeURIComponent).join('/') + '/' + encodeURIComponent(result.slug ?? result.name) : null
  return <div className="mt-2 flex flex-col items-start gap-2">
    {description ? <>
      <p className={`whitespace-pre-line break-words text-sm leading-relaxed text-ink-soft ${expanded ? '' : 'line-clamp-3'}`}>{description}</p>
      <button type="button" className="text-xs text-accent hover:underline" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {t(expanded ? 'skills.discovery.less' : 'skills.discovery.more')}
      </button>
    </> : <p className="text-sm text-ink-faint">
      {t(result && details.isLoading ? 'skills.discovery.descriptionLoading' : 'skills.discovery.noDescription')}
    </p>}
    {result ? <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-faint">
      <span>{t('skills.discovery.installs', { count: result.installs.toLocaleString(locale()) })}</span>
      <a href={directoryUrl!} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-ink-soft hover:underline">
        {t('skills.discovery.directoryPage')}<ExternalLink size={12} />
      </a>
      <a href={`https://github.com/${result.repository.split('/').map(encodeURIComponent).join('/')}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-ink-soft hover:underline">
        {t('skills.discovery.repository')}<ExternalLink size={12} />
      </a>
    </div> : null}
  </div>
}
