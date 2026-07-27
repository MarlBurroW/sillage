import { KeyRound, User } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { ApiRequestError } from '../lib/api'
import { useLogin } from '../lib/session'
import { Banner, Button, Card, CardBody, Field } from '../components/ui'

export function LoginPage() {
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
        ? 'Le serveur est injoignable.'
        : null

  return (
    <div className="gradient-canvas flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <span className="gradient-accent shadow-float size-11 rounded-xl" aria-hidden />
          <div className="text-center">
            <h1 className="text-xl font-semibold tracking-tight">Sillage</h1>
            <p className="mt-1 text-sm text-ink-faint">Plateforme de développement agentique</p>
          </div>
        </div>

        <Card>
          <CardBody>
            <form onSubmit={submit} className="flex flex-col gap-4">
              <Field
                label="Nom d'utilisateur"
                icon={<User size={16} />}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                autoFocus
                required
              />
              <Field
                label="Mot de passe"
                type="password"
                icon={<KeyRound size={16} />}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              {message ? <Banner>{message}</Banner> : null}
              <Button type="submit" disabled={login.isPending} className="mt-1 w-full">
                {login.isPending ? 'Connexion...' : 'Se connecter'}
              </Button>
            </form>
          </CardBody>
        </Card>
      </div>
    </div>
  )
}
