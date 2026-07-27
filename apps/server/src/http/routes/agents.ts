import type { FastifyInstance } from 'fastify'
import type {
  ClaudeAccountDto,
  ClaudeModelDto,
  CodexMode,
  CodexModeDto,
  CodexModelDto,
} from '@sillage/protocol'
import type { CollaborationModeMask } from '@sillage/protocol/codex/v2'
import type { AgentCatalogs } from '../../agents/catalogs.js'
import { HttpError } from '../errors.js'
import { requireUser } from '../require-user.js'

/** Les deux CLI échouent de la même façon : absent, non authentifié, ou trop lent. */
function unavailable(cli: string, err: unknown): HttpError {
  return new HttpError(
    502,
    'model_list_unavailable',
    `Impossible de lire les modèles depuis ${cli} : ${err instanceof Error ? err.message : String(err)}`,
  )
}

export function registerAgentRoutes(app: FastifyInstance, catalogs: AgentCatalogs): void {
  const { claude, codex } = catalogs

  /**
   * Consommation du compte. Lue à la demande plutôt que poussée : chaque lecture
   * démarre un process CLI, et la valeur n'intéresse que le moment où on l'ouvre.
   * `?refresh=1` court-circuite le cache, pour le bouton de rafraîchissement.
   */
  app.get('/api/agents/:agent/usage', async (request) => {
    requireUser(request)
    const { agent } = request.params as { agent: string }
    const force = (request.query as { refresh?: string }).refresh === '1'

    if (agent !== 'claude' && agent !== 'codex') {
      throw new HttpError(404, 'unknown_agent', `CLI inconnu : ${agent}`)
    }

    try {
      return agent === 'claude'
        ? await catalogs.claudeUsage.read(force)
        : await catalogs.codexUsage.read(force)
    } catch (err) {
      throw new HttpError(
        502,
        'usage_unavailable',
        `Impossible de lire la consommation depuis ${agent === 'claude' ? 'Claude Code' : 'Codex'} : ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  })

  app.get('/api/agents/claude/models', async (request) => {
    requireUser(request)

    let listing
    try {
      listing = await claude.list()
    } catch (err) {
      // Renvoyer une liste en dur mentirait sur ce qui est réellement disponible.
      throw unavailable('Claude Code', err)
    }

    const models: ClaudeModelDto[] = listing.models.map((model) => ({
      value: model.value,
      resolvedModel: model.resolvedModel ?? null,
      displayName: model.displayName,
      description: model.description,
      supportedEffortLevels: model.supportedEffortLevels ?? [],
    }))

    const account: ClaudeAccountDto | null = listing.account
      ? {
          subscriptionType: listing.account.subscriptionType ?? null,
          organization: listing.account.organization ?? null,
          billedBySubscription: Boolean(listing.account.subscriptionType),
        }
      : null

    return { models, account, fetchedAt: listing.fetchedAt }
  })

  app.get('/api/agents/codex/models', async (request) => {
    requireUser(request)

    let listing
    try {
      listing = await codex.list()
    } catch (err) {
      throw unavailable('Codex', err)
    }

    const models: CodexModelDto[] = listing.models.map((model) => ({
      id: model.id,
      model: model.model,
      displayName: model.displayName,
      description: model.description,
      supportedReasoningEfforts: model.supportedReasoningEfforts.map((effort) => ({
        value: effort.reasoningEffort,
        description: effort.description,
      })),
      defaultReasoningEffort: model.defaultReasoningEffort,
      isDefault: model.isDefault,
    }))

    // `mode` est nullable côté protocole : un préréglage qui ne désigne aucun mode ne
    // peut pas être proposé comme choix, il est écarté plutôt que rendu inerte.
    const modes: CodexModeDto[] = listing.modes
      .filter((mask): mask is CollaborationModeMask & { mode: CodexMode } => mask.mode !== null)
      .map((mask) => ({ mode: mask.mode, label: mask.name }))

    return { models, modes, fetchedAt: listing.fetchedAt }
  })
}
