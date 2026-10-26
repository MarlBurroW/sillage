import { BookOpen } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslate } from '../../lib/i18n'
import { useLocalSkills, useSkillLibrary } from '../../lib/skill-library'
import { Badge, Banner, Card, CardBody, CardHeader } from '../ui'
import { AddSkillMenu } from './AddSkillMenu'
import { SkillUpdates } from './SkillUpdates'
import { SkillTabs } from './SkillTabs'
import { SkillDiscovery } from './SkillDiscovery'
import { SkillList, originLabel } from './SkillList'

/**
 * Project skills include owner-editable library entries and read-only repository skills. Show
 * repository entries because each serves only its CLI: claude skills are invisible to Codex and
 * agents skills to Claude. Importing through Add delivers them to both.
 */
export function ProjectSkills({ projectId, isOwner }: { projectId: string; isOwner: boolean }) {
  const t = useTranslate()
  const [tab, setTab] = useState<'installed' | 'discover' | 'updates' | 'repository'>('installed')
  const { data } = useSkillLibrary(projectId)
  const { data: local } = useLocalSkills(projectId, true)
  const skills = data?.skills ?? []
  const own = skills.filter((skill) => skill.scope === 'project')
  const globals = skills.length - own.length
  const repository = (local?.skills ?? []).filter((skill) => skill.origin.endsWith('-repo'))

  return (
    <Card>
      <CardHeader
        title={t('skills.project.title')}
        description={t('skills.project.description')}
        icon={<BookOpen size={16} />}
        actions={isOwner ? <AddSkillMenu scope="project" projectId={projectId} onDiscover={() => setTab('discover')} /> : null}
      />
      <CardBody className="flex flex-col gap-4">
        {data && !data.enabled ? <Banner tone="caution">{t('skills.instanceDisabled')}</Banner> : null}
        <SkillTabs label={t('skills.project.title')} value={tab} onChange={setTab} tabs={[
          { value: 'installed', label: t('skills.tabs.installed') },
          { value: 'discover', label: t('skills.tabs.discover') },
          { value: 'updates', label: t('skills.tabs.updates') },
          { value: 'repository', label: t('skills.tabs.repository') },
        ]}>
          {tab === 'installed' ? <div className="flex flex-col gap-4">
            <p className="text-xs text-ink-faint">
              {t('skills.project.globals', { count: globals })}{' '}
              <Link to="/settings/skills" className="text-accent hover:underline">
                {t('skills.project.globals.link')}
              </Link>
            </p>
            {own.length > 0 ? <SkillList skills={own} /> : (
              <p className="text-sm text-ink-faint">{t('skills.project.empty')}</p>
            )}
          </div> : null}
        {tab === 'discover' ? <SkillDiscovery scope="project" projectId={projectId} /> : null}
        {tab === 'updates' ? <SkillUpdates skills={own} showEmpty /> : null}
        {tab === 'repository' ? (
          <section className="flex flex-col gap-2">
            <div>
              <h3 className="text-sm font-semibold text-ink-soft">{t('skills.project.repo.title')}</h3>
              <p className="text-xs text-ink-faint">{t('skills.project.repo.hint')}</p>
            </div>
            {repository.length === 0 ? <p className="py-4 text-sm text-ink-faint">{t('skills.repository.empty')}</p> : null}
            <ul className="flex flex-col gap-1.5">
              {repository.map((skill) => (
                <li key={skill.path} className="flex flex-wrap items-center gap-2 rounded-md bg-sunken px-3 py-2">
                  <span className="font-mono text-sm">{skill.name}</span>
                  <Badge>{originLabel(skill.origin)}</Badge>
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-faint">{skill.description}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        </SkillTabs>
      </CardBody>
    </Card>
  )
}
