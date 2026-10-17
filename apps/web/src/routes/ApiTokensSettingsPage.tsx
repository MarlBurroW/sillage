import { BookOpen, Check, Copy, KeyRound, Plug, Plus, Terminal, Trash2, Unplug } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
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
  cx,
} from '../components/ui'
import { AGENT_LABELS, AgentIcon } from '../components/AgentIcon'
import { ListHeading, SectionHeader } from './SettingsPage'
import { ApiRequestError } from '../lib/api'
import { useAgentModels, effortLabel, effortsFor } from '../lib/agents'
import {
  useApiTokens,
  useCreateApiToken,
  useDeleteApiToken,
  useRevokeApiToken,
} from '../lib/api-tokens'
import { copyText } from '../lib/clipboard'
import { locale, useTranslate, type MessageKey } from '../lib/i18n'
import { useProjects } from '../lib/projects'

/**
 * API et serveur MCP : les deux portes de Sillage vers un outil extérieur, et les jetons
 * qui les ouvrent.
 *
 * Les deux vivent sous `/api/v1` et partagent les jetons, ce qui les faisait passer pour
 * une seule chose : la page commence donc par les présenter côte à côte, chacune avec
 * son adresse et un bouton qui prépare un jeton à sa mesure.
 *
 * Pour l'API, c'est ici que se décide avec quoi les agents travailleront : le CLI, le
 * modèle et l'effort sont portés par le jeton, une fois, plutôt que redemandés à chaque
 * tâche par un appelant qui ne saurait pas les choisir. Le serveur MCP n'en a pas
 * l'usage : une session qu'il lance prend les réglages par défaut du projet.
 */

const SCOPES = apiScopeSchema.options

/** Ce que chaque portée ouvre, dit en clair : le nom seul ne dit pas où s'arrête `tasks:write`. */
const SCOPE_HINT_KEYS: Record<ApiScope, MessageKey> = {
  'projects:read': 'apiTokens.scope.projects:read',
  'projects:write': 'apiTokens.scope.projects:write',
  'tasks:read': 'apiTokens.scope.tasks:read',
  'tasks:write': 'apiTokens.scope.tasks:write',
  'tasks:autonomous': 'apiTokens.scope.tasks:autonomous',
  mcp: 'apiTokens.scope.mcp',
}

/**
 * Modes de permission proposables sur un jeton : ceux où le CLI garde un garde-fou.
 * `bypassPermissions` n'y est pas, à dessein : il vaudra la portée `tasks:autonomous`
 * de la tranche 3, pas une option de formulaire parmi d'autres.
 */
const API_PERMISSION_MODES = ['manual', 'auto', 'acceptEdits', 'dontAsk', 'bypassPermissions'] as const
type ApiPermissionMode = (typeof API_PERMISSION_MODES)[number]
const PERMISSION_MODE_KEYS = {
  manual: 'composer.permission.manual',
  auto: 'composer.permission.auto',
  acceptEdits: 'composer.permission.acceptEdits',
  dontAsk: 'composer.permission.dontAsk',
  bypassPermissions: 'composer.permission.bypass',
} as const
const AGENTS = Object.keys(AGENT_LABELS) as AgentKind[]

/** Ce pour quoi un jeton est créé : il décide des portées cochées d'entrée et des champs montrés. */
type TokenUse = 'api' | 'mcp'
const PRESET_SCOPES: Record<TokenUse, ApiScope[]> = {
  api: ['projects:read', 'tasks:read', 'tasks:write'],
  mcp: ['mcp'],
}

/** Le CLI, le modèle et le webhook ne servent qu'aux tâches : sans portée `tasks:*`, rien ne les lit. */
const launchesTasks = (scopes: ApiScope[]) => scopes.some((scope) => scope.startsWith('tasks:'))

/** Documentation publique, lisible sans être connecté à l'instance. */
const DOCS = {
  api: 'https://github.com/MarlBurroW/sillage/blob/main/docs/api.md',
  mcp: 'https://github.com/MarlBurroW/sillage/blob/main/docs/mcp.md',
}

/**
 * Les adresses que l'utilisateur recopiera ailleurs : celles par lesquelles il voit
 * l'interface, qui sont aussi celles que son outil atteindra.
 */
const apiEndpoint = () => `${window.location.origin}/api/v1`
const mcpEndpoint = () => `${window.location.origin}/api/v1/mcp`

/**
 * Exemples de configuration d'un client MCP. Ce ne sont que des cas particuliers des
 * trois informations du guide (transport, adresse, en-tête) : MCP est un standard, et
 * tout client qui parle HTTP « streamable » se configure de la même façon, sous des
 * noms de champs différents. Formats sondés : `http_headers` lu par Codex 0.162.1
 * (`codex mcp get --json`), `--header` de `claude mcp add`.
 */
const mcpJsonExample = (token: string) =>
  JSON.stringify(
    { mcpServers: { sillage: { type: 'http', url: mcpEndpoint(), headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  )
const codexTomlExample = (token: string) =>
  `[mcp_servers.sillage]\nurl = "${mcpEndpoint()}"\nhttp_headers = { "Authorization" = "Bearer ${token}" }`
const claudeCommandExample = (token: string) =>
  `claude mcp add --transport http sillage ${mcpEndpoint()} --header "Authorization: Bearer ${token}"`

/** Durées de vie proposées, en jours. `none` laisse le jeton valable jusqu'à révocation. */
const LIFETIMES = { none: null, '30': 30, '90': 90, '365': 365 } as const
type LifetimeChoice = keyof typeof LIFETIMES
const DAY_MS = 24 * 60 * 60 * 1000

const errorOf = (error: unknown): string | null =>
  error instanceof ApiRequestError ? error.message : null

export function ApiTokensSettingsPage() {
  const t = useTranslate()
  const { data: tokens } = useApiTokens()
  const [adding, setAdding] = useState<TokenUse | null>(null)
  const [created, setCreated] = useState<CreatedApiTokenDto | null>(null)

  const open = (use: TokenUse) => {
    setCreated(null)
    setAdding(use)
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title={t('apiTokens.section.title')}
        description={t('apiTokens.section.description')}
      />

      {/* L'une sous l'autre : côte à côte, la colonne des réglages est trop étroite pour
          qu'une adresse tienne sur une ligne à côté de son bouton. */}
      <section className="flex flex-col gap-3">
        <SurfaceCard
          icon={<Terminal size={16} />}
          title={t('apiTokens.surface.api.title')}
          description={t('apiTokens.surface.api.description')}
          endpoint={apiEndpoint()}
          scopes={t('apiTokens.surface.api.scopes')}
          docs={DOCS.api}
          createLabel={t('apiTokens.surface.api.create')}
          disabled={adding !== null}
          onCreate={() => open('api')}
        />
        <SurfaceCard
          icon={<Plug size={16} />}
          title={t('apiTokens.surface.mcp.title')}
          description={t('apiTokens.surface.mcp.description')}
          endpoint={mcpEndpoint()}
          scopes={t('apiTokens.surface.mcp.scopes')}
          docs={DOCS.mcp}
          createLabel={t('apiTokens.surface.mcp.create')}
          disabled={adding !== null}
          onCreate={() => open('mcp')}
        >
          {/* Replié : utile au moment de brancher un client, encombrant le reste du temps.
              Le jeton n'existe plus en clair, d'où l'emplacement à remplacer. */}
          <details className="rounded-md border border-line px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium text-ink-soft">
              {t('apiTokens.mcpGuide.toggle')}
            </summary>
            <div className="pt-3">
              <McpConnectGuide token={null} />
            </div>
          </details>
        </SurfaceCard>
      </section>

      <Banner tone="info">{t('apiTokens.banner')}</Banner>

      {created ? <SecretReveal created={created} onDismiss={() => setCreated(null)} /> : null}

      {/* Remonté à la fermeture : un formulaire rouvert doit repartir vide, pas des
          champs du jeton précédent. La clé le remonte aussi d'un usage à l'autre. */}
      {adding ? (
        <CreateTokenCard
          key={adding}
          use={adding}
          onCreated={(token) => {
            setCreated(token)
            setAdding(null)
          }}
          onCancel={() => setAdding(null)}
        />
      ) : null}

      <section className="flex flex-col gap-2">
        <ListHeading title={t('apiTokens.existing.title')} count={tokens?.length} />

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
 * Une des deux portes de Sillage : ce qu'elle ouvre, son adresse, et de quoi créer le
 * jeton qui va avec. L'adresse se copie, parce qu'elle part dans la configuration d'un
 * autre outil et qu'une faute de frappe y donnerait une erreur peu parlante.
 */
function SurfaceCard({
  icon,
  title,
  description,
  endpoint,
  scopes,
  docs,
  createLabel,
  disabled,
  onCreate,
  children,
}: {
  icon: ReactNode
  title: string
  description: string
  endpoint: string
  scopes: string
  docs: string
  createLabel: string
  disabled: boolean
  onCreate: () => void
  /** Ce que la porte demande en plus pour s'en servir, sous son adresse. */
  children?: ReactNode
}) {
  const t = useTranslate()
  return (
    <Card className="flex flex-col">
      <CardHeader title={title} description={description} icon={icon} />
      <CardBody className="flex flex-1 flex-col gap-3">
        <CopyableValue label={t('apiTokens.surface.endpoint')} value={endpoint} />
        <p className="text-xs text-ink-faint">{scopes}</p>
        {children}
        <div className="mt-auto flex flex-wrap items-center gap-3">
          <Button size="sm" icon={<Plus size={15} />} disabled={disabled} onClick={onCreate}>
            {createLabel}
          </Button>
          <a
            href={docs}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink"
          >
            <BookOpen size={14} />
            {t('apiTokens.surface.docs')}
          </a>
        </div>
      </CardBody>
    </Card>
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
        <CopyableValue label={t('apiTokens.secret.token')} value={created.secret} />
        {created.token.webhookUrl ? (
          <CopyableValue
            label={t('apiTokens.secret.webhook')}
            value={created.webhookSecret}
          />
        ) : null}
        {/* Le jeton à peine né est le seul moment où le guide peut l'embarquer : après, il
            n'existe plus en clair nulle part. */}
        {created.token.scopes.includes('mcp') ? <McpConnectGuide token={created.secret} /> : null}
        <Button size="sm" variant="ghost" onClick={onDismiss} className="self-start">
          {t('apiTokens.secret.dismiss')}
        </Button>
      </CardBody>
    </Card>
  )
}

/**
 * Comment brancher un client MCP sur Sillage, quel qu'il soit.
 *
 * MCP est un standard : tout client demande les trois mêmes choses, transport, adresse
 * et authentification, sous des noms qui varient. Le guide les donne d'abord, puis dit
 * comment les reconnaître dans un formulaire : c'est là que l'utilisateur se trompe,
 * pas sur l'adresse. Les exemples ne viennent qu'ensuite, repliés, comme des cas
 * particuliers. Sans jeton, ils portent un emplacement à remplacer.
 */
function McpConnectGuide({ token }: { token: string | null }) {
  const t = useTranslate()
  const value = token ?? t('apiTokens.mcpGuide.placeholder')
  const examples: { label: string; value: string }[] = [
    { label: t('apiTokens.mcpGuide.example.json'), value: mcpJsonExample(value) },
    { label: t('apiTokens.mcpGuide.example.codex'), value: codexTomlExample(value) },
    { label: t('apiTokens.mcpGuide.example.claude'), value: claudeCommandExample(value) },
  ]
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-soft">{t('apiTokens.mcpGuide.intro')}</p>
      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="font-medium text-ink">{t('apiTokens.mcpGuide.transport')}</dt>
        <dd className="text-ink-soft">{t('apiTokens.mcpGuide.transport.value')}</dd>
        <dt className="font-medium text-ink">{t('apiTokens.mcpGuide.url')}</dt>
        <dd className="min-w-0">
          <code className="break-all font-mono text-xs text-ink">{mcpEndpoint()}</code>
        </dd>
        <dt className="font-medium text-ink">{t('apiTokens.mcpGuide.auth')}</dt>
        <dd className="min-w-0">
          <code className="break-all font-mono text-xs text-ink">Authorization: Bearer {value}</code>
        </dd>
      </dl>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-ink">{t('apiTokens.mcpGuide.fields')}</span>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-ink-soft">
          <li>{t('apiTokens.mcpGuide.fields.headers')}</li>
          <li>{t('apiTokens.mcpGuide.fields.bearer')}</li>
          <li>{t('apiTokens.mcpGuide.fields.env')}</li>
        </ul>
      </div>

      <details className="rounded-md border border-line px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium text-ink-soft">
          {t('apiTokens.mcpGuide.examples')}
        </summary>
        <div className="flex flex-col gap-3 pt-3">
          {examples.map((example) => (
            <CopyableValue key={example.label} label={example.label} value={example.value} multiline />
          ))}
        </div>
      </details>
    </div>
  )
}

function CopyableValue({
  label,
  value,
  multiline = false,
}: {
  label: string
  value: string
  /** Une commande sur plusieurs lignes garde ses retours ; un secret se coupe où il peut. */
  multiline?: boolean
}) {
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
        <code
          className={cx(
            'min-w-0 flex-1 break-all rounded-md bg-sunken px-3 py-2 font-mono text-xs text-ink',
            multiline && 'whitespace-pre-wrap',
          )}
        >
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

function CreateTokenCard({
  use,
  onCreated,
  onCancel,
}: {
  use: TokenUse
  onCreated: (created: CreatedApiTokenDto) => void
  onCancel: () => void
}) {
  const t = useTranslate()
  const { data: projects } = useProjects()
  const createToken = useCreateApiToken()

  const [label, setLabel] = useState('')
  const [agent, setAgent] = useState<AgentKind>('claude')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [scopes, setScopes] = useState<ApiScope[]>(PRESET_SCOPES[use])
  const [projectIds, setProjectIds] = useState<string[]>([])
  const [lifetime, setLifetime] = useState<LifetimeChoice>('none')
  const [webhookUrl, setWebhookUrl] = useState('')
  const [permissionMode, setPermissionMode] = useState<ApiPermissionMode>('manual')

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
    if (agent === 'claude') config.permissionMode = permissionMode

    const days = LIFETIMES[lifetime]
    createToken.mutate(
      {
        label: label.trim(),
        scopes,
        projectIds,
        agent,
        config,
        expiresAt: days === null ? null : Date.now() + days * DAY_MS,
        // Masqué sans portée de tâches : une valeur saisie avant de décocher ne doit pas partir.
        webhookUrl: (launchesTasks(scopes) && webhookUrl.trim()) || null,
      },
      { onSuccess: onCreated },
    )
  }

  return (
    <Card>
      <CardHeader
        title={use === 'mcp' ? t('apiTokens.create.title.mcp') : t('apiTokens.create.title')}
        icon={use === 'mcp' ? <Plug size={16} /> : <Terminal size={16} />}
      />
      <CardBody>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field
            label={t('apiTokens.label.label')}
            hint={t('apiTokens.label.hint')}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            autoFocus
            required
          />

          {/* Le CLI, le modèle et le webhook ne servent qu'aux tâches de l'API : pour un
              jeton MCP seul, les montrer laisserait croire qu'ils règlent ses sessions. */}
          {launchesTasks(scopes) ? (
            <>
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
                    label: AGENT_LABELS[kind],
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
                    ...efforts.map((entry) => ({ value: entry.value, label: effortLabel(t, entry) })),
                  ]}
                />
              </div>

              {agent === 'claude' ? (
                <Select
                  label={t('apiTokens.permission.label')}
                  value={permissionMode}
                  onChange={(mode) => {
                    setPermissionMode(mode)
                    // Tout permettre exige la portée dédiée : la cocher soi-même serait
                    // facile à oublier, et le serveur refuserait le formulaire entier.
                    if (mode === 'bypassPermissions' && !scopes.includes('tasks:autonomous')) {
                      setScopes([...scopes, 'tasks:autonomous'])
                    }
                  }}
                  className="sm:max-w-xs"
                  options={API_PERMISSION_MODES.map((mode) => ({
                    value: mode,
                    label: t(PERMISSION_MODE_KEYS[mode]),
                    hint: t(`${PERMISSION_MODE_KEYS[mode]}.hint` as Parameters<typeof t>[0]),
                  }))}
                />
              ) : null}

              <Field
                label={t('apiTokens.webhook.label')}
                hint={t('apiTokens.webhook.hint')}
                type="url"
                placeholder="https://..."
                value={webhookUrl}
                onChange={(event) => setWebhookUrl(event.target.value)}
              />
            </>
          ) : (
            <p className="text-sm text-ink-faint">{t('apiTokens.create.mcpOnly')}</p>
          )}

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

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium text-ink-soft">
              {t('apiTokens.scopes.label')}
            </legend>
            {/* Une ligne par portée, avec ce qu'elle ouvre : un nom comme
                `tasks:write` ne dit pas s'il permet aussi d'arrêter une tâche. */}
            <div className="grid gap-2 sm:grid-cols-2">
              {SCOPES.map((scope) => (
                <label
                  key={scope}
                  className={cx(
                    'flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 text-sm text-ink transition-colors',
                    'has-checked:border-accent has-checked:bg-accent-wash',
                    'border-line hover:border-line-strong',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    onChange={() => setScopes(toggle(scopes, scope))}
                    className="mt-0.5 size-4 shrink-0 accent-accent"
                  />
                  <span className="min-w-0">
                    <code className="font-mono text-xs">{scope}</code>
                    <span className="block text-xs text-ink-faint">{t(SCOPE_HINT_KEYS[scope])}</span>
                  </span>
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
                    className="size-4 accent-accent"
                  />
                  {project.name}
                </label>
              ))}
            </div>
          </fieldset>

          {errorOf(createToken.error) ? <Banner>{errorOf(createToken.error)}</Banner> : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={createToken.isPending || scopes.length === 0}>
              {createToken.isPending ? t('apiTokens.create.pending') : t('apiTokens.create.action')}
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t('common.cancel')}
            </Button>
          </div>
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
            {/* Le CLI ne règle que les tâches : sur un jeton MCP seul, il ne dirait rien de vrai. */}
            {launchesTasks(token.scopes) ? (
              <Badge icon={<AgentIcon agent={token.agent} size={11} />}>{token.agent}</Badge>
            ) : null}
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
