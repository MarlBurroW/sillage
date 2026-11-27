import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiRequestError } from '../lib/api'
import { useTranslate } from '../lib/i18n'
import { useLogin } from '../lib/session'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { LanguageSwitch } from '../components/LanguageSwitch'
import { Logo } from '../components/Logo'
import { Banner, Button, Field, PasswordField } from '../components/ui'

// The water is decoration: its own chunk, so the form never waits for it.
const LoginWater = lazy(() => import('../components/login/LoginWater'))

export function LoginPage() {
  const t = useTranslate()
  const login = useLogin()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const passwordInput = useRef<HTMLInputElement>(null)
  // A phone opens its keyboard on an autofocused field and hides the page before it is seen, and
  // the password manager's suggestions come with the first tap anyway: focus for keyboards only.
  const [autoFocus] = useState(() => matchMedia('(pointer: fine)').matches)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    login.mutate({ username, password })
  }

  // When a session ends, every open tab of the instance says it is waiting for a sign-in.
  const action = t('login.submit.action')
  useEffect(() => {
    document.title = `${action} · Sillage`
    return () => {
      document.title = 'Sillage'
    }
  }, [action])

  // A refused attempt leaves the password selected, ready to be typed again.
  useEffect(() => {
    if (!login.error) return
    passwordInput.current?.focus()
    passwordInput.current?.select()
  }, [login.error])

  // The error describes the last attempt: it goes as soon as the next one is being typed.
  const edit = (set: (value: string) => void, value: string) => {
    set(value)
    if (login.isError) login.reset()
  }

  const message =
    login.error instanceof ApiRequestError
      ? login.error.message
      : login.error
        ? t('login.error.unreachable')
        : null

  return (
    // The document never scrolls (index.css): this layer does, for short screens and landscape phones.
    <div className="h-dvh overflow-y-auto bg-canvas text-ink">
      <div className="flex min-h-full flex-col">
        <div className="flex justify-end px-4 md:px-6" style={{ paddingTop: 'calc(0.75rem + var(--sg-safe-top))' }}>
          <LanguageSwitch compact plain />
        </div>

        <main className="flex flex-1 items-center justify-center px-6 pt-6 pb-10">
          <div className="w-full max-w-[22rem]">
            <header className="mb-9 flex items-center gap-3.5">
              <Logo size={44} className="shrink-0 text-accent" />
              <div className="min-w-0">
                <h1 className="text-[1.75rem] leading-none font-semibold tracking-[-0.02em]">Sillage</h1>
                {/* The address, for the installed app that has no address bar to tell instances apart. */}
                <p className="mt-1.5 truncate text-sm text-ink-faint">{window.location.host}</p>
              </div>
            </header>

            <form onSubmit={submit} className="flex flex-col gap-4">
              <Field
                label={t('login.username.label')}
                name="username"
                value={username}
                onChange={(event) => edit(setUsername, event.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoFocus={autoFocus}
                required
              />
              <PasswordField
                ref={passwordInput}
                label={t('login.password.label')}
                name="password"
                value={password}
                onChange={(event) => edit(setPassword, event.target.value)}
                autoComplete="current-password"
                required
              />
              {message ? <Banner>{message}</Banner> : null}
              <Button type="submit" busy={login.isPending} className="mt-2 w-full">
                {login.isPending ? t('login.submit.pending') : t('login.submit.action')}
              </Button>
            </form>

            <p className="mt-7 text-[0.8125rem] leading-relaxed text-pretty text-ink-faint">{t('login.help')}</p>
          </div>
        </main>

        <div className="h-[40dvh] min-h-36 shrink-0">
          {/* Decoration: should its chunk fail to load, the page goes without water, not without a form. */}
          <ErrorBoundary label="sign-in water" fallback={() => null}>
            <Suspense fallback={null}>
              <LoginWater />
            </Suspense>
          </ErrorBoundary>
        </div>
      </div>
    </div>
  )
}
