import { useTranslate } from '../../lib/i18n'
import { RemoteAccessCard } from '../../routes/RemoteAccessSettingsPage'
import { StepTitle, Tip, useCommit, useGate, type StepProps } from './shell'

/**
 * Desktop's counterpart to the hosted address step. The app listens on this computer only, so
 * following a turn from a phone goes through Tailscale Serve; the setting existed in Settings
 * alone, where a newcomer had no reason to look. Optional and off by default: the step shows the
 * very card of the settings page, so what is learned here is found again there.
 */
export function RemoteStep({ nav }: StepProps) {
  const t = useTranslate()

  useGate(nav, { canContinue: true, laterAllowed: true, skipAllowed: true })
  useCommit(nav, null)

  return (
    <>
      <StepTitle title={t('onboarding.remote.title')} lead={t('onboarding.remote.lead')} />
      <RemoteAccessCard />
      <Tip>{t('onboarding.remote.tip')}</Tip>
    </>
  )
}
