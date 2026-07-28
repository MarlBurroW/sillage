import { ShieldCheck } from 'lucide-react'
import { AccountForm } from '../components/AccountForm'
import { useCurrentUser } from '../lib/session'
import { Badge, Card, CardBody } from '../components/ui'
import { SectionHeader } from './SettingsPage'

export function AccountSection() {
  const { data: user } = useCurrentUser()

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title="Compte" description="Ce que les autres comptes voient de toi." />

      {user?.isAdmin ? (
        <Badge tone="accent" icon={<ShieldCheck size={11} />}>
          Administrateur
        </Badge>
      ) : null}

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
