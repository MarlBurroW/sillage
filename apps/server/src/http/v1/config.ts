import type { ApiTokenRow, ProjectRow } from '@sillage/db'
import {
  EFFORT_FIELD,
  mergeAgentConfig,
  readProjectDefaults,
  type AgentConfig,
  type AgentDefaults,
  type AgentKind,
  type AgentModelsDto,
  type CreateTaskBody,
} from '@sillage/protocol'
import type { AgentRegistry } from '../../agents/registry.js'
import { readExecutionPolicy } from '../../auth/api-tokens.js'
import { assertAgentAllowed, assertTokenExecution } from './execution-policy.js'
import { badRequest } from '../errors.js'

/**
 * Configuration a task will run with.
 *
 * Four levels, from most to least specific: request settings, token settings,
 * project settings, then defaults of the account owning the token. A machine
 * caller only needs to supply a prompt; someone made the model choice once
 * through a form with the necessary context.
 */
export async function resolveTaskConfig(
  registry: AgentRegistry,
  token: ApiTokenRow,
  project: ProjectRow,
  body: CreateTaskBody,
  defaults: AgentDefaults,
  modelsFor?: (config: AgentConfig) => Promise<AgentModelsDto>,
): Promise<{ agent: AgentKind; config: AgentConfig }> {
  const agent = body.agent ?? token.agent
  const policy = readExecutionPolicy(token)
  assertAgentAllowed(policy, agent)
  const base = baseConfigFor(agent, token, project, defaults)

  let catalog: AgentModelsDto | undefined
  try {
    catalog = await (modelsFor ? modelsFor(base) : registry.adapter(agent).models())
  } catch {
    // Explicit policies still apply when a CLI catalog is unavailable.
  }
  const override = { ...body.config }
  const effortField = EFFORT_FIELD[agent]
  if (body.model !== undefined) override.model = body.model
  if (body.effort !== undefined) override[effortField] = body.effort
  const requestedModel = override.model
  if (typeof requestedModel === 'string' && requestedModel) {
    const exact = catalog?.models.find((entry) => entry.value.toLowerCase() === requestedModel.toLowerCase())
    const named = catalog?.models.filter((entry) => entry.displayName.toLowerCase() === requestedModel.toLowerCase()) ?? []
    const model = exact ?? (named.length === 1 ? named[0] : undefined)
    const approvedCustomModel = policy?.agents.find((rule) => rule.agent === agent)?.models?.includes(requestedModel)
    if (!model && catalog?.models.length && !approvedCustomModel) {
      throw badRequest('model_unknown', 'Unknown model {model} for {agent}. Known: {known}.', {
        model: requestedModel, agent, known: catalog.models.map((entry) => entry.value).join(', '),
      })
    }
    if (model) override.model = model.value
  }
  // Resolve the model before normalizing "max": Codex's native enum calls it "xhigh".
  const modelConfig = await registry.adapter(agent).resolveDefaults({ ...base, ...(typeof override.model === 'string' ? { model: override.model } : {}) })
  const model = catalog?.models.find((entry) => entry.value === modelConfig.model)
  const requestedEffort = override[effortField]
  if (typeof requestedEffort === 'string' && requestedEffort && model) {
    const efforts = model.efforts.map((entry) => entry.value)
    const effort = requestedEffort === 'max' && !efforts.includes('max') ? efforts.at(-1) : requestedEffort
    if (!effort || !efforts.includes(effort)) {
      throw badRequest('effort_unknown', 'Unknown effort {effort} for {model}. Allowed: {allowed}.', {
        effort: requestedEffort, model: modelConfig.model, allowed: efforts.join(', '),
      })
    }
    override[effortField] = effort
  } else if (requestedModel && model?.defaultEffort && !model.efforts.some((entry) => entry.value === (modelConfig as unknown as Record<string, unknown>)[effortField])) {
    override[effortField] = model.defaultEffort
  }
  let merged: AgentConfig
  let rejected: string[]
  try {
    ;({ config: merged, rejected } = mergeAgentConfig(modelConfig, override))
  } catch {
    throw badRequest('config_invalid', 'The configuration override is not valid for {agent}. See GET /api/v1/agents.', { agent })
  }
  if (rejected.length > 0) {
    throw badRequest('config_field_locked', 'These safeguard or budget settings cannot be overridden: {fields}. Model and effort may be selected within the token permissions.', { fields: rejected.join(', ') })
  }
  let resolved = await registry.adapter(agent).resolveDefaults(merged)
  const cap = policy?.agents.find((rule) => rule.agent === agent)?.maxBudgetUsd
  if (resolved.agent === 'claude' && cap != null && body.config?.maxBudgetUsd === undefined) {
    resolved = { ...resolved, maxBudgetUsd: Math.min(resolved.maxBudgetUsd ?? cap, cap) }
  }
  assertTokenExecution(token, resolved)
  return { agent, config: resolved }
}

/**
 * Base configuration to which the override applies.
 *
 * Configurations do not merge: each level is complete, and the first matching
 * the requested CLI wins. Layering Claude settings onto Codex settings would
 * make no sense.
 */
function baseConfigFor(
  agent: AgentKind,
  token: ApiTokenRow,
  project: ProjectRow,
  defaults: AgentDefaults,
): AgentConfig {
  if (agent === token.agent) return JSON.parse(token.config) as AgentConfig

  return readProjectDefaults(project.defaultConfig)[agent] ?? defaults[agent]
}
