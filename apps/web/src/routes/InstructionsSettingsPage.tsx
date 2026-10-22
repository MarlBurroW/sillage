import { HowItWorks, INSTRUCTIONS_HELP } from '../components/instructions/HowItWorks'
import { GlobalInstructions } from '../components/instructions/Instructions'
import { Banner } from '../components/ui'
import { useTranslate } from '../lib/i18n'
import { SectionHeader } from './SettingsPage'

/**
 * Global SILLAGE.md section, injected into every instance session, Claude and Codex alike.
 * Project sections are configured on project pages.
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
