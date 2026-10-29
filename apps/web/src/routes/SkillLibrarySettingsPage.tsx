import { SkillLoading } from '../components/skills/SkillLoading'
import { BookOpen, Search } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AddSkillMenu } from '../components/skills/AddSkillMenu'
import { SkillDiscovery } from '../components/skills/SkillDiscovery'
import { SkillUpdates } from '../components/skills/SkillUpdates'
import { SkillList } from '../components/skills/SkillList'
import { SkillSourcesSection } from '../components/skills/SkillSourcesSection'
import { SkillTabs } from '../components/skills/SkillTabs'
import { Banner, EmptyState, Field } from '../components/ui'
import { useTranslate } from '../lib/i18n'
import { useCurrentUser } from '../lib/session'
import { useSkillLibrary } from '../lib/skill-library'
import { SectionHeader } from './SettingsPage'

const TABS = ['installed', 'discover', 'sources', 'updates'] as const
type Tab = typeof TABS[number]

/** One task and one list per tab; URLs retain the section when returning from an editor. */
export function SkillLibrarySettingsPage() {
  const t = useTranslate()
  const { data: me } = useCurrentUser()
  const isAdmin = me?.isAdmin === true
  const { data, isLoading, error } = useSkillLibrary(null)
  const skills = data?.skills ?? []
  const [params, setParams] = useSearchParams()
  const requested = params.get('tab')
  const tab: Tab = TABS.find((value) => value === requested) ?? 'installed'
  const setTab = (value: Tab) => setParams((previous) => { const next = new URLSearchParams(previous); next.set('tab', value); return next })
  const [filter, setFilter] = useState('')
  const needle = filter.trim().toLocaleLowerCase()
  const filtered = skills.filter((skill) => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(needle))

  return <div className="flex flex-col gap-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <SectionHeader title={t('skills.section.title')} description={t('skills.navigation.description')} />
      {isAdmin ? <AddSkillMenu scope="global" projectId={null} onDiscover={() => setTab('discover')} /> : null}
    </div>
    {data && !data.enabled ? <Banner tone="caution">{t('skills.instanceDisabled')}</Banner> : null}
    {isAdmin ? null : <Banner>{t('skills.readonly')}</Banner>}
    <SkillTabs label={t('skills.section.title')} tabs={TABS.map((value) => ({ value, label: t(`skills.tabs.${value}`) }))}
      value={tab} onChange={setTab}>
      {tab === 'installed' ? <div className="flex flex-col gap-4">
        <Field label={t('skills.installed.filter')} icon={<Search size={15} />} value={filter} onChange={(event) => setFilter(event.target.value)} />
        {isLoading ? <SkillLoading label={t('skills.loading.library')} rows={3} /> : error ? <Banner>{error.message}</Banner>
          : skills.length === 0 ? <EmptyState icon={<BookOpen size={22} />} title={t('skills.empty.title')} description={t('skills.empty.description')} />
          : filtered.length === 0 ? <p className="py-8 text-center text-sm text-ink-faint">{t('skills.search.empty')}</p>
          : <SkillList skills={filtered} />}
      </div> : null}
      {tab === 'discover' ? <SkillDiscovery scope="global" projectId={null} /> : null}
      {tab === 'sources' ? <SkillSourcesSection isAdmin={isAdmin} /> : null}
      {tab === 'updates' ? isLoading ? <SkillLoading label={t('skills.loading.library')} rows={3} /> : error ? <Banner>{error.message}</Banner> : <SkillUpdates skills={skills} showEmpty /> : null}
    </SkillTabs>
  </div>
}
