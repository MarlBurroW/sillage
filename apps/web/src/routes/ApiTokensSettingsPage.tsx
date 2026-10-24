import { BookOpen, Check, Copy, KeyRound, Plug, Plus, Terminal, Trash2, Unplug } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import {
  DEFAULT_CONFIGS,
  DEFAULT_ANTIGRAVITY_CONFIG,
  EFFORT_FIELD,
  apiScopeSchema,
  type CreatedApiTokenDto,
  type AgentKind,
  type AntigravityConfig,
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
import { AccountChoice } from '../components/chat/AccountChoice'
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
 * API and MCP server: Sillage's two entry points for external tools, and the tokens that unlock
 * them.
 *
 * Both live under `/api/v1` and share tokens, making them look like one feature. The page
 * therefore introduces them side by side, each with its address and a button preparing an
 * appropriate token.
 *
 * For the API, this is where agent settings are chosen: CLI, model and effort are set once on
 * the token rather than requested with every task from callers unable to choose them. MCP does
 * not need them: sessions it launches use project defaults.
 */

const SCOPES = apiScopeSchema.options

/** What each scope allows, in plain language: the name alone does not explain the limits of `tasks:write`. */
const SCOPE_HINT_KEYS: Record<ApiScope, MessageKey> = {
  'projects:read': 'apiTokens.scope.projects:read',
  'projects:write': 'apiTokens.scope.projects:write',
  'tasks:read': 'apiTokens.scope.tasks:read',
  'tasks:write': 'apiTokens.scope.tasks:write',
  'tasks:autonomous': 'apiTokens.scope.tasks:autonomous',
  mcp: 'apiTokens.scope.mcp',
}

/**
 * Token permission modes that retain a CLI safeguard. `bypassPermissions` is deliberately
 * absent: it belongs to the phase-3 `tasks:autonomous` scope, not an ordinary form option.
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
/**
 * Grok modes configurable on a token: plan mode makes no sense for tasks nobody reviews before
 * execution. “Ask” reuses Claude's label.
 */
const GROK_API_PERMISSION_MODES = ['default', 'auto', 'bypassPermissions'] as const
type GrokApiPermissionMode = (typeof GROK_API_PERMISSION_MODES)[number]
const GROK_PERMISSION_MODE_KEYS = {
  default: { label: 'composer.permission.manual', hint: 'composer.permission.manual.hint' },
  auto: { label: 'composer.permission.auto', hint: 'composer.grokPermission.auto.hint' },
  bypassPermissions: { label: 'composer.permission.bypass', hint: 'composer.permission.bypass.hint' },
} as const
const AGENTS = Object.keys(AGENT_LABELS) as AgentKind[]

/** Token purpose determines initially selected scopes and displayed fields. */
type TokenUse = 'api' | 'mcp'
const PRESET_SCOPES: Record<TokenUse, ApiScope[]> = {
  api: ['projects:read', 'tasks:read', 'tasks:write'],
  mcp: ['mcp'],
}

/** CLI, model and webhook are task-only: without a `tasks:*` scope, nothing reads them. */
const launchesTasks = (scopes: ApiScope[]) => scopes.some((scope) => scope.startsWith('tasks:'))

/** Public documentation readable without signing into the instance. */
const DOCS = {
  api: 'https://github.com/MarlBurroW/sillage/blob/main/docs/api.md',
  mcp: 'https://github.com/MarlBurroW/sillage/blob/main/docs/mcp.md',
}

/**
 * Addresses users copy elsewhere: those used to view the UI, which their tools will also reach.
 */
const apiEndpoint = () => `${window.location.origin}/api/v1`
const mcpEndpoint = () => `${window.location.origin}/api/v1/mcp`

/**
 * MCP client configuration examples. Special cases of the guide's three inputs (transport,
 * address, header): MCP is a standard, and every streamable HTTP client configures the same
 * information under different field names. Probed formats: Codex 0.162.1 `http_headers` (`codex
 * mcp get --json`), and `claude mcp add --header`.
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

/** Suggested lifetimes in days. `none` keeps the token valid until revoked. */
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

      {/*
       * Stack vertically: the settings column is too narrow for side-by-side addresses and
       * their buttons on one line.
       */}
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
          {/*
           * Collapsed: useful when connecting a client, clutter otherwise. The token no longer
           * exists in cleartext, hence the replacement placeholder.
           */}
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

      {/*
       * Remount on closing: reopened forms must start empty, not with the previous token's
       * fields. The key also remounts when changing purpose.
       */}
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
 * One of Sillage's two entry points: what it exposes, its address, and token creation. The
 * address is copyable because it goes into another tool's configuration, where a typo would
 * cause an unhelpful error.
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
  /** Additional requirements for using this entry point, below its address. */
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
 * Secrets appear only here, once.
 *
 * The token because only its hash is stored; the webhook secret because the screen has no
 * reason to reveal it again. A subtle banner would let users lose them on their first
 * navigation.
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
        {/*
         * Immediately after token creation is the only time the guide can include it:
         * afterwards it no longer exists in cleartext anywhere.
         */}
        {created.token.scopes.includes('mcp') ? <McpConnectGuide token={created.secret} /> : null}
        <Button size="sm" variant="ghost" onClick={onDismiss} className="self-start">
          {t('apiTokens.secret.dismiss')}
        </Button>
      </CardBody>
    </Card>
  )
}

/**
 * Connecting any MCP client to Sillage.
 *
 * MCP is a standard: all clients need transport, address and authentication under varying
 * names. The guide provides these first, then explains how to recognize them in a form, where
 * users make mistakes. Collapsed examples follow as special cases. Without a token, they
 * contain a replacement placeholder.
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
  /** Multiline commands retain line breaks; secrets wrap wherever possible. */
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
  const [grokPermissionMode, setGrokPermissionMode] = useState<GrokApiPermissionMode>('default')

  const [google, setGoogle] = useState<AntigravityConfig>(DEFAULT_ANTIGRAVITY_CONFIG)
  const { data: catalog } = useAgentModels(agent, true, agent === 'antigravity' ? google.account : null)
  const models = catalog?.models ?? []
  const efforts = effortsFor(models, model)

  const toggle = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]

  const submit = (event: FormEvent) => {
    event.preventDefault()

    // Send a complete configuration built from CLI defaults: the form exposes only
    // what a caller might change; everything else retains its known value.
    // The effort field uses the CLI's native name, `effort` or `reasoningEffort`.
    const config: Record<string, unknown> = { ...(agent === 'antigravity' ? google : DEFAULT_CONFIGS[agent]), model }
    if (effort) config[EFFORT_FIELD[agent]] = effort
    if (agent === 'claude') config.permissionMode = permissionMode
    if (agent === 'grok') config.permissionMode = grokPermissionMode

    const days = LIFETIMES[lifetime]
    createToken.mutate(
      {
        label: label.trim(),
        scopes,
        projectIds,
        agent,
        config,
        expiresAt: days === null ? null : Date.now() + days * DAY_MS,
        // Hidden without task scopes: values entered before deselection must not be sent.
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

          {/*
           * CLI, model and webhook apply only to API tasks: showing them for MCP-only tokens
           * would imply they configure MCP sessions.
           */}
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
                    // Allowing everything requires the dedicated scope: selecting it manually would
                    // be easy to forget, causing the server to reject the entire form.
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
              {agent === 'antigravity' ? <>
                <AccountChoice config={google} enabled onChange={(next) => { if (next.agent === 'antigravity') setGoogle(next) }} />
                <Select
                  label={t('apiTokens.permission.label')}
                  value={google.permissionMode}
                  onChange={(mode) => {
                    setGoogle({ ...google, permissionMode: mode })
                    if (mode === 'yolo' && !scopes.includes('tasks:autonomous')) setScopes([...scopes, 'tasks:autonomous'])
                  }}
                  options={[
                    { value: 'default', label: t('composer.permission.manual'), hint: t('composer.permission.manual.hint') },
                    { value: 'auto_edit', label: t('composer.permission.acceptEdits'), hint: t('composer.permission.acceptEdits.hint') },
                    { value: 'yolo', label: t('composer.permission.bypass'), hint: t('composer.permission.bypass.hint') },
                  ]}
                />
              </> : null}
              {agent === 'grok' ? (
                <Select
                  label={t('apiTokens.permission.label')}
                  value={grokPermissionMode}
                  onChange={(mode) => {
                    setGrokPermissionMode(mode)
                    // `auto` and `bypassPermissions` retain no human in the loop:
                    // the server therefore requires the autonomous-task scope.
                    if (mode !== 'default' && !scopes.includes('tasks:autonomous')) {
                      setScopes([...scopes, 'tasks:autonomous'])
                    }
                  }}
                  className="sm:max-w-xs"
                  options={GROK_API_PERMISSION_MODES.map((mode) => ({
                    value: mode,
                    label: t(GROK_PERMISSION_MODE_KEYS[mode].label),
                    hint: t(GROK_PERMISSION_MODE_KEYS[mode].hint),
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
            {/*
             * One row per scope, explaining access: `tasks:write` alone does not say whether
             * stopping tasks is allowed.
             */}
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
            {/*
             * No selection means “all projects”, the common case. Requiring a selection would
             * silently make restriction the default.
             */}
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
            {/* CLI settings govern tasks only: they would convey nothing true on an MCP-only token. */}
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
