import { ShieldCheck } from 'lucide-react'
import { AccountForm } from '../components/AccountForm'
import { useTranslate } from '../lib/i18n'
import { useCurrentUser } from '../lib/session'
import { Badge, Card, CardBody } from '../components/ui'
import { SectionHeader } from './SettingsPage'

export function AccountSection() {
  const t = useTranslate()
  const { data: user } = useCurrentUser()

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title={t('settings.section.account')}
        description={t('account.section.description')}
        // À côté du titre et non entre lui et la carte : le rôle qualifie le compte
        // entier, et une pastille seule sur sa ligne s'étirait sur toute la largeur.
        badge={
          user?.isAdmin ? (
            <Badge tone="accent" icon={<ShieldCheck size={11} />}>
              {t('users.badge.admin')}
            </Badge>
          ) : null
        }
      />

      <Card>
        <CardBody>
          {user ? (
            <AccountForm
              userId={user.id}
              username={user.username}
              displayName={user.displayName}
              isSelf
            />
          ) : null}
        </CardBody>
      </Card>
    </div>
  )
}
