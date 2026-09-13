import { randomUUID } from 'node:crypto'
import {
  CLI_DEFAULT,
  parseElicitationFields,
  type AgentConfig,
  type AgentQuestion,
  type AgentSkillDto,
  type CodexConfig,
  type ContentBlock,
  type McpServer,
  type McpServerStatus,
} from '@sillage/protocol'
import type { CollaborationMode, RequestId } from '@sillage/codex-bindings'
import type {
  AccountRateLimitsUpdatedNotification,
  AskForApproval,
  AgentMessageDeltaNotification,
  CommandExecutionOutputDeltaNotification,
  CommandExecutionRequestApprovalParams,
  CommandExecutionRequestApprovalResponse,
  ErrorNotification,
  FileChangeRequestApprovalParams,
  FileChangeRequestApprovalResponse,
  ListMcpServerStatusResponse,
  McpServerElicitationRequestParams,
  McpServerStatusUpdatedNotification,
  McpServerElicitationRequestResponse,
  PermissionsRequestApprovalParams,
  PermissionsRequestApprovalResponse,
  ReasoningTextDeltaNotification,
  SandboxPolicy,
  SkillsListResponse,
  ThreadItem,
  ThreadNameUpdatedNotification,
  ThreadStartResponse,
  ThreadTokenUsageUpdatedNotification,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
  TurnCompletedNotification,
  TurnPlanUpdatedNotification,
  ThreadStartedNotification,
  ThreadStatusChangedNotification,
  ThreadSettingsUpdatedNotification,
  TurnDiffUpdatedNotification,
  TerminalInteractionNotification,
  FileChangePatchUpdatedNotification,
  ServerRequestResolvedNotification,
  HookStartedNotification,
  HookCompletedNotification,
  ItemGuardianApprovalReviewStartedNotification,
  ItemGuardianApprovalReviewCompletedNotification,
  ModelReroutedNotification,
  ModelSafetyBufferingUpdatedNotification,
  ConfigWarningNotification,
  McpToolCallProgressNotification,
  WarningNotification,
  TurnStartedNotification,
  TurnStartParams,
  TurnStartResponse,
  UserInput,
} from '@sillage/codex-bindings/v2'
import type {
  AgentRunner,
  ElicitationAnswer,
  OutgoingAttachment,
  OutgoingMention,
  PermissionDecision,
  PlanReview,
  QuestionAnswer,
  RunnerContext,
} from '../types.js'
import { PendingInteractions } from '../interactions.js'
import { describeOutgoingMessage } from '../outgoing.js'
import { journalDeath } from '../session-close.js'
import { ToolDurations } from '../tool-durations.js'
import { failedStatuses } from '../mcp-registry.js'
import { CodexAppServerClient, CodexRpcError } from './app-server-client.js'
import { CodexAsyncQuestions } from './async-questions.js'
import { startedItem, completedItem } from './item-events.js'
import { NOTIFICATION_POLICY } from './notification-policy.js'
import { CodexTurnUsage } from './turn-usage.js'
import { CLIENT_INFO } from './client-info.js'
import { describeTurnError } from './errors.js'
import { fromCodexMcpStatus, toCodexThreadConfig, type CodexMcpStartup } from './mcp.js'
import { describeWindow } from './quota.js'

/**
 * Adaptateur Codex (invariant I3) : traduit l'app-server vers le schéma d'événements
 * commun. Le frontend ne sait pas qu'il parle à Codex plutôt qu'à Claude.
 *
 * Différence structurante avec Claude : Codex accepte modèle, effort, approbation et
 * sandbox **à chaque tour**, donc changer un réglage ne demande jamais de relancer le
 * process.
 */

/**
 * `turn/start` accepte un mode de collaboration derrière la capacité `experimentalApi`,
 * mais `generate-ts` ne l'exporte pas : le champ est ajouté ici par intersection plutôt
 * que le paramètre entier réécrit à la main. Le jour où Codex l'exportera, l'intersection
 * deviendra redondante sans rien casser.
 */
type ExperimentalTurnStartParams = TurnStartParams & {
  collaborationMode?: CollaborationMode | null
}

/**
 * Notifications volontairement ignorées : progression interne ou redondante avec ce
 * que `item/completed` apporte déjà. Liste nommée plutôt qu'un `default:` muet, pour
 * qu'une notification inconnue reste visible.
 */
/** Délai accordé au CLI pour clore un tour interrompu avant de forcer `idle`. */
const INTERRUPT_GRACE_MS = 15_000

/**
 * Traduit un message et ses pièces jointes pour l'app-server. Les blocs journalisés
 * viennent du module commun.
 *
 * Codex accepte un chemin local pour les images (`localImage`), là où Claude exige du
 * base64 : c'est le protocole de chacun qui décide, pas une préférence de Sillage.
 */
function buildUserInput(
  text: string,
  attachments: OutgoingAttachment[],
  mentions: OutgoingMention[],
  skills: Map<string, string>,
): { blocks: ContentBlock[]; input: UserInput[] } {
  const { blocks, promptText } = describeOutgoingMessage(text, attachments)
  const input: UserInput[] = []

  // Devant le texte, comme le fait le TUI : la compétence est le cadre dans lequel la
  // consigne se lit, pas une précision qu'on ajoute après coup.
  for (const [name, path] of skills) {
    input.push({ type: 'skill', name, path })
  }

  if (promptText) {
    input.push({ type: 'text', text: promptText, text_elements: [] })
  }

  // Contrairement à Claude, l'app-server ne développe pas les `@chemin` du texte : la
  // mention est un élément d'entrée à part, que le protocole prévoit explicitement.
  for (const mention of mentions) {
    input.push({ type: 'mention', name: mention.name, path: mention.path })
  }

  for (const attachment of attachments) {
    if (attachment.inlineImage) {
      input.push({ type: 'localImage', path: attachment.path })
    }
  }

  return { blocks, input }
}

/**
 * Questions normalisées, à partir de `item/tool/requestUserInput`.
 *
 * Le protocole n'a pas d'équivalent du `multiSelect` de Claude : la réponse est un
 * tableau, mais rien n'indique qu'une question en accepte plusieurs. Annoncer un
 * choix multiple ici serait une invention, donc la case reste à faux.
 *
 * Une question sans options attend une réponse libre : `options` vaut alors null.
 */
function toQuestions(params: ToolRequestUserInputParams): AgentQuestion[] {
  return params.questions.map((question) => ({
    id: question.id,
    header: question.header,
    question: question.question,
    multiSelect: false,
    allowOther: question.isOther || !question.options?.length,
    secret: question.isSecret,
    options: (question.options ?? []).map((option) => ({
      label: option.label,
      description: option.description,
      // Le protocole Codex ne transporte pas d'aperçu, contrairement à Claude.
      preview: null,
    })),
  }))
}

export class CodexRunner implements AgentRunner {
  readonly conversationId: string

  private client: CodexAppServerClient | null = null
  private threadId: string | null = null
  /** Serveurs transmis au thread courant, pour distinguer les nôtres de ceux du CLI. */
  private mcpServers: McpServer[] = []
  /** Serveurs qu'on n'a pas pu lancer, à joindre à l'inventaire que le CLI rapporte. */
  private mcpFailures: McpServerStatus[] = []
  /** Dernier démarrage annoncé par serveur : l'inventaire ne porte ni état ni erreur. */
  private readonly mcpStartup = new Map<string, CodexMcpStartup>()
  /** Dernier inventaire publié, pour n'écrire au journal que ce qui change. */
  private lastMcpPayload: string | null = null
  /** Chemin de chaque compétence publiée, seule façon de rouvrir un nom à l'envoi. */
  private skillPaths = new Map<string, string>()
  private config: CodexConfig
  private readonly interactions: PendingInteractions
  private readonly asyncQuestions: CodexAsyncQuestions
  private readonly serverRequests = new Map<RequestId, string>()
  private readonly requestScopes = new Map<RequestId, { threadId: string | null; turnId: string | null }>()
  private readonly childThreads = new Map<string, { toolId: string; parent: string | null; description: string; startedAt: number; running: boolean }>()
  private readonly turnUsage = new CodexTurnUsage()
  private readonly startedItems = new Set<string>()
  private readonly completedItems = new Set<string>()
  private readonly durations = new ToolDurations()
  /** Nom que Codex donne au fil, annoncé par `thread/name/updated`. */
  private suggested: string | null = null
  /** Tour en cours : `turn/interrupt` l'exige, contrairement au SDK Claude. */
  private turnId: string | null = null
  /** Garde-fou d'interruption : force `idle` si le CLI ne clôt jamais le tour. */
  private interruptWatchdog: NodeJS.Timeout | null = null
  /**
   * Tour dont la panne est déjà au journal. Le CLI l'annonce deux fois : par une
   * notification `error`, puis dans le `turn/completed` qui la clôt. Un seul bandeau.
   */
  private reportedErrorTurn: string | null = null
  private readonly completedTurns = new Set<string>()
  /** Modèle réellement retenu par le CLI, seul connu quand la conversation dit « défaut ». */
  private threadModel: string | null = null

  /** Voir `AgentRunner`. `this.config` n'avance qu'après une application réussie. */
  get appliedConfig(): AgentConfig {
    return this.config
  }

  constructor(private readonly ctx: RunnerContext) {
    this.conversationId = ctx.conversationId
    this.config = ctx.config as CodexConfig
    this.interactions = new PendingInteractions(ctx)
    this.asyncQuestions = new CodexAsyncQuestions(ctx)
  }

  /**
   * La sentinelle `CLI_DEFAULT` devient `null` : le protocole y voit « applique la
   * politique configurée dans le CLI », ce qui est précisément ce qu'elle exprime.
   */
  private approvalPolicy(): AskForApproval | null {
    return this.config.askForApproval === CLI_DEFAULT ? null : this.config.askForApproval
  }

  /**
   * `sandbox` est une chaîne côté configuration Sillage, mais une union objet dans le
   * protocole. La traduction vit ici, à partir des types générés.
   */
  private sandboxPolicy(): SandboxPolicy {
    switch (this.config.sandbox) {
      case 'read-only':
        return { type: 'readOnly', networkAccess: this.config.webSearch }
      case 'danger-full-access':
        return { type: 'dangerFullAccess' }
      case 'workspace-write':
        return {
          type: 'workspaceWrite',
          writableRoots: this.config.additionalDirectories,
          networkAccess: this.config.webSearch,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        }
    }
  }

  async start(): Promise<void> {
    this.client = new CodexAppServerClient({
      binary: this.ctx.binary,
      cwd: this.ctx.cwd,
      onNotification: (method, params) => {
        try { this.translate(method, params) }
        catch (error) {
          this.notice('translation_failed', `Impossible de lire l'événement Codex ${method} : ${error instanceof Error ? error.message : String(error)}`, 'warning', params)
        }
      },
      onServerRequest: (method, params, id) => this.handleServerRequest(method, params, id),
      onExit: (code) => this.onProcessExit(code),
    })

    await this.client.initialize(CLIENT_INFO)

    const resolved = this.ctx.resolveMcpServers(this.config)
    this.mcpServers = resolved.servers
    this.mcpFailures = failedStatuses(resolved.failures)
    // Repassé au `thread/resume` autant qu'au `thread/start`, et ce n'est pas une
    // précaution : une surcharge de thread n'est pas persistée avec le thread. Sondé,
    // un thread créé avec des serveurs MCP puis repris sans cette configuration les
    // perd entièrement, sans erreur ni trace. Ne pas simplifier.
    const threadConfig = {
      ...toCodexThreadConfig(this.mcpServers),
      // Rend aussi les questions structurées disponibles en mode de travail normal.
      'features.default_mode_request_user_input': true,
    }

    // L'équivalent de l'appendice au prompt système côté Claude. Sondé sur le CLI
    // installé : la consigne tient sur toute la durée du thread, et le
    // `developer_instructions` nul que le mode de collaboration porte à chaque tour ne
    // l'efface pas. Repassé au `thread/resume` par le même raisonnement que la
    // configuration MCP.
    const developerInstructions = [
      this.ctx.projectOverview(this.config),
      'Sillage displays structured user questions as interactive forms. When asking the user to choose or clarify, use the available request_user_input or request_user_input_async tool instead of listing choices in a plain message. Never treat a suggested option as a submitted answer.',
    ].filter(Boolean).join('\n\n')

    const started = this.ctx.resumeSessionId
      ? await this.client.call<ThreadStartResponse, 'thread/resume'>('thread/resume', {
          threadId: this.ctx.resumeSessionId,
          cwd: this.ctx.cwd,
          approvalPolicy: this.approvalPolicy(),
          sandbox: this.config.sandbox,
          model: this.config.model,
          config: threadConfig,
          developerInstructions,
        })
      : await this.client.call<ThreadStartResponse, 'thread/start'>('thread/start', {
          cwd: this.ctx.cwd,
          approvalPolicy: this.approvalPolicy(),
          sandbox: this.config.sandbox,
          model: this.config.model,
          config: threadConfig,
          developerInstructions,
        })

    this.threadId = started.thread.id
    this.threadModel = started.model
    this.ctx.setAgentSessionId(started.thread.id)
    this.ctx.emit(
      {
        type: 'session.started',
        agent: 'codex',
        agentSessionId: started.thread.id,
        model: started.model,
        cwd: started.cwd,
        // L'app-server n'annonce pas la liste des outils : elle dépend du sandbox et
        // des serveurs MCP configurés. Mieux vaut vide que devinée.
        tools: [],
      },
      started,
    )
    void this.publishMcpStatus()
    void this.publishSkills()
  }

  /**
   * Publie les compétences que le CLI met à disposition, et retient leurs chemins.
   *
   * Le chemin ne quitte jamais le serveur : le composer choisit un nom, et c'est cette
   * table qui le rouvre à l'envoi. Sans elle, il faudrait faire confiance au client sur
   * le fichier que le CLI ira lire.
   *
   * Interrogé sur le répertoire de travail du thread : les compétences d'un dépôt sont
   * portées par le dépôt, et une réponse sans `cwds` ne rendrait que celles du poste.
   */
  private async publishSkills(): Promise<void> {
    const client = this.client
    if (!client) return

    try {
      const listed = await client.call<SkillsListResponse, 'skills/list'>('skills/list', {
        cwds: [this.ctx.cwd],
      })

      this.skillPaths = new Map()
      const skills: AgentSkillDto[] = []
      for (const entry of listed.data) {
        for (const skill of entry.skills) {
          // Une compétence désactivée reste dans l'inventaire, mais l'invoquer n'aurait
          // aucun effet : la proposer serait promettre ce que le CLI ne fera pas.
          if (!skill.enabled) continue
          this.skillPaths.set(skill.name, skill.path)
          skills.push({
            name: skill.name,
            // La description longue commence par les conditions d'emploi destinées au
            // modèle (« Use when... ») : le résumé de l'interface est écrit pour être lu.
            description:
              skill.interface?.shortDescription ?? skill.shortDescription ?? skill.description,
          })
        }
      }

      this.ctx.emit({ type: 'skills.updated', skills })
    } catch (err) {
      // Sans inventaire, le composer ne propose rien et le reste de la conversation
      // fonctionne : rien qui justifie de faire tomber la session.
      process.stderr.write(
        `[codex ${this.conversationId}] compétences indisponibles : ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }

  /** Ne garde que les noms que le CLI a réellement publiés, avec leur chemin. */
  private resolveSkills(names: string[]): Map<string, string> {
    const resolved = new Map<string, string>()
    for (const name of names) {
      const path = this.skillPaths.get(name)
      if (path) resolved.set(name, path)
    }
    return resolved
  }

  /**
   * Publie l'inventaire MCP du thread.
   *
   * Interrogé avec `threadId` : sans lui, l'app-server ne répond que les serveurs de la
   * configuration de l'utilisateur, et les surcharges posées par Sillage restent
   * invisibles. C'est la contrepartie de ne rien écrire dans son `config.toml`.
   *
   * Codex annonce un démarrage par serveur, et chaque annonce relit l'inventaire
   * entier. Les publications identiques sont donc écartées : restent celles où un
   * serveur a réellement changé d'état ou d'outils, qui sont la seule chose que le
   * journal a besoin de garder.
   */
  private async publishMcpStatus(): Promise<void> {
    const client = this.client
    const threadId = this.threadId
    if (!client || !threadId) return

    try {
      const inventory: ListMcpServerStatusResponse['data'] = []
      let cursor: string | null = null
      const cursors = new Set<string>()
      do {
        const page: ListMcpServerStatusResponse = await client.call('mcpServerStatus/list', {
          threadId, detail: 'toolsAndAuthOnly', cursor,
        })
        inventory.push(...page.data)
        cursor = page.nextCursor
        if (cursor && cursors.has(cursor)) throw new Error('Curseur MCP répété par Codex.')
        if (cursor) cursors.add(cursor)
      } while (cursor)
      // Même raison que côté Claude : un serveur écarté faute d'un secret n'a jamais
      // été transmis, donc l'inventaire du CLI l'ignore.
      const servers = [
        ...this.mcpFailures,
        ...fromCodexMcpStatus(inventory, this.mcpServers, this.mcpStartup),
      ]

      const payload = JSON.stringify(servers)
      if (payload === this.lastMcpPayload) return
      this.lastMcpPayload = payload

      this.ctx.emit({ type: 'mcp.updated', servers })
    } catch (err) {
      // Le thread reste utilisable sans son inventaire : seul l'écran d'état est en
      // retard, et la prochaine annonce de démarrage le rattrapera.
      process.stderr.write(
        `[codex ${this.conversationId}] inventaire MCP indisponible : ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }

  /**
   * Le process est mort sans qu'on le lui demande. Équivalent du chemin d'erreur de
   * la boucle de consommation du runner Claude : clore ce qui attend une réponse,
   * le dire dans le journal, et passer en erreur pour que le gestionnaire libère la
   * session. Le prochain message repartira en reprise du fil.
   */
  private onProcessExit(code: number | null): void {
    this.client = null
    this.turnId = null
    this.clearInterruptWatchdog()

    // Mort pendant le démarrage : la session n'a jamais existé. L'appel `initialize`
    // ou `thread/start` en vol est rejeté, `start()` échoue, et le gestionnaire
    // nettoie et remonte l'erreur HTTP. Journaliser ici en plus écrirait une fin de
    // session et un statut d'erreur pour une conversation qui n'a rien commencé.
    if (!this.threadId) return

    this.interactions.expireAll()
    this.asyncQuestions.expireAll()
    // Le statut avant le journal : une écriture refusée ne doit pas laisser la
    // conversation en `running` alors que le process est déjà mort.
    this.ctx.setStatus('error')
    journalDeath(this.ctx, {
      type: 'error',
      code: 'runner_failed',
      message: `codex app-server s'est arrêté de façon inattendue (code ${code ?? 'inconnu'}).`,
      recoverable: true,
    })
  }

  private translate(method: string, params: unknown): void {
    if (method === 'thread/started') {
      const { thread } = params as ThreadStartedNotification
      if (thread.parentThreadId) {
        const parent = this.childThreads.get(thread.parentThreadId)?.toolId ?? null
        this.ensureSubAgent(thread.id, thread.agentNickname ?? thread.name ?? 'Codex', parent, thread.preview)
      }
      return
    }
    const threadId = (params as { threadId?: string } | null)?.threadId
    const child = threadId && threadId !== this.threadId ? this.childThreads.get(threadId) : undefined
    // Les tours des sous-agents ne doivent jamais clore le tour du fil principal.
    if (this.threadId && threadId && threadId !== this.threadId) {
      if (child) this.translateChild(method, params, threadId, child.toolId)
      return
    }
    const nativeTurnId = (params as { turnId?: string } | null)?.turnId
    if (nativeTurnId && !this.turnId && method.startsWith('item/')) this.beginTurn(nativeTurnId)
    switch (method) {
      case 'item/plan/delta':
      case 'item/agentMessage/delta': {
        const p = params as AgentMessageDeltaNotification
        this.ctx.emit({ type: 'message.delta', messageId: p.itemId, text: p.delta, parentToolCallId: null })
        return
      }

      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        const p = params as ReasoningTextDeltaNotification
        this.ctx.emit({ type: 'thinking.delta', messageId: p.itemId, text: p.delta, parentToolCallId: null })
        return
      }

      case 'item/commandExecution/outputDelta': {
        const p = params as CommandExecutionOutputDeltaNotification
        this.ctx.emit({ type: 'tool.output_delta', toolCallId: p.itemId, chunk: p.delta })
        return
      }

      case 'item/fileChange/outputDelta': {
        const p = params as CommandExecutionOutputDeltaNotification
        this.ctx.emit({ type: 'tool.output_delta', toolCallId: p.itemId, chunk: p.delta })
        return
      }

      case 'item/mcpToolCall/progress': {
        const p = params as McpToolCallProgressNotification
        this.ctx.emit({ type: 'tool.output_delta', toolCallId: p.itemId, chunk: `${p.message}\n` }, p)
        return
      }

      case 'turn/diff/updated': {
        const p = params as TurnDiffUpdatedNotification
        this.ctx.emit({ type: 'diff.updated', files: [], patch: p.diff }, p)
        return
      }

      case 'item/fileChange/patchUpdated': {
        const p = params as FileChangePatchUpdatedNotification
        this.ctx.emit({ type: 'tool.input_updated', toolCallId: p.itemId, input: { changes: p.changes } }, p)
        return
      }

      case 'item/commandExecution/terminalInteraction': {
        const p = params as TerminalInteractionNotification
        this.ctx.emit({ type: 'tool.output_delta', toolCallId: p.itemId, chunk: `\n> ${p.stdin}\n` }, p)
        return
      }

      case 'thread/settings/updated': {
        const p = params as ThreadSettingsUpdatedNotification
        const model = p.threadSettings.model
        if (this.threadModel && model !== this.threadModel) this.notice(method, `Modèle Codex : ${model}`, 'info')
        this.threadModel = model
        return
      }

      case 'item/reasoning/summaryPartAdded': {
        const p = params as { itemId: string; summaryIndex: number }
        if (p.summaryIndex > 0) this.ctx.emit({ type: 'thinking.delta', messageId: p.itemId, text: '\n\n', parentToolCallId: null })
        return
      }

      case 'serverRequest/resolved': {
        const p = params as ServerRequestResolvedNotification
        const requestId = this.serverRequests.get(p.requestId)
        if (requestId) {
          this.interactions.expire(requestId)
          this.serverRequests.delete(p.requestId)
          if (this.turnId) this.ctx.setStatus(this.interactions.hasBlocking ? 'awaiting_input' : 'running')
        }
        return
      }

      case 'thread/status/changed': {
        const p = params as ThreadStatusChangedNotification
        if (p.status.type === 'active') {
          this.ctx.setStatus(this.interactions.hasBlocking ? 'awaiting_input' : 'running')
        } else if (p.status.type === 'systemError') {
          this.notice(method, 'Codex signale une erreur de session.', 'warning', p)
        }
        return
      }

      case 'warning':
      case 'guardianWarning': {
        const p = params as WarningNotification
        this.notice(method, p.message, 'warning', p)
        return
      }

      case 'configWarning': {
        const p = params as ConfigWarningNotification
        this.notice(method, p.summary, 'warning', p)
        return
      }

      case 'model/rerouted': {
        const p = params as ModelReroutedNotification
        this.notice(method, `Codex utilise ${p.toModel} à la place de ${p.fromModel}.`, 'warning', p)
        return
      }

      case 'model/safetyBuffering/updated': {
        const p = params as ModelSafetyBufferingUpdatedNotification
        if (p.showBufferingUi) this.notice(method, 'Codex vérifie sa réponse avant de la transmettre.', 'info', p)
        return
      }

      case 'model/verification':
        this.notice(method, 'Codex demande une vérification du compte.', 'warning', params)
        return

      case 'hook/started': {
        const p = params as HookStartedNotification
        this.ctx.emit({ type: 'tool.started', toolCallId: `hook-${p.run.id}`, name: `Hook/${p.run.eventName}`,
          input: { source: p.run.sourcePath, scope: p.run.scope }, parentToolCallId: null }, p)
        return
      }

      case 'hook/completed': {
        const p = params as HookCompletedNotification
        this.ctx.emit({ type: 'tool.completed', toolCallId: `hook-${p.run.id}`,
          output: { message: p.run.statusMessage, entries: p.run.entries },
          isError: p.run.status === 'failed' || p.run.status === 'blocked', durationMs: Number(p.run.durationMs ?? 0) }, p)
        return
      }

      case 'item/autoApprovalReview/started': {
        const p = params as ItemGuardianApprovalReviewStartedNotification
        this.ctx.emit({ type: 'tool.started', toolCallId: `review-${p.reviewId}`, name: 'AutoApprovalReview',
          input: p.action, parentToolCallId: null }, p)
        return
      }

      case 'item/autoApprovalReview/completed': {
        const p = params as ItemGuardianApprovalReviewCompletedNotification
        this.ctx.emit({ type: 'tool.completed', toolCallId: `review-${p.reviewId}`, output: p.review,
          isError: p.review.status === 'denied', durationMs: p.completedAtMs - p.startedAtMs }, p)
        if (p.review.status === 'denied') this.notice(method, p.review.rationale ?? 'La vérification automatique a refusé cette action.', 'warning', p.action)
        return
      }

      case 'mcpServer/startupStatus/updated': {
        const p = params as McpServerStatusUpdatedNotification
        this.mcpStartup.set(p.name, { status: p.status, error: p.error })
        void this.publishMcpStatus()
        return
      }

      // Signal d'invalidation, sans contenu : la notification dit que les fichiers de
      // compétences ont bougé, c'est `skills/list` qui dit en quoi.
      case 'skills/changed': {
        void this.publishSkills()
        return
      }

      case 'item/started': {
        const { item } = params as { item: ThreadItem }
        this.onItemStarted(item, params)
        return
      }

      case 'item/completed': {
        const { item } = params as { item: ThreadItem }
        this.onItemCompleted(item, params)
        return
      }

      case 'turn/started': {
        const p = params as TurnStartedNotification
        this.beginTurn(p.turn.id)
        return
      }

      /**
       * Panne en cours de tour. Quand le CLI compte réessayer lui-même (flux coupé,
       * serveur momentanément saturé), rien n'est journalisé : le tour continue et un
       * bandeau annoncerait un échec qui n'a pas eu lieu. Sinon, c'est la panne qui
       * explique le silence du fil, et elle doit s'y lire.
       */
      case 'error': {
        const p = params as ErrorNotification
        if (p.willRetry) {
          this.notice('retry', `Codex réessaie après une interruption : ${p.error.message}`, 'info')
          return
        }
        this.reportedErrorTurn = p.turnId
        this.ctx.emit(describeTurnError(p.error), p)
        return
      }

      case 'turn/completed': {
        const p = params as TurnCompletedNotification
        if (this.completedTurns.has(p.turn.id)) return
        this.completedTurns.add(p.turn.id)
        if (this.completedTurns.size > 64) this.completedTurns.delete(this.completedTurns.values().next().value!)
        if (this.turnId && this.turnId !== p.turn.id) return
        this.turnId = null
        this.clearInterruptWatchdog()
        // Un tour échoué porte sa cause. C'est ce qui manquait quand un quota épuisé
        // laissait la conversation s'arrêter sans un mot : le `turn.completed` seul
        // ne dit rien de plus qu'un tour réussi.
        if (p.turn.status === 'failed' && p.turn.error && this.reportedErrorTurn !== p.turn.id) {
          this.ctx.emit(describeTurnError(p.turn.error), p)
        }
        this.reportedErrorTurn = null
        // Le tour fini, plus personne n'attend de réponse : une sollicitation encore
        // ouverte est morte avec lui. La laisser vivante est ce qui bloquait les
        // conversations interrompues sur une demande d'approbation : le clic
        // « autoriser » suivant repassait la conversation en `running` pour un tour
        // qui n'existait plus, et rien ne pouvait plus la faire redescendre.
        this.expireTurnRequests(p.threadId, p.turn.id)
        if (p.turn.status !== 'completed') this.asyncQuestions.expireAll()
        this.ctx.emit(
          {
            type: 'turn.completed',
            stopReason: p.turn.status,
            // L'app-server ne chiffre pas le coût : sur abonnement il ne serait de
            // toute façon pas facturé, et l'inventer serait pire que l'omettre.
            costUsd: 0,
            ...this.turnUsage.finish(),
          },
          p,
        )
        this.ctx.setStatus(this.interactions.hasBlocking ? 'awaiting_input' : 'idle')
        return
      }

      case 'thread/tokenUsage/updated': {
        const p = params as ThreadTokenUsageUpdatedNotification
        this.turnUsage.update(p)
        const last = p.tokenUsage.last
        const window = p.tokenUsage.modelContextWindow

        /**
         * L'occupation du contexte est la taille d'entrée de la **dernière** requête,
         * pas le cumul du fil.
         *
         * `total.totalTokens` additionne tous les tours (12 570 puis 25 497 puis 38 794
         * sur trois tours mesurés) : rapporté à la fenêtre, il finit par dépasser 100 %
         * et ne redescend jamais, pas même après une compaction. `last.inputTokens`,
         * lui, suit le contexte réellement envoyé et inclut déjà la part mise en cache.
         *
         * Un tour sans entrée utilisateur, comme une compaction, le rapporte à zéro :
         * la jauge n'est alors pas mise à jour plutôt que d'annoncer un contexte vide.
         */
        const used = last.inputTokens
        this.ctx.emit({
          type: 'usage.updated',
          costUsd: 0,
          inputTokens: last.inputTokens,
          outputTokens: last.outputTokens,
          // Contrairement à Claude, l'app-server annonce la fenêtre spontanément :
          // aucune requête supplémentaire n'est nécessaire.
          context: window && used > 0
            ? { usedTokens: used, maxTokens: window, ratio: used / window }
            : null,
          rateLimit: null,
        })
        return
      }

      case 'turn/plan/updated': {
        const p = params as TurnPlanUpdatedNotification
        this.ctx.emit({
          type: 'plan.updated',
          items: (p.plan ?? []).map((entry) => ({
            text: entry.step,
            status:
              entry.status === 'completed'
                ? 'completed'
                : entry.status === 'inProgress'
                  ? 'in_progress'
                  : 'pending',
          })),
        })
        return
      }

      case 'account/rateLimits/updated': {
        const p = params as AccountRateLimitsUpdatedNotification
        const window = p.rateLimits.primary ?? p.rateLimits.secondary
        if (!window) return
        this.ctx.emit(
          {
            type: 'usage.updated',
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            rateLimit: {
              type: describeWindow(p.rateLimits.limitName, window.windowDurationMins, true),
              // Pas de seuil d'alerte inventé : seul un dépassement annoncé par le CLI
              // change le statut, le pourcentage parle de lui-même.
              status: p.rateLimits.rateLimitReachedType ? 'rejected' : 'allowed',
              utilization: window.usedPercent / 100,
              resetsAt: window.resetsAt,
            },
          },
          p,
        )
        return
      }

      /**
       * Codex ne nomme pas ses fils tout seul, contrairement à Claude Code : cette
       * notification n'arrive que si le fil est renommé ailleurs (TUI, `thread/name/set`).
       * Une conversation Codex garde donc l'extrait de son premier message.
       */
      case 'thread/name/updated': {
        const p = params as ThreadNameUpdatedNotification
        if (p.threadName) this.suggested = p.threadName
        return
      }

      default: {
        // Le flux `codex/event/*` est le doublon v1 du flux typé v2.
        if (method.startsWith('codex/event/') || NOTIFICATION_POLICY[method] === 'ignore') return
        // Chaque état reste au journal, mais le rendu remplace le repère précédent.
        this.notice(method, `Événement Codex : ${method}`, 'info', params,
          `codex-notice:${this.turnId ?? 'session'}:${method}`)
        return
      }
    }
  }

  private notice(code: string, message: string, level: 'info' | 'warning', details?: unknown, id?: string): void {
    this.ctx.emit({ type: 'agent.notice', id, code, message, level, details }, { method: code, params: details })
  }

  private beginTurn(id: string): void {
    if (this.turnId === id || this.completedTurns.has(id)) return
    this.turnId = id
    this.turnUsage.start(id)
    this.ctx.emit({ type: 'turn.started' })
    this.ctx.setStatus(this.interactions.hasBlocking ? 'awaiting_input' : 'running')
  }

  private ensureSubAgent(threadId: string, label: string, parent: string | null, prompt = ''): string {
    const previous = this.childThreads.get(threadId)
    if (previous?.running) return previous.toolId
    const toolId = `codex-agent-${threadId}-${randomUUID()}`
    this.childThreads.set(threadId, { toolId, parent, description: label, startedAt: Date.now(), running: true })
    this.ctx.emit({ type: 'tool.started', toolCallId: toolId, name: 'Agent',
      input: { description: label, prompt: prompt || label }, parentToolCallId: parent })
    this.ctx.emit({ type: 'task.started', taskId: threadId, toolCallId: toolId, kind: 'agent', description: label })
    this.publishSubAgents()
    return toolId
  }

  private completeSubAgent(threadId: string, output: unknown, isError = false): void {
    const agent = this.childThreads.get(threadId)
    if (!agent?.running) return
    agent.running = false
    this.publishSubAgents()
    this.ctx.emit({ type: 'tool.completed', toolCallId: agent.toolId, output, isError,
      durationMs: Date.now() - agent.startedAt })
    this.ctx.emit({ type: 'task.completed', taskId: threadId, status: isError ? 'failed' : 'completed',
      summary: typeof output === 'string' ? output : JSON.stringify(output), durationMs: Date.now() - agent.startedAt, ambient: false })
  }

  private publishSubAgents(): void {
    this.ctx.emit({ type: 'background.updated', tasks: [...this.childThreads]
      .filter(([, agent]) => agent.running)
      .map(([id, agent]) => ({ id, kind: 'agent', description: agent.description })) })
  }

  private subAgentActivity(item: Extract<ThreadItem, { type: 'subAgentActivity' }>, parent: string | null): void {
    if (item.kind === 'started' || item.kind === 'interacted') {
      this.ensureSubAgent(item.agentThreadId, item.agentPath, parent)
    } else {
      this.completeSubAgent(item.agentThreadId, { agent: item.agentPath, status: item.kind })
    }
  }

  private translateChild(method: string, params: unknown, threadId: string, parent: string): void {
    switch (method) {
      case 'turn/started': {
        const child = this.childThreads.get(threadId)!
        this.ensureSubAgent(threadId, child.description, child.parent)
        return
      }
      case 'item/started': {
        const { item } = params as { item: ThreadItem }
        this.onItemStarted(item, params, parent)
        return
      }
      case 'item/completed': {
        const { item } = params as { item: ThreadItem }
        this.onItemCompleted(item, params, parent)
        return
      }
      case 'item/agentMessage/delta':
      case 'item/plan/delta':
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        const p = params as AgentMessageDeltaNotification
        this.ctx.emit({ type: method.includes('/reasoning/') ? 'thinking.delta' : 'message.delta',
          messageId: p.itemId, text: p.delta, parentToolCallId: parent })
        return
      }
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta': {
        const p = params as CommandExecutionOutputDeltaNotification
        this.ctx.emit({ type: 'tool.output_delta', toolCallId: p.itemId, chunk: p.delta })
        return
      }
      case 'turn/completed': {
        const p = params as TurnCompletedNotification
        this.expireTurnRequests(threadId, p.turn.id)
        this.completeSubAgent(threadId, p.turn.items.filter((item) => item.type === 'agentMessage')
          .map((item) => item.text).join('\n\n') || p.turn.error?.message || p.turn.status, p.turn.status === 'failed')
        if (!this.turnId) this.ctx.setStatus(this.interactions.hasBlocking ? 'awaiting_input' : 'idle')
        return
      }
      case 'serverRequest/resolved': {
        const p = params as ServerRequestResolvedNotification
        const requestId = this.serverRequests.get(p.requestId)
        if (requestId) this.interactions.expire(requestId)
        return
      }
      default:
        if (method === 'error' || method === 'warning') this.notice(method, 'Un sous-agent Codex signale un problème.', 'warning', params)
    }
  }

  private onItemStarted(item: ThreadItem, raw: unknown, parent: string | null = null): void {
    if (this.startedItems.has(item.id) || this.completedItems.has(item.id)) return
    this.startedItems.add(item.id)
    this.durations.start(item.id)
    for (const event of startedItem(item, parent)) this.ctx.emit(event, raw)
  }

  private onItemCompleted(item: ThreadItem, raw: unknown, parent: string | null = null): void {
    if (this.completedItems.has(item.id)) return
    if (!this.startedItems.has(item.id)) this.onItemStarted(item, raw, parent)
    this.completedItems.add(item.id)
    this.startedItems.delete(item.id)
    if (this.completedItems.size > 4096) this.completedItems.delete(this.completedItems.values().next().value!)
    for (const event of completedItem(item, this.ctx.cwd, this.durations.stop(item.id), parent)) {
      this.ctx.emit(event, raw)
    }
    if (item.type === 'agentMessage') this.asyncQuestions.request(item, raw)
    if (item.type === 'subAgentActivity') this.subAgentActivity(item, parent)
    if (item.type === 'collabAgentToolCall') {
      for (const threadId of item.receiverThreadIds) {
        const state = item.agentsStates[threadId]
        if (['spawnAgent', 'resumeAgent', 'sendInput', 'followupTask'].includes(item.tool) && item.status !== 'failed') {
          this.ensureSubAgent(threadId, threadId, parent, item.prompt ?? '')
        }
        if (state && ['completed', 'errored', 'shutdown', 'interrupted', 'notFound'].includes(state.status)) {
          this.completeSubAgent(threadId, state.message ?? state.status, state.status === 'errored' || state.status === 'notFound')
        }
      }
    }
  }

  /**
   * Les trois requêtes d'approbation de Codex deviennent le même événement que
   * `canUseTool` côté Claude : une seule UI de permission couvre les deux CLI.
   */
  private async handleServerRequest(method: string, params: unknown, rpcId: RequestId): Promise<unknown> {
    const scope = params as { threadId?: string; turnId?: string } | null
    this.requestScopes.set(rpcId, { threadId: scope?.threadId ?? this.threadId, turnId: scope?.turnId ?? null })
    try { return await this.dispatchServerRequest(method, params, rpcId) }
    finally { this.requestScopes.delete(rpcId) }
  }

  private expireTurnRequests(threadId: string, turnId: string): void {
    for (const [rpcId, requestId] of this.serverRequests) {
      const scope = this.requestScopes.get(rpcId)
      if (scope?.threadId === threadId && (scope.turnId === null || scope.turnId === turnId)) {
        this.interactions.expire(requestId)
      }
    }
  }

  private dispatchServerRequest(method: string, params: unknown, rpcId: RequestId): Promise<unknown> {
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const p = params as CommandExecutionRequestApprovalParams
        return this.askPermission(
          rpcId, 'Bash',
          { command: p.command, cwd: p.cwd, reason: p.reason, kind: p.kind, network: p.networkApprovalContext },
          (allowed, scope): CommandExecutionRequestApprovalResponse => ({
            decision: allowed ? (scope === 'session' ? 'acceptForSession' : 'accept') : 'decline',
          }),
        )
      }

      case 'item/fileChange/requestApproval': {
        const p = params as FileChangeRequestApprovalParams
        return this.askPermission(
          rpcId, 'Edit',
          { reason: p.reason, grantRoot: p.grantRoot },
          (allowed, scope): FileChangeRequestApprovalResponse => ({
            decision: allowed ? (scope === 'session' ? 'acceptForSession' : 'accept') : 'decline',
          }),
        )
      }

      case 'item/permissions/requestApproval': {
        const p = params as PermissionsRequestApprovalParams
        return this.askPermission(
          rpcId, 'Permissions',
          { reason: p.reason, cwd: p.cwd, permissions: p.permissions },
          (allowed, scope): PermissionsRequestApprovalResponse => ({
            // Refuser, c'est n'accorder aucune permission : le protocole n'a pas de
            // variante « refus », il attend le profil réellement accordé.
            //
            // Accorder, c'est recopier le profil demandé, à ceci près qu'un volet
            // non demandé y vaut `null` alors que le profil accordé le veut absent.
            permissions: allowed
              ? {
                  network: p.permissions.network ?? undefined,
                  fileSystem: p.permissions.fileSystem ?? undefined,
                }
              : {},
            scope: scope === 'session' ? 'session' : 'turn',
          }),
        )
      }

      case 'item/tool/requestUserInput': {
        const p = params as ToolRequestUserInputParams
        return this.askQuestion(p, rpcId)
      }

      case 'mcpServer/elicitation/request': {
        const p = params as McpServerElicitationRequestParams
        return this.askElicitation(p, rpcId)
      }

      default:
        this.notice(method, `Codex demande une interaction non prise en charge : ${method}.`, 'warning', params)
        return Promise.reject(new CodexRpcError(`Requête serveur non gérée : ${method}`, -32601))
    }
  }

  private askQuestion(params: ToolRequestUserInputParams, rpcId: RequestId): Promise<ToolRequestUserInputResponse> {
    return new Promise<ToolRequestUserInputResponse>((resolve) => {
      const requestId = this.interactions.requestQuestion(toQuestions(params), (answer) => {
        this.serverRequests.delete(rpcId)
        // Une annulation ou une expiration renvoie un jeu de réponses vide : le
        // protocole n'a pas de variante « pas de réponse », et laisser la requête
        // sans réponse figerait le tour.
        const answers = answer === null || answer.status === 'cancelled' ? {} : answer.answers
        resolve({
          answers: Object.fromEntries(
            Object.entries(answers).map(([id, values]) => [id, { answers: values }]),
          ),
        })
      }, params.isBlocking !== false)
      this.serverRequests.set(rpcId, requestId)
    })
  }

  async answerQuestion(requestId: string, answer: QuestionAnswer): Promise<boolean> {
    if (this.interactions.resolveQuestion(requestId, answer)) return true
    return this.asyncQuestions.answer(requestId, answer, async (text, clientMessageId, threadId) => {
      if (!this.client || !this.threadId) throw new Error('La session Codex est fermée.')
      const input: UserInput[] = [{ type: 'text', text, text_elements: [] }]
      const child = threadId && threadId !== this.threadId ? this.childThreads.get(threadId) : null
      if (child && threadId) await this.client.call('turn/start', { threadId, input, clientUserMessageId: clientMessageId })
      else await this.startTurn(input, clientMessageId)
      this.ctx.emit({ type: 'message.completed', messageId: clientMessageId, role: 'user',
        blocks: [{ type: 'text', text }], parentToolCallId: child?.toolId ?? null })
    })
  }

  /**
   * Élicitation MCP.
   *
   * Auparavant cette requête tombait dans le `default:` qui rejette, donc un serveur MCP
   * qui réclamait une saisie faisait échouer le tour entier. C'est le seul des trois
   * canaux d'interaction dont l'absence provoquait une panne et pas seulement un manque.
   */
  private askElicitation(
    params: McpServerElicitationRequestParams,
    rpcId: RequestId,
  ): Promise<McpServerElicitationRequestResponse> {
    return new Promise<McpServerElicitationRequestResponse>((resolve) => {
      const requestId = this.interactions.requestElicitation(
        {
          serverName: params.serverName,
          // `openai/form` est un formulaire dont le schéma n'est pas typé par le
          // protocole : il passe par le même analyseur, tolérant à ce qu'il ne
          // reconnaît pas.
          mode: params.mode === 'url' ? 'url' : 'form',
          message: params.message,
          url: params.mode === 'url' ? params.url : null,
          fields: params.mode === 'url' ? [] : parseElicitationFields(params.requestedSchema),
          title: null,
        },
        (answer) => {
          this.serverRequests.delete(rpcId)
          if (answer === null) {
            // `cancel` plutôt que `decline` : le serveur MCP distingue un refus
            // explicite d'une demande qui n'a jamais atteint personne.
            resolve({ action: 'cancel', content: null, _meta: null })
            return
          }
          resolve({
            action: answer.action,
            content: answer.action === 'accept' ? answer.content : null,
            _meta: null,
          })
        },
      )
      this.serverRequests.set(rpcId, requestId)
    })
  }

  resolveElicitation(requestId: string, answer: ElicitationAnswer): boolean {
    return this.interactions.resolveElicitation(requestId, answer)
  }

  /**
   * Codex ne soumet pas de plan à validation : son mode plan produit un item de fil,
   * pas une requête bloquante. Renvoyer false le dit franchement plutôt que de faire
   * croire à une décision prise.
   */
  reviewPlan(_requestId: string, _review: PlanReview): boolean {
    return false
  }

  private askPermission<T>(
    rpcId: RequestId,
    toolName: string,
    input: unknown,
    buildResponse: (allowed: boolean, scope: PermissionDecision['scope']) => T,
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      const requestId = this.interactions.requestPermission({ toolName, input }, (decision) => {
        this.serverRequests.delete(rpcId)
        // Une expiration vaut refus ponctuel : le CLI reçoit la même réponse qu'un
        // « non », il n'a pas de variante « resté sans réponse ».
        const allowed = decision !== null && decision.decision === 'allowed'
        resolve(buildResponse(allowed, decision?.scope ?? 'once'))
      })
      this.serverRequests.set(rpcId, requestId)
    })
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    return this.interactions.resolvePermission(requestId, decision)
  }

  async send(
    text: string,
    attachments: OutgoingAttachment[],
    mentions: OutgoingMention[],
    skills: string[],
  ): Promise<void> {
    if (!this.client || !this.threadId) throw new Error('La session Codex n\'est pas démarrée.')

    const { blocks, input } = buildUserInput(text, attachments, mentions, this.resolveSkills(skills))
    this.ctx.emit({
      type: 'message.completed',
      messageId: randomUUID(),
      role: 'user',
      blocks,
      parentToolCallId: null,
    })
    this.ctx.setStatus('running')

    try {
      await this.startTurn(input)
    } catch (error) {
      if (!this.turnId && this.client) this.ctx.setStatus('idle')
      throw error
    }
  }

  private async startTurn(input: UserInput[], clientUserMessageId?: string): Promise<void> {
    if (!this.client || !this.threadId) throw new Error('La session Codex est fermée.')
    // La configuration est passée à chaque tour : c'est le protocole qui le prévoit,
    // et c'est ce qui rend le changement de réglage immédiat.
    const turn = await this.client.callExperimental<TurnStartResponse>('turn/start', {
      threadId: this.threadId,
      clientUserMessageId,
      input,
      cwd: this.ctx.cwd,
      approvalPolicy: this.approvalPolicy(),
      sandboxPolicy: this.sandboxPolicy(),
      model: this.config.model,
      effort: this.config.reasoningEffort || null,
      collaborationMode: this.collaborationMode(),
    } satisfies ExperimentalTurnStartParams)
    // Les notifications peuvent précéder la réponse RPC, y compris la clôture.
    if (turn.turn.status === 'inProgress' && !this.completedTurns.has(turn.turn.id)) {
      // Certaines versions répondent sans notification turn/started.
      this.beginTurn(turn.turn.id)
    }
  }

  /**
   * Mode de collaboration du tour, ou null quand le modèle réel n'est pas encore connu.
   *
   * `settings.model` n'est pas facultatif côté protocole, et le modèle de la
   * conversation peut valoir la sentinelle « défaut du CLI » : c'est alors celui que
   * `thread/start` a annoncé qui fait foi. Sans lui, plutôt que d'inventer un
   * identifiant, on n'envoie pas le mode.
   */
  private collaborationMode(): CollaborationMode | null {
    const model = this.config.model || this.threadModel
    if (!model) return null

    return {
      mode: this.config.collaborationMode,
      settings: {
        model,
        // L'effort du mode reste celui de la conversation : le préréglage du CLI en
        // propose un, mais l'appliquer écraserait en silence le choix de l'utilisateur.
        reasoning_effort: this.config.reasoningEffort || null,
        developer_instructions: null,
      },
    }
  }

  /**
   * Infléchit le tour en cours.
   *
   * `expectedTurnId` est une précondition du protocole : la requête échoue si le tour
   * a changé entre l'affichage et le clic, ce qui est exactement le comportement voulu.
   * Le tour garde son identifiant, vérifié sur le CLI installé : infléchir ne relance
   * rien, l'agent change de cap à l'intérieur du tour déjà commencé.
   *
   * Le message est journalisé ici, comme dans `send` : l'app-server le renvoie aussi
   * en écho sous forme d'item `userMessage`, que le traducteur ignore justement pour
   * ne pas l'écrire deux fois.
   */
  async steer(
    text: string,
    attachments: OutgoingAttachment[],
    mentions: OutgoingMention[],
    skills: string[],
  ): Promise<boolean> {
    if (!this.client || !this.threadId || !this.turnId) return false

    const { blocks, input } = buildUserInput(text, attachments, mentions, this.resolveSkills(skills))
    await this.client.call('turn/steer', {
      threadId: this.threadId,
      expectedTurnId: this.turnId,
      input,
    })

    this.ctx.emit({
      type: 'message.completed',
      messageId: randomUUID(),
      role: 'user',
      blocks,
      parentToolCallId: null,
    })
    return true
  }

  /**
   * Compaction. Contrairement à Claude, l'app-server a une requête dédiée : rien ne
   * transite par le fil de conversation.
   */
  async compact(): Promise<boolean> {
    if (!this.client || !this.threadId) return false
    await this.client.call('thread/compact/start', { threadId: this.threadId })
    // Rien dans les notifications ne distingue un tour de compaction d'un tour
    // ordinaire : c'est la requête, ici, qui sait ce qu'elle vient de lancer.
    this.ctx.emit({ type: 'context.compaction_started' })
    return true
  }

  /** L'arrêt ciblé depuis la liste des tâches n'est pas exposé par cet adaptateur. */
  async stopBackgroundTask(): Promise<boolean> {
    return false
  }

  async applyConfig(config: AgentConfig): Promise<boolean> {
    if (config.agent !== 'codex') return false
    this.config = config
    return true
  }

  async suggestedTitle(): Promise<string | null> {
    return this.suggested
  }

  async interrupt(): Promise<void> {
    this.asyncQuestions.expireAll()
    // Sans tour en cours il n'y a rien à interrompre : le protocole exige un turnId.
    // Le geste reste une sortie pour autant : si la conversation se croit occupée
    // sans tour ouvert, un retour silencieux la laisserait ainsi pour de bon.
    if (!this.client || !this.threadId || !this.turnId) {
      this.interactions.expireAll()
      this.ctx.setStatus('idle')
      return
    }
    const interrupted = this.turnId
    await this.client.call('turn/interrupt', { threadId: this.threadId, turnId: this.turnId })

    // Pas de passage à `idle` ici : l'app-server clôt le tour de son côté et envoie
    // `turn/completed`, qui fait foi. L'annoncer avant ferait partir un message en
    // file pendant que le tour interrompu se termine encore. Le garde-fou couvre le
    // cas où cette clôture ne vient jamais (approbation restée sans réponse, par
    // exemple) : sans lui, la conversation resterait occupée jusqu'à l'échéance
    // d'inactivité et les messages suivants seraient mis en file pour rien.
    this.clearInterruptWatchdog()
    this.interruptWatchdog = setTimeout(() => {
      if (this.turnId !== interrupted) return
      this.turnId = null
      this.interactions.expireAll()
      this.ctx.setStatus('idle')
    }, INTERRUPT_GRACE_MS)
    this.interruptWatchdog.unref()
  }

  private clearInterruptWatchdog(): void {
    if (this.interruptWatchdog) clearTimeout(this.interruptWatchdog)
    this.interruptWatchdog = null
  }

  async stop(): Promise<void> {
    this.asyncQuestions.expireAll()
    this.clearInterruptWatchdog()
    this.interactions.expireAll()
    this.client?.close()
    this.client = null
  }
}
