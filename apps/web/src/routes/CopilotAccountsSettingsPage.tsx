import * as Dialog from '@radix-ui/react-dialog'
import { ExternalLink, IdCard, LogOut, Pencil, Plus, Smartphone, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import type { CopilotAccount } from '@sillage/protocol'
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
  useCopilotAccounts,
  useCopilotLoginStatus,
  useCreateCopilotAccount,
  useDeleteCopilotAccount,
  useRenameCopilotAccount,
  useStartCopilotLogin,
  useStopCopilotLogin,
} from '../lib/copilot-accounts'

/**
 * Additional GitHub Copilot accounts for the Sillage account, following the Grok model.
 *
 * An account starts empty with a name, then signs in through a GitHub device code. Copilot keeps
 * the sign-in in the account's home; the screen shows the code and waits. Nothing secret comes
 * back here, only the GitHub login.
 */

const errorOf = (error: unknown): string | null =>
  error instanceof ApiRequestError ? error.message : null

export function CopilotAccountsSettingsPage() {
  const t = useTranslate()
  const { data } = useCopilotAccounts()
  const [adding, setAdding] = useState(false)

  const accounts = data?.accounts ?? []
  const addButton = (
    <Button size="sm" icon={<Plus size={15} />} disabled={adding} onClick={() => setAdding(true)}>
      {t('copilotAccounts.create.open')}
    </Button>
  )

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title={t('copilotAccounts.section.title')}
        description={t('copilotAccounts.section.description')}
      />

      <Banner tone="info">{t('copilotAccounts.banner')}</Banner>

      <section className="flex flex-col gap-2">
        <ListHeading
          title={t('copilotAccounts.existing.title')}
          count={accounts.length}
          action={accounts.length > 0 ? addButton : null}
        />

        <LabelDialog open={adding} onClose={() => setAdding(false)} />

        {accounts.length === 0 ? (
          <EmptyState
            icon={<IdCard size={22} />}
            title={t('copilotAccounts.empty.title')}
            description={t('copilotAccounts.empty.description')}
            action={addButton}
          />
        ) : (
          accounts.map((account) => <AccountCard key={account.id} account={account} />)
        )}
      </section>
    </div>
  )
}

/** Name of a new account, or of an existing one when `account` is given, in a window of its own. */
function LabelDialog({ open, onClose, account }: { open: boolean; onClose: () => void; account?: CopilotAccount }) {
  const t = useTranslate()
  const create = useCreateCopilotAccount()
  const rename = useRenameCopilotAccount()
  const mutation = account ? rename : create
  const [label, setLabel] = useState(account?.label ?? '')

  const openChange = (next: boolean) => {
    if (next) return
    onClose()
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const trimmed = label.trim()
    if (account) rename.mutate({ id: account.id, label: trimmed }, { onSuccess: onClose })
    else create.mutate({ label: trimmed }, { onSuccess: () => { setLabel(''); onClose() } })
  }
  const title = account ? t('copilotAccounts.edit.title', { label: account.label }) : t('copilotAccounts.create.title')

  return (
    <Dialog.Root open={open} onOpenChange={openChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={() => { mutation.reset(); setLabel(account?.label ?? '') }}
          className="fixed top-1/2 left-1/2 z-50 max-h-[90dvh] w-[min(34rem,94vw)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg shadow-pop"
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          <Card>
            <CardHeader title={title} icon={account ? <Pencil size={16} /> : <IdCard size={16} />} />
            <CardBody>
              <form onSubmit={submit} className="flex flex-col gap-4">
                <Field
                  label={t('copilotAccounts.label.label')}
                  hint={account ? undefined : t('copilotAccounts.label.hint')}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  maxLength={60}
                  autoFocus
                  required
                />
                {errorOf(mutation.error) ? <Banner>{errorOf(mutation.error)}</Banner> : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" disabled={mutation.isPending || (account !== undefined && label.trim() === account.label)}>
                    {account
                      ? mutation.isPending ? t('copilotAccounts.edit.pending') : t('copilotAccounts.edit.action')
                      : mutation.isPending ? t('copilotAccounts.create.pending') : t('copilotAccounts.create.action')}
                  </Button>
                  <Button type="button" variant="ghost" onClick={onClose}>
                    {t('common.cancel')}
                  </Button>
                </div>
              </form>
            </CardBody>
          </Card>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function AccountCard({ account }: { account: CopilotAccount }) {
  const t = useTranslate()
  const remove = useDeleteCopilotAccount()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        {/* On phones, buttons move below the name rather than crushing it. */}
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{account.label}</span>
              {account.status === 'ready' ? (
                <Badge tone="positive">{t('copilotAccounts.status.ready')}</Badge>
              ) : (
                <Badge>{t('copilotAccounts.status.pending')}</Badge>
              )}
            </span>
            {account.status === 'ready' && account.login ? (
              <p className="text-xs text-ink-faint">
                {account.host && account.host !== 'https://github.com'
                  ? t('copilotAccounts.identity.host', { login: account.login, host: account.host.replace(/^https:\/\//, '') })
                  : t('copilotAccounts.identity', { login: account.login })}
              </p>
            ) : null}
            <p className="text-xs text-ink-faint">
              {t('copilotAccounts.updatedAt', { date: new Date(account.updatedAt).toLocaleString(locale()) })}
            </p>
          </div>
          <Button size="sm" variant="ghost" icon={<Pencil size={15} />} onClick={() => setEditing(true)}>
            {t('copilotAccounts.action.edit')}
          </Button>
          <Button size="sm" variant="danger" icon={<Trash2 size={15} />} onClick={() => setConfirming(true)}>
            {t('copilotAccounts.action.delete')}
          </Button>
        </div>

        <LoginControls account={account} />
      </CardBody>

      <LabelDialog open={editing} onClose={() => setEditing(false)} account={account} />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('copilotAccounts.delete.title', { label: account.label })}
        confirmLabel={t('copilotAccounts.delete.confirm')}
        tone="critical"
        busy={remove.isPending}
        onConfirm={() => remove.mutate(account.id)}
      >
        {t('copilotAccounts.delete.body')}
      </ConfirmDialog>
    </Card>
  )
}

/** Sign-in beneath the account's card: the device code while signed out or waiting, sign-out once ready. */
export function LoginControls({ account }: { account: CopilotAccount }) {
  const t = useTranslate()
  const { data: status } = useCopilotLoginStatus(account.id, account.status === 'pending')
  const start = useStartCopilotLogin(account.id)
  const stop = useStopCopilotLogin(account.id)

  const failure = errorOf(start.error) ?? errorOf(stop.error) ?? (status?.state === 'failed' ? status.error : null)

  if (status?.state === 'pending') {
    return (
      <div className="flex flex-col gap-3 border-t border-line pt-3">
        <p className="text-sm text-ink-soft">{t('copilotAccounts.device.instructions')}</p>
        <div className="flex flex-wrap items-center gap-3">
          <code className="rounded-md bg-sunken px-3 py-2 font-mono text-lg tracking-widest text-ink">{status.userCode}</code>
          <a
            href={status.verificationUrl ?? '#'}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm text-accent underline-offset-2 hover:underline"
          >
            {t('copilotAccounts.device.open')}
            <ExternalLink size={14} />
          </a>
        </div>
        <p className="text-xs text-ink-faint">{t('copilotAccounts.device.waiting')}</p>
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
            {t('copilotAccounts.action.logout')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 border-t border-line pt-3">
      {failure ? <Banner>{failure}</Banner> : null}
      <div>
        <Button size="sm" icon={<Smartphone size={15} />} disabled={start.isPending} onClick={() => start.mutate()}>
          {start.isPending ? t('copilotAccounts.device.pending') : t('copilotAccounts.device.action')}
        </Button>
      </div>
      <p className="text-xs text-ink-faint">{t('copilotAccounts.device.hint')}</p>
    </div>
  )
}
