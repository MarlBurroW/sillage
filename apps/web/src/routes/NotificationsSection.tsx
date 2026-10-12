import { PushControls } from '../components/PushControls'
import { SectionHeader } from './SettingsPage'
import { useTranslate } from '../lib/i18n'

export function NotificationsSection() {
  const t = useTranslate()
  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title={t('settings.section.notifications')}
        description={t('settings.notifications.deviceScope')}
      />
      <PushControls />
    </div>
  )
}
