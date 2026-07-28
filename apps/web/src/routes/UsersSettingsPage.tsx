import { KeyRound, ShieldCheck, Trash2, UserPlus, UserRound } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import type { UserDto } from '@sillage/protocol'
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Select,
} from '../components/ui'
import { AccountForm } from '../components/AccountForm'
import { SectionHeader } from './SettingsPage'
import { ApiRequestError } from '../lib/api'
import { useCurrentUser } from '../lib/session'
import { useCreateUser, useDeleteUser, useUpdateUser, useUsers, type CreateUserInput } from '../lib/users'

const EMPTY_FORM: CreateUserInput = {
  username: '',
  displayName: '',
  password: '',
  isAdmin: false,
}

const errorOf = (error: unknown): string | null =>
  error instanceof ApiRequestError ? error.message : null

/**
 * Gestion des comptes de l'instance.
 *
 * Rappel du modèle : un compte donne l'accès à Sillage, pas une isolation. Tous les
 * agents tournent sous le même utilisateur système et partagent tes credentials CLI.
 */
export function UsersSettingsPage() {
  const { data: me } = useCurrentUser()
  const isAdmin = me?.isAdmin === true
  const { data: users } = useUsers(isAdmin)

  const createUser = useCreateUser()
  const [form, setForm] = useState<CreateUserInput>(EMPTY_FORM)

  if (!isAdmin) {
    return (
      <EmptyState
        icon={<ShieldCheck size={22} />}
        title="Réservé aux administrateurs"
        description="Demande à un administrateur de l'instance."
      />
    )
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    createUser.mutate(form, { onSuccess: () => setForm(EMPTY_FORM) })
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title="Comptes" description="Les comptes de l'instance, et ce qu'ils peuvent faire." />

      <Banner tone="info">
        Un compte ouvre l&apos;accès à cette instance, sans isolation : tous les agents
        tournent sous le même utilisateur système et partagent les mêmes credentials CLI.
      </Banner>

      <Card>
        <CardHeader title="Nouveau compte" icon={<UserPlus size={16} />} />
        <CardBody>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Nom d'utilisateur"
                icon={<UserRound size={16} />}
                value={form.username}
                onChange={(event) => setForm({ ...form, username: event.target.value })}
                autoCapitalize="none"
                autoCorrect="off"
                required
              />
              <Field
                label="Nom affiché"
                value={form.displayName}
                onChange={(event) => setForm({ ...form, displayName: event.target.value })}
                required
              />
            </div>
            <Field
              label="Mot de passe"
              type="password"
              icon={<KeyRound size={16} />}
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              hint="8 caractères minimum."
              autoComplete="new-password"
              required
            />
            <Select
              label="Rôle"
              value={form.isAdmin ? 'admin' : 'member'}
              onChange={(role) => setForm({ ...form, isAdmin: role === 'admin' })}
              options={[
                { value: 'member', label: 'Membre', hint: 'Accès aux projets partagés' },
                {
                  value: 'admin',
                  label: 'Administrateur',
                  icon: <ShieldCheck size={15} />,
                  hint: 'Peut gérer les comptes',
                },
              ]}
            />
            {errorOf(createUser.error) ? <Banner>{errorOf(createUser.error)}</Banner> : null}
            <Button type="submit" disabled={createUser.isPending} className="self-start">
              {createUser.isPending ? 'Création...' : 'Créer le compte'}
            </Button>
          </form>
        </CardBody>
      </Card>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-ink-soft">Existants</h2>
        {users?.map((user) => (
          <UserCard key={user.id} user={user} isSelf={user.id === me?.id} />
        ))}
      </section>
    </div>
  )
}

function UserCard({ user, isSelf }: { user: UserDto; isSelf: boolean }) {
  const updateUser = useUpdateUser()
  const deleteUser = useDeleteUser()
  const [editing, setEditing] = useState(false)

  const error = errorOf(updateUser.error) ?? errorOf(deleteUser.error)

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate font-medium">{user.displayName}</p>
              {user.isAdmin ? (
                <Badge tone="accent" icon={<ShieldCheck size={11} />}>
                  Administrateur
                </Badge>
              ) : null}
              {isSelf ? <Badge>Toi</Badge> : null}
            </div>
            <p className="mt-0.5 font-mono text-xs text-ink-faint">{user.username}</p>
            <p className="mt-2 text-xs text-ink-faint">
              {user.ownedProjects} projet{user.ownedProjects > 1 ? 's' : ''}
              {' · '}
              {user.ownedConversations} conversation{user.ownedConversations > 1 ? 's' : ''}
              {' · '}
              {user.activeSessions} session{user.activeSessions > 1 ? 's' : ''} ouverte
              {user.activeSessions > 1 ? 's' : ''}
            </p>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={updateUser.isPending}
              onClick={() => updateUser.mutate({ id: user.id, isAdmin: !user.isAdmin })}
            >
              {user.isAdmin ? 'Retirer le rôle' : 'Nommer admin'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing((value) => !value)}>
              {editing ? 'Fermer' : 'Modifier'}
            </Button>
            {!isSelf ? (
              <Button
                size="sm"
                variant="danger"
                icon={<Trash2 size={15} />}
                disabled={deleteUser.isPending}
                onClick={() => {
                  if (confirm(`Supprimer le compte « ${user.username} » ?`)) {
                    deleteUser.mutate(user.id)
                  }
                }}
              >
                Supprimer
              </Button>
            ) : null}
          </div>
        </div>

        {editing ? (
          <div className="rounded-md border border-line bg-sunken p-3">
            {/* Même formulaire que pour son propre compte : le mot de passe actuel n'y
                est pas demandé, un administrateur réinitialise sans le connaître. */}
            <AccountForm
              userId={user.id}
              username={user.username}
              displayName={user.displayName}
              isSelf={isSelf}
              onDone={() => setEditing(false)}
            />
          </div>
        ) : null}

        {error ? <Banner>{error}</Banner> : null}
      </CardBody>
    </Card>
  )
}
