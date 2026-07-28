import { Card, CardBody } from '../components/ui'
import { PushControls } from '../components/PushControls'
import { SectionHeader } from './SettingsPage'
import { useTranslate } from '../lib/i18n'

export function NotificationsSection() {
  const t = useTranslate()
  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Notifications"
        description={t('settings.notifications.deviceScope')}
      />
      <Card>
        <CardBody>
          <PushControls />
        </CardBody>
      </Card>
    </div>
  )
}
