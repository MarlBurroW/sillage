import { IdCard, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import type { ClaudeAccount } from '@sillage/protocol'
import {
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
  useClaudeAccounts,
  useCreateClaudeAccount,
  useDeleteClaudeAccount,
  useUpdateClaudeAccount,
} from '../lib/claude-accounts'

/**
 * Comptes Claude supplémentaires du compte Sillage.
 *
 * Le CLI ne tient qu'une connexion : celle de `/login`. Un abonnement de plus passe par
 * un jeton de `claude setup-token`, que l'utilisateur colle ici et que Sillage donne à
 * la session qui choisit ce compte. Comme pour les accès git, l'écran n'affiche jamais
 * un jeton : l'API n'en rend aucun. Ce qui reste et qui compte, c'est le nom qu'on lui
 * a donné et la date du dernier jeton, parce qu'il expire au bout d'un an.
 */

const errorOf = (error: unknown): string | null =>
  error instanceof ApiRequestError ? error.message : null

export function ClaudeAccountsSettingsPage() {
  const t = useTranslate()
  const { data } = useClaudeAccounts()
  const create = useCreateClaudeAccount()

  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [token, setToken] = useState('')

  const openForm = () => {
    setLabel('')
    setToken('')
    create.reset()
    setAdding(true)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    create.mutate({ label: label.trim(), token: token.trim() }, { onSuccess: () => setAdding(false) })
  }

  const accounts = data?.accounts ?? []
  const addButton = (
    <Button size="sm" icon={<Plus size={15} />} disabled={adding} onClick={openForm}>
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

        {adding ? (
          <Card>
            <CardHeader title={t('claudeAccounts.create.title')} icon={<KeyRound size={16} />} />
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
                <TokenField value={token} onChange={setToken} />
                {errorOf(create.error) ? <Banner>{errorOf(create.error)}</Banner> : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" disabled={create.isPending}>
                    {create.isPending ? t('claudeAccounts.create.pending') : t('claudeAccounts.create.action')}
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
 * Le jeton, avec la marche à suivre pour l'obtenir juste sous le champ : c'est au
 * moment de coller qu'on se demande d'où il vient. La commande se lance dans un
 * terminal où l'on est connecté au compte voulu, et le navigateur fait le reste.
 */
function TokenField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useTranslate()
  return (
    <div className="flex flex-col gap-2">
      <Field
        label={t('claudeAccounts.token.label')}
        hint={t('claudeAccounts.token.hint')}
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        // Le gestionnaire de mots de passe du navigateur n'a rien à retenir ici.
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
  )
}

function AccountCard({ account }: { account: ClaudeAccount }) {
  const t = useTranslate()
  const update = useUpdateClaudeAccount()
  const remove = useDeleteClaudeAccount()
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
              <div className="flex flex-col gap-2">
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
              </div>
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
        <CardBody className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="font-medium">{account.label}</span>
            <p className="text-xs text-ink-faint">
              {t('claudeAccounts.updatedAt', {
                date: new Date(account.updatedAt).toLocaleString(locale()),
              })}
            </p>
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
