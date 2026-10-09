import { KeyRound, Plus, ShieldCheck, Trash2 } from 'lucide-react'
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
import { ListHeading, SectionHeader } from './SettingsPage'
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
  const [adding, setAdding] = useState(false)
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

  const openForm = () => {
    setName('')
    setValue('')
    putSecret.reset()
    setAdding(true)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    putSecret.mutate({ name: name.trim(), value }, { onSuccess: () => setAdding(false) })
  }

  const secrets = data?.secrets ?? []
  const addButton = (
    <Button size="sm" icon={<Plus size={15} />} disabled={adding} onClick={openForm}>
      {t('secrets.create.open')}
    </Button>
  )

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title={t('secrets.section.title')}
        description={t('secrets.section.description')}
      />

      <Banner tone="info">{t('secrets.banner')}</Banner>

      <section className="flex flex-col gap-2">
        <ListHeading
          title={t('secrets.existing.title')}
          count={secrets.length}
          action={secrets.length > 0 ? addButton : null}
        />

        {adding ? (
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
                  autoFocus
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
                {/* Au moment de saisir, pas en tête de page, et sur le ton d'une
                    information : en rouge au-dessus de tout, on le lisait comme une
                    erreur alors que rien n'avait encore été fait. */}
                <Banner tone="info">{t('secrets.writeOnly')}</Banner>
                {errorOf(putSecret.error) ? <Banner>{errorOf(putSecret.error)}</Banner> : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" disabled={putSecret.isPending}>
                    {putSecret.isPending ? t('secrets.create.pending') : t('secrets.create.action')}
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                    {t('common.cancel')}
                  </Button>
                </div>
              </form>
            </CardBody>
          </Card>
        ) : null}

        {secrets.length === 0 ? (
          adding ? null : (
            <EmptyState
              icon={<KeyRound size={22} />}
              title={t('secrets.empty.title')}
              description={t('secrets.empty.description')}
              action={addButton}
            />
          )
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
