import { KeyRound, UserRound } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { ApiRequestError } from '../lib/api'
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
          setDone(changingPassword ? 'Mot de passe changé.' : 'Compte mis à jour.')
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
          label="Nom d'utilisateur"
          icon={<UserRound size={16} />}
          value={form.username}
          onChange={(event) => setForm({ ...form, username: event.target.value })}
          hint="Sert à la connexion."
          autoCapitalize="none"
          autoCorrect="off"
        />
        <Field
          label="Nom affiché"
          value={form.displayName}
          onChange={(event) => setForm({ ...form, displayName: event.target.value })}
        />
      </div>

      {isSelf ? (
        <Field
          label="Mot de passe actuel"
          type="password"
          icon={<KeyRound size={16} />}
          value={passwords.current}
          onChange={(event) => setPasswords({ ...passwords, current: event.target.value })}
          hint="Requis seulement pour en définir un nouveau."
          autoComplete="current-password"
        />
      ) : null}

      <Field
        label="Nouveau mot de passe"
        type="password"
        icon={<KeyRound size={16} />}
        value={passwords.next}
        onChange={(event) => setPasswords({ ...passwords, next: event.target.value })}
        hint={
          isSelf
            ? 'Laisse vide pour ne pas le changer. Les autres appareils seront déconnectés.'
            : 'Laisse vide pour ne pas le changer. Toutes les sessions de ce compte seront fermées.'
        }
        autoComplete="new-password"
      />

      {error ? <Banner>{error}</Banner> : null}
      {done && !error ? <Banner tone="positive">{done}</Banner> : null}

      <Button type="submit" disabled={!canSubmit} className="self-start">
        {updateUser.isPending ? 'Enregistrement...' : 'Enregistrer'}
      </Button>
    </form>
  )
}
