import { ExternalLink, IdCard, KeyRound, LogOut, Pencil, Plus, Smartphone, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import type { CodexAccount } from '@sillage/protocol'
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
  useCodexAccounts,
  useCodexLoginStatus,
  useCreateCodexAccount,
  useDeleteCodexAccount,
  useRenameCodexAccount,
  useStartCodexLogin,
  useStopCodexLogin,
} from '../lib/codex-accounts'

/**
 * Comptes Codex supplémentaires du compte Sillage.
 *
 * Un compte naît vide, avec un nom, puis se connecte : par code d'appareil pour un
 * abonnement ChatGPT, par clé API sinon. C'est Codex qui mène la connexion dans le
 * home du compte ; l'écran montre le code à saisir et attend qu'il dise que c'est
 * fait. Rien de secret ne revient ici : au mieux un courriel et un forfait.
 */

const errorOf = (error: unknown): string | null =>
  error instanceof ApiRequestError ? error.message : null

export function CodexAccountsSettingsPage() {
  const t = useTranslate()
  const { data } = useCodexAccounts()
  const create = useCreateCodexAccount()

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
      {t('codexAccounts.create.open')}
    </Button>
  )

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title={t('codexAccounts.section.title')}
        description={t('codexAccounts.section.description')}
      />

      <Banner tone="info">{t('codexAccounts.banner')}</Banner>

      <section className="flex flex-col gap-2">
        <ListHeading
          title={t('codexAccounts.existing.title')}
          count={accounts.length}
          action={accounts.length > 0 ? addButton : null}
        />

        {adding ? (
          <Card>
            <CardHeader title={t('codexAccounts.create.title')} icon={<IdCard size={16} />} />
            <CardBody>
              <form onSubmit={submit} className="flex flex-col gap-4">
                <Field
                  label={t('codexAccounts.label.label')}
                  hint={t('codexAccounts.label.hint')}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  maxLength={60}
                  autoFocus
                  required
                />
                {errorOf(create.error) ? <Banner>{errorOf(create.error)}</Banner> : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" disabled={create.isPending}>
                    {create.isPending ? t('codexAccounts.create.pending') : t('codexAccounts.create.action')}
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
              title={t('codexAccounts.empty.title')}
              description={t('codexAccounts.empty.description')}
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

function AccountCard({ account }: { account: CodexAccount }) {
  const t = useTranslate()
  const rename = useRenameCodexAccount()
  const remove = useDeleteCodexAccount()
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
          <CardHeader title={t('codexAccounts.edit.title', { label: account.label })} icon={<Pencil size={16} />} />
          <CardBody>
            <form onSubmit={submit} className="flex flex-col gap-4">
              <Field
                label={t('codexAccounts.label.label')}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                maxLength={60}
                autoFocus
                required
              />
              {errorOf(rename.error) ? <Banner>{errorOf(rename.error)}</Banner> : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" disabled={rename.isPending || label.trim() === account.label}>
                  {rename.isPending ? t('codexAccounts.edit.pending') : t('codexAccounts.edit.action')}
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
          {/* Les boutons passent sous le nom au téléphone plutôt que de l'écraser. */}
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{account.label}</span>
                {account.status === 'ready' ? (
                  <Badge tone="positive">{t('codexAccounts.status.ready')}</Badge>
                ) : (
                  <Badge>{t('codexAccounts.status.pending')}</Badge>
                )}
              </span>
              {account.status === 'ready' ? (
                <p className="text-xs text-ink-faint">
                  {account.authMode === 'apiKey'
                    ? t('codexAccounts.identity.apiKey')
                    : t('codexAccounts.identity.chatgpt', {
                        email: account.email ?? '?',
                        plan: account.planType ?? '?',
                      })}
                </p>
              ) : null}
              <p className="text-xs text-ink-faint">
                {t('codexAccounts.updatedAt', { date: new Date(account.updatedAt).toLocaleString(locale()) })}
              </p>
            </div>
            <Button size="sm" variant="ghost" icon={<Pencil size={15} />} onClick={openEdit}>
              {t('codexAccounts.action.edit')}
            </Button>
            <Button size="sm" variant="danger" icon={<Trash2 size={15} />} onClick={() => setConfirming(true)}>
              {t('codexAccounts.action.delete')}
            </Button>
          </div>

          <LoginControls account={account} />
        </CardBody>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('codexAccounts.delete.title', { label: account.label })}
        confirmLabel={t('codexAccounts.delete.confirm')}
        tone="critical"
        busy={remove.isPending}
        onConfirm={() => remove.mutate(account.id)}
      >
        {t('codexAccounts.delete.body')}
      </ConfirmDialog>
    </Card>
  )
}

/**
 * La connexion du compte, sous sa carte : les deux voies tant qu'il n'est pas
 * connecté, le code à saisir pendant l'attente, la déconnexion une fois prêt.
 */
export function LoginControls({ account }: { account: CodexAccount }) {
  const t = useTranslate()
  const { data: status } = useCodexLoginStatus(account.id, account.status === 'pending')
  const start = useStartCodexLogin(account.id)
  const stop = useStopCodexLogin(account.id)
  const [keyForm, setKeyForm] = useState(false)
  const [apiKey, setApiKey] = useState('')

  const submitKey = (event: FormEvent) => {
    event.preventDefault()
    start.mutate({ type: 'apiKey', apiKey: apiKey.trim() }, { onSuccess: () => { setKeyForm(false); setApiKey('') } })
  }

  const failure = errorOf(start.error) ?? errorOf(stop.error) ?? (status?.state === 'failed' ? status.error : null)

  if (status?.state === 'pending') {
    return (
      <div className="flex flex-col gap-3 border-t border-line pt-3">
        <p className="text-sm text-ink-soft">{t('codexAccounts.device.instructions')}</p>
        <div className="flex flex-wrap items-center gap-3">
          <code className="rounded-md bg-sunken px-3 py-2 font-mono text-lg tracking-widest text-ink">{status.userCode}</code>
          <a
            href={status.verificationUrl ?? '#'}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm text-accent underline-offset-2 hover:underline"
          >
            {t('codexAccounts.device.open')}
            <ExternalLink size={14} />
          </a>
        </div>
        <p className="text-xs text-ink-faint">{t('codexAccounts.device.waiting')}</p>
        <div>
          <Button size="sm" variant="ghost" disabled={stop.isPending} onClick={() => stop.mutate()}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    )
  }

  if (account.status === 'ready') {
    return (
      <div className="flex flex-col gap-2 border-t border-line pt-3">
        {failure ? <Banner>{failure}</Banner> : null}
        <div>
          <Button size="sm" variant="ghost" icon={<LogOut size={15} />} disabled={stop.isPending} onClick={() => stop.mutate()}>
            {t('codexAccounts.action.logout')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 border-t border-line pt-3">
      {failure ? <Banner>{failure}</Banner> : null}
      {keyForm ? (
        <form onSubmit={submitKey} className="flex flex-col gap-3">
          <Field
            label={t('codexAccounts.apiKey.label')}
            hint={t('codexAccounts.apiKey.hint')}
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            autoFocus
            required
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={start.isPending}>
              {start.isPending ? t('codexAccounts.apiKey.pending') : t('codexAccounts.apiKey.action')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setKeyForm(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" icon={<Smartphone size={15} />} disabled={start.isPending} onClick={() => start.mutate({ type: 'deviceCode' })}>
            {start.isPending ? t('codexAccounts.device.pending') : t('codexAccounts.device.action')}
          </Button>
          <Button size="sm" variant="secondary" icon={<KeyRound size={15} />} onClick={() => setKeyForm(true)}>
            {t('codexAccounts.apiKey.open')}
          </Button>
        </div>
      )}
      <p className="text-xs text-ink-faint">{t('codexAccounts.device.hint')}</p>
    </div>
  )
}
