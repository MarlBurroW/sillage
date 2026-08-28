import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { agentKindSchema, PREFERRED_CLI_RELEASES, type ProjectCommandsDto } from '@sillage/protocol'
import type { CliInstaller } from '../../agents/cli-install.js'
import type { AgentAdapter, AgentRegistry } from '../../agents/registry.js'
import { projectCwd } from '../../workspace.js'
import type { AppContext } from '../context.js'
import { HttpError } from '../errors.js'
import { requireUser } from '../require-user.js'

const commandsQuerySchema = z.object({
  agent: agentKindSchema,
  worktreeId: z.string().optional(),
  refresh: z.string().optional(),
})

/**
 * Une sonde CLI qui échoue vaut 502, jamais une liste vide : renvoyer un catalogue
 * en dur ou un tableau nu mentirait sur ce qui est réellement disponible. Absent, non
 * authentifié ou trop lent, le CLI échoue toujours de la même façon.
 */
function cliUnavailable(
  adapter: AgentAdapter,
  code: string,
  message: string,
  err: unknown,
): HttpError {
  return new HttpError(502, code, message, {
    label: adapter.label,
    error: err instanceof Error ? err.message : String(err),
  })
}

export function registerAgentRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  registry: AgentRegistry,
  installer: CliInstaller,
): void {
  /** Le nom du CLI vient de la requête : un inconnu vaut 404, pas un défaut silencieux. */
  const resolveAdapter = (agent: string): AgentAdapter => {
    const adapter = registry.find(agent)
    if (!adapter) throw new HttpError(404, 'unknown_agent', 'Unknown CLI: {agent}.', { agent })
    return adapter
  }
  const paramsAgent = (params: unknown) => (params as { agent: string }).agent

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
        preferredVersion: PREFERRED_CLI_RELEASES[adapter.kind].version,
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
    const adapter = resolveAdapter(paramsAgent(request.params))

    if (!installer.start(adapter.kind)) {
      throw new HttpError(
        409,
        'install_in_progress',
        'An installation of {label} is already in progress.',
        { label: adapter.label },
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
    const adapter = resolveAdapter(paramsAgent(request.params))
    const force = (request.query as { refresh?: string }).refresh === '1'

    try {
      return await adapter.usage(force)
    } catch (err) {
      throw cliUnavailable(
        adapter,
        'usage_unavailable',
        'Could not read usage from {label}: {error}.',
        err,
      )
    }
  })

  app.get('/api/agents/:agent/models', async (request) => {
    requireUser(request)
    const adapter = resolveAdapter(paramsAgent(request.params))

    try {
      return await adapter.models()
    } catch (err) {
      throw cliUnavailable(
        adapter,
        'model_list_unavailable',
        'Could not read models from {label}: {error}.',
        err,
      )
    }
  })

  /**
   * Commandes en `/` proposables depuis le brouillon d'une conversation.
   *
   * Le fil reçoit sa liste du runner au premier tour ; avant ce tour il n'y a ni session
   * ni journal, seulement un dossier et un CLI choisi. Portée par le projet comme
   * `/files`, et lue dans le même dossier que lui : les commandes de projet vivent dans
   * l'arbre. `?refresh=1` court-circuite le cache, comme pour `/usage`.
   */
  app.get('/api/projects/:id/commands', async (request): Promise<ProjectCommandsDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const { agent, worktreeId, refresh } = commandsQuerySchema.parse(request.query)
    const cwd = projectCwd(ctx.db, id, user.id, worktreeId)
    const adapter = resolveAdapter(agent)

    try {
      return await adapter.commands(cwd, refresh === '1')
    } catch (err) {
      throw cliUnavailable(
        adapter,
        'command_list_unavailable',
        'Could not read commands from {label}: {error}.',
        err,
      )
    }
  })
}
