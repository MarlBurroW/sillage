import type { ApiTokenRow } from '@sillage/db'
import { EFFORT_FIELD, isPermissiveConfig, type AgentConfig, type AgentKind, type AgentModelDto, type ApiExecutionPolicy } from '@sillage/protocol'
import { readExecutionPolicy } from '../../auth/api-tokens.js'
import { forbidden } from '../errors.js'

export function assertAgentAllowed(policy: ApiExecutionPolicy | null, agent: AgentKind): void {
  if (policy && !policy.agents.some((rule) => rule.agent === agent)) {
    throw forbidden('token_agent_denied', 'CLI {agent} is not allowed by this token.', { agent })
  }
}

/** Check effective values, including inherited defaults and aliases resolved by the CLI. */
export function assertExecutionAllowed(policy: ApiExecutionPolicy | null, config: AgentConfig, checkBudget = true): void {
  assertAgentAllowed(policy, config.agent)
  const rule = policy?.agents.find((entry) => entry.agent === config.agent)
  if (!rule) return
  if (rule.models && !rule.models.includes(config.model)) {
    throw forbidden('token_model_denied', 'Model {model} is not allowed by this token. Allowed: {allowed}.', {
      model: config.model || '(CLI default)', allowed: rule.models.join(', '),
    })
  }
  const effort = (config as unknown as Record<string, unknown>)[EFFORT_FIELD[config.agent]]
  if (rule.efforts && !rule.efforts.includes(String(effort))) {
    throw forbidden('token_effort_denied', 'Effort {effort} is not allowed by this token. Allowed: {allowed}.', {
      effort: String(effort || '(CLI default)'), allowed: rule.efforts.join(', '),
    })
  }
  if (checkBudget && config.agent === 'claude' && rule.maxBudgetUsd !== null &&
    (config.maxBudgetUsd === null || config.maxBudgetUsd > rule.maxBudgetUsd)) {
    throw forbidden('token_budget_denied', 'This token allows a budget of at most {budget} USD per session.', { budget: rule.maxBudgetUsd })
  }
}

export function assertTokenExecution(token: ApiTokenRow, config: AgentConfig): void {
  assertExecutionAllowed(readExecutionPolicy(token), config)
  if (isPermissiveConfig(config) && !(JSON.parse(token.scopes) as string[]).includes('tasks:autonomous')) {
    throw forbidden('config_requires_autonomous', 'A configuration without guardrails requires the tasks:autonomous scope.')
  }
}

/** Discovery is a view of the same policy enforced during launches. */
export function allowedModels(policy: ApiExecutionPolicy | null, agent: AgentKind, models: AgentModelDto[]): AgentModelDto[] {
  const rule = policy?.agents.find((entry) => entry.agent === agent)
  if (policy && !rule) return []
  return models.filter((model) => !rule?.models || rule.models.includes(model.value))
    .map((model) => ({ ...model, efforts: model.efforts.filter((effort) => !rule?.efforts || rule.efforts.includes(effort.value)) }))
}
