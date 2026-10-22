import { KeyRound, Plus, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import type { GitCredential } from '@sillage/protocol'
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
  GITHUB_HOST,
  useDeleteGitCredential,
  useGitCredentials,
  usePutGitCredential,
} from '../lib/git-credentials'

/**
 * Account git-forge access.
 *
 * Like secrets, tokens cannot be displayed because the API returns none. What matters is the
 * host, presented username and last-write date, useful when a token expires.
 *
 * Per account, unlike instance secrets: everyone sees only their own credentials,
 * administrators included.
 */

const errorOf = (error: unknown): string | null =>
  error instanceof ApiRequestError ? error.message : null

export function GitCredentialsSettingsPage() {
  const t = useTranslate()
  const { data } = useGitCredentials()
  const putCredential = usePutGitCredential()

  const [adding, setAdding] = useState(false)
  const [host, setHost] = useState(GITHUB_HOST)
  const [username, setUsername] = useState('x-access-token')
  const [token, setToken] = useState('')

  const openForm = () => {
    setHost(GITHUB_HOST)
    setUsername('x-access-token')
    setToken('')
    putCredential.reset()
    setAdding(true)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    putCredential.mutate(
      { host: host.trim().toLowerCase(), username: username.trim(), token },
      { onSuccess: () => setAdding(false) },
    )
  }

  const credentials = data?.credentials ?? []
  const addButton = (
    <Button size="sm" icon={<Plus size={15} />} disabled={adding} onClick={openForm}>
      {t('gitCredentials.create.open')}
    </Button>
  )

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title={t('gitCredentials.section.title')}
        description={t('gitCredentials.section.description')}
      />

      <Banner tone="info">{t('gitCredentials.banner')}</Banner>

      <section className="flex flex-col gap-2">
        <ListHeading
          title={t('gitCredentials.existing.title')}
          count={credentials.length}
          action={credentials.length > 0 ? addButton : null}
        />

        {adding ? (
          <Card>
            <CardHeader title={t('gitCredentials.create.title')} icon={<KeyRound size={16} />} />
            <CardBody>
              <form onSubmit={submit} className="flex flex-col gap-4">
                <Field
                  label={t('gitCredentials.host.label')}
                  hint={t('gitCredentials.host.hint')}
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                  pattern="[A-Za-z0-9.\-]+"
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoFocus
                  required
                />
                <Field
                  label={t('gitCredentials.username.label')}
                  hint={t('gitCredentials.username.hint')}
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoCapitalize="none"
                  autoCorrect="off"
                  required
                />
                <Field
                  label={t('gitCredentials.token.label')}
                  hint={t('gitCredentials.token.hint')}
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  // The browser password manager has nothing to save here.
                  autoComplete="off"
                  required
                />
                {/*
                 * At token selection, not the page top: this is where scope is decided.
                 */}
                <Banner tone="caution">{t('gitCredentials.trustModel')}</Banner>
                {errorOf(putCredential.error) ? (
                  <Banner>{errorOf(putCredential.error)}</Banner>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" disabled={putCredential.isPending}>
                    {putCredential.isPending
                      ? t('gitCredentials.create.pending')
                      : t('gitCredentials.create.action')}
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                    {t('common.cancel')}
                  </Button>
                </div>
              </form>
            </CardBody>
          </Card>
        ) : null}

        {credentials.length === 0 ? (
          adding ? null : (
            <EmptyState
              icon={<KeyRound size={22} />}
              title={t('gitCredentials.empty.title')}
              description={t('gitCredentials.empty.description')}
              action={addButton}
            />
          )
        ) : (
          credentials.map((credential) => (
            <CredentialCard key={credential.host} credential={credential} />
          ))
        )}
      </section>
    </div>
  )
}

function CredentialCard({ credential }: { credential: GitCredential }) {
  const t = useTranslate()
  const deleteCredential = useDeleteGitCredential()
  const [confirming, setConfirming] = useState(false)

  return (
    <Card>
      <CardBody className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="font-mono font-medium">{credential.host}</span>
          <p className="text-xs text-ink-faint">
            {t('gitCredentials.username.value', { username: credential.username })}
          </p>
          <p className="text-xs text-ink-faint">
            {t('gitCredentials.updatedAt', {
              date: new Date(credential.updatedAt).toLocaleString(locale()),
            })}
          </p>
        </div>

        <Button
          size="sm"
          variant="danger"
          icon={<Trash2 size={15} />}
          onClick={() => setConfirming(true)}
        >
          {t('gitCredentials.action.delete')}
        </Button>

        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={t('gitCredentials.delete.title', { host: credential.host })}
          confirmLabel={t('gitCredentials.delete.confirm')}
          tone="critical"
          busy={deleteCredential.isPending}
          onConfirm={() => deleteCredential.mutate(credential.host)}
        >
          {t('gitCredentials.delete.body')}
        </ConfirmDialog>
      </CardBody>
    </Card>
  )
}
