import type { ApiTokenRow, ProjectRow } from '@sillage/db'
import {
  EFFORT_FIELD,
  agentConfigSchema,
  agentKindSchema,
  defaultConfigFor,
  readProjectDefaults,
  type AgentConfig,
  type AgentKind,
  type AgentModelDto,
} from '@sillage/protocol'
import type { AgentRegistry } from '../agents/registry.js'
import { readExecutionPolicy } from '../auth/api-tokens.js'
import type { AppContext } from '../http/context.js'
import { resolveTaskConfig } from '../http/v1/config.js'
import { allowedModels, assertAgentAllowed } from '../http/v1/execution-policy.js'
import { readUserSettings } from '../settings/user-settings.js'
import { Refusal, type Requester, type StartSessionPayload } from './agent-requests-shared.js'
import type { SessionManager } from './session-manager.js'

/** CLI, model and effort of what agents launch (`start_session`, `schedule_task`, `create_automation`), and the `list_models` catalog they choose from. */

/** How long a launch waits for a cold model catalog before starting with the CLI's own defaults. Warm catalogs answer instantly; a cold probe boots a CLI, which on Windows can outlast the caller's wait, and the probe keeps running to warm the cache for the next launch. */
const DEFAULTS_BUDGET_MS = 3000

/** `fallback` when `promise` outlasts `ms`; the promise keeps running, which is wanted for probes that warm a cache. Rejections also yield the fallback: callers here treat an unreachable catalog like a slow one. */
function withinBudget<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      () => { clearTimeout(timer); resolve(fallback) },
    )
  })
}

export class LaunchConfigs {
  constructor(
    private readonly ctx: AppContext,
    private readonly registry: AgentRegistry,
    private readonly sessions: Pick<SessionManager, 'modelsFor'>,
  ) {}

  parseAgent(value: unknown, fallback: AgentKind): AgentKind {
    if (value === undefined || value === null || value === '') return fallback
    const parsed = agentKindSchema.safeParse(typeof value === 'string' ? value.toLowerCase() : value)
    if (!parsed.success) {
      throw new Refusal(`Unknown CLI “${String(value)}”. Available values: ${agentKindSchema.options.join(', ')}.`)
    }
    return parsed.data
  }

  /** Launched-session configuration matches interface proposals: project presets then account defaults for the selected CLI, overridden by requested model and effort. Agents cannot change other settings, especially permissions; delegated sessions gain no more latitude than human one-click launches. */
  async launchConfig(
    agent: AgentKind,
    project: ProjectRow | null,
    userId: string,
    payload: StartSessionPayload,
    token?: ApiTokenRow,
  ): Promise<AgentConfig> {
    if (token) {
      if (!project) throw new Refusal('Select a target project for this API token.')
      const override: Record<string, unknown> = {}
      if (payload.model !== undefined) override.model = payload.model
      if (payload.effort !== undefined) override[EFFORT_FIELD[agent]] = payload.effort
      return (await resolveTaskConfig(this.registry, token, project, {
        prompt: '', agent, config: override, worktreeId: null,
      }, readUserSettings(this.ctx.db, userId).agentDefaults, (config) => this.sessions.modelsFor(userId, config))).config
    }
    const base =
      readProjectDefaults(project?.defaultConfig ?? null)[agent] ??
      readUserSettings(this.ctx.db, userId).agentDefaults[agent] ??
      defaultConfigFor(agent)

    const requestedModel = typeof payload.model === 'string' ? payload.model.trim() : ''
    const requestedEffort = typeof payload.effort === 'string' ? payload.effort.trim().toLowerCase() : ''
    if (!requestedModel && !requestedEffort) {
      // Resolving sentinels reads the catalog: a cold one must not delay the session past the caller's wait, and the CLI applies the same defaults itself.
      return withinBudget(this.registry.adapter(agent).resolveDefaults(base), DEFAULTS_BUDGET_MS, base)
    }

    const catalog = await this.sessions.modelsFor(userId, base)
      .then((listing) => listing.models)
      .catch((): AgentModelDto[] => [])

    let config: AgentConfig = { ...base }
    if (requestedModel) {
      const model = matchModel(catalog, requestedModel)
      if (!model && catalog.length > 0) {
        throw new Refusal(
          `Unknown model “${requestedModel}” for ${agent}. Available: ${catalog.map(nameModel).join(', ')}.`,
        )
      }
      config = { ...config, model: model?.value ?? requestedModel }
    }

    // Effective model after defaults resolution determines which
    // effort levels are available.
    config = await this.registry.adapter(agent).resolveDefaults(config)

    const model = catalog.find((entry) => entry.value === config.model) ?? catalog.find((entry) => entry.isDefault)
    const efforts = model?.efforts.map((entry) => entry.value) ?? []
    const current = effortOf(config)
    if (!requestedEffort && model?.defaultEffort && efforts.length > 0 && !efforts.includes(current)) {
      // Requested models use their own default effort rather than inherited defaults,
      // matching interface selection and avoiding invalid launches.
      config = withEffort(config, model.defaultEffort)
    }

    if (requestedEffort) {
      const effort = matchEffort(efforts, requestedEffort)
      if (!effort) {
        throw new Refusal(
          efforts.length === 0
            ? `Model ${config.model} does not support effort settings: omit \`effort\`.`
            : `Unknown effort “${requestedEffort}” for ${config.model}. Levels: ${efforts.join(', ')}.`,
        )
      }
      config = withEffort(config, effort)
    }

    const parsed = agentConfigSchema.safeParse(config)
    if (!parsed.success) throw new Refusal(`Configuration refused: ${parsed.error.issues[0]?.message ?? 'invalid'}.`)
    return parsed.data
  }

  // --- list_models ---------------------------------------------------------------

  async listModels(
    requester: Pick<Requester, 'userId' | 'agent' | 'apiToken'>,
    project: ProjectRow | null,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const agents: AgentKind[] =
      payload.agent === undefined || payload.agent === null || payload.agent === ''
        ? [...agentKindSchema.options]
        : [this.parseAgent(payload.agent, requester.agent)]

    const policy = requester.apiToken ? readExecutionPolicy(requester.apiToken) : null
    if (payload.agent) for (const agent of agents) assertAgentAllowed(policy, agent)
    // CLIs the user hid or the instance disabled are not probed: an explicit `agent` still names them so the answer explains their absence.
    const hidden = new Set(readUserSettings(this.ctx.db, requester.userId).hiddenAgents)
    const listed = agents.filter((kind) => !policy || policy.agents.some((rule) => rule.agent === kind))
    // Each cold catalog boots a CLI: probing in sequence summed their startups and outran the caller's wait. Independent probes run together.
    const sections = await Promise.all(listed.map(async (agent) => {
      const head = `## ${agent}`
      if (this.registry.adapter(agent).cli?.isEnabled === false) return `${head}\nDisabled in Sillage settings.`
      if (hidden.has(agent) && !payload.agent) return `${head}\nHidden by the user in Sillage: pass \`agent: "${agent}"\` to list it anyway.`
      const defaults = await this.launchConfig(agent, project, requester.userId, {}, requester.apiToken).catch(() => null)
      const models = await (defaults ? this.sessions.modelsFor(requester.userId, defaults) : this.registry.adapter(agent).models())
        .then((listing) => allowedModels(policy, agent, listing.models))
        .catch(() => null)
      const headline = defaults
        ? `${head} — defaults: model ${describeModel(defaults)}, effort ${describeEffort(defaults)}`
        : head
      if (!models) return `${headline}\nCatalog unavailable: the CLI may not be installed, or it did not answer in time.`
      const lines = models.map((model) => {
        const efforts = model.efforts.map((entry) => entry.value)
        return `- \`${model.value}\` (${model.displayName})${model.isDefault ? ' [CLI default]' : ''}${efforts.length > 0 ? ` — efforts: ${efforts.join(', ')}` : ''}`
      })
      return [headline, ...lines].join('\n')
    }))
    return `${sections.join('\n\n')}\n\nIn start_session, \`model\` accepts a value or display name, and \`effort: "max"\` selects the highest level when the model has no level with that name.`
  }
}

function nameModel(model: AgentModelDto): string {
  return model.displayName && model.displayName !== model.value ? `${model.value} (${model.displayName})` : model.value
}

/** Finds models by agent-supplied names, often user labels such as 'Astra' or 'opus' instead of exact IDs. */
export function matchModel(catalog: AgentModelDto[], wanted: string): AgentModelDto | null {
  const needle = wanted.toLowerCase()
  const exact = catalog.find((model) => model.value.toLowerCase() === needle)
  if (exact) return exact
  const named = catalog.find((model) => model.displayName.toLowerCase() === needle)
  if (named) return named
  const partial = catalog.filter(
    (model) => model.value.toLowerCase().includes(needle) || model.displayName.toLowerCase().includes(needle),
  )
  // Require unique candidates: guessing between models would choose on behalf
  // of the user.
  return partial.length === 1 ? (partial[0] ?? null) : null
}

/** `max` selects a literal level when available (Codex has one below `ultra`), otherwise the model maximum. Users request maximum effort without knowing models may stop at `xhigh`. Catalog levels run lowest to highest. */
export function matchEffort(efforts: string[], wanted: string): string | null {
  if (efforts.includes(wanted)) return wanted
  if (wanted === 'max' || wanted === 'maximum') return efforts.at(-1) ?? null
  if (wanted === 'min' || wanted === 'minimum') return efforts[0] ?? null
  return null
}

function withEffort(config: AgentConfig, effort: string): AgentConfig {
  // Schemas reject unsupported Claude levels later; the cast merely passes
  // the string through to validation.
  if (config.agent === 'claude') return { ...config, effort: effort as typeof config.effort }
  if (config.agent === 'codex' || config.agent === 'grok' || config.agent === 'antigravity') return { ...config, reasoningEffort: effort }
  return { ...config, variant: effort }
}

/** Effort named according to each CLI, including opencode variants. */
function effortOf(config: AgentConfig): string {
  if (config.agent === 'claude') return config.effort
  if (config.agent === 'opencode') return config.variant
  return config.reasoningEffort
}

export function describeModel(config: AgentConfig): string {
  return config.model || 'CLI default'
}

export function describeEffort(config: AgentConfig): string {
  return effortOf(config) || 'CLI default'
}

export function describePermissions(config: AgentConfig): string | null {
  if (config.agent === 'claude' && config.permissionMode === 'manual') {
    return 'Permissions are manual, following project defaults: it will pause to ask the user before acting.'
  }
  if (config.agent === 'codex' && config.askForApproval !== 'never' && config.askForApproval !== '') {
    return 'It will ask for user approval outside its sandbox, following project defaults.'
  }
  if (config.agent === 'opencode' && (config.permissions.edit === 'ask' || config.permissions.bash === 'ask')) {
    return 'It will ask for user permission before writing or executing, following project defaults.'
  }
  if (config.agent === 'grok' && (config.permissionMode === 'default' || config.permissionMode === 'plan')) {
    return 'It will ask for user permission before writing or executing, following project defaults.'
  }
  return null
}
