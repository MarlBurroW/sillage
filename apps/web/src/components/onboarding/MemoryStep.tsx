import { Brain, FileText, FolderGit2, Layers, Sparkles } from 'lucide-react'
import type { ProjectDefaults } from '@sillage/protocol'
import { useTranslate } from '../../lib/i18n'
import { useProjectDefaults, useUpdateProjectDefaults } from '../../lib/user-settings'
import { CardGrid, ChoiceCard, Question, StepTitle, Tip, Why, useCommit, useGate, type StepProps } from './shell'

/**
 * Instruction and memory storage defaults for this account's future projects: Sillage or each CLI.
 * Save both on click; projects may override on their pages.
 */
export function MemoryStep({ nav, state }: StepProps) {
  const t = useTranslate()
  const defaults = useProjectDefaults()
  const update = useUpdateProjectDefaults()

  useGate(nav, { canContinue: true, laterAllowed: true, skipAllowed: true })
  useCommit(nav, null)

  const choose = (patch: Partial<ProjectDefaults>) => update.mutate({ ...defaults, ...patch })

  return (
    <>
      <StepTitle title={t('onboarding.memory.title')} lead={t('onboarding.memory.lead')} />

      <Question label={t('onboarding.memory.instructions')} hint={t('onboarding.memory.recommended')}>
        <CardGrid columns={3}>
          <ChoiceCard
            selected={defaults.instructionsMode === 'sillage'}
            onClick={() => choose({ instructionsMode: 'sillage' })}
            icon={<Layers size={15} />}
            label={t('onboarding.memory.instructions.sillage')}
            hint={t('onboarding.memory.instructions.sillage.hint')}
          />
          <ChoiceCard
            selected={defaults.instructionsMode === 'repo'}
            onClick={() => choose({ instructionsMode: 'repo' })}
            icon={<FolderGit2 size={15} />}
            label={t('onboarding.memory.instructions.repo')}
            hint={t('onboarding.memory.instructions.repo.hint')}
          />
          <ChoiceCard
            selected={defaults.instructionsMode === 'auto'}
            onClick={() => choose({ instructionsMode: 'auto' })}
            icon={<Sparkles size={15} />}
            label={t('onboarding.memory.instructions.auto')}
            hint={t('onboarding.memory.instructions.auto.hint')}
          />
        </CardGrid>
      </Question>

      <Question label={t('onboarding.memory.memory')} hint={t('onboarding.memory.recommended')}>
        <CardGrid>
          <ChoiceCard
            selected={defaults.memoryMode === 'sillage'}
            onClick={() => choose({ memoryMode: 'sillage' })}
            icon={<Brain size={15} />}
            label={t('onboarding.memory.memory.sillage')}
            hint={t('onboarding.memory.memory.sillage.hint')}
          />
          <ChoiceCard
            selected={defaults.memoryMode === 'native'}
            onClick={() => choose({ memoryMode: 'native' })}
            icon={<FileText size={15} />}
            label={t('onboarding.memory.memory.native')}
            hint={t('onboarding.memory.memory.native.hint')}
          />
        </CardGrid>
      </Question>

      {state.answers.guidance === 'guided' ? (
        <Why>
          <b>{t('onboarding.memory.why.title')}</b> {t('onboarding.memory.why.body')}
        </Why>
      ) : null}
      <Tip>{t('onboarding.memory.perProject')}</Tip>
    </>
  )
}
