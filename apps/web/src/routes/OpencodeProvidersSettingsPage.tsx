import * as Dialog from '@radix-ui/react-dialog'
import { KeyRound, Plug, Plus, Search, ShieldCheck, Unplug } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import type { OpencodeConnectionDto, OpencodeProviderDto } from '@sillage/protocol'
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
  cx,
} from '../components/ui'
import { ListHeading, SectionHeader } from './SettingsPage'
import { ApiRequestError } from '../lib/api'
import { useTranslate } from '../lib/i18n'
import { useConnectOpencodeKey, useDisconnectOpencodeCredential, useOpencodeProviders } from '../lib/opencode-providers'
import { useCurrentUser } from '../lib/session'

/**
 * Model providers OpenCode 2 can use, connected from Sillage instead of `opencode auth login`.
 *
 * OpenCode keeps the credential for the machine's user: every conversation, and the TUI, use it.
 * That makes it global configuration, for administrators (scope rule). This first step offers
 * API keys; OAuth and device-code methods stay in the terminal for now.
 */

const errorOf = (error: unknown): string | null =>
  error instanceof ApiRequestError ? error.message : null

export function OpencodeProvidersSettingsPage() {
  const t = useTranslate()
  const { data: me } = useCurrentUser()
  const isAdmin = me?.isAdmin === true
  const { data, error, isPending } = useOpencodeProviders(isAdmin)
  const [connecting, setConnecting] = useState(false)

  if (!isAdmin) {
    return (
      <EmptyState
        icon={<ShieldCheck size={22} />}
        title={t('opencodeProviders.adminOnly.title')}
        description={t('opencodeProviders.adminOnly.description')}
      />
    )
  }

  const providers = data?.providers ?? []
  const connected = providers.filter((provider) => provider.connections.length > 0)
  const connectButton = (
    <Button size="sm" icon={<Plus size={15} />} disabled={!data} onClick={() => setConnecting(true)}>
      {t('opencodeProviders.connect.open')}
    </Button>
  )

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title={t('opencodeProviders.section.title')}
        description={t('opencodeProviders.section.description')}
      />

      <Banner tone="info">{t('opencodeProviders.banner')}</Banner>

      <section className="flex flex-col gap-2">
        <ListHeading
          title={t('opencodeProviders.connected.title')}
          count={connected.length}
          action={connected.length > 0 ? connectButton : null}
        />

        <ConnectDialog open={connecting} onClose={() => setConnecting(false)} providers={providers} />

        {error ? (
          <Banner>{errorOf(error) ?? t('opencodeProviders.loadFailed')}</Banner>
        ) : isPending ? (
          <p className="text-sm text-ink-faint">{t('opencodeProviders.loading')}</p>
        ) : connected.length === 0 ? (
          <EmptyState
            icon={<Plug size={22} />}
            title={t('opencodeProviders.empty.title')}
            description={t('opencodeProviders.empty.description')}
            action={connectButton}
          />
        ) : (
          connected.map((provider) => <ProviderCard key={provider.id} provider={provider} />)
        )}
      </section>
    </div>
  )
}

function ProviderCard({ provider }: { provider: OpencodeProviderDto }) {
  return (
    <Card>
      <CardBody className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{provider.name}</span>
          <span className="font-mono text-xs text-ink-faint">{provider.id}</span>
        </div>
        <ul className="flex flex-col gap-1.5">
          {provider.connections.map((connection) => (
            <ConnectionRow key={connection.type === 'env' ? `env:${connection.name}` : connection.id} provider={provider} connection={connection} />
          ))}
        </ul>
      </CardBody>
    </Card>
  )
}

function ConnectionRow({ provider, connection }: { provider: OpencodeProviderDto; connection: OpencodeConnectionDto }) {
  const t = useTranslate()
  const disconnect = useDisconnectOpencodeCredential()
  const [confirming, setConfirming] = useState(false)

  if (connection.type === 'env') {
    return (
      <li className="flex flex-wrap items-center gap-2 text-sm">
        <Badge>{t('opencodeProviders.method.env')}</Badge>
        <span className="font-mono text-xs">{connection.name}</span>
        <span className="text-xs text-ink-faint">{t('opencodeProviders.env.hint')}</span>
      </li>
    )
  }

  return (
    <li className="flex flex-wrap items-center gap-2 text-sm">
      <Badge tone="accent">{t(`opencodeProviders.method.${connection.method}`)}</Badge>
      <span className="min-w-0 flex-1 truncate">{connection.label}</span>
      <Button size="sm" variant="danger" icon={<Unplug size={15} />} onClick={() => setConfirming(true)}>
        {t('opencodeProviders.disconnect.action')}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('opencodeProviders.disconnect.title', { provider: provider.name })}
        confirmLabel={t('opencodeProviders.disconnect.confirm')}
        tone="critical"
        busy={disconnect.isPending}
        onConfirm={() => disconnect.mutate(connection.id, { onSuccess: () => setConfirming(false) })}
      >
        {t('opencodeProviders.disconnect.body')}
        {errorOf(disconnect.error) ? <Banner>{errorOf(disconnect.error)}</Banner> : null}
      </ConfirmDialog>
    </li>
  )
}

/** A window rather than a form under the button: pick a provider, type its key. */
function ConnectDialog({ open, onClose, providers }: { open: boolean; onClose: () => void; providers: OpencodeProviderDto[] }) {
  const t = useTranslate()
  const connect = useConnectOpencodeKey()
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<string | null>(null)
  const [key, setKey] = useState('')
  const [label, setLabel] = useState('')

  const offered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return providers
      .filter((provider) => provider.acceptsKey)
      .filter((provider) => !needle || provider.name.toLowerCase().includes(needle) || provider.id.includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [providers, query])
  const provider = providers.find((entry) => entry.id === chosen) ?? null

  const reset = () => {
    connect.reset()
    setQuery('')
    setChosen(null)
    setKey('')
    setLabel('')
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!provider) return
    connect.mutate({ provider: provider.id, key: key.trim(), label: label.trim() || undefined }, {
      onSuccess: () => { reset(); onClose() },
    })
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={reset}
          className="fixed top-1/2 left-1/2 z-50 max-h-[90dvh] w-[min(34rem,94vw)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg shadow-pop"
        >
          <Dialog.Title className="sr-only">{t('opencodeProviders.connect.title')}</Dialog.Title>
          <Card>
            <CardHeader title={t('opencodeProviders.connect.title')} icon={<KeyRound size={16} />} />
            <CardBody>
              <form onSubmit={submit} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Field
                    label={t('opencodeProviders.provider.label')}
                    icon={<Search size={14} />}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('opencodeProviders.provider.search')}
                    autoCapitalize="none"
                    autoCorrect="off"
                    autoFocus
                  />
                  <div role="listbox" aria-label={t('opencodeProviders.provider.label')} className="max-h-48 overflow-y-auto rounded-md border border-line p-1">
                    {offered.length === 0 ? (
                      <p className="p-2 text-xs text-ink-faint">{t('opencodeProviders.provider.none')}</p>
                    ) : offered.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        role="option"
                        aria-selected={entry.id === chosen}
                        onClick={() => setChosen(entry.id)}
                        className={cx(
                          'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm',
                          entry.id === chosen ? 'bg-accent-wash text-ink' : 'text-ink-soft hover:bg-surface-high',
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                        {entry.connections.length > 0 ? <Badge>{t('opencodeProviders.provider.connected')}</Badge> : null}
                        <span className="font-mono text-[0.6875rem] text-ink-faint">{entry.id}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <Field
                  label={provider ? t('opencodeProviders.key.labelFor', { provider: provider.name }) : t('opencodeProviders.key.label')}
                  hint={t('opencodeProviders.key.hint')}
                  type="password"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  // Nothing for the browser's password manager to keep.
                  autoComplete="off"
                  disabled={!provider}
                  required
                />
                <Field
                  label={t('opencodeProviders.name.label')}
                  hint={t('opencodeProviders.name.hint')}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  maxLength={60}
                  disabled={!provider}
                />
                {errorOf(connect.error) ? <Banner>{errorOf(connect.error)}</Banner> : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" disabled={!provider || !key.trim() || connect.isPending}>
                    {connect.isPending ? t('opencodeProviders.connect.pending') : t('opencodeProviders.connect.action')}
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
