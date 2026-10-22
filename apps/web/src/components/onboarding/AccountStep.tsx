import { useQueryClient } from '@tanstack/react-query'
import { IdCard, KeyRound, UserRound } from 'lucide-react'
import { useState } from 'react'
import { DEFAULT_ONBOARDING, type CurrentUser } from '@sillage/protocol'
import { api } from '../../lib/api'
import { useTranslate } from '../../lib/i18n'
import { ME_KEY } from '../../lib/session'
import { useUpdateUser } from '../../lib/users'
import { Banner, Card, CardBody, Field } from '../ui'
import { StepTitle, Tip, Why, useCommit, useGate, type StepProps } from './shell'

const MIN_PASSWORD = 8

/** Suggested identifier derived from display name: Nicolas Dupont becomes nicolas-dupont. */
function slugUsername(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Account step in three forms: first-account creation for empty databases, existing administrator
 * accounts created through CLI or just now, and invited users taking ownership.
 */
export function AccountStep(props: StepProps) {
  if (!props.user) return <SetupForm {...props} />
  if (props.user.isAdmin) return <AdminSummary {...props} />
  return <MemberForm {...props} />
}

function SetupForm({ nav, hostname }: StepProps) {
  const t = useTranslate()
  const queryClient = useQueryClient()
  const [displayName, setDisplayName] = useState('')
  const [username, setUsername] = useState('')
  const [usernameEdited, setUsernameEdited] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')

  const applyName = (next: string) => {
    setDisplayName(next)
    if (!usernameEdited) setUsername(slugUsername(next))
  }

  const usernameInvalid = username.length > 0 && !/^[a-z0-9._-]+$/i.test(username)
  const passwordShort = password.length > 0 && password.length < MIN_PASSWORD
  const mismatch = confirm.length > 0 && confirm !== password
  const valid =
    displayName.trim().length > 0 &&
    username.length > 0 &&
    !usernameInvalid &&
    password.length >= MIN_PASSWORD &&
    password === confirm

  useGate(nav, { canContinue: valid, laterAllowed: false, skipAllowed: false })
  useCommit(nav, async () => {
    const user = await api.post<CurrentUser>('/api/auth/setup', {
      username,
      displayName: displayName.trim(),
      password,
    })
    // Onboarding is due from Welcome for this account: account setup is complete.
    await api.patch('/api/me/settings', { onboarding: { ...DEFAULT_ONBOARDING, pending: true, step: 1 } })
    queryClient.setQueryData(ME_KEY, user)
    // Instance setup is complete: reread profile or reloading would return here.
    await queryClient.invalidateQueries({ queryKey: ['system', 'instance'] })
  })

  return (
    <>
      <StepTitle title={t('onboarding.account.create.title')} lead={t('onboarding.account.create.lead', { host: hostname })} />
      <Card>
        <CardBody className="flex flex-col gap-4">
          <Field
            label={t('onboarding.account.displayName')}
            hint={t('onboarding.account.displayName.hint')}
            icon={<UserRound size={16} />}
            value={displayName}
            onChange={(event) => applyName(event.target.value)}
            autoComplete="name"
            autoFocus
            required
          />
          <Field
            label={t('onboarding.account.username')}
            hint={t('onboarding.account.username.hint')}
            icon={<IdCard size={16} />}
            value={username}
            onChange={(event) => {
              setUsernameEdited(true)
              setUsername(event.target.value)
            }}
            error={usernameInvalid ? t('onboarding.account.username.invalid') : undefined}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            required
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={t('onboarding.account.password')}
              hint={t('onboarding.account.password.hint', { min: MIN_PASSWORD })}
              // Buttons stay disabled for short passwords, so fields must explain the blocker.
              error={passwordShort ? t('onboarding.account.password.short', { min: MIN_PASSWORD }) : undefined}
              type="password"
              icon={<KeyRound size={16} />}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              required
            />
            <Field
              label={t('onboarding.account.confirm')}
              type="password"
              icon={<KeyRound size={16} />}
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              error={mismatch ? t('onboarding.account.confirm.mismatch') : undefined}
              autoComplete="new-password"
              required
            />
          </div>
        </CardBody>
      </Card>
      <Why>
        <b>{t('onboarding.account.why.title')}</b> {t('onboarding.account.why.body')}
      </Why>
      <Tip>
        {t('onboarding.account.cli')} <code className="rounded bg-sunken px-1 py-0.5 font-mono text-[0.8125rem] text-ink">sillage user:create</code>
      </Tip>
    </>
  )
}

function AdminSummary({ nav, user }: StepProps) {
  const t = useTranslate()
  useGate(nav, { canContinue: true, laterAllowed: false, skipAllowed: true })
  useCommit(nav, null)
  return (
    <>
      <StepTitle title={t('onboarding.account.done.title')} lead={t('onboarding.account.done.lead')} />
      <Banner tone="positive">{t('onboarding.account.done.banner', { name: user?.displayName ?? '', username: user?.username ?? '' })}</Banner>
      <Why>
        <b>{t('onboarding.account.why.title')}</b> {t('onboarding.account.why.body')}
      </Why>
      <Tip>{t('onboarding.account.done.others')}</Tip>
    </>
  )
}

function MemberForm({ nav, user, hostname }: StepProps) {
  const t = useTranslate()
  const queryClient = useQueryClient()
  const updateUser = useUpdateUser()
  const [displayName, setDisplayName] = useState(user?.displayName ?? '')
  const [current, setCurrent] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')

  const changingPassword = password.length > 0
  const passwordShort = changingPassword && password.length < MIN_PASSWORD
  const mismatch = confirm.length > 0 && confirm !== password
  const currentMissing = changingPassword && current.length === 0
  const valid =
    displayName.trim().length > 0 &&
    (!changingPassword || (password.length >= MIN_PASSWORD && password === confirm && current.length > 0))

  useGate(nav, { canContinue: valid, laterAllowed: true, skipAllowed: true })
  useCommit(nav, async () => {
    if (!user) return
    const nameChanged = displayName.trim() !== user.displayName
    if (!nameChanged && !changingPassword) return
    await updateUser.mutateAsync({
      id: user.id,
      ...(nameChanged ? { displayName: displayName.trim() } : {}),
      ...(changingPassword ? { password, currentPassword: current } : {}),
    })
    if (nameChanged) queryClient.setQueryData(ME_KEY, { ...user, displayName: displayName.trim() })
  })

  return (
    <>
      <StepTitle title={t('onboarding.account.member.title')} lead={t('onboarding.account.member.lead', { host: hostname })} />
      <Card>
        <CardBody className="flex flex-col gap-4">
          <Field
            label={t('onboarding.account.displayName')}
            hint={t('onboarding.account.displayName.hint')}
            icon={<UserRound size={16} />}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            autoComplete="name"
            required
          />
          <Field
            label={t('onboarding.account.member.current')}
            hint={t('onboarding.account.member.current.hint')}
            type="password"
            icon={<KeyRound size={16} />}
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            error={currentMissing ? t('onboarding.account.member.current.missing') : undefined}
            autoComplete="current-password"
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={t('onboarding.account.member.password')}
              hint={t('onboarding.account.password.hint', { min: MIN_PASSWORD })}
              error={passwordShort ? t('onboarding.account.password.short', { min: MIN_PASSWORD }) : undefined}
              type="password"
              icon={<KeyRound size={16} />}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
            />
            <Field
              label={t('onboarding.account.confirm')}
              type="password"
              icon={<KeyRound size={16} />}
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              error={mismatch ? t('onboarding.account.confirm.mismatch') : undefined}
              autoComplete="new-password"
            />
          </div>
        </CardBody>
      </Card>
      <Why>
        <b>{t('onboarding.account.member.why.title')}</b> {t('onboarding.account.member.why.body')}
      </Why>
    </>
  )
}
