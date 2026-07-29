import { Check, Copy, KeyRound, Plus, Trash2, Unplug } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import {
  DEFAULT_CONFIGS,
  EFFORT_FIELD,
  apiScopeSchema,
  type CreatedApiTokenDto,
  type AgentKind,
  type ApiScope,
  type ApiTokenDto,
} from '@sillage/protocol'
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
  Select,
} from '../components/ui'
import { AgentIcon } from '../components/AgentIcon'
import { SectionHeader } from './SettingsPage'
import { ApiRequestError } from '../lib/api'
import { useAgentModels, effortsFor } from '../lib/agents'
import {
  useApiTokens,
  useCreateApiToken,
  useDeleteApiToken,
  useRevokeApiToken,
} from '../lib/api-tokens'
import { copyText } from '../lib/clipboard'
import { locale, useTranslate } from '../lib/i18n'
import { useProjects } from '../lib/projects'

/**
 * Jetons d'API.
 *
 * C'est ici que se décide avec quoi les agents travailleront : le CLI, le modèle et
 * l'effort sont portés par le jeton, une fois, plutôt que redemandés à chaque tâche par
 * un appelant qui ne saurait pas les choisir.
 */

const SCOPES = apiScopeSchema.options
const AGENTS: AgentKind[] = ['claude', 'codex']

/** Durées de vie proposées, en jours. `none` laisse le jeton valable jusqu'à révocation. */
const LIFETIMES = { none: null, '30': 30, '90': 90, '365': 365 } as const
type LifetimeChoice = keyof typeof LIFETIMES
const DAY_MS = 24 * 60 * 60 * 1000

const errorOf = (error: unknown): string | null =>
  error instanceof ApiRequestError ? error.message : null

export function ApiTokensSettingsPage() {
  const t = useTranslate()
  const { data: tokens } = useApiTokens()
  const [created, setCreated] = useState<CreatedApiTokenDto | null>(null)

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title={t('apiTokens.section.title')}
        description={t('apiTokens.section.description')}
      />

      <Banner tone="info">{t('apiTokens.banner')}</Banner>

      {created ? <SecretReveal created={created} onDismiss={() => setCreated(null)} /> : null}

      <CreateTokenCard onCreated={setCreated} />

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-ink-soft">{t('apiTokens.existing.title')}</h2>
        {tokens && tokens.length > 0 ? (
          tokens.map((token) => <TokenCard key={token.id} token={token} />)
        ) : (
          <EmptyState
            icon={<KeyRound size={22} />}
            title={t('apiTokens.empty.title')}
            description={t('apiTokens.empty.description')}
          />
        )}
      </section>
    </div>
  )
}

/**
 * Les secrets ne s'affichent qu'ici, et une seule fois.
 *
 * Le jeton parce que seule son empreinte est stockée ; le secret de webhook parce que
 * l'écran n'a aucune raison de le réexposer ensuite. Une bannière discrète les
 * laisserait perdre à la première navigation.
 */
function SecretReveal({
  created,
  onDismiss,
}: {
  created: CreatedApiTokenDto
  onDismiss: () => void
}) {
  const t = useTranslate()

  return (
    <Card>
      <CardHeader title={t('apiTokens.secret.title')} icon={<KeyRound size={16} />} />
      <CardBody className="flex flex-col gap-3">
        <Banner tone="caution">{t('apiTokens.secret.once')}</Banner>
        <CopyableSecret label={t('apiTokens.secret.token')} value={created.secret} />
        {created.token.webhookUrl ? (
          <CopyableSecret
            label={t('apiTokens.secret.webhook')}
            value={created.webhookSecret}
          />
        ) : null}
        <Button size="sm" variant="ghost" onClick={onDismiss} className="self-start">
          {t('apiTokens.secret.dismiss')}
        </Button>
      </CardBody>
    </Card>
  )
}

function CopyableSecret({ label, value }: { label: string; value: string }) {
  const t = useTranslate()
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    if (!(await copyText(value))) return
    setCopied(true)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-ink-soft">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-md bg-sunken px-3 py-2 font-mono text-xs text-ink">
          {value}
        </code>
        <Button
          size="sm"
          icon={copied ? <Check size={15} /> : <Copy size={15} />}
          onClick={() => void copy()}
        >
          {copied ? t('apiTokens.secret.copied') : t('apiTokens.secret.copy')}
        </Button>
      </div>
    </div>
  )
}

function CreateTokenCard({ onCreated }: { onCreated: (created: CreatedApiTokenDto) => void }) {
  const t = useTranslate()
  const { data: projects } = useProjects()
  const createToken = useCreateApiToken()

  const [label, setLabel] = useState('')
  const [agent, setAgent] = useState<AgentKind>('claude')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [scopes, setScopes] = useState<ApiScope[]>(['projects:read', 'tasks:read', 'tasks:write'])
  const [projectIds, setProjectIds] = useState<string[]>([])
  const [lifetime, setLifetime] = useState<LifetimeChoice>('none')
  const [webhookUrl, setWebhookUrl] = useState('')

  const { data: catalog } = useAgentModels(agent)
  const models = catalog?.models ?? []
  const efforts = effortsFor(models, model)

  const toggle = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]

  const submit = (event: FormEvent) => {
    event.preventDefault()

    // La configuration part complète, construite sur les défauts du CLI : le formulaire
    // n'expose que ce qu'un appelant voudrait changer, le reste garde sa valeur connue.
    // Le champ d'effort porte le nom natif du CLI, `effort` ou `reasoningEffort`.
    const config: Record<string, unknown> = { ...DEFAULT_CONFIGS[agent], model }
    if (effort) config[EFFORT_FIELD[agent]] = effort

    const days = LIFETIMES[lifetime]
    createToken.mutate(
      {
        label: label.trim(),
        scopes,
        projectIds,
        agent,
        config,
        expiresAt: days === null ? null : Date.now() + days * DAY_MS,
        webhookUrl: webhookUrl.trim() || null,
      },
      {
        onSuccess: (created) => {
          onCreated(created)
          setLabel('')
          setProjectIds([])
          setWebhookUrl('')
        },
      },
    )
  }

  return (
    <Card>
      <CardHeader title={t('apiTokens.create.title')} icon={<Plus size={16} />} />
      <CardBody>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field
            label={t('apiTokens.label.label')}
            hint={t('apiTokens.label.hint')}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            required
          />

          <div className="grid gap-4 sm:grid-cols-3">
            <Select
              label={t('apiTokens.agent.label')}
              value={agent}
              onChange={(value) => {
                setAgent(value)
                setModel('')
                setEffort('')
              }}
              options={AGENTS.map((kind) => ({
                value: kind,
                label: kind === 'claude' ? 'Claude Code' : 'Codex',
                icon: <AgentIcon agent={kind} size={13} />,
              }))}
            />
            <Select
              label={t('apiTokens.model.label')}
              value={model}
              onChange={(value) => {
                setModel(value)
                setEffort('')
              }}
              placeholder={t('apiTokens.model.default')}
              options={[
                { value: '', label: t('apiTokens.model.default') },
                ...models.map((entry) => ({ value: entry.value, label: entry.displayName })),
              ]}
            />
            <Select
              label={t('apiTokens.effort.label')}
              value={effort}
              onChange={setEffort}
              placeholder={t('apiTokens.effort.default')}
              disabled={efforts.length === 0}
              options={[
                { value: '', label: t('apiTokens.effort.default') },
                ...efforts.map((entry) => ({ value: entry.value, label: entry.label })),
              ]}
            />
          </div>

          <Select
            label={t('apiTokens.lifetime.label')}
            value={lifetime}
            onChange={setLifetime}
            className="sm:max-w-xs"
            options={[
              { value: 'none', label: t('apiTokens.lifetime.none') },
              { value: '30', label: t('apiTokens.lifetime.days', { days: 30 }) },
              { value: '90', label: t('apiTokens.lifetime.days', { days: 90 }) },
              { value: '365', label: t('apiTokens.lifetime.days', { days: 365 }) },
            ]}
          />

          <Field
            label={t('apiTokens.webhook.label')}
            hint={t('apiTokens.webhook.hint')}
            type="url"
            placeholder="https://..."
            value={webhookUrl}
            onChange={(event) => setWebhookUrl(event.target.value)}
          />

          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-sm font-medium text-ink-soft">
              {t('apiTokens.scopes.label')}
            </legend>
            <div className="flex flex-wrap gap-3">
              {SCOPES.map((scope) => (
                <label key={scope} className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    onChange={() => setScopes(toggle(scopes, scope))}
                  />
                  <code className="font-mono text-xs">{scope}</code>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-sm font-medium text-ink-soft">
              {t('apiTokens.projects.label')}
            </legend>
            {/* Aucune case cochée vaut « tous les projets » : c'est le cas courant, et
                forcer une sélection ferait de la restriction le défaut silencieux. */}
            <p className="text-xs text-ink-faint">{t('apiTokens.projects.hint')}</p>
            <div className="flex flex-wrap gap-3">
              {(projects ?? []).map((project) => (
                <label key={project.id} className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={projectIds.includes(project.id)}
                    onChange={() => setProjectIds(toggle(projectIds, project.id))}
                  />
                  {project.name}
                </label>
              ))}
            </div>
          </fieldset>

          {errorOf(createToken.error) ? <Banner>{errorOf(createToken.error)}</Banner> : null}

          <Button
            type="submit"
            disabled={createToken.isPending || scopes.length === 0}
            className="self-start"
          >
            {createToken.isPending ? t('apiTokens.create.pending') : t('apiTokens.create.action')}
          </Button>
        </form>
      </CardBody>
    </Card>
  )
}

function TokenCard({ token }: { token: ApiTokenDto }) {
  const t = useTranslate()
  const revoke = useRevokeApiToken()
  const remove = useDeleteApiToken()
  const [confirming, setConfirming] = useState<'revoke' | 'delete' | null>(null)
  const revoked = token.revokedAt !== null

  return (
    <Card>
      <CardBody className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{token.label}</span>
            <code className="font-mono text-xs text-ink-faint">
              {t('apiTokens.hint', { hint: token.hint })}
            </code>
            {revoked ? <Badge tone="critical">{t('apiTokens.revoked')}</Badge> : null}
            <Badge icon={<AgentIcon agent={token.agent} size={11} />}>{token.agent}</Badge>
            {token.scopes.map((scope) => (
              <Badge key={scope}>{scope}</Badge>
            ))}
          </div>
          <p className="text-xs text-ink-faint">
            {token.projectIds.length === 0
              ? t('apiTokens.projects.all')
              : t('apiTokens.projects.count', { count: token.projectIds.length })}
            {' · '}
            {token.lastUsedAt === null
              ? t('apiTokens.lastUsed.never')
              : t('apiTokens.lastUsed', {
                  date: new Date(token.lastUsedAt).toLocaleString(locale()),
                })}
            {token.expiresAt === null
              ? null
              : ` · ${t('apiTokens.expires', {
                  date: new Date(token.expiresAt).toLocaleString(locale()),
                })}`}
          </p>
        </div>

        {revoked ? (
          <Button
            size="sm"
            variant="danger"
            icon={<Trash2 size={15} />}
            onClick={() => setConfirming('delete')}
          >
            {t('apiTokens.action.delete')}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="danger"
            icon={<Unplug size={15} />}
            onClick={() => setConfirming('revoke')}
          >
            {t('apiTokens.action.revoke')}
          </Button>
        )}

        <ConfirmDialog
          open={confirming !== null}
          onOpenChange={(open) => setConfirming(open ? confirming : null)}
          title={
            confirming === 'delete'
              ? t('apiTokens.delete.title', { label: token.label })
              : t('apiTokens.revoke.title', { label: token.label })
          }
          confirmLabel={
            confirming === 'delete'
              ? t('apiTokens.action.delete')
              : t('apiTokens.action.revoke')
          }
          tone="critical"
          busy={revoke.isPending || remove.isPending}
          onConfirm={() =>
            confirming === 'delete' ? remove.mutate(token.id) : revoke.mutate(token.id)
          }
        >
          {confirming === 'delete' ? t('apiTokens.delete.body') : t('apiTokens.revoke.body')}
        </ConfirmDialog>
      </CardBody>
    </Card>
  )
}
