import { ExternalLink, Gauge, IdCard, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import type { ClaudeAccount, ClaudeLoginStatusDto } from '@sillage/protocol'
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  ChoiceList,
  ConfirmDialog,
  EmptyState,
  Field,
} from '../components/ui'
import { ListHeading, SectionHeader } from './SettingsPage'
import { ApiRequestError } from '../lib/api'
import { locale, useTranslate } from '../lib/i18n'
import {
  useCancelClaudeLogin,
  useClaudeAccounts,
  useClaudeLoginStatus,
  useCreateClaudeAccount,
  useDeleteClaudeAccount,
  useForgetClaudeGauge,
  useStartClaudeGauge,
  useStartClaudeLogin,
  useSubmitClaudeLoginCode,
  useUpdateClaudeAccount,
} from '../lib/claude-accounts'

/**
 * Additional Claude accounts for the Sillage account.
 *
 * The CLI keeps one login through `/login`. Additional subscriptions use `claude setup-token`,
 * which Sillage can run itself: show the authorization URL, collect the page's code and create
 * the account with the token. Users may also paste an externally obtained token or a
 * usage-billed Console API key.
 *
 * As with git credentials, the screen never displays a secret because the API returns none.
 * What remains meaningful is the label, secret kind and last-secret date, since tokens expire
 * after a year.
 */

const errorOf = (error: unknown): string | null =>
  error instanceof ApiRequestError ? error.message : null

type AddMode = 'guided' | 'paste'

export function ClaudeAccountsSettingsPage() {
  const t = useTranslate()
  const { data } = useClaudeAccounts()

  const [adding, setAdding] = useState(false)

  const accounts = data?.accounts ?? []
  const addButton = (
    <Button size="sm" icon={<Plus size={15} />} disabled={adding} onClick={() => setAdding(true)}>
      {t('claudeAccounts.create.open')}
    </Button>
  )

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title={t('claudeAccounts.section.title')}
        description={t('claudeAccounts.section.description')}
      />

      <Banner tone="info">{t('claudeAccounts.banner')}</Banner>

      <section className="flex flex-col gap-2">
        <ListHeading
          title={t('claudeAccounts.existing.title')}
          count={accounts.length}
          action={accounts.length > 0 ? addButton : null}
        />

        {adding ? <AddAccountCard onClose={() => setAdding(false)} /> : null}

        {accounts.length === 0 ? (
          adding ? null : (
            <EmptyState
              icon={<IdCard size={22} />}
              title={t('claudeAccounts.empty.title')}
              description={t('claudeAccounts.empty.description')}
              action={addButton}
            />
          )
        ) : (
          accounts.map((account) => <AccountCard key={account.id} account={account} />)
        )}
      </section>
    </div>
  )
}

/**
 * Add form: name, then method. Guided login is driven by the server with visible steps; pasted
 * secrets are submitted as-is.
 */
export function AddAccountCard({ onClose }: { onClose: () => void }) {
  const t = useTranslate()
  const create = useCreateClaudeAccount()
  const start = useStartClaudeLogin()
  const [mode, setMode] = useState<AddMode>('guided')
  const [label, setLabel] = useState('')
  const [token, setToken] = useState('')
  /** Current guided login, once started. */
  const [login, setLogin] = useState<ClaudeLoginStatusDto | null>(null)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (mode === 'paste') {
      create.mutate({ label: label.trim(), token: token.trim() }, { onSuccess: onClose })
    } else {
      start.mutate({ label: label.trim() }, { onSuccess: setLogin })
    }
  }

  if (login) return <GuidedLogin initial={login} onClose={onClose} />

  const modes = [
    { value: 'guided' as const, label: t('claudeAccounts.mode.guided'), hint: t('claudeAccounts.mode.guided.hint') },
    { value: 'paste' as const, label: t('claudeAccounts.mode.paste'), hint: t('claudeAccounts.mode.paste.hint') },
  ]
  const pending = create.isPending || start.isPending
  const failure = errorOf(create.error) ?? errorOf(start.error)

  return (
    <Card>
      <CardHeader title={t('claudeAccounts.create.title')} icon={<IdCard size={16} />} />
      <CardBody>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field
            label={t('claudeAccounts.label.label')}
            hint={t('claudeAccounts.label.hint')}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={60}
            autoFocus
            required
          />
          <ChoiceList label={t('claudeAccounts.mode.label')} value={mode} options={modes} onChange={setMode} />
          {mode === 'paste' ? (
            <div className="flex flex-col gap-2">
              <Field
                label={t('claudeAccounts.token.label')}
                hint={t('claudeAccounts.token.hint')}
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                // The browser password manager has nothing to save here.
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                required
              />
              <p className="text-xs text-ink-faint">
                {t('claudeAccounts.token.howto')}{' '}
                <code className="rounded bg-sunken px-1 py-0.5 font-mono text-[0.8125rem] text-ink">claude setup-token</code>
              </p>
            </div>
          ) : (
            <p className="text-xs text-ink-faint">{t('claudeAccounts.guided.explain')}</p>
          )}
          {failure ? <Banner>{failure}</Banner> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={pending}>
              {pending
                ? t('claudeAccounts.create.pending')
                : mode === 'paste'
                  ? t('claudeAccounts.create.action')
                  : t('claudeAccounts.guided.start')}
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  )
}

/**
 * Visible CLI steps: URL to open, code to paste, then created account. Rejected codes can be
 * re-entered without starting over while the CLI remains alive.
 */
export function GuidedLogin({ initial: first, onClose }: { initial: ClaudeLoginStatusDto; onClose: () => void }) {
  const t = useTranslate()
  /**
   * Tracked login: token first, then optionally the gauge. Both use the same tracking routes;
   * only the ID changes.
   */
  const [initial, setInitial] = useState(first)
  const { data: polled } = useClaudeLoginStatus(initial.loginId)
  const submit = useSubmitClaudeLoginCode(initial.loginId)
  const cancel = useCancelClaudeLogin()
  const startGauge = useStartClaudeGauge()
  const [code, setCode] = useState('')
  // Code submission places its response in the same query state, which remains authoritative.
  const status = polled ?? initial
  const gauge = status.purpose === 'gauge'

  const chainGauge = (accountId: string) =>
    startGauge.mutate(accountId, {
      onSuccess: (next) => {
        setCode('')
        submit.reset()
        setInitial(next)
      },
    })

  const send = (event: FormEvent) => {
    event.preventDefault()
    submit.mutate({ code: code.trim() })
  }

  const close = () => {
    if (status.state !== 'done') cancel.mutate(initial.loginId)
    onClose()
  }

  return (
    <Card>
      <CardHeader
        title={gauge ? t('claudeAccounts.gauge.title') : t('claudeAccounts.guided.title')}
        icon={gauge ? <Gauge size={16} /> : <IdCard size={16} />}
      />
      <CardBody className="flex flex-col gap-4">
        {gauge && status.state !== 'done' ? <p className="text-sm text-ink-soft">{t('claudeAccounts.gauge.explain')}</p> : null}
        {status.state === 'done' ? (
          <>
            <Banner tone="positive">
              {gauge
                ? status.account?.gauge?.email
                  ? t('claudeAccounts.gauge.doneWithEmail', { label: status.account.label, email: status.account.gauge.email })
                  : t('claudeAccounts.gauge.done', { label: status.account?.label ?? '' })
                : t('claudeAccounts.guided.done', { label: status.account?.label ?? '' })}
            </Banner>
            {/*
             * The token enables sessions, not the gauge: offering the gauge immediately adds
             * one page and code while the user is already there.
             */}
            {!gauge && status.account ? <p className="text-sm text-ink-soft">{t('claudeAccounts.gauge.offer')}</p> : null}
            {errorOf(startGauge.error) ? <Banner>{errorOf(startGauge.error)}</Banner> : null}
            <div className="flex flex-wrap items-center gap-2">
              {!gauge && status.account ? (
                <Button
                  type="button"
                  icon={<Gauge size={15} />}
                  disabled={startGauge.isPending}
                  onClick={() => chainGauge(status.account!.id)}
                >
                  {t('claudeAccounts.gauge.enable')}
                </Button>
              ) : null}
              <Button type="button" variant={!gauge && status.account ? 'ghost' : 'primary'} onClick={onClose}>
                {gauge ? t('common.close') : t('claudeAccounts.gauge.later')}
              </Button>
            </div>
          </>
        ) : (
          <form onSubmit={send} className="flex flex-col gap-4">
            <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-ink-soft">
              <li>
                {t('claudeAccounts.guided.step.open')}{' '}
                {status.authUrl ? (
                  <a
                    href={status.authUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-accent underline-offset-2 hover:underline"
                  >
                    {t('claudeAccounts.guided.openLink')}
                    <ExternalLink size={14} />
                  </a>
                ) : (
                  <span className="text-ink-faint">{t('claudeAccounts.guided.starting')}</span>
                )}
              </li>
              <li>{t('claudeAccounts.guided.step.authorize')}</li>
              <li>{t('claudeAccounts.guided.step.paste')}</li>
            </ol>
            <Field
              label={t('claudeAccounts.guided.code.label')}
              hint={t('claudeAccounts.guided.code.hint')}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              disabled={status.state === 'starting' || status.state === 'checking'}
              required
            />
            {status.state === 'failed' && status.error ? <Banner>{status.error}</Banner> : null}
            {errorOf(submit.error) ? <Banner>{errorOf(submit.error)}</Banner> : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={submit.isPending || status.state === 'checking' || status.state === 'starting'}>
                {submit.isPending || status.state === 'checking'
                  ? t('claudeAccounts.guided.checking')
                  : t('claudeAccounts.guided.submit')}
              </Button>
              <Button type="button" variant="ghost" onClick={close}>
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        )}
      </CardBody>
    </Card>
  )
}

function AccountCard({ account }: { account: ClaudeAccount }) {
  const t = useTranslate()
  const update = useUpdateClaudeAccount()
  const remove = useDeleteClaudeAccount()
  const startGauge = useStartClaudeGauge()
  const forgetGauge = useForgetClaudeGauge()
  /** Current gauge login for this account, once started. */
  const [gaugeLogin, setGaugeLogin] = useState<ClaudeLoginStatusDto | null>(null)
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [label, setLabel] = useState(account.label)
  const [token, setToken] = useState('')

  const openEdit = () => {
    setLabel(account.label)
    setToken('')
    update.reset()
    setEditing(true)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const trimmedLabel = label.trim()
    const trimmedToken = token.trim()
    update.mutate(
      {
        id: account.id,
        ...(trimmedLabel !== account.label ? { label: trimmedLabel } : {}),
        ...(trimmedToken ? { token: trimmedToken } : {}),
      },
      { onSuccess: () => setEditing(false) },
    )
  }

  return (
    <Card>
      {editing ? (
        <>
          <CardHeader title={t('claudeAccounts.edit.title', { label: account.label })} icon={<Pencil size={16} />} />
          <CardBody>
            <form onSubmit={submit} className="flex flex-col gap-4">
              <Field
                label={t('claudeAccounts.label.label')}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                maxLength={60}
                required
              />
              <Field
                label={t('claudeAccounts.token.label')}
                hint={t('claudeAccounts.token.replaceHint')}
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
              />
              {errorOf(update.error) ? <Banner>{errorOf(update.error)}</Banner> : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" disabled={update.isPending || (label.trim() === account.label && !token.trim())}>
                  {update.isPending ? t('claudeAccounts.edit.pending') : t('claudeAccounts.edit.action')}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </form>
          </CardBody>
        </>
      ) : (
        <CardBody className="flex flex-wrap items-start gap-3">
          <div className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{account.label}</span>
              <Badge icon={<KeyRound size={11} />}>
                {account.kind === 'apiKey' ? t('claudeAccounts.kind.apiKey') : t('claudeAccounts.kind.oauth')}
              </Badge>
            </span>
            <p className="text-xs text-ink-faint">
              {t('claudeAccounts.updatedAt', {
                date: new Date(account.updatedAt).toLocaleString(locale()),
              })}
            </p>
            {/* Subscription gauge: without it, account selection is blind. */}
            {account.kind === 'oauth' ? (
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                <span className={account.gauge ? 'text-ink-soft' : 'text-ink-faint'}>
                  <Gauge size={12} className="mr-1 inline align-[-2px]" />
                  {account.gauge
                    ? account.gauge.email
                      ? t('claudeAccounts.gauge.onWithEmail', { email: account.gauge.email })
                      : t('claudeAccounts.gauge.on')
                    : t('claudeAccounts.gauge.off')}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={startGauge.isPending || gaugeLogin !== null}
                  onClick={() => startGauge.mutate(account.id, { onSuccess: setGaugeLogin })}
                >
                  {account.gauge ? t('claudeAccounts.gauge.renew') : t('claudeAccounts.gauge.enable')}
                </Button>
                {account.gauge ? (
                  <Button size="sm" variant="ghost" disabled={forgetGauge.isPending} onClick={() => forgetGauge.mutate(account.id)}>
                    {t('claudeAccounts.gauge.remove')}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {errorOf(startGauge.error) ? <Banner>{errorOf(startGauge.error)}</Banner> : null}
          </div>

          <Button size="sm" variant="ghost" icon={<Pencil size={15} />} onClick={openEdit}>
            {t('claudeAccounts.action.edit')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon={<Trash2 size={15} />}
            onClick={() => setConfirming(true)}
          >
            {t('claudeAccounts.action.delete')}
          </Button>
        </CardBody>
      )}

      {gaugeLogin ? (
        <div className="border-t border-line">
          <GuidedLogin initial={gaugeLogin} onClose={() => setGaugeLogin(null)} />
        </div>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('claudeAccounts.delete.title', { label: account.label })}
        confirmLabel={t('claudeAccounts.delete.confirm')}
        tone="critical"
        busy={remove.isPending}
        onConfirm={() => remove.mutate(account.id)}
      >
        {t('claudeAccounts.delete.body')}
      </ConfirmDialog>
    </Card>
  )
}
