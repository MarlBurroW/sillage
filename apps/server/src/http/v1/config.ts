import type { ApiTokenRow, ProjectRow } from '@sillage/db'
import {
  defaultConfigFor,
  mergeAgentConfig,
  type AgentConfig,
  type AgentKind,
  type CreateTaskBody,
} from '@sillage/protocol'
import type { AgentRegistry } from '../../agents/registry.js'
import { badRequest } from '../errors.js'

/**
 * Avec quoi une tâche va tourner.
 *
 * Quatre niveaux, du plus précis au plus général : ce que la requête dit, les réglages
 * du jeton, ceux du projet, puis les défauts du CLI. Un appelant machine n'a ainsi
 * qu'un prompt à fournir, et le choix du modèle a été fait une fois, dans un
 * formulaire, par quelqu'un qui savait ce qu'il faisait.
 */
export async function resolveTaskConfig(
  registry: AgentRegistry,
  token: ApiTokenRow,
  project: ProjectRow,
  body: CreateTaskBody,
): Promise<{ agent: AgentKind; config: AgentConfig }> {
  const agent = body.agent ?? token.agent
  const base = baseConfigFor(agent, token, project)

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

  return { agent, config: await registry.adapter(agent).resolveDefaults(merged) }
}

/**
 * Le socle sur lequel la surcharge s'applique.
 *
 * Les configurations ne se fusionnent pas entre elles : chaque niveau est complet, et
 * le premier qui parle du bon CLI l'emporte. Empiler un réglage Claude sur un réglage
 * Codex ne voudrait rien dire.
 */
function baseConfigFor(agent: AgentKind, token: ApiTokenRow, project: ProjectRow): AgentConfig {
  if (agent === token.agent) return JSON.parse(token.config) as AgentConfig

  if (project.defaultConfig) {
    const preset = JSON.parse(project.defaultConfig) as AgentConfig
    if (preset.agent === agent) return preset
  }
  return defaultConfigFor(agent)
}

/**
 * Un modèle inventé doit se voir dire ce qui existe.
 *
 * Seule la valeur explicitement demandée est vérifiée : contrôler aussi celle du jeton
 * ferait échouer une tâche pour une configuration choisie dans l'interface, et
 * dépendre du CLI à chaque lancement. Si le catalogue est injoignable, on laisse
 * passer, comme le fait `resolveDefaults` avec ses sentinelles.
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
