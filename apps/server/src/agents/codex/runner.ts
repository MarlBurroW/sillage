import { randomUUID } from 'node:crypto'
import {
  CLI_DEFAULT,
  parseElicitationFields,
  type AgentConfig,
  type AgentQuestion,
  type CodexConfig,
  type ContentBlock,
} from '@sillage/protocol'
import type { CollaborationMode } from '@sillage/protocol/codex'
import type {
  AccountRateLimitsUpdatedNotification,
  AskForApproval,
  AgentMessageDeltaNotification,
  CommandExecutionOutputDeltaNotification,
  CommandExecutionRequestApprovalParams,
  FileChangeRequestApprovalParams,
  McpServerElicitationRequestParams,
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
} from '@sillage/protocol/codex/v2'
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
import { toWorkspacePath } from '../claude/file-edits.js'
import { CodexAppServerClient } from './app-server-client.js'
import { CLIENT_INFO } from './client-info.js'

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
const IGNORED_NOTIFICATIONS = new Set([
  'thread/status/changed',
  'item/reasoning/summaryPartAdded',
  'thread/loaded/list',
  'configWarning',
  'remoteControl/status/changed',
  'model/safetyBuffering/updated',
  'fuzzyFileSearch/sessionUpdated',
  'fuzzyFileSearch/sessionCompleted',
  'mcpServer/startupStatus/updated',
])

/** Libellé de fenêtre de quota, à partir de ce que le CLI annonce. */
function describeWindow(limitName: string | null, durationMins: number | null): string {
  if (limitName) return limitName
  if (durationMins === null) return 'quota'
  if (durationMins < 60) return `${durationMins} min`
  const hours = durationMins / 60
  // 168 h se lit mal : au-delà d'une journée, on exprime en jours.
  return hours >= 24 && hours % 24 === 0 ? `${hours / 24} j` : `${Math.round(hours)} h`
}

/**
 * Traduit un message et ses pièces jointes pour l'app-server.
 *
 * Codex accepte un chemin local pour les images (`localImage`), là où Claude exige du
 * base64 : c'est le protocole de chacun qui décide, pas une préférence de Sillage.
 */
function buildUserInput(
  text: string,
  attachments: OutgoingAttachment[],
  mentions: OutgoingMention[],
): { blocks: ContentBlock[]; input: UserInput[] } {
  const blocks: ContentBlock[] = []
  const input: UserInput[] = []

  const files = attachments.filter((entry) => !entry.inlineImage)
  const promptText = files.length
    ? [text, '', 'Fichiers joints à ce message :', ...files.map((f) => `- ${f.filename} : ${f.path}`)]
        .join('\n')
        .trim()
    : text

  if (promptText) {
    blocks.push({ type: 'text', text })
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
      blocks.push({
        type: 'image',
        mimeType: attachment.mimeType,
        url: `/api/attachments/${attachment.id}`,
      })
    } else {
      blocks.push({
        type: 'file',
        name: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        url: `/api/attachments/${attachment.id}`,
      })
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

/** Une demande d'approbation en attente, avec la façon d'y répondre. */
interface PendingApproval {
  respond: (allowed: boolean, scope: PermissionDecision['scope']) => unknown
}

/** Une question en attente, avec la façon de renvoyer les réponses au CLI. */
interface PendingQuestion {
  respond: (answers: Record<string, string[]>) => void
}

/** Une élicitation MCP en attente. */
interface PendingElicitation {
  respond: (answer: ElicitationAnswer) => void
}

export class CodexRunner implements AgentRunner {
  readonly conversationId: string

  private client: CodexAppServerClient | null = null
  private threadId: string | null = null
  private config: CodexConfig
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private readonly pendingQuestions = new Map<string, PendingQuestion>()
  private readonly pendingElicitations = new Map<string, PendingElicitation>()
  private readonly itemStartedAt = new Map<string, number>()
  /** Nom que Codex donne au fil, annoncé par `thread/name/updated`. */
  private suggested: string | null = null
  /** Tour en cours : `turn/interrupt` l'exige, contrairement au SDK Claude. */
  private turnId: string | null = null
  /** Modèle réellement retenu par le CLI, seul connu quand la conversation dit « défaut ». */
  private threadModel: string | null = null

  constructor(private readonly ctx: RunnerContext) {
    this.conversationId = ctx.conversationId
    this.config = ctx.config as CodexConfig
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

    const started = this.ctx.resumeSessionId
      ? await this.client.call<ThreadStartResponse, 'thread/resume'>('thread/resume', {
          threadId: this.ctx.resumeSessionId,
          cwd: this.ctx.cwd,
          approvalPolicy: this.approvalPolicy(),
          sandbox: this.config.sandbox,
          model: this.config.model,
        })
      : await this.client.call<ThreadStartResponse, 'thread/start'>('thread/start', {
          cwd: this.ctx.cwd,
          approvalPolicy: this.approvalPolicy(),
          sandbox: this.config.sandbox,
          model: this.config.model,
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
    this.expirePending()
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
        this.ctx.emit({ type: 'message.delta', messageId: p.itemId, text: p.delta })
        return
      }

      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        const p = params as ReasoningTextDeltaNotification
        this.ctx.emit({ type: 'thinking.delta', messageId: p.itemId, text: p.delta })
        return
      }

      case 'item/commandExecution/outputDelta': {
        const p = params as CommandExecutionOutputDeltaNotification
        this.ctx.emit({ type: 'tool.output_delta', toolCallId: p.itemId, chunk: p.delta })
        return
      }

      case 'item/started': {
        const { item } = params as { item: ThreadItem }
        this.itemStartedAt.set(item.id, Date.now())
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
              type: describeWindow(p.rateLimits.limitName, window.windowDurationMins),
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
    const startedAt = this.itemStartedAt.get(item.id)
    this.itemStartedAt.delete(item.id)
    const durationMs = startedAt ? Date.now() - startedAt : 0

    switch (item.type) {
      case 'agentMessage': {
        const blocks: ContentBlock[] = [{ type: 'text', text: item.text }]
        this.ctx.emit({ type: 'message.completed', messageId: item.id, role: 'assistant', blocks }, raw)
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
    const requestId = randomUUID()
    this.ctx.setStatus('awaiting_input')
    this.ctx.emit({ type: 'question.requested', requestId, questions: toQuestions(params) })

    return new Promise<ToolRequestUserInputResponse>((resolve) => {
      this.pendingQuestions.set(requestId, {
        respond: (answers) => {
          resolve({
            answers: Object.fromEntries(
              Object.entries(answers).map(([id, values]) => [id, { answers: values }]),
            ),
          })
        },
      })
    })
  }

  answerQuestion(requestId: string, answer: QuestionAnswer): boolean {
    const pending = this.pendingQuestions.get(requestId)
    if (!pending) return false
    this.pendingQuestions.delete(requestId)

    this.ctx.emit({
      type: 'question.resolved',
      requestId,
      status: answer.status,
      answers: answer.answers,
      decidedBy: answer.decidedBy,
    })

    // Une annulation renvoie un jeu de réponses vide : le protocole n'a pas de
    // variante « pas de réponse », et laisser la requête sans réponse figerait le tour.
    pending.respond(answer.status === 'cancelled' ? {} : answer.answers)
    this.ctx.setStatus('running')
    return true
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
    const requestId = randomUUID()
    this.ctx.setStatus('awaiting_input')

    this.ctx.emit({
      type: 'elicitation.requested',
      requestId,
      serverName: params.serverName,
      // `openai/form` est un formulaire dont le schéma n'est pas typé par le protocole :
      // il passe par le même analyseur, tolérant à ce qu'il ne reconnaît pas.
      mode: params.mode === 'url' ? 'url' : 'form',
      message: params.message,
      url: params.mode === 'url' ? params.url : null,
      fields: params.mode === 'url' ? [] : parseElicitationFields(params.requestedSchema),
      title: null,
    })

    return new Promise<McpServerElicitationRequestResponse>((resolve) => {
      this.pendingElicitations.set(requestId, {
        respond: (answer) => {
          resolve({
            action: answer.action,
            content: answer.action === 'accept' ? answer.content : null,
            _meta: null,
          })
        },
      })
    })
  }

  resolveElicitation(requestId: string, answer: ElicitationAnswer): boolean {
    const pending = this.pendingElicitations.get(requestId)
    if (!pending) return false
    this.pendingElicitations.delete(requestId)

    this.ctx.emit({
      type: 'elicitation.resolved',
      requestId,
      status: answer.action,
      content: answer.content,
      decidedBy: answer.decidedBy,
    })

    pending.respond(answer)
    this.ctx.setStatus('running')
    return true
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
    const requestId = this.ctx.openPermissionRequest(toolName, input)
    this.ctx.setStatus('awaiting_input')

    this.ctx.emit({
      type: 'permission.requested',
      requestId,
      toolName,
      input,
      suggestions: [
        { id: 'allow-once', label: 'Autoriser', scope: 'once', behavior: 'allow' },
        { id: 'allow-session', label: 'Autoriser pour la session', scope: 'session', behavior: 'allow' },
        { id: 'deny', label: 'Refuser', scope: 'once', behavior: 'deny' },
      ],
    })

    return new Promise((resolve) => {
      this.pendingApprovals.set(requestId, {
        respond: (allowed, scope) => {
          const response = buildResponse(allowed, scope)
          resolve(response)
          return response
        },
      })
    })
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.pendingApprovals.get(requestId)
    if (!pending) return false
    this.pendingApprovals.delete(requestId)

    this.ctx.closePermissionRequest(requestId, decision)
    this.ctx.emit({
      type: 'permission.resolved',
      requestId,
      decision: decision.decision,
      scope: decision.scope,
      decidedBy: decision.decidedBy,
    })

    pending.respond(decision.decision === 'allowed', decision.scope)
    this.ctx.setStatus('running')
    return true
  }

  /** Un runner qui s'arrête ne doit pas laisser le CLI attendre une réponse à jamais. */
  private expirePending(): void {
    for (const [requestId, pending] of this.pendingQuestions) {
      this.ctx.emit({
        type: 'question.resolved',
        requestId,
        status: 'expired',
        answers: {},
        decidedBy: null,
      })
      pending.respond({})
    }
    this.pendingQuestions.clear()

    for (const [requestId, pending] of this.pendingElicitations) {
      this.ctx.emit({
        type: 'elicitation.resolved',
        requestId,
        status: 'expired',
        content: {},
        decidedBy: null,
      })
      pending.respond({ action: 'cancel', content: {}, decidedBy: null })
    }
    this.pendingElicitations.clear()

    for (const [requestId, pending] of this.pendingApprovals) {
      this.ctx.closePermissionRequest(requestId, {
        decision: 'denied',
        scope: 'once',
        decidedBy: null,
      })
      this.ctx.emit({
        type: 'permission.resolved',
        requestId,
        decision: 'expired',
        scope: 'once',
        decidedBy: null,
      })
      pending.respond(false, 'once')
    }
    this.pendingApprovals.clear()
  }

  async send(
    text: string,
    attachments: OutgoingAttachment[],
    mentions: OutgoingMention[],
  ): Promise<void> {
    if (!this.client || !this.threadId) throw new Error('La session Codex n\'est pas démarrée.')

    const { blocks, input } = buildUserInput(text, attachments, mentions)
    this.ctx.emit({ type: 'message.completed', messageId: randomUUID(), role: 'user', blocks })
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

    this.ctx.emit({ type: 'message.completed', messageId: randomUUID(), role: 'user', blocks })
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
    await this.client.call('turn/interrupt', { threadId: this.threadId, turnId: this.turnId })
    // Pas de passage à `idle` ici : l'app-server clôt le tour de son côté et envoie
    // `turn/completed`, qui fait foi. L'annoncer avant ferait partir un message en
    // file pendant que le tour interrompu se termine encore.
  }

  async stop(): Promise<void> {
    this.expirePending()
    this.client?.close()
    this.client = null
  }
}
