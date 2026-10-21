import { randomUUID } from 'node:crypto'
import { Cron } from 'croner'
import { and, asc, count, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import {
  agentRequests,
  cardNotes,
  conversationPaths,
  cards,
  conversations,
  projects,
  scheduledTasks,
  users,
  worktrees,
  type AgentRequestRow,
  type ConversationRow,
  type ProjectRow,
} from '@sillage/db'
import {
  DEFAULT_CHECK_TIMEOUT_SECONDS,
  DEFAULT_SCHEDULE_DURATION_MINUTES,
  MAX_CHECK_SCRIPT_CHARS,
  MAX_CHECK_TIMEOUT_SECONDS,
  MIN_CHECK_TIMEOUT_SECONDS,
  checkScriptSchema,
  checkTimeoutSchema,
  MAX_SCHEDULE_DURATION_MINUTES,
  MAX_SCHEDULE_NAME_CHARS,
  MAX_SCHEDULE_PROMPT_CHARS,
  MIN_SCHEDULE_DURATION_MINUTES,
  AUTOMATION_TEMPLATES,
  agentConfigSchema,
  automationConditionsSchema,
  taskReplyBodySchema,
  createProjectActionBodySchema,
  updateProjectActionBodySchema,
  updateCardBodySchema,
  createCardRelationBodySchema,
  agentKindSchema,
  defaultConfigFor,
  formatSessionMessage,
  readProjectDefaults,
  scheduleCadenceSchema,
  type ScheduleCadence,
  type AgentConfig,
  type AgentKind,
  type AgentModelDto,
  type DeliveryReason,
  type ProjectActionRunResult,
  type WebhookSettings,
  type WebhookVerification,
} from '@sillage/protocol'
import type { ZodError } from 'zod'
import {
  createAction,
  deleteAction,
  loadAction,
  updateAction,
  type ActionRunner,
} from '../actions/actions.js'
import type { AgentRegistry } from '../agents/registry.js'
import type { EventLog } from '../events/event-log.js'
import { createWebhook, readSettings, revealSecret, webhookUrl } from '../automations/webhooks.js'
import { createConversation } from '../conversations/create.js'
import type { AppContext } from '../http/context.js'
import { HttpError } from '../http/errors.js'
import { advanceCardOnLaunch, createCard, updateCard } from '../http/routes/cards.js'
import { linkCards, unlinkCards } from '../board/card-relations.js'
import type { BoardSync } from '../board/board-sync.js'
import { DecisionRefusal, type DecisionService } from '../decisions/service.js'
import { createWorktree } from '../http/routes/worktrees.js'
import { defaultBase } from '../worktrees/assess.js'
import type { WorktreeStatusService } from '../worktrees/status-service.js'
import { createScheduledTask } from '../scheduler/tasks.js'
import { readUserSettings } from '../settings/user-settings.js'
import { resolveConversationCwd } from '../workspace.js'
import type { SessionManager } from './session-manager.js'

/**
 * Traite les demandes que les sessions adressent au daemon par le serveur MCP :
 * lancer une autre session, créer une carte, planifier une tâche, lire le catalogue des
 * modèles.
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
 * Cadence la plus serrée qu'un agent peut poser. L'interface descend plus bas, mais là
 * une personne a choisi : une tâche à la minute créée sur un malentendu brûlerait un
 * quota entier avant que quiconque la voie.
 */
export const MIN_AGENT_SCHEDULE_MINUTES = 15

/** Tâches par projet au-delà desquelles un agent n'en ajoute plus. */
export const MAX_AGENT_SCHEDULES_PER_PROJECT = 20

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

/** Doit rester d'accord avec `createWorktreeBodySchema` du protocole : le nom sert aussi de dossier. */
function assertWorktreeName(name: string): void {
  if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.split('/').includes('..') || name.startsWith('/') || name.endsWith('/')) {
    throw new Refusal(`Nom de worktree invalide « ${name} » : lettres, chiffres, . _ - / seulement, comme une branche git.`)
  }
}

/** L'état d'un arbre dit à un agent, avec ce qu'il implique pour lui. */
const WORKTREE_STATE_WORDS = {
  missing: 'introuvable (dossier disparu)',
  dirty: 'non commité',
  unmerged: 'commité, à fusionner',
  merged: 'fusionné, rien à garder (à nettoyer)',
} as const

/**
 * Qui demande : une session, ou un compte sans session.
 *
 * Le second cas est celui d'un CLI local branché sur toute l'instance par le serveur
 * MCP en mode global (`docs/mcp.md`) : la demande porte un `user_id` et pas de
 * conversation. Il a l'`id` vide, pas de worktree ni de tâche d'origine, et tout ce qui
 * tient à une session (chaîne de lancements, note de provenance, décision) ne s'y
 * applique pas. Un `Pick` et non la ligne entière, pour que le type dise ce que les
 * traitements lisent vraiment.
 */
type Requester = Pick<ConversationRow, 'id' | 'projectId' | 'userId' | 'agent' | 'worktreeId' | 'scheduleId' | 'title'>

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
    /** Absent des tests qui n'en ont pas l'usage : `run_action` y est alors refusé. */
    private readonly actions?: ActionRunner,
    /** Clé des secrets de signature des webhooks ; sans elle, `create_automation` est refusé. */
    private readonly encryptionKey?: Buffer,
    /** Board relié à GitHub ; sans lui, `create_card` reste local. */
    private readonly board?: BoardSync,
    /** Décisions des sessions autonomes ; sans lui, `request_decision` est refusé. */
    private readonly decisions?: DecisionService,
    /** Journal, pour retrouver la sollicitation ouverte que `reply_session` résout. */
    private readonly log?: EventLog,
    /** Avancement des worktrees ; sans lui, `list_worktrees` est refusé. */
    private readonly worktreeStatus?: WorktreeStatusService,
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
      const conversation = request.conversationId
        ? this.ctx.db
            .select()
            .from(conversations)
            .where(
              and(
                eq(conversations.id, request.conversationId),
                eq(conversations.projectId, request.projectId),
              ),
            )
            .get()
        : null
      if (request.conversationId && !conversation) throw new Refusal("La session qui demande n'existe plus dans ce projet.")
      const requester: Requester = conversation ?? this.principal(request)
      const project = this.ctx.db
        .select()
        .from(projects)
        .where(eq(projects.id, request.projectId))
        .get()
      if (!project) throw new Refusal("Le projet n'existe plus.")

      if (request.kind === 'start_session') {
        const { text, launchedId } = await this.startSession(request, requester, project, payload)
        this.settle(request.id, text, false, launchedId)
      } else if (request.kind === 'schedule_task') {
        this.settle(request.id, await this.scheduleTask(requester, project, payload), false)
      } else if (request.kind === 'request_decision' || request.kind === 'withdraw_decision') {
        // Une décision est posée au nom d'une session autonome : sans session, personne.
        if (!conversation) throw new Refusal("Cet outil ne sert qu'aux sessions autonomes : hors session, il n'y a pas de décision à demander.")
        this.settle(request.id, await this.decide(request.kind, conversation, payload), false)
      } else if (request.kind === 'link_cards' || request.kind === 'unlink_cards') {
        if (!Number.isInteger(payload.number)) throw new Refusal('Le numéro de la carte est requis.')
        const { target, kind } = createCardRelationBodySchema.parse(payload)
        const change = request.kind === 'link_cards' ? linkCards : unlinkCards
        change(this.ctx.db, requester.projectId, payload.number as number, target, kind)
        this.settle(request.id, request.kind === 'link_cards' ? 'Relation ajoutée.' : 'Relation supprimée.', false)
      } else if (request.kind === 'update_card') {
        this.settle(request.id, this.updateCard(requester, payload), false)
      } else if (request.kind === 'create_card') {
        this.settle(request.id, await this.createCard(requester, payload), false)
      } else if (request.kind === 'register_action') {
        this.settle(request.id, this.registerAction(requester, payload), false)
      } else if (request.kind === 'remove_action') {
        this.settle(request.id, await this.removeAction(requester, payload), false)
      } else if (request.kind === 'create_automation') {
        this.settle(request.id, await this.createAutomation(requester, project, payload), false)
      } else if (request.kind === 'run_action') {
        this.settle(request.id, await this.runAction(requester, payload), false)
      } else if (request.kind === 'create_worktree') {
        this.settle(request.id, await this.createWorktreeFor(requester, project, payload), false)
      } else if (request.kind === 'list_worktrees') {
        this.settle(request.id, await this.listWorktrees(requester, project), false)
      } else if (
        request.kind === 'message_session' ||
        request.kind === 'steer_session' ||
        request.kind === 'interrupt_session' ||
        request.kind === 'reply_session'
      ) {
        this.settle(request.id, await this.actOnSession(request.kind, requester, payload), false)
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

  /**
   * Le demandeur d'une demande sans session : le compte qu'elle nomme.
   *
   * Le CLI par défaut est Claude, comme pour un projet neuf dans l'interface ; le client
   * global passe `agent` quand il en veut un autre, et sa description le lui dit.
   */
  private principal(request: AgentRequestRow): Requester {
    if (!request.userId) throw new Refusal("La demande ne vient d'aucune session ni d'aucun compte : Sillage ne sait pas pour qui agir.")
    const user = this.ctx.db.select().from(users).where(eq(users.id, request.userId)).get()
    if (!user) throw new Refusal("Le compte au nom duquel agir n'existe plus.")
    return {
      id: '',
      projectId: request.projectId,
      userId: user.id,
      agent: 'claude',
      worktreeId: null,
      scheduleId: null,
      title: user.displayName,
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
    requester: Requester,
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
        // Lancée par un compte et non par une session : la mission arrive nue, comme si
        // l'utilisateur l'avait tapée, sans note qui renverrait à une session inexistante.
        text: requester.id
          ? formatSessionMessage({
              kind: 'launch',
              from: requester.id,
              title: requester.title,
              agent: requester.agent,
              messageId: request.id,
              body: prompt,
            })
          : prompt,
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
  private assertLaunchAllowed(requester: Requester, requestId: string): void {
    const refusal = launchRefusal(this.ctx.db, requester.id, requestId)
    if (refusal) throw new Refusal(refusal.message)
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
    const current = effortOf(config)
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
    requester: Requester,
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

    assertWorktreeName(name)
    const row = await createWorktree(this.ctx, project, requester.userId, name, 'HEAD')
    this.worktreeStatus?.forget(project.id)
    return row.id
  }

  // --- create_worktree, list_worktrees ---------------------------------------------

  /**
   * Crée un worktree pour la session qui le demande, au même endroit et de la même façon
   * que l'interface, puis l'y rattache.
   *
   * Le rattachement passe par `conversation_paths`, comme une écriture dans l'arbre, et
   * jamais par `conversations.worktree_id` : ce dernier décide du cwd à la reprise, et
   * Claude range ses transcripts par dossier de travail, si bien qu'une session dont on
   * changerait le cwd après coup ne se retrouverait plus. Le cwd reste donc où il est,
   * et l'agent travaille dans l'arbre par chemins absolus.
   *
   * Une branche neuve part de la branche par défaut du projet et non de HEAD : la
   * session qui demande est souvent dans l'arbre principal, resté sur une autre branche
   * que celle qu'on croit.
   */
  private async createWorktreeFor(requester: Requester, project: ProjectRow, payload: Record<string, unknown>): Promise<string> {
    const branch = typeof payload.branch === 'string' ? payload.branch.trim() : ''
    if (!branch) throw new Refusal('Le paramètre `branch` est requis : le nom de la branche, par exemple `fix/titre-tronque`.')
    assertWorktreeName(branch)

    const existing = this.ctx.db
      .select()
      .from(worktrees)
      .where(and(eq(worktrees.projectId, project.id), eq(worktrees.name, branch), isNull(worktrees.removedAt)))
      .get()

    let row = existing
    let origin: string
    if (row) {
      origin = 'Il existait déjà : Sillage te le rend tel quel.'
    } else {
      const requested = typeof payload.base === 'string' ? payload.base.trim() : ''
      // Passée telle quelle à `git worktree add` : un tiret en tête serait lu comme une option.
      if (requested && (!/^[A-Za-z0-9._/@{}^~-]+$/.test(requested) || requested.startsWith('-'))) {
        throw new Refusal(`Base invalide « ${requested} » : un nom de branche, de tag ou de commit.`)
      }
      const base = requested || (await defaultBase(project.workspacePath)) || 'HEAD'
      row = await createWorktree(this.ctx, project, requester.userId, branch, base)
      origin = row.baseRef === branch
        ? `La branche « ${branch} » existait : elle est reprise telle quelle.`
        : `Branche neuve, partie de ${base}.`
    }

    if (requester.id) {
      const now = Date.now()
      this.ctx.db
        .insert(conversationPaths)
        .values({ conversationId: requester.id, path: row.path, lastTs: now })
        .onConflictDoUpdate({
          target: [conversationPaths.conversationId, conversationPaths.path],
          set: { lastTs: sql`max(${conversationPaths.lastTs}, ${now})` },
        })
        .run()
    }
    this.worktreeStatus?.forget(project.id)

    return [
      `Worktree « ${branch} » prêt dans ${row.path}. ${origin}`,
      requester.id
        ? "Ta session y est rattachée : l'utilisateur la voit avec cette branche dans la barre latérale, et retrouve l'arbre dans la vue Chantiers, d'où il le nettoiera une fois fusionné."
        : "Il apparaît dans la vue Chantiers du projet.",
      requester.id
        ? `Ton répertoire de travail ne change pas. Travaille dans l'arbre par chemins absolus : édite les fichiers sous ${row.path}, et lance tes commandes avec \`cd ${row.path} && …\` ou \`git -C ${row.path} …\`.`
        : null,
      `Pour qu'une autre session y travaille directement, start_session avec \`worktree: "${branch}"\`.`,
    ]
      .filter((line) => line !== null)
      .join('\n')
  }

  /**
   * Les arbres du projet et leur avancement, tels que la vue Chantiers les montre.
   *
   * Attend un calcul à jour plutôt que de rendre la liste périmée que l'interface
   * accepte : un agent qui demande s'il peut reprendre un arbre décide sur la réponse.
   */
  private async listWorktrees(requester: Requester, project: ProjectRow): Promise<string> {
    if (!this.worktreeStatus) throw new Refusal("L'avancement des worktrees n'est pas disponible ici.")
    const list = await this.worktreeStatus.current(project)
    if (list.worktrees.length === 0) {
      return list.base === null
        ? "Ce projet n'est pas un dépôt git : il n'a pas de worktree."
        : "Aucun worktree en dehors de l'arbre principal. create_worktree en crée un."
    }

    const ids = [...new Set(list.worktrees.flatMap((tree) => tree.conversations.map((entry) => entry.id)))]
    const titles = new Map(
      ids.length
        ? this.ctx.db
            .select({ id: conversations.id, title: conversations.title, archivedAt: conversations.archivedAt })
            .from(conversations)
            .where(inArray(conversations.id, ids))
            .all()
            .map((row) => [row.id, row.archivedAt ? `${row.title} (archivée)` : row.title])
        : [],
    )

    const lines = list.worktrees.map((tree) => {
      const facts = [
        tree.modified > 0 ? `${tree.modified} fichier(s) modifié(s)` : null,
        tree.untracked > 0 ? `${tree.untracked} non suivi(s)` : null,
        tree.ahead > 0 ? `${tree.ahead} commit(s) en avance` : null,
        tree.behind > 0 ? `${tree.behind} en retard` : null,
        tree.conflicts ? 'conflit prévisible' : null,
      ].filter(Boolean)
      const sessions = tree.conversations.map((entry) => {
        const who = entry.id === requester.id ? 'toi' : `« ${titles.get(entry.id) ?? entry.id} »`
        return `${who} ${entry.link === 'worktree' ? 'y travaille' : 'y a travaillé'}`
      })
      return [
        `- \`${tree.name}\` : ${WORKTREE_STATE_WORDS[tree.state]}${facts.length ? ` (${facts.join(', ')})` : ''}`,
        `  ${tree.path}${tree.external ? ' · créé hors de Sillage' : ''}`,
        sessions.length ? `  Sessions : ${sessions.join(' ; ')}` : '  Aucune session rattachée.',
      ].join('\n')
    })

    return [`Worktrees du projet, comparés à ${list.base ?? 'HEAD'} :`, ...lines].join('\n')
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

  // --- schedule_task -------------------------------------------------------------

  /**
   * Crée une tâche planifiée, comme le ferait le formulaire de l'interface.
   *
   * Même latitude qu'un lancement : le modèle et l'effort se choisissent, les
   * permissions restent celles des défauts du projet. Elles comptent davantage ici,
   * personne n'étant là pendant les tirs, et la réponse les rappelle pour que l'agent
   * le dise à l'utilisateur.
   */
  private async scheduleTask(
    requester: Requester,
    project: ProjectRow,
    payload: Record<string, unknown>,
  ): Promise<string> {
    if (requester.scheduleId) {
      throw new Refusal(
        "Refusé : cette session est elle-même un tir planifié. Une tâche qui en crée d'autres se multiplierait sans personne pour l'arrêter ; ouvre une carte avec create_card.",
      )
    }

    const name = typeof payload.name === 'string' ? payload.name.trim() : ''
    if (!name) throw new Refusal('Le paramètre `name` est requis : le nom court de la tâche.')
    if (name.length > MAX_SCHEDULE_NAME_CHARS) {
      throw new Refusal(`Nom trop long (${MAX_SCHEDULE_NAME_CHARS} caractères au plus).`)
    }
    const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : ''
    if (!prompt) throw new Refusal('Le paramètre `prompt` est requis : la consigne rejouée à chaque tir.')
    if (prompt.length > MAX_SCHEDULE_PROMPT_CHARS) {
      throw new Refusal(
        `Consigne trop longue (${prompt.length} caractères, ${MAX_SCHEDULE_PROMPT_CHARS} au plus). Mets le détail dans un fichier et cite-le.`,
      )
    }

    const [existing] = this.ctx.db
      .select({ total: count() })
      .from(scheduledTasks)
      .where(eq(scheduledTasks.projectId, project.id))
      .all()
    if ((existing?.total ?? 0) >= MAX_AGENT_SCHEDULES_PER_PROJECT) {
      throw new Refusal(
        `Refusé : ce projet porte déjà ${MAX_AGENT_SCHEDULES_PER_PROJECT} tâches planifiées. L'utilisateur peut en supprimer dans la vue Planification.`,
      )
    }

    const cadence = parseAgentCadence(payload)
    const maxDurationMinutes = payload.max_duration_minutes ?? DEFAULT_SCHEDULE_DURATION_MINUTES
    if (
      typeof maxDurationMinutes !== 'number' ||
      !Number.isInteger(maxDurationMinutes) ||
      maxDurationMinutes < MIN_SCHEDULE_DURATION_MINUTES ||
      maxDurationMinutes > MAX_SCHEDULE_DURATION_MINUTES
    ) {
      throw new Refusal(
        `\`max_duration_minutes\` est un entier entre ${MIN_SCHEDULE_DURATION_MINUTES} et ${MAX_SCHEDULE_DURATION_MINUTES}.`,
      )
    }
    const overlap = payload.overlap ?? 'skip'
    if (overlap !== 'skip' && overlap !== 'wait') {
      throw new Refusal('`overlap` vaut `skip` (sauter le tir) ou `wait` (attendre la fin du précédent).')
    }
    const checkScript = checkScriptSchema.safeParse(payload.check_script ?? null)
    if (!checkScript.success) {
      throw new Refusal(`\`check_script\` est le texte du script, ${MAX_CHECK_SCRIPT_CHARS} caractères au plus.`)
    }
    const checkTimeout = checkTimeoutSchema.safeParse(payload.check_timeout_seconds ?? DEFAULT_CHECK_TIMEOUT_SECONDS)
    if (!checkTimeout.success) {
      throw new Refusal(
        `\`check_timeout_seconds\` est un entier entre ${MIN_CHECK_TIMEOUT_SECONDS} et ${MAX_CHECK_TIMEOUT_SECONDS}.`,
      )
    }

    const agent = this.parseAgent(payload.agent, requester.agent)
    const config = await this.launchConfig(agent, project, requester.userId, payload)
    const task = createScheduledTask(
      this.ctx.db,
      { projectId: project.id, userId: requester.userId, conversationId: requester.id || undefined },
      {
        name,
        agent,
        config,
        prompt,
        cadence,
        overlapPolicy: overlap,
        maxDurationMinutes,
        enabled: true,
        checkScript: checkScript.data,
        checkTimeoutSeconds: checkTimeout.data,
      },
    )

    const lines = [
      `Tâche planifiée « ${task.name} » créée, id ${task.id}.`,
      `Cadence : ${describeCadence(cadence)}. Prochain tir : ${task.nextRunAt ? new Date(task.nextRunAt).toLocaleString('fr-FR') : 'aucun'} (heure du serveur).`,
      `Chaque tir ouvre une session neuve : CLI ${agent}, modèle ${describeModel(config)}, effort ${describeEffort(config)}, ${task.maxDurationMinutes} min au plus, à la racine du projet.`,
      describePermissions(config)
        ? "Attention : avec les permissions par défaut du projet, un tir s'arrêtera pour demander un accord que personne ne donnera, jusqu'à sa durée maximale. Dis-le à l'utilisateur : il règle les permissions de la tâche dans la vue Planification."
        : null,
      task.checkScript
        ? "Le script de vérification attend la validation de l'utilisateur : tant qu'il n'est pas validé, les tirs sont écartés, sans script ni session. Dis-le-lui : il peut le relire, l'essayer et le valider directement sous cet appel dans la conversation, ou depuis la vue Automatisations du projet."
        : null,
      "L'utilisateur la retrouve dans la vue Planification du projet, où il peut la modifier, la mettre en pause, la lancer tout de suite ou la supprimer. Ses tirs n'apparaissent pas dans la liste des sessions mais sous la tâche.",
    ]
    return lines.filter(Boolean).join('\n')
  }

  // --- create_automation ---------------------------------------------------------

  /**
   * Une automatisation déclenchée par webhook, avec les bornes de `schedule_task` : pas
   * depuis une session elle-même née d'une automatisation, et un plafond par projet.
   * Le secret de signature est rendu à l'agent, qui en a besoin pour brancher le
   * webhook chez l'appelant (`gh api repos/…/hooks`).
   */
  private async createAutomation(
    requester: Requester,
    project: ProjectRow,
    payload: Record<string, unknown>,
  ): Promise<string> {
    if (!this.encryptionKey) throw new Refusal('Les automatisations ne sont pas disponibles sur ce serveur.')
    if (requester.scheduleId) {
      throw new Refusal(
        "Refusé : cette session est elle-même née d'une automatisation ou d'une tâche planifiée. Une automatisation qui en crée d'autres se multiplierait sans personne pour l'arrêter ; ouvre une carte avec create_card.",
      )
    }
    const name = typeof payload.name === 'string' ? payload.name.trim() : ''
    if (!name) throw new Refusal('Le paramètre `name` est requis.')
    if (name.length > MAX_SCHEDULE_NAME_CHARS) throw new Refusal(`Nom trop long (${MAX_SCHEDULE_NAME_CHARS} caractères au plus).`)

    const template = payload.template === undefined || payload.template === null || payload.template === ''
      ? null
      : AUTOMATION_TEMPLATES.find((entry) => entry.id === payload.template)
    if (template === undefined) {
      throw new Refusal(`Modèle inconnu « ${String(payload.template)} ». Valeurs possibles : ${AUTOMATION_TEMPLATES.map((entry) => entry.id).join(', ')}.`)
    }
    const prompt = typeof payload.prompt === 'string' && payload.prompt.trim() ? payload.prompt.trim() : (template?.prompt.fr ?? '')
    if (!prompt) throw new Refusal('Le paramètre `prompt` est requis sans modèle : la consigne, avec des `{{payload.…}}`.')
    if (prompt.length > MAX_SCHEDULE_PROMPT_CHARS) throw new Refusal(`Consigne trop longue (${MAX_SCHEDULE_PROMPT_CHARS} caractères au plus).`)

    const settings: Partial<WebhookSettings> = { ...template?.settings }
    if (payload.conditions !== undefined) {
      const parsed = automationConditionsSchema.safeParse({ mode: payload.match ?? 'all', rules: payload.conditions })
      if (!parsed.success) throw new Refusal(describeZod(parsed.error))
      settings.conditions = parsed.data
    }
    if (typeof payload.subject_path === 'string') settings.subjectPath = payload.subject_path.trim()
    if (payload.verification !== undefined) {
      const presets: Record<string, WebhookVerification> = {
        github: { kind: 'hmac', header: 'x-hub-signature-256', algorithm: 'sha256', prefix: 'sha256=' },
        gitlab: { kind: 'token', header: 'x-gitlab-token' },
        none: { kind: 'none' },
      }
      const chosen = presets[String(payload.verification)]
      if (!chosen) throw new Refusal('`verification` vaut `github`, `gitlab` ou `none`.')
      settings.verification = chosen
    }

    const [existing] = this.ctx.db
      .select({ total: count() })
      .from(scheduledTasks)
      .where(eq(scheduledTasks.projectId, project.id))
      .all()
    if ((existing?.total ?? 0) >= MAX_AGENT_SCHEDULES_PER_PROJECT) {
      throw new Refusal(`Refusé : ce projet porte déjà ${MAX_AGENT_SCHEDULES_PER_PROJECT} automatisations et tâches planifiées.`)
    }

    const agent = this.parseAgent(payload.agent, requester.agent)
    const config = await this.launchConfig(agent, project, requester.userId, payload)
    const key = this.encryptionKey
    const { task, hook } = this.ctx.db.transaction(() => {
      const task = createScheduledTask(
        this.ctx.db,
        { projectId: project.id, userId: requester.userId, conversationId: requester.id || undefined },
        {
          name,
          agent,
          config,
          prompt,
          cadence: { kind: 'webhook' },
          overlapPolicy: 'wait',
          maxDurationMinutes: DEFAULT_SCHEDULE_DURATION_MINUTES,
          enabled: true,
        },
      )
      return { task, hook: createWebhook(this.ctx.db, key, task.id, settings, template?.id ?? null) }
    })
    const url = webhookUrl(this.ctx.config.server.publicUrl, hook.token)
    const verification = readSettings(hook).verification
    const secret = revealSecret(key, hook)

    return [
      `Automatisation « ${task.name} » créée (id ${task.id}), active.`,
      `Adresse : ${url}`,
      verification.kind === 'none'
        ? 'Vérification : aucune, l\'adresse suffit. Préviens l\'utilisateur.'
        : `Secret de signature : ${secret} (${verification.kind === 'hmac' ? `HMAC ${verification.algorithm} dans l'en-tête ${verification.header}` : `jeton dans l'en-tête ${verification.header}`}). Ne le recopie nulle part ailleurs que dans la configuration du webhook.`,
      'Pour GitHub : `gh api repos/OWNER/REPO/hooks -f name=web -F active=true -f "events[]=issues" -f config[url]=<adresse> -f config[content_type]=json -f config[secret]=<secret>` (adapte les événements aux conditions).',
      `Chaque appel retenu ouvre une session neuve (CLI ${agent}, modèle ${describeModel(config)}), une à la fois, ${DEFAULT_SCHEDULE_DURATION_MINUTES} min au plus ; au-delà de ${readSettings(hook).maxRunsPerHour} lancements par heure, elle se met en pause.`,
      "L'utilisateur règle les conditions, le script et le prompt dans la vue Automatisations du projet, où il voit aussi chaque appel reçu et son sort.",
    ].join('\n')
  }

  // --- request_decision / withdraw_decision --------------------------------------

  private async decide(kind: 'request_decision' | 'withdraw_decision', requester: ConversationRow, payload: Record<string, unknown>): Promise<string> {
    if (!this.decisions) throw new Refusal('Les décisions ne sont pas disponibles sur ce serveur.')
    try {
      return kind === 'request_decision' ? await this.decisions.request(requester, payload) : this.decisions.withdraw(requester, payload)
    } catch (err) {
      if (err instanceof DecisionRefusal) throw new Refusal(err.message)
      throw err
    }
  }

  private updateCard(requester: Requester, payload: Record<string, unknown>): string {
    if (!Number.isInteger(payload.number)) throw new Refusal('Le numéro de la carte est requis.')
    const card = this.ctx.db.select().from(cards)
      .where(and(eq(cards.projectId, requester.projectId), eq(cards.number, payload.number as number))).get()
    if (!card) throw new Refusal('Aucune carte de ce numéro dans ce projet.')
    const body = updateCardBodySchema.pick({ title: true, description: true }).parse({
      title: typeof payload.title === 'string' ? payload.title.trim() : payload.title,
      description: payload.description,
    })
    if (body.title === undefined && body.description === undefined) {
      throw new Refusal('Donne au moins un titre ou une description à modifier.')
    }
    updateCard(this.ctx.db, card, body)
    this.board?.kick(requester.projectId)
    return `Carte #${card.number} mise à jour.`
  }

  // --- create_card ---------------------------------------------------------------

  /**
   * Toujours en « à faire » : une carte ouverte par un agent est une proposition, pas
   * un travail engagé. Elle avance quand une session la prend, comme toute autre.
   */
  private async createCard(requester: Requester, payload: Record<string, unknown>): Promise<string> {
    const title = typeof payload.title === 'string' ? payload.title.trim() : ''
    const description = typeof payload.description === 'string' ? payload.description.trim() : ''
    if (!title) throw new Refusal('Le paramètre `title` est requis.')
    if (title.length > 200) throw new Refusal('Titre trop long (200 caractères au plus).')
    if (description.length > 20000) throw new Refusal('Description trop longue (20 000 caractères au plus).')

    // Le réglage du board décide, sauf demande explicite de l'agent, qui ne la fait que
    // si l'utilisateur la lui a donnée : l'outil le lui dit.
    const link = this.board?.link(requester.projectId)
    if (payload.github === true && !link) {
      throw new Refusal("Ce board n'est pas relié à GitHub : la carte ne peut être que locale. Recommence sans `github`.")
    }
    const github = Boolean(link) && (typeof payload.github === 'boolean' ? payload.github : link?.newCards === 'github')
    const fields = { title, description, column: 'todo' as const }
    const card =
      github && this.board
        ? await this.board.createIssueCard(
            requester.projectId,
            requester.userId,
            fields,
            requester.id ? { agent: requester.agent, conversationId: requester.id } : undefined,
          )
        : createCard(this.ctx.db, requester.projectId, requester.userId, fields)
    // La provenance se lit dans le fil de la carte, avec un lien vers la session : la
    // description reste celle que l'agent a rédigée, et la personne qui la reprendra
    // sait d'où elle vient. Une carte ouverte au nom d'un compte porte déjà son auteur.
    if (requester.id) {
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
    }

    const issue = github ? this.board?.issueOf(card.id) : undefined
    const where = issue
      ? ` et publiée sur GitHub comme issue #${issue.number} (${issue.url}), visible de tous si le dépôt est public`
      : link
        ? ', locale (elle ne part pas sur GitHub)'
        : ''
    return `Carte #${card.number} « ${card.title} » créée dans « à faire »${where}. Pour la faire traiter tout de suite : start_session avec card=${card.number}.`
  }

  // --- actions -------------------------------------------------------------------

  private projectAction(requester: Requester, id: unknown) {
    if (typeof id !== 'string' || !id) throw new Refusal('Le paramètre `id` est requis (voir list_actions).')
    try {
      const row = loadAction(this.ctx.db, id)
      if (row.projectId === requester.projectId) return row
    } catch {
      // Même réponse qu'une action d'un autre projet.
    }
    throw new Refusal(`Aucune action \`${id}\` dans ce projet : list_actions donne les identifiants.`)
  }

  /**
   * Créée ou modifiée en `proposed` : l'utilisateur relit la commande avant que son
   * premier clic la lance. Renommer ou redécrire un bouton relu ne change pas son statut.
   */
  private registerAction(requester: Requester, payload: Record<string, unknown>): string {
    const fields = Object.fromEntries(
      ['label', 'description', 'kind', 'command', 'subdir', 'url']
        .filter((key) => payload[key] !== undefined && payload[key] !== null)
        .map((key) => [key, payload[key]]),
    )
    if (payload.id !== undefined && payload.id !== null && payload.id !== '') {
      const row = this.projectAction(requester, payload.id)
      const parsed = updateProjectActionBodySchema.safeParse(fields)
      if (!parsed.success) throw new Refusal(describeZod(parsed.error))
      const next = updateAction(this.ctx.db, row, parsed.data, requester.id || null)
      return next.approvedAt
        ? `Action « ${next.label} » mise à jour ; elle reste validée.`
        : `Action « ${next.label} » mise à jour. Sa commande a changé : l'utilisateur doit la valider avant de la lancer d'un clic.`
    }
    const parsed = createProjectActionBodySchema.safeParse(fields)
    if (!parsed.success) throw new Refusal(describeZod(parsed.error))
    const row = createAction(this.ctx.db, requester.projectId, parsed.data, requester.id || null)
    return `Action « ${row.label} » (${row.kind}, id ${row.id}) proposée. Elle apparaît dans l'onglet Actions du panneau ; l'utilisateur la valide avant son premier lancement.`
  }

  private async removeAction(requester: Requester, payload: Record<string, unknown>): Promise<string> {
    const row = this.projectAction(requester, payload.id)
    await this.actions?.forget(row)
    deleteAction(this.ctx.db, row.id)
    return `Action « ${row.label} » supprimée${row.kind === 'service' ? ', et son service arrêté' : ''}.`
  }

  /**
   * Lance l'action dans le worktree de la session qui demande. Permis même pour une
   * action encore proposée : l'agent pourrait exécuter la même commande dans son shell,
   * la relecture protège le clic de l'utilisateur, pas l'agent de lui-même.
   */
  private async runAction(requester: Requester, payload: Record<string, unknown>): Promise<string> {
    if (!this.actions) throw new Refusal('Les actions ne sont pas disponibles sur ce serveur.')
    const row = this.projectAction(requester, payload.id)
    const result = await this.actions.run(row, resolveConversationCwd(this.ctx.db, requester), requester.id || null)
    if (result.service) {
      // Un temps pour qu'un échec immédiat (port pris, commande introuvable) se voie.
      if (!result.alreadyRunning) await new Promise((resolve) => setTimeout(resolve, 2000))
      const fresh = await this.actions.toDto(row)
      return describeRun(row.label, result, fresh.service)
    }
    return describeRun(row.label, result, null)
  }

  // --- gestes sur une session existante -------------------------------------------

  /**
   * Ce qu'un client hors session fait à une session, comme l'utilisateur le ferait
   * dans l'interface : lui écrire, infléchir son tour, l'arrêter, répondre à ce qu'elle
   * demande. Réservé aux demandeurs sans session : une session qui veut parler à une
   * autre a send_session_message, qui signe et remet le message dans les formes.
   *
   * La cible est une conversation du projet de la demande, qui appartient au compte :
   * les mêmes bornes que `loadTaskForToken` côté API.
   */
  private async actOnSession(
    kind: 'message_session' | 'steer_session' | 'interrupt_session' | 'reply_session',
    requester: Requester,
    payload: Record<string, unknown>,
  ): Promise<string> {
    if (requester.id) {
      throw new Refusal("Cet outil est réservé aux clients hors session : depuis une session, écris à une autre avec send_session_message.")
    }
    const id = typeof payload.session === 'string' ? payload.session.trim() : ''
    if (!id) throw new Refusal('Le paramètre `session` est requis : l\'identifiant que list_sessions donne.')
    const target = this.ctx.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.projectId, requester.projectId), isNull(conversations.archivedAt)))
      .get()
    if (!target || target.userId !== requester.userId) {
      throw new Refusal(`Aucune session « ${id} » à toi dans ce projet. list_sessions donne celles qui existent.`)
    }

    if (kind === 'interrupt_session') {
      if (target.status !== 'running') return `La session « ${target.title} » ne travaille pas (${target.status}) : rien à interrompre.`
      await this.sessions.interrupt(target.id)
      return `Tour de « ${target.title} » interrompu. Un message la fait reprendre, avec son contexte.`
    }

    if (kind === 'reply_session') return this.replyToSession(target, requester, payload)

    const body = typeof payload.body === 'string' ? payload.body.trim() : ''
    if (!body) throw new Refusal('Le paramètre `body` est requis.')
    if (body.length > MAX_LAUNCH_PROMPT_CHARS) {
      throw new Refusal(`Message trop long (${body.length} caractères, ${MAX_LAUNCH_PROMPT_CHARS} au plus).`)
    }
    if (kind === 'steer_session') {
      // Une inflexion n'existe que pendant un tour, et l'appelant perd souvent la
      // course : le texte repart alors en message ordinaire plutôt que de se perdre.
      const steered = await this.sessions.steer(target.id, randomUUID(), body, [], [])
      if (steered) return `Tour de « ${target.title} » infléchi : le CLI lit le message dans le tour en cours.`
      await this.sessions.sendMessage(target.id, randomUUID(), body, [], [])
      return `Aucun tour en cours à infléchir sur « ${target.title} » (ou son CLI ne le permet pas) : le message est parti comme un message ordinaire, qui ouvre un tour.`
    }
    const busy = target.status === 'running'
    await this.sessions.sendMessage(target.id, randomUUID(), body, [], [])
    return busy
      ? `Message mis en attente pour « ${target.title} » : elle travaille, il lui sera remis à la fin de son tour. wait_for_session puis read_session pour voir sa réponse.`
      : `Message remis à « ${target.title} » : elle reprend, comme si l'utilisateur l'avait tapé dans Sillage. wait_for_session puis read_session pour voir sa réponse.`
  }

  /** Répond à la sollicitation ouverte, selon sa nature, comme la route `replies` de l'API. */
  private async replyToSession(target: ConversationRow, requester: Requester, payload: Record<string, unknown>): Promise<string> {
    if (!this.log) throw new Refusal('Les réponses aux sollicitations ne sont pas disponibles sur ce serveur.')
    const requestId = typeof payload.request_id === 'string' ? payload.request_id.trim() : ''
    const open = this.log.openPrompts(target.id)
    const pending = requestId ? open.find((prompt) => prompt.requestId === requestId) : open[0]
    if (!pending) {
      throw new Refusal(
        requestId
          ? `Aucune sollicitation ouverte « ${requestId} » sur cette session : read_session dit ce qu'elle attend.`
          : `La session « ${target.title} » n'attend aucune réponse.`,
      )
    }
    const parsed = taskReplyBodySchema.safeParse({ kind: pending.kind, ...payload })
    if (!parsed.success) throw new Refusal(`Réponse mal formée pour une sollicitation de type ${pending.kind} : ${describeZod(parsed.error)}`)
    const body = parsed.data
    const decidedBy = requester.userId
    let resolved: boolean
    switch (body.kind) {
      case 'permission':
        resolved = this.sessions.resolvePermission(target.id, pending.requestId, { decision: body.decision, scope: body.scope, decidedBy })
        break
      case 'question':
        resolved = await this.sessions.answerQuestion(target.id, pending.requestId, { status: body.status, answers: body.answers, decidedBy })
        break
      case 'plan':
        resolved = this.sessions.reviewPlan(target.id, pending.requestId, { decision: body.decision, followUpMode: body.followUpMode, decidedBy })
        break
      case 'elicitation':
        resolved = this.sessions.resolveElicitation(target.id, pending.requestId, { action: body.action, content: body.content, decidedBy })
        break
    }
    if (!resolved) throw new Refusal("Cette sollicitation a expiré : la session s'est arrêtée entre-temps. Un message la fait reprendre.")
    return `Réponse (${body.kind}) remise à « ${target.title} » : elle continue. wait_for_session puis read_session pour la suite.`
  }

  // --- list_models ---------------------------------------------------------------

  private async listModels(
    requester: Requester,
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

/**
 * La cadence telle qu'un agent la donne : exactement un de `every_minutes`, `cron`, `at`.
 *
 * Trois paramètres à plat plutôt qu'un objet discriminé : c'est la forme qu'un modèle
 * remplit sans se tromper, et celle de `CronCreate` qu'il connaît déjà.
 */
function parseAgentCadence(payload: Record<string, unknown>): ScheduleCadence {
  const given = ['every_minutes', 'cron', 'at'].filter(
    (key) => payload[key] !== undefined && payload[key] !== null && payload[key] !== '',
  )
  if (given.length !== 1) {
    throw new Refusal(
      'Donne exactement une cadence : `every_minutes` (intervalle), `cron` (motif à cinq champs) ou `at` (date et heure uniques, ISO 8601).',
    )
  }

  let candidate: unknown
  if (given[0] === 'every_minutes') {
    candidate = { kind: 'interval', minutes: payload.every_minutes }
  } else if (given[0] === 'cron') {
    candidate = { kind: 'cron', expression: typeof payload.cron === 'string' ? payload.cron.trim() : payload.cron }
  } else {
    const at = typeof payload.at === 'string' ? Date.parse(payload.at) : Number.NaN
    if (Number.isNaN(at)) throw new Refusal('`at` doit être une date ISO 8601, par exemple 2026-10-12T09:00:00+02:00.')
    if (at <= Date.now()) throw new Refusal('`at` est dans le passé.')
    candidate = { kind: 'once', at }
  }

  const parsed = scheduleCadenceSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new Refusal(
      given[0] === 'cron'
        ? `Motif cron invalide « ${String(payload.cron)} » : cinq champs (minute heure jour mois jour-de-semaine), lus à l'heure du serveur.`
        : '`every_minutes` doit être un entier positif.',
    )
  }

  const cadence = parsed.data
  if (cadence.kind === 'interval' && cadence.minutes < MIN_AGENT_SCHEDULE_MINUTES) {
    throw new Refusal(`Intervalle trop court : ${MIN_AGENT_SCHEDULE_MINUTES} minutes au moins.`)
  }
  if (cadence.kind === 'cron') {
    const [first, second] = new Cron(cadence.expression, { paused: true }).nextRuns(2)
    if (first && second && second.getTime() - first.getTime() < MIN_AGENT_SCHEDULE_MINUTES * 60_000) {
      throw new Refusal(`Motif trop serré : ${MIN_AGENT_SCHEDULE_MINUTES} minutes au moins entre deux tirs.`)
    }
  }
  return cadence
}

function describeCadence(cadence: ScheduleCadence): string {
  if (cadence.kind === 'interval') return `toutes les ${cadence.minutes} minutes`
  if (cadence.kind === 'cron') return `motif cron \`${cadence.expression}\``
  if (cadence.kind === 'webhook') return 'à chaque appel de son webhook'
  return `une seule fois, le ${new Date(cadence.at).toLocaleString('fr-FR')}`
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
  if (config.agent === 'claude') return { ...config, effort: effort as typeof config.effort }
  if (config.agent === 'codex' || config.agent === 'grok') return { ...config, reasoningEffort: effort }
  return { ...config, variant: effort }
}

/** L'effort sous le nom que chaque CLI lui donne : la variante, chez opencode. */
function effortOf(config: AgentConfig): string {
  if (config.agent === 'claude') return config.effort
  if (config.agent === 'opencode') return config.variant
  return config.reasoningEffort
}

function describeModel(config: AgentConfig): string {
  return config.model || 'celui du CLI'
}

function describeEffort(config: AgentConfig): string {
  return effortOf(config) || 'celui du CLI'
}

function describePermissions(config: AgentConfig): string | null {
  if (config.agent === 'claude' && config.permissionMode === 'manual') {
    return "Ses permissions sont en mode manuel, comme les défauts du projet : elle s'arrêtera pour demander à l'utilisateur avant d'agir."
  }
  if (config.agent === 'codex' && config.askForApproval !== 'never' && config.askForApproval !== '') {
    return "Elle demandera l'approbation de l'utilisateur pour ce qui sort de son bac à sable, comme le veulent les défauts du projet."
  }
  if (config.agent === 'opencode' && (config.permissions.edit === 'ask' || config.permissions.bash === 'ask')) {
    return "Elle demandera la permission de l'utilisateur avant d'écrire ou d'exécuter, comme le veulent les défauts du projet."
  }
  if (config.agent === 'grok' && (config.permissionMode === 'default' || config.permissionMode === 'plan')) {
    return "Elle demandera la permission de l'utilisateur avant d'écrire ou d'exécuter, comme le veulent les défauts du projet."
  }
  return null
}

function describeZod(error: ZodError): string {
  const issues = error.issues.map((issue) => `\`${issue.path.join('.') || 'paramètres'}\` : ${issue.message}`)
  return `Paramètres invalides — ${issues.join(' ; ')}`
}

function describeRun(
  label: string,
  result: ProjectActionRunResult,
  service: ProjectActionRunResult['service'],
): string {
  if (service) {
    const ports = service.ports.length > 0 ? `, ports ${service.ports.join(', ')}` : ''
    const state = `unité ${service.unit} : ${service.state}${ports}`
    if (result.alreadyRunning) return `« ${label} » tournait déjà (${state}).`
    if (service.state === 'failed') {
      return `« ${label} » a échoué au démarrage (${state}). Journal : journalctl --user -u ${service.unit} -n 50`
    }
    return `« ${label} » démarré (${state}). Journal : journalctl --user -u ${service.unit} -n 50`
  }
  const terminal = result.terminal
  if (result.alreadyRunning) return `« ${label} » tourne déjà dans le terminal « ${terminal?.title ?? label} » du panneau.`
  return `« ${label} » lancé dans un terminal du panneau, sous les yeux de l'utilisateur. Tu n'en lis pas la sortie : pour l'exploiter toi-même, exécute la commande dans ton shell.`
}

/**
 * Pourquoi la session `from` ne peut plus en lancer d'autre, ou null si elle le peut :
 * trop profonde dans une chaîne de lancements, ou trop de lancements dans l'heure.
 *
 * Partagée avec les webhooks : un appel qui porte la marque d'une session compte comme
 * un lancement fait par elle (`webhook_launch`), et les mêmes limites s'appliquent, que
 * la chaîne passe par `start_session` ou par une issue ouverte sur GitHub.
 */
export function launchRefusal(
  db: AppContext['db'],
  from: string,
  excludeRequestId?: string,
): { reason: DeliveryReason; message: string } | null {
  let depth = 0
  let current = from
  while (depth <= MAX_LAUNCH_DEPTH) {
    const parent = db
      .select({ from: agentRequests.conversationId })
      .from(agentRequests)
      .where(eq(agentRequests.launchedConversationId, current))
      .get()
    if (!parent) break
    depth += 1
    current = parent.from
  }
  if (depth >= MAX_LAUNCH_DEPTH) {
    return {
      reason: { code: 'chain_depth', params: { depth, max: MAX_LAUNCH_DEPTH } },
      // Le message va à l'agent, en français comme tout ce que Sillage lui écrit ; la
      // raison codée va à l'interface, qui la traduit.
      message: `Refusé : cette session a elle-même été lancée par une session qui l'avait été (${depth} niveaux). Au-delà de ${MAX_LAUNCH_DEPTH}, plus de lancement en chaîne. Crée plutôt une carte avec create_card, ou propose à l'utilisateur de lancer la session lui-même.`,
    }
  }

  const [recent] = db
    .select({ total: count() })
    .from(agentRequests)
    .where(
      and(
        eq(agentRequests.conversationId, from),
        inArray(agentRequests.kind, ['start_session', 'webhook_launch']),
        eq(agentRequests.isError, false),
        ...(excludeRequestId ? [ne(agentRequests.id, excludeRequestId)] : []),
        gt(agentRequests.createdAt, Date.now() - HOUR_MS),
      ),
    )
    .all()
  if ((recent?.total ?? 0) >= LAUNCHES_PER_HOUR) {
    return {
      reason: { code: 'chain_rate', params: { max: LAUNCHES_PER_HOUR } },
      message: `Refusé : cette session a déjà lancé ${LAUNCHES_PER_HOUR} sessions dans l'heure. Crée des cartes avec create_card pour le reste, l'utilisateur les lancera.`,
    }
  }
  return null
}
