import type { FastifyInstance } from 'fastify'
import type { AgentAdapter, AgentRegistry } from '../../agents/registry.js'
import { HttpError } from '../errors.js'
import { requireUser } from '../require-user.js'

export function registerAgentRoutes(app: FastifyInstance, registry: AgentRegistry): void {
  /** Le nom du CLI vient de l'URL : un inconnu vaut 404, pas un défaut silencieux. */
  const resolveAdapter = (params: unknown): AgentAdapter => {
    const { agent } = params as { agent: string }
    const adapter = registry.find(agent)
    if (!adapter) throw new HttpError(404, 'unknown_agent', `CLI inconnu : ${agent}`)
    return adapter
  }

  /**
   * Présence et version des CLI, tous agents confondus.
   *
   * Sillage ne transporte plus les binaires : ils viennent du système, donc l'écran doit
   * pouvoir dire lequel manque et pourquoi plutôt que de proposer un agent que le serveur
   * échouerait à lancer. `?refresh=1` force la sonde, pour le bouton de rafraîchissement
   * après une installation faite à côté.
   */
  app.get('/api/agents', async (request) => {
    requireUser(request)
    const force = (request.query as { refresh?: string }).refresh === '1'

    // En parallèle : chaque sonde absente coûte une résolution de PATH, chaque sonde
    // présente un lancement de process, et les faire à la queue leu leu ferait attendre
    // l'écran pour rien.
    return { agents: await Promise.all(registry.all().map((a) => a.cli.describe(force))) }
  })

  /**
   * Consommation du compte. Lue à la demande plutôt que poussée : chaque lecture
   * démarre un process CLI, et la valeur n'intéresse que le moment où on l'ouvre.
   * `?refresh=1` court-circuite le cache, pour le bouton de rafraîchissement.
   */
  app.get('/api/agents/:agent/usage', async (request) => {
    requireUser(request)
    const adapter = resolveAdapter(request.params)
    const force = (request.query as { refresh?: string }).refresh === '1'

    try {
      return await adapter.usage(force)
    } catch (err) {
      throw new HttpError(
        502,
        'usage_unavailable',
        `Impossible de lire la consommation depuis ${adapter.label} : ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  })

  app.get('/api/agents/:agent/models', async (request) => {
    requireUser(request)
    const adapter = resolveAdapter(request.params)

    try {
      return await adapter.models()
    } catch (err) {
      // Renvoyer une liste en dur mentirait sur ce qui est réellement disponible.
      // Absent, non authentifié ou trop lent : le CLI échoue toujours de la même façon.
      throw new HttpError(
        502,
        'model_list_unavailable',
        `Impossible de lire les modèles depuis ${adapter.label} : ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  })
}
