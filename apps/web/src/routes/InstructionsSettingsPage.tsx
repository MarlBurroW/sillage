import { HowItWorks, INSTRUCTIONS_HELP } from '../components/instructions/HowItWorks'
import { GlobalInstructions } from '../components/instructions/Instructions'
import { Banner } from '../components/ui'
import { useTranslate } from '../lib/i18n'
import { SectionHeader } from './SettingsPage'

/**
 * La partie globale de SILLAGE.md : injectée dans toutes les sessions de l'instance,
 * Claude comme Codex. Celle d'un projet se règle sur la page du projet.
 */
export function InstructionsSettingsPage() {
  const t = useTranslate()
  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title={t('instructions.section.title')} description={t('instructions.section.description')} />
      <Banner tone="info">{t('instructions.section.banner')}</Banner>
      <HowItWorks items={INSTRUCTIONS_HELP} />
      <GlobalInstructions />
    </div>
  )
}
