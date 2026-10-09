import { KeyRound, MoreHorizontal, Pencil, Plus, ShieldCheck, Trash2, UserPlus, UserRound } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import type { UserDto } from '@sillage/protocol'
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  Field,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  Select,
} from '../components/ui'
import { AccountForm } from '../components/AccountForm'
import { ListHeading, SectionHeader } from './SettingsPage'
import { ApiRequestError } from '../lib/api'
import { useTranslate } from '../lib/i18n'
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
  const t = useTranslate()
  const { data: me } = useCurrentUser()
  const isAdmin = me?.isAdmin === true
  const { data: users } = useUsers(isAdmin)

  const createUser = useCreateUser()
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<CreateUserInput>(EMPTY_FORM)

  if (!isAdmin) {
    return (
      <EmptyState
        icon={<ShieldCheck size={22} />}
        title={t('users.adminOnly.title')}
        description={t('users.adminOnly.description')}
      />
    )
  }

  const openForm = () => {
    setForm(EMPTY_FORM)
    createUser.reset()
    setAdding(true)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    createUser.mutate(form, { onSuccess: () => setAdding(false) })
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title={t('users.section.title')} description={t('users.section.description')} />

      <Banner tone="info">{t('users.banner')}</Banner>

      <section className="flex flex-col gap-2">
        <ListHeading
          title={t('users.existing.title')}
          count={users?.length}
          action={
            <Button size="sm" icon={<Plus size={15} />} disabled={adding} onClick={openForm}>
              {t('users.create.open')}
            </Button>
          }
        />

        {adding ? (
          <Card>
            <CardHeader title={t('users.create.title')} icon={<UserPlus size={16} />} />
            <CardBody>
              <form onSubmit={submit} className="flex flex-col gap-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label={t('users.username.label')}
                    icon={<UserRound size={16} />}
                    value={form.username}
                    onChange={(event) => setForm({ ...form, username: event.target.value })}
                    autoCapitalize="none"
                    autoCorrect="off"
                    autoFocus
                    required
                  />
                  <Field
                    label={t('users.displayName.label')}
                    value={form.displayName}
                    onChange={(event) => setForm({ ...form, displayName: event.target.value })}
                    required
                  />
                </div>
                <Field
                  label={t('users.password.label')}
                  type="password"
                  icon={<KeyRound size={16} />}
                  value={form.password}
                  onChange={(event) => setForm({ ...form, password: event.target.value })}
                  hint={t('users.password.hint')}
                  autoComplete="new-password"
                  required
                />
                <Select
                  label={t('users.role.label')}
                  value={form.isAdmin ? 'admin' : 'member'}
                  onChange={(role) => setForm({ ...form, isAdmin: role === 'admin' })}
                  options={[
                    {
                      value: 'member',
                      label: t('users.role.member.label'),
                      hint: t('users.role.member.hint'),
                    },
                    {
                      value: 'admin',
                      label: t('users.role.admin.label'),
                      icon: <ShieldCheck size={15} />,
                      hint: t('users.role.admin.hint'),
                    },
                  ]}
                />
                {errorOf(createUser.error) ? <Banner>{errorOf(createUser.error)}</Banner> : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" disabled={createUser.isPending}>
                    {createUser.isPending ? t('users.create.pending') : t('users.create.action')}
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                    {t('common.cancel')}
                  </Button>
                </div>
              </form>
            </CardBody>
          </Card>
        ) : null}

        {users?.map((user) => (
          <UserCard key={user.id} user={user} isSelf={user.id === me?.id} />
        ))}
      </section>
    </div>
  )
}

function UserCard({ user, isSelf }: { user: UserDto; isSelf: boolean }) {
  const t = useTranslate()
  const updateUser = useUpdateUser()
  const deleteUser = useDeleteUser()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)

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
                  {t('users.badge.admin')}
                </Badge>
              ) : null}
              {isSelf ? <Badge>{t('users.badge.self')}</Badge> : null}
            </div>
            <p className="mt-0.5 font-mono text-xs text-ink-faint">{user.username}</p>
            <p className="mt-2 text-xs text-ink-faint">
              {t(user.ownedProjects > 1 ? 'users.count.projects.other' : 'users.count.projects.one', {
                count: user.ownedProjects,
              })}
              {' · '}
              {t(
                user.ownedConversations > 1
                  ? 'users.count.conversations.other'
                  : 'users.count.conversations.one',
                { count: user.ownedConversations },
              )}
              {' · '}
              {t(user.activeSessions > 1 ? 'users.count.sessions.other' : 'users.count.sessions.one', {
                count: user.activeSessions,
              })}
            </p>
          </div>

          {/* Modifier sous la main, le reste dans un menu : changer un rôle ou
              supprimer un compte est rare, et trois boutons empilés par ligne
              donnaient à la liste l'air d'un tableau de bord. */}
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="hidden md:inline-flex"
              onClick={() => setEditing((value) => !value)}
            >
              {t(editing ? 'users.edit.close' : 'users.edit.open')}
            </Button>
            <Menu
              trigger={
                <IconButton label={t('users.action.more')} size="sm">
                  <MoreHorizontal size={16} />
                </IconButton>
              }
            >
              {/* Au doigt, « Modifier » rejoint le menu : la ligne n'a pas la place. */}
              <div className="md:hidden">
                <MenuItem icon={<Pencil size={15} />} onSelect={() => setEditing((value) => !value)}>
                  {editing ? t('users.edit.close') : t('users.edit.open')}
                </MenuItem>
                <MenuSeparator />
              </div>
              <MenuItem
                icon={<ShieldCheck size={15} />}
                disabled={updateUser.isPending}
                onSelect={() => updateUser.mutate({ id: user.id, isAdmin: !user.isAdmin })}
              >
                {user.isAdmin ? t('users.role.remove') : t('users.role.promote')}
              </MenuItem>
              <MenuSeparator />
              {/* Grisé plutôt qu'absent pour son propre compte : l'action existe,
                  le serveur la refuse pour soi. */}
              <MenuItem
                icon={<Trash2 size={15} />}
                tone="critical"
                disabled={isSelf || deleteUser.isPending}
                onSelect={() => setConfirming(true)}
              >
                {t('users.delete.action')}
              </MenuItem>
            </Menu>
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

        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={t('users.delete.confirm', { username: user.username })}
          confirmLabel={t('users.delete.action')}
          tone="critical"
          busy={deleteUser.isPending}
          onConfirm={() => deleteUser.mutate(user.id, { onSettled: () => setConfirming(false) })}
        >
          {t('users.delete.body')}
        </ConfirmDialog>
      </CardBody>
    </Card>
  )
}
