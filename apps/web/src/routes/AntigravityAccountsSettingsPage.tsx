import { ExternalLink, IdCard, KeyRound, LogOut, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import type { AntigravityAccount, AntigravityAuthMethod } from '@sillage/protocol'
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
} from '../components/ui'
import { ListHeading, SectionHeader } from './SettingsPage'
import { ApiRequestError } from '../lib/api'
import { locale, useTranslate } from '../lib/i18n'
import {
  useAntigravityCallback,
  useAntigravityAccounts,
  useAntigravityLoginStatus,
  useCreateAntigravityAccount,
  useDeleteAntigravityAccount,
  useRenameAntigravityAccount,
  useStartAntigravityLogin,
  useStopAntigravityLogin,
} from '../lib/antigravity-accounts'

/**
 * Native Google authentication in separate homes. A remote browser can relay its
 * loopback callback through the owning Sillage account without exposing tokens.
 */

const errorOf = (error: unknown): string | null =>
  error instanceof ApiRequestError ? error.message : null

export function LoginControls({ account }: { account: AntigravityAccount }) {
  const t = useTranslate()
  const { data: status } = useAntigravityLoginStatus(account.id, account.status === 'pending')
  const start = useStartAntigravityLogin(account.id)
  const stop = useStopAntigravityLogin(account.id)
  const callback = useAntigravityCallback(account.id)
  const [method, setMethod] = useState<AntigravityAuthMethod>('oauth-personal')
  const [apiKey, setApiKey] = useState('')
  const [project, setProject] = useState('')
  const [location, setLocation] = useState('global')
  const [callbackUrl, setCallbackUrl] = useState('')
  const failure = errorOf(start.error) ?? errorOf(stop.error) ?? errorOf(callback.error) ?? (status?.state === 'failed' ? status.error : null)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    start.mutate({ method, ...(apiKey ? { apiKey } : {}), ...(project ? { project, location } : {}) }, { onSuccess: () => setApiKey('') })
  }
  const pending = status?.state === 'pending'
  return <div className="flex flex-col gap-3 border-t border-line pt-3">
    {failure ? <Banner>{failure}</Banner> : null}
    {pending ? <>
      <p className="text-sm text-ink-soft">{t('antigravityAccounts.oauth.waiting')}</p>
      {status.verificationUrl ? <>
        <a href={status.verificationUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-2 text-sm text-accent underline">
          {t('antigravityAccounts.oauth.open')} <ExternalLink size={14} />
        </a>
        <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); callback.mutate(callbackUrl, { onSuccess: () => setCallbackUrl('') }) }}>
          <Field label={t('antigravityAccounts.callback.label')} hint={t('antigravityAccounts.callback.hint')} value={callbackUrl} onChange={(event) => setCallbackUrl(event.target.value)} type="password" autoComplete="off" required />
          <Button type="submit" size="sm" disabled={callback.isPending || !callbackUrl}>{t('antigravityAccounts.callback.action')}</Button>
        </form>
      </> : null}
      <Button size="sm" variant="ghost" disabled={stop.isPending} onClick={() => stop.mutate()}>{t('common.cancel')}</Button>
    </> : account.status === 'ready' ? <Button size="sm" variant="ghost" icon={<LogOut size={15} />} disabled={stop.isPending} onClick={() => stop.mutate()}>{t('antigravityAccounts.action.logout')}</Button> : <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">{t('antigravityAccounts.method')}
        <select className="min-h-11 rounded-md border border-line bg-surface px-3" value={method} onChange={(event) => { setMethod(event.target.value as AntigravityAuthMethod); setApiKey('') }}>
          <option value="oauth-personal">{t('antigravityAccounts.method.personal')}</option>
          <option value="oauth-business">{t('antigravityAccounts.method.business')}</option>
          <option value="gemini-api-key">{t('antigravityAccounts.method.key')}</option>
          <option value="agent-platform">{t('antigravityAccounts.method.platform')}</option>
        </select>
      </label>
      {method === 'gemini-api-key' || method === 'agent-platform' ? <Field label={t('antigravityAccounts.apiKey.label')} hint={t(method === 'agent-platform' ? 'antigravityAccounts.adc.hint' : 'antigravityAccounts.apiKey.hint')} type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" required={method === 'gemini-api-key'} /> : null}
      {method === 'oauth-business' || (method === 'agent-platform' && !apiKey) ? <>
        <Field label={t('antigravityAccounts.project')} value={project} onChange={(event) => setProject(event.target.value)} required />
        <Field label={t('antigravityAccounts.location')} value={location} onChange={(event) => setLocation(event.target.value)} required />
      </> : null}
      <Button type="submit" size="sm" icon={<KeyRound size={15} />} disabled={start.isPending}>{t(start.isPending ? 'antigravityAccounts.apiKey.pending' : 'antigravityAccounts.apiKey.action')}</Button>
    </form>}
  </div>
}

export function AntigravityAccountsSettingsPage() {
  const t = useTranslate()
  const { data } = useAntigravityAccounts()
  const create = useCreateAntigravityAccount()

  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')

  const openForm = () => {
    setLabel('')
    create.reset()
    setAdding(true)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    create.mutate({ label: label.trim() }, { onSuccess: () => setAdding(false) })
  }

  const accounts = data?.accounts ?? []
  const addButton = (
    <Button size="sm" icon={<Plus size={15} />} disabled={adding} onClick={openForm}>
      {t('antigravityAccounts.create.open')}
    </Button>
  )

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title={t('antigravityAccounts.section.title')}
        description={t('antigravityAccounts.section.description')}
      />

      <Banner tone="info">{t('antigravityAccounts.banner')}</Banner>

      <section className="flex flex-col gap-2">
        <ListHeading
          title={t('antigravityAccounts.existing.title')}
          count={accounts.length}
          action={accounts.length > 0 ? addButton : null}
        />

        {adding ? (
          <Card>
            <CardHeader title={t('antigravityAccounts.create.title')} icon={<IdCard size={16} />} />
            <CardBody>
              <form onSubmit={submit} className="flex flex-col gap-4">
                <Field
                  label={t('antigravityAccounts.label.label')}
                  hint={t('antigravityAccounts.label.hint')}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  maxLength={60}
                  autoFocus
                  required
                />
                {errorOf(create.error) ? <Banner>{errorOf(create.error)}</Banner> : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" disabled={create.isPending}>
                    {create.isPending ? t('antigravityAccounts.create.pending') : t('antigravityAccounts.create.action')}
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                    {t('common.cancel')}
                  </Button>
                </div>
              </form>
            </CardBody>
          </Card>
        ) : null}

        {accounts.length === 0 ? (
          adding ? null : (
            <EmptyState
              icon={<IdCard size={22} />}
              title={t('antigravityAccounts.empty.title')}
              description={t('antigravityAccounts.empty.description')}
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

function AccountCard({ account }: { account: AntigravityAccount }) {
  const t = useTranslate()
  const rename = useRenameAntigravityAccount()
  const remove = useDeleteAntigravityAccount()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [label, setLabel] = useState(account.label)

  const openEdit = () => {
    setLabel(account.label)
    rename.reset()
    setEditing(true)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    rename.mutate({ id: account.id, label: label.trim() }, { onSuccess: () => setEditing(false) })
  }

  return (
    <Card>
      {editing ? (
        <>
          <CardHeader title={t('antigravityAccounts.edit.title', { label: account.label })} icon={<Pencil size={16} />} />
          <CardBody>
            <form onSubmit={submit} className="flex flex-col gap-4">
              <Field
                label={t('antigravityAccounts.label.label')}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                maxLength={60}
                autoFocus
                required
              />
              {errorOf(rename.error) ? <Banner>{errorOf(rename.error)}</Banner> : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" disabled={rename.isPending || label.trim() === account.label}>
                  {rename.isPending ? t('antigravityAccounts.edit.pending') : t('antigravityAccounts.edit.action')}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </form>
          </CardBody>
        </>
      ) : (
        <CardBody className="flex flex-col gap-3">
          {/* On phones, buttons move below the name rather than crushing it. */}
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{account.label}</span>
                {account.status === 'ready' ? (
                  <Badge tone="positive">{t(account.authMode === 'gemini-api-key' || account.authMode === 'agent-platform' ? 'antigravityAccounts.status.configured' : 'antigravityAccounts.status.ready')}</Badge>
                ) : (
                  <Badge>{t('antigravityAccounts.status.pending')}</Badge>
                )}
              </span>
              {account.status === 'ready' ? (
                <p className="text-xs text-ink-faint">
                  {[account.email, account.plan, t(account.authMode === 'oauth-business' ? 'antigravityAccounts.method.business' : account.authMode === 'agent-platform' ? 'antigravityAccounts.method.platform' : account.authMode === 'gemini-api-key' ? 'antigravityAccounts.method.key' : 'antigravityAccounts.method.personal')].filter(Boolean).join(' · ')}
                </p>
              ) : null}
              <p className="text-xs text-ink-faint">
                {t('antigravityAccounts.updatedAt', { date: new Date(account.updatedAt).toLocaleString(locale()) })}
              </p>
            </div>
            <Button size="sm" variant="ghost" icon={<Pencil size={15} />} onClick={openEdit}>
              {t('antigravityAccounts.action.edit')}
            </Button>
            <Button size="sm" variant="danger" icon={<Trash2 size={15} />} onClick={() => setConfirming(true)}>
              {t('antigravityAccounts.action.delete')}
            </Button>
          </div>

          <LoginControls account={account} />
        </CardBody>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('antigravityAccounts.delete.title', { label: account.label })}
        confirmLabel={t('antigravityAccounts.delete.confirm')}
        tone="critical"
        busy={remove.isPending}
        onConfirm={() => remove.mutate(account.id)}
      >
        {t('antigravityAccounts.delete.body')}
      </ConfirmDialog>
    </Card>
  )
}

