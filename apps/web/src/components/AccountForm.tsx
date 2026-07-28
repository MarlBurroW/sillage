import { KeyRound, UserRound } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { ApiRequestError } from '../lib/api'
import { useTranslate } from '../lib/i18n'
import { useUpdateUser } from '../lib/users'
import { Banner, Button, Field } from './ui'

/**
 * Édition d'un compte : identifiant, nom affiché, mot de passe.
 *
 * Le même formulaire sert pour son propre compte et, côté administration, pour celui
 * d'un autre. La seule différence tient au mot de passe : pour soi, l'actuel est exigé,
 * parce qu'un écran resté déverrouillé suffirait sinon à prendre le compte.
 */
export function AccountForm({
  userId,
  username,
  displayName,
  isSelf,
  onDone,
}: {
  userId: string
  username: string
  displayName: string
  isSelf: boolean
  onDone?: () => void
}) {
  const updateUser = useUpdateUser()
  const t = useTranslate()

  const [form, setForm] = useState({ username, displayName })
  const [passwords, setPasswords] = useState({ current: '', next: '' })
  const [done, setDone] = useState<string | null>(null)

  const identityChanged = form.username !== username || form.displayName !== displayName
  const changingPassword = passwords.next.length > 0
  const canSubmit =
    (identityChanged || changingPassword) &&
    !updateUser.isPending &&
    form.username.trim().length > 0 &&
    form.displayName.trim().length > 0 &&
    (!changingPassword || passwords.next.length >= 8) &&
    (!changingPassword || !isSelf || passwords.current.length > 0)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return
    setDone(null)

    updateUser.mutate(
      {
        id: userId,
        // Seuls les champs réellement modifiés partent : envoyer l'identifiant
        // inchangé déclencherait une vérification d'unicité contre soi-même.
        ...(form.username !== username ? { username: form.username.trim() } : {}),
        ...(form.displayName !== displayName ? { displayName: form.displayName.trim() } : {}),
        ...(changingPassword
          ? {
              password: passwords.next,
              ...(isSelf ? { currentPassword: passwords.current } : {}),
            }
          : {}),
      },
      {
        onSuccess: () => {
          setPasswords({ current: '', next: '' })
          setDone(changingPassword ? t('account.password.changed') : t('account.updated'))
          onDone?.()
        },
      },
    )
  }

  const error =
    updateUser.error instanceof ApiRequestError ? updateUser.error.message : null

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={t('account.username.label')}
          icon={<UserRound size={16} />}
          value={form.username}
          onChange={(event) => setForm({ ...form, username: event.target.value })}
          hint={t('account.username.hint')}
          autoCapitalize="none"
          autoCorrect="off"
        />
        <Field
          label={t('account.displayName.label')}
          value={form.displayName}
          onChange={(event) => setForm({ ...form, displayName: event.target.value })}
        />
      </div>

      {isSelf ? (
        <Field
          label={t('account.password.current.label')}
          type="password"
          icon={<KeyRound size={16} />}
          value={passwords.current}
          onChange={(event) => setPasswords({ ...passwords, current: event.target.value })}
          hint={t('account.password.current.hint')}
          autoComplete="current-password"
        />
      ) : null}

      <Field
        label={t('account.password.next.label')}
        type="password"
        icon={<KeyRound size={16} />}
        value={passwords.next}
        onChange={(event) => setPasswords({ ...passwords, next: event.target.value })}
        hint={
          isSelf
            ? t('account.password.next.hint.self')
            : t('account.password.next.hint.other')
        }
        autoComplete="new-password"
      />

      {error ? <Banner>{error}</Banner> : null}
      {done && !error ? <Banner tone="positive">{done}</Banner> : null}

      <Button type="submit" disabled={!canSubmit} className="self-start">
        {updateUser.isPending ? t('account.save.pending') : t('account.save.action')}
      </Button>
    </form>
  )
}
