import { KeyRound, ShieldCheck, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import type { Secret } from '@sillage/protocol'
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
import { SectionHeader } from './SettingsPage'
import { ApiRequestError } from '../lib/api'
import { locale, useTranslate } from '../lib/i18n'
import { useDeleteSecret, usePutSecret, useSecrets } from '../lib/secrets'
import { useCurrentUser } from '../lib/session'

/**
 * Dépôt de secrets.
 *
 * L'écran ne peut afficher aucune valeur, parce que l'API n'en rend aucune. Il montre
 * donc ce qui reste et qui compte : le nom, la date de dernière écriture, et les
 * serveurs MCP qui s'en servent. Ce dernier point est ce qui rend une suppression
 * décidable au lieu d'être un pari.
 */

const errorOf = (error: unknown): string | null =>
  error instanceof ApiRequestError ? error.message : null

export function SecretsSettingsPage() {
  const t = useTranslate()
  const { data: me } = useCurrentUser()
  const isAdmin = me?.isAdmin === true
  const { data } = useSecrets(isAdmin)

  const putSecret = usePutSecret()
  const [name, setName] = useState('')
  const [value, setValue] = useState('')

  if (!isAdmin) {
    return (
      <EmptyState
        icon={<ShieldCheck size={22} />}
        title={t('secrets.adminOnly.title')}
        description={t('secrets.adminOnly.description')}
      />
    )
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    putSecret.mutate(
      { name: name.trim(), value },
      {
        onSuccess: () => {
          setName('')
          setValue('')
        },
      },
    )
  }

  const secrets = data?.secrets ?? []

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title={t('secrets.section.title')}
        description={t('secrets.section.description')}
      />

      <Banner tone="info">{t('secrets.banner')}</Banner>
      <Banner>{t('secrets.writeOnly')}</Banner>

      <Card>
        <CardHeader title={t('secrets.create.title')} icon={<KeyRound size={16} />} />
        <CardBody>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Field
              label={t('secrets.name.label')}
              hint={t('secrets.name.hint')}
              value={name}
              onChange={(event) => setName(event.target.value)}
              pattern="[A-Za-z0-9_]+"
              autoCapitalize="none"
              autoCorrect="off"
              required
            />
            <Field
              label={t('secrets.value.label')}
              hint={t('secrets.value.hint')}
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              // Le gestionnaire de mots de passe du navigateur n'a rien à retenir ici.
              autoComplete="off"
              required
            />
            {errorOf(putSecret.error) ? <Banner>{errorOf(putSecret.error)}</Banner> : null}
            <Button type="submit" disabled={putSecret.isPending} className="self-start">
              {putSecret.isPending ? t('secrets.create.pending') : t('secrets.create.action')}
            </Button>
          </form>
        </CardBody>
      </Card>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-ink-soft">{t('secrets.existing.title')}</h2>
        {secrets.length === 0 ? (
          <EmptyState
            icon={<KeyRound size={22} />}
            title={t('secrets.empty.title')}
            description={t('secrets.empty.description')}
          />
        ) : (
          secrets.map((secret) => <SecretCard key={secret.name} secret={secret} />)
        )}
      </section>
    </div>
  )
}

function SecretCard({ secret }: { secret: Secret }) {
  const t = useTranslate()
  const deleteSecret = useDeleteSecret()
  const [confirming, setConfirming] = useState(false)

  return (
    <Card>
      <CardBody className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono font-medium">{secret.name}</span>
            {/* Le point d'emploi est la seule chose qui rende une suppression
                décidable : sans lui, effacer revient à parier qu'aucun serveur MCP
                n'en dépend. */}
            {secret.usedBy.length > 0 ? (
              <Badge tone="accent">
                {t('secrets.usedBy', { servers: secret.usedBy.join(', ') })}
              </Badge>
            ) : (
              <Badge>{t('secrets.usedBy.none')}</Badge>
            )}
          </div>
          <p className="text-xs text-ink-faint">
            {t('secrets.updatedAt', {
              date: new Date(secret.updatedAt).toLocaleString(locale()),
            })}
          </p>
        </div>

        <Button
          size="sm"
          variant="danger"
          icon={<Trash2 size={15} />}
          onClick={() => setConfirming(true)}
        >
          {t('secrets.action.delete')}
        </Button>

        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={t('secrets.delete.title', { name: secret.name })}
          confirmLabel={t('secrets.delete.confirm')}
          tone="critical"
          busy={deleteSecret.isPending}
          onConfirm={() => deleteSecret.mutate(secret.name)}
        >
          {t('secrets.delete.body')}
        </ConfirmDialog>
      </CardBody>
    </Card>
  )
}
