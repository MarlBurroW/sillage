import { KeyRound, User } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { ApiRequestError } from '../lib/api'
import { useTranslate } from '../lib/i18n'
import { useLogin } from '../lib/session'
import { Logo } from '../components/Logo'
import { Banner, Button, Card, CardBody, Field } from '../components/ui'

export function LoginPage() {
  const t = useTranslate()
  const login = useLogin()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    login.mutate({ username, password })
  }

  const message =
    login.error instanceof ApiRequestError
      ? login.error.message
      : login.error
        ? t('login.error.unreachable')
        : null

  return (
    <div className="gradient-canvas flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <span className="gradient-accent shadow-float grid size-14 place-items-center rounded-2xl">
            <Logo size={34} className="text-accent-ink" />
          </span>
          <div className="text-center">
            <h1 className="text-xl font-semibold tracking-tight">Sillage</h1>
            <p className="mt-1 text-sm text-ink-faint">{t('login.subtitle')}</p>
          </div>
        </div>

        <Card>
          <CardBody>
            <form onSubmit={submit} className="flex flex-col gap-4">
              <Field
                label={t('login.username.label')}
                icon={<User size={16} />}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                autoFocus
                required
              />
              <Field
                label={t('login.password.label')}
                type="password"
                icon={<KeyRound size={16} />}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              {message ? <Banner>{message}</Banner> : null}
              <Button type="submit" disabled={login.isPending} className="mt-1 w-full">
                {login.isPending ? t('login.submit.pending') : t('login.submit.action')}
              </Button>
            </form>
          </CardBody>
        </Card>
      </div>
    </div>
  )
}
