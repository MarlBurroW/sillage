import { BookOpen } from 'lucide-react'
import { AddSkillMenu } from '../components/skills/AddSkillMenu'
import { SkillList } from '../components/skills/SkillList'
import { SkillSourcesSection } from '../components/skills/SkillSourcesSection'
import { Banner, EmptyState } from '../components/ui'
import { useTranslate } from '../lib/i18n'
import { useCurrentUser } from '../lib/session'
import { useSkillLibrary } from '../lib/skill-library'
import { SectionHeader } from './SettingsPage'

/**
 * Bibliothèque de skills globale : livrée à toutes les conversations de l'instance.
 *
 * Visible de tous, parce que chacun doit savoir ce que ses agents reçoivent ; modifiable
 * par les administrateurs seuls, comme le registre MCP. Les skills d'un projet se gèrent
 * sur la page du projet.
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
