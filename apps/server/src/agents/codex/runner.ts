import { randomUUID } from 'node:crypto'
import {
  CLI_DEFAULT,
  parseElicitationFields,
  type AgentConfig,
  type AgentQuestion,
  type CodexConfig,
  type ContentBlock,
  type McpServer,
  type McpServerStatus,
} from '@sillage/protocol'
import type { CollaborationMode } from '@sillage/codex-bindings'
import type {
  AccountRateLimitsUpdatedNotification,
  AskForApproval,
  AgentMessageDeltaNotification,
  CommandExecutionOutputDeltaNotification,
  CommandExecutionRequestApprovalParams,
  FileChangeRequestApprovalParams,
  ListMcpServerStatusResponse,
  McpServerElicitationRequestParams,
  McpServerStatusUpdatedNotification,
  PatchChangeKind,
  McpServerElicitationRequestResponse,
  PermissionsRequestApprovalParams,
  ReasoningTextDeltaNotification,
  SandboxPolicy,
  ThreadItem,
  ThreadNameUpdatedNotification,
  ThreadStartResponse,
  ThreadTokenUsageUpdatedNotification,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
  TurnCompletedNotification,
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
import { toWorkspacePath } from '../paths.js'
import { ToolDurations } from '../tool-durations.js'
import { failedStatuses } from '../mcp-registry.js'
import { CodexAppServerClient } from './app-server-client.js'
import { CLIENT_INFO } from './client-info.js'
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

/** Vocabulaire de `PatchChangeKind` vers celui du journal. */
const FILE_ACTIONS: Record<PatchChangeKind['type'], 'created' | 'modified' | 'deleted'> = {
  add: 'created',
  update: 'modified',
  delete: 'deleted',
}

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

const IGNORED_NOTIFICATIONS = new Set([
  'thread/status/changed',
  'item/reasoning/summaryPartAdded',
  'thread/loaded/list',
  'configWarning',
  'remoteControl/status/changed',
  'model/safetyBuffering/updated',
  'fuzzyFileSearch/sessionUpdated',
  'fuzzyFileSearch/sessionCompleted',
])

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
): { blocks: ContentBlock[]; input: UserInput[] } {
  const { blocks, promptText } = describeOutgoingMessage(text, attachments)
  const input: UserInput[] = []

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
    allowOther: question.isOther || question.options === null,
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
  private config: CodexConfig
  private readonly interactions: PendingInteractions
  private readonly durations = new ToolDurations()
  /** Nom que Codex donne au fil, annoncé par `thread/name/updated`. */
  private suggested: string | null = null
  /** Tour en cours : `turn/interrupt` l'exige, contrairement au SDK Claude. */
  private turnId: string | null = null
  /** Garde-fou d'interruption : force `idle` si le CLI ne clôt jamais le tour. */
  private interruptWatchdog: NodeJS.Timeout | null = null
  /** Modèle réellement retenu par le CLI, seul connu quand la conversation dit « défaut ». */
  private threadModel: string | null = null

  constructor(private readonly ctx: RunnerContext) {
    this.conversationId = ctx.conversationId
    this.config = ctx.config as CodexConfig
    this.interactions = new PendingInteractions(ctx)
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
      onNotification: (method, params) => this.translate(method, params),
      onServerRequest: (method, params) => this.handleServerRequest(method, params),
      onExit: (code) => this.onProcessExit(code),
    })

    await this.client.initialize(CLIENT_INFO)

    const resolved = this.ctx.resolveMcpServers(this.config.mcpServers)
    this.mcpServers = resolved.servers
    this.mcpFailures = failedStatuses(resolved.failures)
    // Repassé au `thread/resume` autant qu'au `thread/start`, et ce n'est pas une
    // précaution : une surcharge de thread n'est pas persistée avec le thread. Sondé,
    // un thread créé avec des serveurs MCP puis repris sans cette configuration les
    // perd entièrement, sans erreur ni trace. Ne pas simplifier.
    const threadConfig = toCodexThreadConfig(this.mcpServers)

    const started = this.ctx.resumeSessionId
      ? await this.client.call<ThreadStartResponse, 'thread/resume'>('thread/resume', {
          threadId: this.ctx.resumeSessionId,
          cwd: this.ctx.cwd,
          approvalPolicy: this.approvalPolicy(),
          sandbox: this.config.sandbox,
          model: this.config.model,
          config: threadConfig,
        })
      : await this.client.call<ThreadStartResponse, 'thread/start'>('thread/start', {
          cwd: this.ctx.cwd,
          approvalPolicy: this.approvalPolicy(),
          sandbox: this.config.sandbox,
          model: this.config.model,
          config: threadConfig,
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
      const inventory = await client.call<ListMcpServerStatusResponse, 'mcpServerStatus/list'>(
        'mcpServerStatus/list',
        { threadId, detail: 'toolsAndAuthOnly' },
      )
      // Même raison que côté Claude : un serveur écarté faute d'un secret n'a jamais
      // été transmis, donc l'inventaire du CLI l'ignore.
      const servers = [
        ...this.mcpFailures,
        ...fromCodexMcpStatus(inventory.data, this.mcpServers, this.mcpStartup),
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
    this.ctx.emit({
      type: 'error',
      code: 'runner_failed',
      message: `codex app-server s'est arrêté de façon inattendue (code ${code ?? 'inconnu'}).`,
      recoverable: true,
    })
    this.ctx.emit({ type: 'session.ended', reason: 'interrupted' })
    this.ctx.setStatus('error')
  }

  private translate(method: string, params: unknown): void {
    switch (method) {
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

      case 'mcpServer/startupStatus/updated': {
        const p = params as McpServerStatusUpdatedNotification
        this.mcpStartup.set(p.name, { status: p.status, error: p.error })
        void this.publishMcpStatus()
        return
      }

      case 'item/started': {
        const { item } = params as { item: ThreadItem }
        this.durations.start(item.id)
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
        this.turnId = p.turn.id
        this.ctx.emit({ type: 'turn.started' })
        this.ctx.setStatus('running')
        return
      }

      case 'turn/completed': {
        const p = params as TurnCompletedNotification
        this.turnId = null
        this.clearInterruptWatchdog()
        this.ctx.emit(
          {
            type: 'turn.completed',
            stopReason: p.turn.status,
            // L'app-server ne chiffre pas le coût : sur abonnement il ne serait de
            // toute façon pas facturé, et l'inventer serait pire que l'omettre.
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
          p,
        )
        this.ctx.setStatus('idle')
        return
      }

      case 'thread/tokenUsage/updated': {
        const p = params as ThreadTokenUsageUpdatedNotification
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
        const p = params as { plan?: { text: string; status: string }[] }
        this.ctx.emit({
          type: 'plan.updated',
          items: (p.plan ?? []).map((entry) => ({
            text: entry.text,
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
        if (IGNORED_NOTIFICATIONS.has(method)) return
        // Non traduite : conservée brute dans le journal plutôt que perdue, sans
        // polluer le fil avec un type que l'UI ne saurait pas rendre.
        return
      }
    }
  }

  private onItemStarted(item: ThreadItem, raw: unknown): void {
    if (item.type === 'commandExecution') {
      this.ctx.emit(
        {
          type: 'tool.started',
          toolCallId: item.id,
          name: 'Bash',
          input: { command: item.command, cwd: item.cwd },
          parentToolCallId: null,
        },
        raw,
      )
    } else if (item.type === 'fileChange') {
      this.ctx.emit(
        {
          type: 'tool.started',
          toolCallId: item.id,
          name: 'Edit',
          input: { changes: item.changes },
          parentToolCallId: null,
        },
        raw,
      )
    } else if (item.type === 'mcpToolCall') {
      this.ctx.emit(
        {
          type: 'tool.started',
          toolCallId: item.id,
          name: `${item.server}/${item.tool}`,
          input: item.arguments,
          parentToolCallId: null,
        },
        raw,
      )
    } else if (item.type === 'webSearch') {
      this.ctx.emit(
        {
          type: 'tool.started',
          toolCallId: item.id,
          name: 'WebSearch',
          input: { query: item.query },
          parentToolCallId: null,
        },
        raw,
      )
    }
  }

  private onItemCompleted(item: ThreadItem, raw: unknown): void {
    const durationMs = this.durations.stop(item.id)

    switch (item.type) {
      case 'agentMessage': {
        const blocks: ContentBlock[] = [{ type: 'text', text: item.text }]
        this.ctx.emit(
          { type: 'message.completed', messageId: item.id, role: 'assistant', blocks, parentToolCallId: null },
          raw,
        )
        return
      }

      case 'reasoning': {
        const text = [...item.summary, ...item.content].join('\n\n')
        if (!text) return
        this.ctx.emit(
          {
            type: 'message.completed',
            messageId: item.id,
            role: 'assistant',
            blocks: [{ type: 'thinking', text }],
            parentToolCallId: null,
          },
          raw,
        )
        return
      }

      case 'commandExecution': {
        this.ctx.emit(
          {
            type: 'tool.completed',
            toolCallId: item.id,
            output: item.aggregatedOutput,
            isError: item.status === 'failed' || item.status === 'declined',
            durationMs,
          },
          raw,
        )
        return
      }

      case 'fileChange': {
        this.ctx.emit(
          {
            type: 'tool.completed',
            toolCallId: item.id,
            output: item.changes,
            isError: item.status === 'failed' || item.status === 'declined',
            durationMs,
          },
          raw,
        )

        // Codex, contrairement à Claude, nomme lui-même la nature du changement : le
        // `kind` de chaque entrée dit s'il s'agit d'un ajout, d'une réécriture ou
        // d'une suppression, il n'y a rien à déduire.
        if (item.status === 'completed') {
          for (const change of item.changes) {
            this.ctx.emit({
              type: 'file.edited',
              toolCallId: item.id,
              path: toWorkspacePath(this.ctx.cwd, change.path),
              action: FILE_ACTIONS[change.kind.type],
            })
          }
        }
        return
      }

      case 'mcpToolCall': {
        this.ctx.emit(
          {
            type: 'tool.completed',
            toolCallId: item.id,
            output: item.result ?? item.error,
            isError: item.error !== null,
            durationMs,
          },
          raw,
        )
        return
      }

      case 'contextCompaction': {
        // L'item de Codex ne porte qu'un identifiant : ni le déclencheur ni le nombre
        // de tokens d'avant ne sont transmis, contrairement à Claude.
        this.ctx.emit(
          { type: 'context.compacted', trigger: 'unknown', preTokens: null, postTokens: null },
          raw,
        )
        return
      }

      case 'webSearch': {
        this.ctx.emit(
          {
            type: 'tool.completed',
            toolCallId: item.id,
            output: { query: item.query },
            isError: false,
            durationMs,
          },
          raw,
        )
        return
      }

      default:
        // Les autres items (userMessage, plan, compaction...) sont soit déjà
        // journalisés par send(), soit sans rendu propre à ce stade.
        return
    }
  }

  /**
   * Les trois requêtes d'approbation de Codex deviennent le même événement que
   * `canUseTool` côté Claude : une seule UI de permission couvre les deux CLI.
   */
  private handleServerRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const p = params as CommandExecutionRequestApprovalParams
        return this.askPermission('Bash', { command: p.command, cwd: p.cwd, reason: p.reason }, (allowed, scope) => ({
          decision: allowed ? (scope === 'session' ? 'acceptForSession' : 'accept') : 'decline',
        }))
      }

      case 'item/fileChange/requestApproval': {
        const p = params as FileChangeRequestApprovalParams
        return this.askPermission('Edit', { reason: p.reason, grantRoot: p.grantRoot }, (allowed, scope) => ({
          decision: allowed ? (scope === 'session' ? 'acceptForSession' : 'accept') : 'decline',
        }))
      }

      case 'item/permissions/requestApproval': {
        const p = params as PermissionsRequestApprovalParams
        return this.askPermission(
          'Permissions',
          { reason: p.reason, cwd: p.cwd, permissions: p.permissions },
          (allowed, scope) => ({
            // Refuser, c'est n'accorder aucune permission : le protocole n'a pas de
            // variante « refus », il attend le profil réellement accordé.
            permissions: allowed ? p.permissions : {},
            scope: scope === 'session' ? 'session' : 'turn',
          }),
        )
      }

      case 'item/tool/requestUserInput': {
        const p = params as ToolRequestUserInputParams
        return this.askQuestion(p)
      }

      case 'mcpServer/elicitation/request': {
        const p = params as McpServerElicitationRequestParams
        return this.askElicitation(p)
      }

      default:
        return Promise.reject(new Error(`Requête serveur non gérée : ${method}`))
    }
  }

  private askQuestion(params: ToolRequestUserInputParams): Promise<ToolRequestUserInputResponse> {
    return new Promise<ToolRequestUserInputResponse>((resolve) => {
      this.interactions.requestQuestion(toQuestions(params), (answer) => {
        // Une annulation ou une expiration renvoie un jeu de réponses vide : le
        // protocole n'a pas de variante « pas de réponse », et laisser la requête
        // sans réponse figerait le tour.
        const answers = answer === null || answer.status === 'cancelled' ? {} : answer.answers
        resolve({
          answers: Object.fromEntries(
            Object.entries(answers).map(([id, values]) => [id, { answers: values }]),
          ),
        })
      })
    })
  }

  answerQuestion(requestId: string, answer: QuestionAnswer): boolean {
    return this.interactions.resolveQuestion(requestId, answer)
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
  ): Promise<McpServerElicitationRequestResponse> {
    return new Promise<McpServerElicitationRequestResponse>((resolve) => {
      this.interactions.requestElicitation(
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

  private askPermission(
    toolName: string,
    input: unknown,
    buildResponse: (allowed: boolean, scope: PermissionDecision['scope']) => unknown,
  ): Promise<unknown> {
    return new Promise((resolve) => {
      this.interactions.requestPermission({ toolName, input }, (decision) => {
        // Une expiration vaut refus ponctuel : le CLI reçoit la même réponse qu'un
        // « non », il n'a pas de variante « resté sans réponse ».
        const allowed = decision !== null && decision.decision === 'allowed'
        resolve(buildResponse(allowed, decision?.scope ?? 'once'))
      })
    })
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    return this.interactions.resolvePermission(requestId, decision)
  }

  async send(
    text: string,
    attachments: OutgoingAttachment[],
    mentions: OutgoingMention[],
  ): Promise<void> {
    if (!this.client || !this.threadId) throw new Error('La session Codex n\'est pas démarrée.')

    const { blocks, input } = buildUserInput(text, attachments, mentions)
    this.ctx.emit({
      type: 'message.completed',
      messageId: randomUUID(),
      role: 'user',
      blocks,
      parentToolCallId: null,
    })
    this.ctx.setStatus('running')

    // La configuration est passée à chaque tour : c'est le protocole qui le prévoit,
    // et c'est ce qui rend le changement de réglage immédiat.
    const turn = await this.client.callExperimental<TurnStartResponse>('turn/start', {
      threadId: this.threadId,
      input,
      cwd: this.ctx.cwd,
      approvalPolicy: this.approvalPolicy(),
      sandboxPolicy: this.sandboxPolicy(),
      model: this.config.model,
      effort: this.config.reasoningEffort || null,
      collaborationMode: this.collaborationMode(),
    } satisfies ExperimentalTurnStartParams)
    this.turnId = turn.turn.id
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
  ): Promise<boolean> {
    if (!this.client || !this.threadId || !this.turnId) return false

    const { blocks, input } = buildUserInput(text, attachments, mentions)
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

  async applyConfig(config: AgentConfig): Promise<boolean> {
    if (config.agent !== 'codex') return false
    this.config = config
    return true
  }

  async suggestedTitle(): Promise<string | null> {
    return this.suggested
  }

  async interrupt(): Promise<void> {
    // Sans tour en cours il n'y a rien à interrompre : le protocole exige un turnId.
    if (!this.client || !this.threadId || !this.turnId) return
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
    this.clearInterruptWatchdog()
    this.interactions.expireAll()
    this.client?.close()
    this.client = null
  }
}
