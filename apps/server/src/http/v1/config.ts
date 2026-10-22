import type { ApiTokenRow, ProjectRow } from '@sillage/db'
import {
  isPermissiveConfig,
  mergeAgentConfig,
  readProjectDefaults,
  type AgentConfig,
  type AgentDefaults,
  type AgentKind,
  type CreateTaskBody,
} from '@sillage/protocol'
import type { AgentRegistry } from '../../agents/registry.js'
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
): Promise<{ agent: AgentKind; config: AgentConfig }> {
  const agent = body.agent ?? token.agent
  const base = baseConfigFor(agent, token, project, defaults)

  let merged: AgentConfig
  let rejected: string[]
  try {
    ;({ config: merged, rejected } = mergeAgentConfig(base, body.config))
  } catch {
    throw badRequest(
      'config_invalid',
      'The configuration override is not valid for {agent}. See GET /api/v1/agents.',
      { agent },
    )
  }

  if (rejected.length > 0) {
    throw badRequest(
      'config_field_locked',
      'These settings are fixed by the token and cannot be set per task: {fields}.',
      { fields: rejected.join(', ') },
    )
  }

  if (typeof body.config?.model === 'string' && body.config.model.length > 0) {
    await assertModelExists(registry, agent, body.config.model)
  }

  // Check the resolved configuration rather than the token configuration: the base
  // can also come from the project preset when the task targets the other CLI,
  // and that path must not bypass the scope check.
  const scopes = JSON.parse(token.scopes) as string[]
  if (isPermissiveConfig(merged) && !scopes.includes('tasks:autonomous')) {
    throw badRequest(
      'config_requires_autonomous',
      'A configuration without guardrails requires the tasks:autonomous scope.',
    )
  }

  return { agent, config: await registry.adapter(agent).resolveDefaults(merged) }
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

/**
 * Reject an unknown requested model with the list of available models.
 *
 * Only explicitly requested values are checked: validating the token's settings
 * would reject tasks configured through the interface and require the CLI on
 * every launch. If the catalog is unreachable, allow the request, matching
 * `resolveDefaults` and its sentinel values.
 */
async function assertModelExists(
  registry: AgentRegistry,
  agent: AgentKind,
  model: string,
): Promise<void> {
  let known: string[]
  try {
    const catalog = await registry.adapter(agent).models()
    known = catalog.models.map((entry) => entry.value)
  } catch {
    return
  }

  if (known.length > 0 && !known.includes(model)) {
    throw badRequest('model_unknown', 'Unknown model {model} for {agent}. Known: {known}.', {
      model,
      agent,
      known: known.join(', '),
    })
  }
}
