import { BookOpen } from 'lucide-react'
import { AddSkillMenu } from '../components/skills/AddSkillMenu'
import { SkillUpdates } from '../components/skills/SkillUpdates'
import { SkillList } from '../components/skills/SkillList'
import { SkillSourcesSection } from '../components/skills/SkillSourcesSection'
import { Banner, EmptyState } from '../components/ui'
import { useTranslate } from '../lib/i18n'
import { useCurrentUser } from '../lib/session'
import { useSkillLibrary } from '../lib/skill-library'
import { SectionHeader } from './SettingsPage'

/**
 * Global skill library delivered to every conversation in the instance.
 *
 * Visible to all so everyone knows what agents receive; editable only by administrators, like
 * the MCP registry. Project skills are managed on project pages.
 */
export function SkillLibrarySettingsPage() {
  const t = useTranslate()
  const { data: me } = useCurrentUser()
  const isAdmin = me?.isAdmin === true
  const { data } = useSkillLibrary(null)
  const skills = data?.skills ?? []

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title={t('skills.section.title')} description={t('skills.section.description')} />

      <Banner tone="info">{t('skills.banner')}</Banner>
      {data && !data.enabled ? <Banner tone="caution">{t('skills.instanceDisabled')}</Banner> : null}
      {isAdmin ? null : <Banner>{t('skills.readonly')}</Banner>}

      <SkillUpdates skills={skills} />

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink-soft">{t('skills.global.title')}</h2>
          {isAdmin ? <AddSkillMenu scope="global" projectId={null} /> : null}
        </div>
        {skills.length === 0 ? (
          <EmptyState icon={<BookOpen size={22} />} title={t('skills.empty.title')} description={t('skills.empty.description')} />
        ) : (
          <SkillList skills={skills} />
        )}
      </section>

      <SkillSourcesSection isAdmin={isAdmin} />
    </div>
  )
}
