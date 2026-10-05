import { randomUUID } from 'node:crypto'
import { and, asc, count, eq, gt, isNull, ne } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import {
  agentRequests,
  cardNotes,
  cards,
  conversations,
  projects,
  worktrees,
  type AgentRequestRow,
  type ConversationRow,
  type ProjectRow,
} from '@sillage/db'
import {
  agentConfigSchema,
  agentKindSchema,
  defaultConfigFor,
  formatSessionMessage,
  readProjectDefaults,
  type AgentConfig,
  type AgentKind,
  type AgentModelDto,
} from '@sillage/protocol'
import type { AgentRegistry } from '../agents/registry.js'
import { createConversation } from '../conversations/create.js'
import type { AppContext } from '../http/context.js'
import { HttpError } from '../http/errors.js'
import { advanceCardOnLaunch, createCard } from '../http/routes/cards.js'
import { createWorktree } from '../http/routes/worktrees.js'
import { readUserSettings } from '../settings/user-settings.js'
import type { SessionManager } from './session-manager.js'

/**
 * Traite les demandes que les sessions adressent au daemon par le serveur MCP :
 * lancer une autre session, créer une carte, lire le catalogue des modèles.
 *
 * Le serveur MCP n'a que la base. Il dépose la demande et attend que ce balayage y
 * écrive le résultat ; plus court que celui du relais, parce qu'ici un agent est
 * suspendu à la réponse.
 *
 * Toutes les réponses sont du texte rédigé pour le modèle, en français comme le reste
 * des outils : c'est lui qui les lit, et une erreur doit lui dire quoi corriger.
 */

const POLL_MS = 500

/**
 * Au-delà, une demande n'est plus traitée : le serveur MCP qui l'attendait a rendu la
 * main depuis longtemps, et lancer une session dont personne n'a l'identifiant serait
 * pire que ne rien lancer.
 */
const STALE_MS = 5 * 60 * 1000

/**
 * Profondeur maximale d'une chaîne de lancements : l'utilisateur ouvre une session, qui
 * en lance une, qui peut en lancer une dernière. Au-delà, chaque étage s'éloigne d'une
 * personne qui regarde, et c'est ainsi qu'un essaim se forme sans que personne l'ait voulu.
 */
export const MAX_LAUNCH_DEPTH = 2

/** Lancements réussis par session et par heure. */
export const LAUNCHES_PER_HOUR = 6

/** Une mission plus longue tient dans un fichier que la mission cite. */
export const MAX_LAUNCH_PROMPT_CHARS = 20000

const HOUR_MS = 60 * 60 * 1000

/**
 * Remplace les `{param}` d'un message d'erreur HTTP : les erreurs des fonctions
 * partagées avec les routes sont écrites pour l'API, le modèle les lit telles quelles.
 */
function describeError(err: unknown): string {
  if (err instanceof HttpError) {
    return err.message.replace(/\{(\w+)\}/g, (_, key: string) => String(err.params?.[key] ?? key))
  }
  return err instanceof Error ? err.message : String(err)
}

class Refusal extends Error {}

interface StartSessionPayload {
  prompt?: unknown
  title?: unknown
  agent?: unknown
  model?: unknown
  effort?: unknown
  worktree?: unknown
  card?: unknown
}

export class AgentRequests {
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private logger: FastifyBaseLogger | null = null

  constructor(
    private readonly ctx: AppContext,
    private readonly sessions: SessionManager,
    private readonly registry: AgentRegistry,
  ) {}

  start(logger: FastifyBaseLogger): void {
    this.logger = logger
    this.timer = setInterval(() => void this.sweep(), POLL_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async sweep(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const pending = this.ctx.db
        .select()
        .from(agentRequests)
        .where(isNull(agentRequests.settledAt))
        .orderBy(asc(agentRequests.createdAt))
        .limit(20)
        .all()

      for (const request of pending) {
        if (request.createdAt < Date.now() - STALE_MS) {
          this.settle(request.id, "Demande expirée : Sillage ne l'a pas traitée à temps.", true)
          continue
        }
        await this.handle(request)
      }
    } finally {
      this.busy = false
    }
  }

  private async handle(request: AgentRequestRow): Promise<void> {
    try {
      const payload = JSON.parse(request.payload) as Record<string, unknown>
      const requester = this.ctx.db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.id, request.conversationId),
            eq(conversations.projectId, request.projectId),
          ),
        )
        .get()
      if (!requester) throw new Refusal("La session qui demande n'existe plus dans ce projet.")
      const project = this.ctx.db
        .select()
        .from(projects)
        .where(eq(projects.id, request.projectId))
        .get()
      if (!project) throw new Refusal("Le projet n'existe plus.")

      if (request.kind === 'start_session') {
        const { text, launchedId } = await this.startSession(request, requester, project, payload)
        this.settle(request.id, text, false, launchedId)
      } else if (request.kind === 'create_card') {
        this.settle(request.id, this.createCard(requester, payload), false)
      } else {
        this.settle(request.id, await this.listModels(requester, project, payload), false)
      }
    } catch (err) {
      if (!(err instanceof Refusal) && !(err instanceof HttpError)) {
        this.logger?.warn({ err, request: request.id, kind: request.kind }, 'demande d’agent en échec')
      }
      this.settle(request.id, describeError(err), true)
    }
  }

  private settle(id: string, result: string, isError: boolean, launchedId: string | null = null): void {
    this.ctx.db
      .update(agentRequests)
      .set({ settledAt: Date.now(), result, isError, launchedConversationId: launchedId })
      .where(eq(agentRequests.id, id))
      .run()
  }

  // --- start_session -------------------------------------------------------------

  private async startSession(
    request: AgentRequestRow,
    requester: ConversationRow,
    project: ProjectRow,
    payload: StartSessionPayload,
  ): Promise<{ text: string; launchedId: string }> {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : ''
    if (!prompt) throw new Refusal('Le paramètre `prompt` est requis : la mission de la nouvelle session.')
    if (prompt.length > MAX_LAUNCH_PROMPT_CHARS) {
      throw new Refusal(
        `Mission trop longue (${prompt.length} caractères, ${MAX_LAUNCH_PROMPT_CHARS} au plus). Mets le détail dans un fichier et cite-le.`,
      )
    }

    this.assertLaunchAllowed(requester, request.id)

    const agent = this.parseAgent(payload.agent, requester.agent)
    const config = await this.launchConfig(agent, project, requester.userId, payload)
    const worktreeId = await this.launchTree(requester, project, payload.worktree)
    const card = this.launchCard(project.id, payload.card)
    const title =
      typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim().slice(0, 200) : undefined

    const row = await createConversation(this.ctx.db, this.sessions, {
      projectId: project.id,
      userId: requester.userId,
      agent,
      config,
      worktreeId,
      cardId: card?.id ?? null,
      title,
      titleSource: prompt,
      origin: null,
      firstMessage: {
        clientMessageId: randomUUID(),
        text: formatSessionMessage({
          kind: 'launch',
          from: requester.id,
          title: requester.title,
          agent: requester.agent,
          messageId: request.id,
          body: prompt,
        }),
        attachments: [],
        mentions: [],
        skills: [],
      },
    })
    if (card) advanceCardOnLaunch(this.ctx, card.id)

    const tree = worktreeId
      ? (this.ctx.db.select({ name: worktrees.name }).from(worktrees).where(eq(worktrees.id, worktreeId)).get()
          ?.name ?? worktreeId)
      : null
    const lines = [
      `Session lancée : « ${row.title} », id ${row.id}.`,
      `CLI ${agent}, modèle ${describeModel(config)}, effort ${describeEffort(config)}.`,
      tree ? `Elle travaille dans le worktree « ${tree} ».` : 'Elle travaille à la racine du projet.',
      card ? `Rattachée à la carte #${card.number} « ${card.title} ».` : null,
      describePermissions(config),
      "L'utilisateur la voit dans Sillage. Pour être prévenu de sa fin : notify_when_done avec ce même id, puis termine ton tour si tu n'as rien d'autre à faire.",
    ]
    return { text: lines.filter(Boolean).join('\n'), launchedId: row.id }
  }

  /**
   * Garde-fous d'un lancement : profondeur de la chaîne et cadence.
   *
   * La chaîne se remonte par les demandes elles-mêmes, qui gardent la session née de
   * chacune : pas de colonne à ajouter aux conversations pour une question que seul ce
   * module pose.
   */
  private assertLaunchAllowed(requester: ConversationRow, requestId: string): void {
    let depth = 0
    let current = requester.id
    while (depth <= MAX_LAUNCH_DEPTH) {
      const parent = this.ctx.db
        .select({ from: agentRequests.conversationId })
        .from(agentRequests)
        .where(eq(agentRequests.launchedConversationId, current))
        .get()
      if (!parent) break
      depth += 1
      current = parent.from
    }
    if (depth >= MAX_LAUNCH_DEPTH) {
      throw new Refusal(
        `Refusé : cette session a elle-même été lancée par une session qui l'avait été (${depth} niveaux). Au-delà de ${MAX_LAUNCH_DEPTH}, plus de lancement en chaîne. Crée plutôt une carte avec create_card, ou propose à l'utilisateur de lancer la session lui-même.`,
      )
    }

    const [recent] = this.ctx.db
      .select({ total: count() })
      .from(agentRequests)
      .where(
        and(
          eq(agentRequests.conversationId, requester.id),
          eq(agentRequests.kind, 'start_session'),
          eq(agentRequests.isError, false),
          ne(agentRequests.id, requestId),
          gt(agentRequests.createdAt, Date.now() - HOUR_MS),
        ),
      )
      .all()
    if ((recent?.total ?? 0) >= LAUNCHES_PER_HOUR) {
      throw new Refusal(
        `Refusé : cette session a déjà lancé ${LAUNCHES_PER_HOUR} sessions dans l'heure. Crée des cartes avec create_card pour le reste, l'utilisateur les lancera.`,
      )
    }
  }

  private parseAgent(value: unknown, fallback: AgentKind): AgentKind {
    if (value === undefined || value === null || value === '') return fallback
    const parsed = agentKindSchema.safeParse(typeof value === 'string' ? value.toLowerCase() : value)
    if (!parsed.success) {
      throw new Refusal(`CLI inconnu « ${String(value)} ». Valeurs possibles : ${agentKindSchema.options.join(', ')}.`)
    }
    return parsed.data
  }

  /**
   * La configuration d'une session lancée : celle que l'interface proposerait pour ce
   * CLI dans ce projet, préréglage du projet puis défauts du compte, avec le modèle et
   * l'effort demandés par-dessus.
   *
   * Rien d'autre n'est réglable par l'agent, et surtout pas les permissions : une
   * session lancée par une autre n'a pas plus de latitude que celle que l'utilisateur
   * aurait ouverte d'un clic.
   */
  private async launchConfig(
    agent: AgentKind,
    project: ProjectRow,
    userId: string,
    payload: StartSessionPayload,
  ): Promise<AgentConfig> {
    const base =
      readProjectDefaults(project.defaultConfig)[agent] ??
      readUserSettings(this.ctx.db, userId).agentDefaults[agent] ??
      defaultConfigFor(agent)

    const requestedModel = typeof payload.model === 'string' ? payload.model.trim() : ''
    const requestedEffort = typeof payload.effort === 'string' ? payload.effort.trim().toLowerCase() : ''
    if (!requestedModel && !requestedEffort) {
      return this.registry.adapter(agent).resolveDefaults(base)
    }

    const catalog = await this.registry
      .adapter(agent)
      .models()
      .then((listing) => listing.models)
      .catch((): AgentModelDto[] => [])

    let config: AgentConfig = { ...base }
    if (requestedModel) {
      const model = matchModel(catalog, requestedModel)
      if (!model && catalog.length > 0) {
        throw new Refusal(
          `Modèle « ${requestedModel} » inconnu pour ${agent}. Disponibles : ${catalog.map(nameModel).join(', ')}.`,
        )
      }
      config = { ...config, model: model?.value ?? requestedModel }
    }

    // Le modèle effectif, une fois les défauts résolus : c'est lui qui dit quels
    // niveaux d'effort existent.
    config = await this.registry.adapter(agent).resolveDefaults(config)

    const model = catalog.find((entry) => entry.value === config.model) ?? catalog.find((entry) => entry.isDefault)
    const efforts = model?.efforts.map((entry) => entry.value) ?? []
    const current = config.agent === 'claude' ? config.effort : config.reasoningEffort
    if (!requestedEffort && model?.defaultEffort && efforts.length > 0 && !efforts.includes(current)) {
      // Le modèle demandé ne connaît pas l'effort des défauts : son propre défaut, comme
      // le fait le sélecteur de l'interface, plutôt qu'un lancement qui échouerait.
      config = withEffort(config, model.defaultEffort)
    }

    if (requestedEffort) {
      const effort = matchEffort(efforts, requestedEffort)
      if (!effort) {
        throw new Refusal(
          efforts.length === 0
            ? `Le modèle ${config.model} ne règle pas d'effort : omets le paramètre \`effort\`.`
            : `Effort « ${requestedEffort} » inconnu pour ${config.model}. Niveaux : ${efforts.join(', ')}.`,
        )
      }
      config = withEffort(config, effort)
    }

    const parsed = agentConfigSchema.safeParse(config)
    if (!parsed.success) throw new Refusal(`Configuration refusée : ${parsed.error.issues[0]?.message ?? 'invalide'}.`)
    return parsed.data
  }

  /**
   * Où travaille la session lancée.
   *
   * Par défaut dans le même arbre que celle qui lance : c'est ce qu'on attend pour
   * « continue ça dans une autre session ». Un bug sans rapport mérite souvent son
   * worktree, que l'agent nomme ; `@root` désigne la racine du projet.
   */
  private async launchTree(
    requester: ConversationRow,
    project: ProjectRow,
    value: unknown,
  ): Promise<string | null> {
    if (value === undefined || value === null || value === '') return requester.worktreeId
    if (typeof value !== 'string') throw new Refusal('Le paramètre `worktree` doit être une chaîne.')
    const name = value.trim()
    if (name === '@root') return null

    const existing = this.ctx.db
      .select({ id: worktrees.id })
      .from(worktrees)
      .where(and(eq(worktrees.projectId, project.id), eq(worktrees.name, name), isNull(worktrees.removedAt)))
      .get()
    if (existing) return existing.id

    if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.split('/').includes('..') || name.startsWith('/') || name.endsWith('/')) {
      throw new Refusal(`Nom de worktree invalide « ${name} » : lettres, chiffres, . _ - / seulement, comme une branche git.`)
    }
    const row = await createWorktree(this.ctx, project, requester.userId, name, 'HEAD')
    return row.id
  }

  private launchCard(projectId: string, value: unknown): { id: string; number: number; title: string } | null {
    if (value === undefined || value === null || value === '') return null
    const number = typeof value === 'number' ? value : Number(String(value).replace(/^#/, ''))
    if (!Number.isInteger(number)) throw new Refusal('Le paramètre `card` est le numéro de la carte, par exemple 12.')
    const card = this.ctx.db
      .select({ id: cards.id, number: cards.number, title: cards.title })
      .from(cards)
      .where(and(eq(cards.projectId, projectId), eq(cards.number, number)))
      .get()
    if (!card) throw new Refusal(`Aucune carte #${number} dans ce projet. list_cards les montre.`)
    return card
  }

  // --- create_card ---------------------------------------------------------------

  /**
   * Toujours en « à faire » : une carte ouverte par un agent est une proposition, pas
   * un travail engagé. Elle avance quand une session la prend, comme toute autre.
   */
  private createCard(requester: ConversationRow, payload: Record<string, unknown>): string {
    const title = typeof payload.title === 'string' ? payload.title.trim() : ''
    const description = typeof payload.description === 'string' ? payload.description.trim() : ''
    if (!title) throw new Refusal('Le paramètre `title` est requis.')
    if (title.length > 200) throw new Refusal('Titre trop long (200 caractères au plus).')
    if (description.length > 20000) throw new Refusal('Description trop longue (20 000 caractères au plus).')

    const card = createCard(this.ctx.db, requester.projectId, requester.userId, {
      title,
      description,
      column: 'todo',
    })
    // La provenance se lit dans le fil de la carte, avec un lien vers la session : la
    // description reste celle que l'agent a rédigée, et la personne qui la reprendra
    // sait d'où elle vient.
    this.ctx.db
      .insert(cardNotes)
      .values({
        id: randomUUID(),
        cardId: card.id,
        conversationId: requester.id,
        userId: null,
        body: 'Carte ouverte depuis cette session.',
        createdAt: Date.now(),
      })
      .run()

    return `Carte #${card.number} « ${card.title} » créée dans « à faire ». Pour la faire traiter tout de suite : start_session avec card=${card.number}.`
  }

  // --- list_models ---------------------------------------------------------------

  private async listModels(
    requester: ConversationRow,
    project: ProjectRow,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const agents: AgentKind[] =
      payload.agent === undefined || payload.agent === null || payload.agent === ''
        ? [...agentKindSchema.options]
        : [this.parseAgent(payload.agent, requester.agent)]

    const sections: string[] = []
    for (const agent of agents) {
      const defaults = await this.launchConfig(agent, project, requester.userId, {}).catch(() => null)
      const models = await this.registry
        .adapter(agent)
        .models()
        .then((listing) => listing.models)
        .catch(() => null)
      const head = defaults
        ? `## ${agent} — par défaut : modèle ${describeModel(defaults)}, effort ${describeEffort(defaults)}`
        : `## ${agent}`
      if (!models) {
        sections.push(`${head}\nCatalogue injoignable : le CLI n'est peut-être pas installé.`)
        continue
      }
      const lines = models.map((model) => {
        const efforts = model.efforts.map((entry) => entry.value)
        return `- \`${model.value}\` (${model.displayName})${model.isDefault ? ' [défaut du CLI]' : ''}${efforts.length > 0 ? ` — efforts : ${efforts.join(', ')}` : ''}`
      })
      sections.push([head, ...lines].join('\n'))
    }
    return `${sections.join('\n\n')}\n\nDans start_session, \`model\` accepte la valeur ou le nom affiché, et \`effort: "max"\` prend le plus haut niveau quand le modèle n'en a pas de ce nom.`
  }
}

function nameModel(model: AgentModelDto): string {
  return model.displayName && model.displayName !== model.value ? `${model.value} (${model.displayName})` : model.value
}

/**
 * Trouve le modèle que l'agent désigne, souvent du nom qu'a dit l'utilisateur
 * (« Astra », « opus ») plutôt que de son identifiant exact.
 */
export function matchModel(catalog: AgentModelDto[], wanted: string): AgentModelDto | null {
  const needle = wanted.toLowerCase()
  const exact = catalog.find((model) => model.value.toLowerCase() === needle)
  if (exact) return exact
  const named = catalog.find((model) => model.displayName.toLowerCase() === needle)
  if (named) return named
  const partial = catalog.filter(
    (model) => model.value.toLowerCase().includes(needle) || model.displayName.toLowerCase().includes(needle),
  )
  // Un seul candidat, ou rien : deviner entre deux modèles serait choisir à la place
  // de l'utilisateur.
  return partial.length === 1 ? (partial[0] ?? null) : null
}

/**
 * `max` vaut le niveau de ce nom s'il existe (Codex en propose un, sous `ultra`), et
 * sinon le plus haut du modèle : l'utilisateur dit « effort max » sans savoir qu'un
 * modèle donné s'arrête à `xhigh`. Les catalogues listent les niveaux du plus bas au
 * plus haut.
 */
export function matchEffort(efforts: string[], wanted: string): string | null {
  if (efforts.includes(wanted)) return wanted
  if (wanted === 'max' || wanted === 'maximum') return efforts.at(-1) ?? null
  if (wanted === 'min' || wanted === 'minimum') return efforts[0] ?? null
  return null
}

function withEffort(config: AgentConfig, effort: string): AgentConfig {
  // Le schéma refuse plus bas un niveau que Claude ne connaît pas : le transtypage ne
  // sert qu'à passer la chaîne jusque-là.
  return config.agent === 'claude'
    ? { ...config, effort: effort as typeof config.effort }
    : { ...config, reasoningEffort: effort }
}

function describeModel(config: AgentConfig): string {
  return config.model || 'celui du CLI'
}

function describeEffort(config: AgentConfig): string {
  const effort = config.agent === 'claude' ? config.effort : config.reasoningEffort
  return effort || 'celui du CLI'
}

function describePermissions(config: AgentConfig): string | null {
  if (config.agent === 'claude' && config.permissionMode === 'manual') {
    return "Ses permissions sont en mode manuel, comme les défauts du projet : elle s'arrêtera pour demander à l'utilisateur avant d'agir."
  }
  if (config.agent === 'codex' && config.askForApproval !== 'never' && config.askForApproval !== '') {
    return "Elle demandera l'approbation de l'utilisateur pour ce qui sort de son bac à sable, comme le veulent les défauts du projet."
  }
  return null
}
