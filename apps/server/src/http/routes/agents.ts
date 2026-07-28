import type { FastifyInstance } from 'fastify'
import { TESTED_CLI_RELEASES } from '@sillage/protocol'
import type { CliInstaller } from '../../agents/cli-install.js'
import type { AgentAdapter, AgentRegistry } from '../../agents/registry.js'
import { HttpError } from '../errors.js'
import { requireUser } from '../require-user.js'

export function registerAgentRoutes(
  app: FastifyInstance,
  registry: AgentRegistry,
  installer: CliInstaller,
): void {
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
    const agents = await Promise.all(
      registry.all().map(async (adapter) => ({
        ...(await adapter.cli.describe(force)),
        testedVersion: TESTED_CLI_RELEASES[adapter.kind].version,
        install: installer.state(adapter.kind),
      })),
    )
    return { agents }
  })

  /**
   * Installe la version testée d'un CLI dans le préfixe que Sillage gère.
   *
   * Répond avant la fin : le paquet pèse plusieurs centaines de mégaoctets, et attendre
   * dans la requête la ferait dépendre de la patience d'un proxy. L'avancement se lit
   * sur `GET /api/agents`.
   */
  app.post('/api/agents/:agent/install', async (request, reply) => {
    requireUser(request)
    const adapter = resolveAdapter(request.params)

    if (!installer.start(adapter.kind)) {
      throw new HttpError(
        409,
        'install_in_progress',
        `Une installation de ${adapter.label} est déjà en cours.`,
      )
    }
    return reply.status(202).send(installer.state(adapter.kind))
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
