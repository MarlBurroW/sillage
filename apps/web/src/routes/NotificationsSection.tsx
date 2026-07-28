import { Card, CardBody } from '../components/ui'
import { PushControls } from '../components/PushControls'
import { SectionHeader } from './SettingsPage'

export function NotificationsSection() {
  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Notifications"
        description="Propre à cet appareil : activer ici ne change rien sur les autres."
      />
      <Card>
        <CardBody>
          <PushControls />
        </CardBody>
      </Card>
    </div>
  )
}
