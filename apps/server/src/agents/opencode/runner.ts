import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  parseSlashCommand,
  usableSlashCommands,
  type AgentConfig,
  type AgentQuestion,
  type McpServer,
  type McpServerStatus,
  type OpencodeConfig,
} from '@sillage/protocol'
import type {
  Command,
  Config,
  Event,
  EventOf,
  MCPStatus,
  Message,
  PartOf,
  RequestBody,
  ResponseBody,
  Session,
  ToolPart,
} from '@sillage/opencode-bindings'
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
import { failedStatuses } from '../mcp-registry.js'
import { describeOutgoingMessage } from '../outgoing.js'
import { agentProcessEnv } from '../process-env.js'
import { journalDeath } from '../session-close.js'
import { fromOpencodeMcpStatus, sameLaunchConfig, toOpencodeConfig } from './config.js'
import { describeSessionError, isAbort, type SessionError } from './errors.js'
import { parseModel } from './model.js'
import { OpencodeServer } from './server.js'
import { describePermission, describeTool, fileEdits, QUESTION_TOOL } from './tools.js'

/**
 * Adaptateur opencode (invariant I3) : traduit le flux d'`opencode serve` vers le schéma
 * d'événements commun.
 *
 * Un serveur par conversation, comme l'app-server de Codex : ce qui se règle chez
 * opencode (permissions, serveurs MCP, skills) se lit dans sa configuration au
 * lancement, voir `config.ts`. Modèle, variante et agent primaire partent en revanche
 * avec chaque message, donc se changent à chaud.
 *
 * Tout ce qui est affirmé ici du comportement d'opencode a été sondé sur la 1.18.25.
 */

/** Délai accordé à opencode pour clore un tour interrompu avant de forcer `idle`. */
const INTERRUPT_GRACE_MS = 15_000

/** Titre qu'opencode pose en attendant d'en générer un : ce n'en est pas un. */
const PLACEHOLDER_TITLE = /^(New session|Child session) - \d{4}-/

/** Événements sans rapport avec la conversation, ou de la seconde génération de l'API. */
const NOISE = [
  'server.', 'plugin.', 'catalog.', 'reference.', 'integration.', 'installation.',
  'file.', 'lsp.', 'vcs.', 'pty.', 'tui.', 'project.', 'workspace.', 'worktree.',
  'global.', 'command.', 'session.next.', 'session.diff', 'session.deleted',
  'message.removed', 'message.part.removed', 'mcp.browser.', 'models-dev.',
]

type PromptBody = NonNullable<RequestBody<'session.prompt_async'>>
type PromptPart = PromptBody['parts'][number]

/** Une part de texte ou de réflexion en cours d'écriture. */
interface OpenPart {
  kind: 'text' | 'thinking'
  text: string
  messageId: string
  parent: string | null
}

/** Ce qu'on a déjà dit d'un appel d'outil, pour ne journaliser que ce qui change. */
interface ToolTrack {
  input: string
  output: string
}

function boundedAdd(set: Set<string>, value: string, max = 4096): void {
  set.add(value)
  if (set.size > max) set.delete(set.values().next().value!)
}

export class OpencodeRunner implements AgentRunner {
  readonly conversationId: string

  private server: OpencodeServer | null = null
  private sessionId: string | null = null
  private config: OpencodeConfig
  /** Configuration avec laquelle le serveur a été lancé. */
  private launched: Config = {}
  private mcpServers: McpServer[] = []
  private mcpFailures: McpServerStatus[] = []
  private lastMcpPayload: string | null = null
  private readonly interactions: PendingInteractions
  /** Demande native (`per_…`, `que_…`) vers l'identifiant de la demande Sillage. */
  private readonly nativeRequests = new Map<string, string>()
  /** Demandes qu'opencode a closes de lui-même : il n'y a plus rien à lui répondre. */
  private readonly settledNatively = new Set<string>()

  /** Rôle de chaque message vu : les parts ne le portent pas. */
  private readonly messages = new Map<string, { role: Message['role']; summary: boolean }>()
  private readonly openParts = new Map<string, OpenPart>()
  private readonly closedParts = new Set<string>()
  private readonly tools = new Map<string, ToolTrack>()
  private readonly closedTools = new Set<string>()
  /** `fournisseur/modèle` de chaque message assistant, que ses parts ne répètent pas. */
  private readonly assistantModels = new Map<string, string>()
  /** Session d'un sous-agent vers l'appel `task` qui l'a lancée. */
  private readonly children = new Map<string, string | null>()
  private readonly noticed = new Set<string>()

  private turnActive = false
  private turn = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  private turnAborted = false
  private turnFailed = false
  /** Une compaction est annoncée et pas encore close. */
  private compacting = false
  private lastAssistantMessageId: string | null = null
  private interruptWatchdog: NodeJS.Timeout | null = null

  /** Fenêtre de contexte par `fournisseur/modèle`, lue au lancement. */
  private readonly contextLimits = new Map<string, number>()
  private defaultModel: string | null = null
  private commandNames = new Set<string>()
  /** Rechargement de l'instance en cours : un message envoyé pendant ce temps attend. */
  private reloading: Promise<void> | null = null
  /** La bibliothèque de skills a changé pendant un tour : à relire quand il finit. */
  private reloadPending = false
  private suggested: string | null = null

  /** Voir `AgentRunner`. `this.config` n'avance qu'après une application réussie. */
  get appliedConfig(): AgentConfig {
    return this.config
  }

  constructor(private readonly ctx: RunnerContext) {
    this.conversationId = ctx.conversationId
    this.config = ctx.config as OpencodeConfig
    this.interactions = new PendingInteractions(ctx)
  }

  private launchConfig(config: OpencodeConfig): { launch: Config; servers: McpServer[]; failures: McpServerStatus[] } {
    const resolved = this.ctx.resolveMcpServers(config)
    const memoryDir = this.ctx.memoryDir()
    return {
      launch: toOpencodeConfig({
        config,
        mcpServers: resolved.servers,
        skillRoots: this.ctx.skillRoots(config),
        // Les pièces jointes et la mémoire du projet vivent hors du répertoire de
        // travail : sans règle, opencode demanderait la permission de les lire.
        readableDirs: [this.ctx.attachmentsRoot, ...(memoryDir ? [memoryDir] : [])],
      }),
      servers: resolved.servers,
      failures: failedStatuses(resolved.failures),
    }
  }

  async start(): Promise<void> {
    const { launch, servers, failures } = this.launchConfig(this.config)
    this.launched = launch
    this.mcpServers = servers
    this.mcpFailures = failures

    // Le projet tient ses consignes dans SILLAGE.md, qui arrive par `system` : lire
    // aussi l'`AGENTS.md` du dépôt les doublerait. opencode n'a pas d'interrupteur plus
    // fin : celui-ci coupe aussi l'`opencode.json` et le dossier `.opencode/` du
    // projet. Les consignes du poste (`~/.config/opencode/AGENTS.md`) restent lues.
    const masked = this.ctx.maskedInstructionRoots().length > 0
    this.server = await OpencodeServer.start({
      binary: this.ctx.binary,
      cwd: this.ctx.cwd,
      env: agentProcessEnv({
        ...this.ctx.processEnv,
        ...(masked ? { OPENCODE_DISABLE_PROJECT_CONFIG: '1' } : {}),
      }),
      config: launch,
      onEvent: (event) => {
        try { this.translate(event) }
        catch (error) {
          this.notice('translation_failed', `Impossible de lire l'événement opencode ${event.type} : ${error instanceof Error ? error.message : String(error)}`, 'warning', event)
        }
      },
      onReconnect: () => void this.resync(),
      onExit: (code) => this.onProcessExit(code),
    })

    // Les sessions vivent dans la base d'opencode, pas dans le process : reprendre,
    // c'est seulement vérifier que celle-ci existe encore.
    const session = this.ctx.resumeSessionId
      ? await this.server.get<Session>(`/session/${this.ctx.resumeSessionId}`)
      : await this.server.post<Session>('/session', {})

    await this.loadCatalog()

    this.sessionId = session.id
    this.ctx.setAgentSessionId(session.id)
    this.ctx.emit(
      {
        type: 'session.started',
        agent: 'opencode',
        agentSessionId: session.id,
        model: this.config.model || this.defaultModel || '',
        cwd: session.directory,
        // La liste des outils dépend de l'agent et du modèle du tour : mieux vaut vide
        // que devinée.
        tools: [],
      },
      session,
    )
    void this.publishMcpStatus()
    void this.publishCommands()
  }

  /**
   * Modèle par défaut et fenêtres de contexte. opencode ne les annonce pas dans le
   * flux, et sans la fenêtre la jauge de contexte n'aurait pas de dénominateur. Un
   * échec n'emporte pas la session : elle tourne alors sans jauge.
   */
  private async loadCatalog(): Promise<void> {
    try {
      const listing = await this.server!.get<ResponseBody<'config.providers'>>('/config/providers')
      for (const provider of listing.providers) {
        for (const model of Object.values(provider.models)) {
          this.contextLimits.set(`${provider.id}/${model.id}`, model.limit.context)
        }
      }
      const configured = (await this.server!.get<Config>('/config')).model
      const first = listing.providers[0]
      const fallback = first ? listing.default[first.id] : undefined
      this.defaultModel = configured ?? (first && fallback ? `${first.id}/${fallback}` : null)
    } catch (err) {
      process.stderr.write(`[opencode ${this.conversationId}] catalogue indisponible : ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  /**
   * Publie l'inventaire MCP. Les publications identiques sont écartées : opencode
   * signale chaque changement d'outils, et l'inventaire entier est relu à chaque fois.
   */
  private async publishMcpStatus(): Promise<void> {
    const server = this.server
    if (!server) return
    try {
      const statuses = await server.get<Record<string, MCPStatus>>('/mcp')
      const servers = [...this.mcpFailures, ...fromOpencodeMcpStatus(statuses, this.mcpServers)]
      const payload = JSON.stringify(servers)
      if (payload === this.lastMcpPayload) return
      this.lastMcpPayload = payload
      this.ctx.emit({ type: 'mcp.updated', servers })
    } catch (err) {
      process.stderr.write(`[opencode ${this.conversationId}] inventaire MCP indisponible : ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  /**
   * Publie les commandes en `/`. opencode y range aussi les skills (`source: skill`),
   * ceux de la bibliothèque de Sillage compris : il n'y a donc pas d'inventaire de
   * compétences à part, contrairement à Codex.
   */
  private async publishCommands(): Promise<void> {
    const server = this.server
    if (!server) return
    try {
      const commands = usableSlashCommands(toSlashCommands(await server.get<Command[]>('/command')))
      this.commandNames = new Set(commands.map((command) => command.name))
      this.ctx.emit({ type: 'commands.updated', commands })
    } catch (err) {
      process.stderr.write(`[opencode ${this.conversationId}] commandes indisponibles : ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  /**
   * Le process est mort sans qu'on le lui demande : clore ce qui attend une réponse, le
   * dire dans le journal, et passer en erreur pour que le gestionnaire libère la
   * session. Le prochain message repartira en reprise.
   */
  private onProcessExit(code: number | null): void {
    this.server = null
    this.turnActive = false
    this.clearInterruptWatchdog()

    // Mort pendant le démarrage : la session n'a jamais existé, `start()` échoue et le
    // gestionnaire remonte l'erreur. Journaliser ici écrirait une fin de session pour
    // une conversation qui n'a rien commencé.
    if (!this.sessionId) return

    this.interactions.expireAll()
    this.ctx.setStatus('error')
    journalDeath(this.ctx, {
      type: 'error',
      code: 'runner_failed',
      message: `opencode serve s'est arrêté de façon inattendue (code ${code ?? 'inconnu'}).`,
      recoverable: true,
    })
  }

  /** Après une coupure du flux : un tour a pu finir sans qu'on l'entende. */
  private async resync(): Promise<void> {
    if (!this.server || !this.sessionId) return
    try {
      const statuses = await this.server.get<ResponseBody<'session.status'>>('/session/status')
      // Une session au repos est absente de la table, pas marquée `idle`.
      const status = statuses[this.sessionId]
      if (this.turnActive && (!status || status.type === 'idle')) this.endTurn()
    } catch {
      // Le flux rebranché dira la suite.
    }
  }

  private inTree(sessionId: string | undefined): sessionId is string {
    return sessionId !== undefined && (sessionId === this.sessionId || this.children.has(sessionId))
  }

  /** Appel `task` dont descend une session, null pour la session principale. */
  private parentOf(sessionId: string): string | null {
    return sessionId === this.sessionId ? null : (this.children.get(sessionId) ?? null)
  }

  private translate(event: Event): void {
    switch (event.type) {
      case 'session.created': {
        const { info } = event.properties
        // L'appel `task` qui la lance la rattache dès que ses métadonnées arrivent.
        if (info.parentID && this.inTree(info.parentID) && !this.children.has(info.id)) {
          this.children.set(info.id, null)
        }
        return
      }

      case 'session.updated': {
        const { info } = event.properties
        if (info.id === this.sessionId && info.title && !PLACEHOLDER_TITLE.test(info.title)) {
          this.suggested = info.title
        }
        return
      }

      case 'session.status': {
        const { sessionID, status } = event.properties
        if (sessionID !== this.sessionId) return
        if (status.type === 'busy') this.beginTurn()
        else if (status.type === 'retry') {
          this.beginTurn()
          this.notice('retry', `opencode réessaie (tentative ${status.attempt}) : ${status.message}`, 'info', status, `opencode-retry:${this.sessionId}`)
        } else this.endTurn()
        return
      }

      case 'session.idle':
        if (event.properties.sessionID === this.sessionId) this.endTurn()
        return

      case 'session.error': {
        const { sessionID, error } = event.properties
        // Sans identifiant, la panne est celle de l'instance : elle nous concerne.
        if (sessionID === undefined || sessionID === this.sessionId) this.reportError(error, event)
        return
      }

      case 'session.compacted':
        if (event.properties.sessionID !== this.sessionId) return
        this.compacting = false
        this.ctx.emit({ type: 'context.compacted', trigger: 'unknown', preTokens: null, postTokens: null }, event)
        return

      case 'message.updated':
        this.onMessage(event.properties.info, event)
        return

      case 'message.part.updated':
        this.onPart(event)
        return

      case 'message.part.delta': {
        const { partID, field, delta } = event.properties
        const open = this.openParts.get(partID)
        // Une part inconnue rattrapera son texte à sa prochaine version complète.
        if (!open || field !== 'text') return
        open.text += delta
        this.ctx.emit({
          type: open.kind === 'text' ? 'message.delta' : 'thinking.delta',
          messageId: partID,
          text: delta,
          parentToolCallId: open.parent,
        })
        return
      }

      case 'permission.asked':
        this.onPermissionAsked(event)
        return

      case 'question.asked':
        this.onQuestionAsked(event)
        return

      // opencode a clos la demande sans nous : une réponse venue d'ailleurs, ou un tour
      // interrompu. Nos propres réponses sont déjà sorties de la table à ce moment.
      case 'permission.replied':
      case 'question.replied':
      case 'question.rejected': {
        const requestId = this.nativeRequests.get(event.properties.requestID)
        if (!requestId) return
        this.settledNatively.add(event.properties.requestID)
        this.interactions.expire(requestId)
        if (this.turnActive) this.ctx.setStatus(this.interactions.hasBlocking ? 'awaiting_input' : 'running')
        return
      }

      case 'todo.updated': {
        if (event.properties.sessionID !== this.sessionId) return
        this.ctx.emit({
          type: 'plan.updated',
          // Une tâche annulée n'a pas d'état dans le schéma commun : elle sort du plan.
          items: event.properties.todos
            .filter((todo) => todo.status !== 'cancelled')
            .map((todo) => ({
              text: todo.content,
              status: todo.status === 'completed' ? 'completed' : todo.status === 'in_progress' ? 'in_progress' : 'pending',
            })),
        })
        return
      }

      case 'mcp.tools.changed':
        void this.publishMcpStatus()
        return

      default: {
        // Le type du flux est plus large que l'union générée (`server.heartbeat`).
        const type: string = event.type
        if (NOISE.some((prefix) => type.startsWith(prefix))) return
        // Un événement d'une version plus récente reste visible, une fois.
        if (this.noticed.has(type)) return
        this.noticed.add(type)
        this.notice(type, `Événement opencode : ${type}`, 'info', event, `opencode-notice:${type}`)
      }
    }
  }

  private notice(code: string, message: string, level: 'info' | 'warning', details?: unknown, id?: string): void {
    this.ctx.emit({ type: 'agent.notice', id, code, message, level, details }, details)
  }

  private beginTurn(): void {
    if (this.turnActive) return
    this.turnActive = true
    this.turnAborted = false
    this.turnFailed = false
    this.turn = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    this.ctx.emit({ type: 'turn.started' })
    this.ctx.setStatus(this.interactions.hasBlocking ? 'awaiting_input' : 'running')
  }

  /**
   * Le tour est fini : `session.idle` fait foi, et opencode l'envoie deux fois.
   *
   * Sondé : à l'interruption, `idle` précède la clôture en erreur des outils en cours,
   * et les demandes de permission restent dans sa liste sans `permission.replied`.
   * Tout ce qui est encore ouvert est donc clos ici, sans attendre la suite du flux.
   */
  private endTurn(): void {
    if (!this.turnActive) return
    this.turnActive = false
    this.clearInterruptWatchdog()

    for (const id of [...this.openParts.keys()]) this.closePart(id)
    for (const id of [...this.tools.keys()]) {
      this.tools.delete(id)
      boundedAdd(this.closedTools, id)
      this.ctx.emit({ type: 'tool.completed', toolCallId: id, output: 'Tool execution aborted', isError: true, durationMs: 0 })
    }
    for (const native of this.nativeRequests.keys()) this.settledNatively.add(native)
    this.interactions.expireAll()
    this.compacting = false

    this.ctx.emit(
      {
        type: 'turn.completed',
        stopReason: this.turnAborted ? 'interrupted' : this.turnFailed ? 'failed' : 'completed',
        costUsd: this.turn.cost,
        inputTokens: this.turn.input,
        outputTokens: this.turn.output,
        cacheReadTokens: this.turn.cacheRead,
        cacheCreationTokens: this.turn.cacheWrite,
      },
      // Le dernier message du tour : c'est sur lui que le fork retrouve son point de coupe.
      { sessionID: this.sessionId, messageID: this.lastAssistantMessageId },
    )
    this.ctx.setStatus('idle')
    if (this.reloadPending) void this.reloadInstance()
  }

  private reportError(error: SessionError | undefined, raw: unknown): void {
    if (!error) return
    if (isAbort(error)) {
      this.turnAborted = true
      return
    }
    // La même panne arrive par `session.error` et par le message assistant qu'elle clôt.
    if (this.turnFailed) return
    this.turnFailed = true
    this.ctx.emit(describeSessionError(error), raw)
  }

  private onMessage(info: Message, raw: unknown): void {
    if (!this.inTree(info.sessionID)) return
    const summary = info.role === 'assistant' && info.summary === true
    this.messages.set(info.id, { role: info.role, summary })
    if (info.role !== 'assistant') return

    this.assistantModels.set(info.id, `${info.providerID}/${info.modelID}`)
    if (this.assistantModels.size > 256) this.assistantModels.delete(this.assistantModels.keys().next().value!)

    if (info.sessionID === this.sessionId) {
      if (summary) {
        // Compaction automatique : rien d'autre ne l'annonce que le message de résumé.
        if (!this.compacting) {
          this.compacting = true
          this.ctx.emit({ type: 'context.compaction_started' })
        }
      } else {
        this.lastAssistantMessageId = info.id
      }
      if (info.error) this.reportError(info.error, raw)
    }

    // Un message clos ne recevra plus rien : ses parts encore ouvertes le sont aussi.
    if (info.time.completed) {
      for (const [id, open] of this.openParts) {
        if (open.messageId === info.id) this.closePart(id, raw)
      }
    }
  }

  private onPart(event: EventOf<'message.part.updated'>): void {
    const { part } = event.properties
    if (!this.inTree(part.sessionID)) return
    const message = this.messages.get(part.messageID)
    // Les parts d'un message utilisateur sont l'écho de ce que Sillage a déjà
    // journalisé à l'envoi, celles d'un résumé de compaction ne se montrent pas.
    if (message?.role !== 'assistant' || message.summary) return
    const parent = this.parentOf(part.sessionID)

    switch (part.type) {
      case 'text':
        if (part.synthetic || part.ignored) return
        this.onTextPart(part.id, 'text', part.text, part.messageID, part.time?.end !== undefined, parent, event.properties)
        return
      case 'reasoning':
        this.onTextPart(part.id, 'thinking', part.text, part.messageID, part.time.end !== undefined, parent, event.properties)
        return
      case 'tool':
        this.onToolPart(part, parent, event.properties)
        return
      case 'step-finish':
        this.onStepFinish(part, this.modelOf(part.messageID, event))
        return
      default:
        // `step-start`, `patch`, `snapshot`… : la mécanique d'opencode, rien à montrer.
        return
    }
  }

  /**
   * Texte et réflexion arrivent en deltas, encadrés par deux versions complètes de la
   * part. La version complète fait foi : si un delta a manqué, ce qui dépasse du texte
   * accumulé part comme un delta de rattrapage.
   */
  private onTextPart(
    id: string, kind: OpenPart['kind'], text: string, messageId: string, ended: boolean,
    parent: string | null, raw: unknown,
  ): void {
    if (this.closedParts.has(id)) return
    let open = this.openParts.get(id)
    if (!open) {
      open = { kind, text: '', messageId, parent }
      this.openParts.set(id, open)
    }
    if (text.length > open.text.length && text.startsWith(open.text)) {
      this.ctx.emit({
        type: kind === 'text' ? 'message.delta' : 'thinking.delta',
        messageId: id,
        text: text.slice(open.text.length),
        parentToolCallId: parent,
      })
    }
    if (text.length >= open.text.length) open.text = text
    if (ended) this.closePart(id, raw)
  }

  private closePart(id: string, raw?: unknown): void {
    const open = this.openParts.get(id)
    if (!open) return
    this.openParts.delete(id)
    boundedAdd(this.closedParts, id)
    // Une réflexion masquée par le fournisseur arrive vide : rien à afficher.
    if (!open.text.trim()) return
    this.ctx.emit(
      {
        type: 'message.completed',
        messageId: id,
        role: 'assistant',
        blocks: [{ type: open.kind, text: open.text }],
        parentToolCallId: open.parent,
      },
      raw,
    )
  }

  private onToolPart(part: ToolPart, parent: string | null, raw: unknown): void {
    if (part.tool === QUESTION_TOOL || this.closedTools.has(part.callID)) return
    const { state } = part
    const described = describeTool(part.tool, state.input, this.mcpServers.map((server) => server.name))
    const input = JSON.stringify(described.input)

    let track = this.tools.get(part.callID)
    if (!track) {
      track = { input, output: '' }
      this.tools.set(part.callID, track)
      this.ctx.emit({ type: 'tool.started', toolCallId: part.callID, ...described, parentToolCallId: parent }, raw)
    } else if (input !== track.input) {
      // L'entrée arrive vide tant que le modèle l'écrit, puis complète à l'exécution.
      track.input = input
      this.ctx.emit({ type: 'tool.input_updated', toolCallId: part.callID, input: described.input }, raw)
    }

    const metadata = 'metadata' in state ? (state.metadata ?? {}) : {}

    // La session du sous-agent n'est nommée que dans les métadonnées de son appel.
    if (part.tool === 'task' && typeof metadata.sessionId === 'string') {
      this.children.set(metadata.sessionId, part.callID)
    }

    if (state.status === 'running') {
      // La sortie d'une commande grossit dans `metadata.output`, en cumulé.
      const output = typeof metadata.output === 'string' ? metadata.output : ''
      if (output.length > track.output.length && output.startsWith(track.output)) {
        this.ctx.emit({ type: 'tool.output_delta', toolCallId: part.callID, chunk: output.slice(track.output.length) })
        track.output = output
      }
      return
    }

    if (state.status !== 'completed' && state.status !== 'error') return
    this.tools.delete(part.callID)
    boundedAdd(this.closedTools, part.callID)
    this.ctx.emit(
      {
        type: 'tool.completed',
        toolCallId: part.callID,
        output: state.status === 'completed' ? state.output : state.error,
        isError: state.status === 'error',
        durationMs: Math.max(0, state.time.end - state.time.start),
      },
      raw,
    )
    for (const edit of fileEdits(part, this.ctx.cwd)) this.ctx.emit(edit)
  }

  /** `fournisseur/modèle` du message d'une part, pour retrouver sa fenêtre de contexte. */
  private modelOf(messageId: string, event: EventOf<'message.part.updated'>): string | null {
    // Seule la session principale occupe le contexte que la jauge décrit.
    if (event.properties.part.sessionID !== this.sessionId) return null
    return this.assistantModels.get(messageId) ?? null
  }

  /**
   * Une étape de modèle s'achève avec sa consommation. `input` ne compte pas ce qui
   * vient du cache : l'occupation du contexte est la somme des trois.
   */
  private onStepFinish(part: PartOf<'step-finish'>, model: string | null): void {
    const { tokens } = part
    this.turn.cost += part.cost
    this.turn.input += tokens.input
    this.turn.output += tokens.output + tokens.reasoning
    this.turn.cacheRead += tokens.cache.read
    this.turn.cacheWrite += tokens.cache.write

    const used = tokens.input + tokens.cache.read + tokens.cache.write
    const limit = model ? this.contextLimits.get(model) : undefined
    this.ctx.emit({
      type: 'usage.updated',
      costUsd: part.cost,
      inputTokens: tokens.input,
      outputTokens: tokens.output + tokens.reasoning,
      context: limit && used > 0 ? { usedTokens: used, maxTokens: limit, ratio: used / limit } : null,
      rateLimit: null,
    })
  }

  private onPermissionAsked(event: EventOf<'permission.asked'>): void {
    const request = event.properties
    if (!this.inTree(request.sessionID) || this.nativeRequests.has(request.id)) return

    const details = describePermission(request.permission, request.patterns, request.metadata, this.ctx.cwd)
    const requestId = this.interactions.requestPermission(details, (decision) => {
      this.nativeRequests.delete(request.id)
      if (this.settledNatively.delete(request.id)) return
      // opencode n'a que deux portées : cette fois, ou jusqu'à la fin de l'instance.
      // Une expiration vaut refus, il n'a pas de variante « resté sans réponse ».
      const reply = decision?.decision === 'allowed'
        ? (decision.scope === 'once' ? 'once' : 'always')
        : 'reject'
      this.reply(`/permission/${request.id}/reply`, { reply } satisfies RequestBody<'permission.reply'>)
    })
    this.nativeRequests.set(request.id, requestId)
  }

  private onQuestionAsked(event: EventOf<'question.asked'>): void {
    const request = event.properties
    if (!this.inTree(request.sessionID) || this.nativeRequests.has(request.id)) return

    // opencode attend les réponses dans l'ordre des questions : le rang sert de clé.
    const questions: AgentQuestion[] = request.questions.map((question, index) => ({
      id: String(index),
      header: question.header,
      question: question.question,
      multiSelect: question.multiple === true,
      // Sauf mention contraire, opencode accepte une réponse libre.
      allowOther: question.custom !== false,
      secret: false,
      options: question.options.map((option) => ({ ...option, preview: null })),
    }))

    const requestId = this.interactions.requestQuestion(questions, (answer) => {
      this.nativeRequests.delete(request.id)
      if (this.settledNatively.delete(request.id)) return
      if (answer?.status === 'answered') {
        this.reply(`/question/${request.id}/reply`, {
          answers: questions.map((question) => answer.answers[question.id] ?? []),
        } satisfies RequestBody<'question.reply'>)
      } else {
        this.reply(`/question/${request.id}/reject`, {})
      }
    })
    this.nativeRequests.set(request.id, requestId)
  }

  /** Réponse à une demande : un échec se dit, il ne doit pas faire tomber la session. */
  private reply(path: string, body: unknown): void {
    const server = this.server
    if (!server) return
    server.post(path, body).catch((err: unknown) => {
      process.stderr.write(`[opencode ${this.conversationId}] réponse refusée sur ${path} : ${err instanceof Error ? err.message : String(err)}\n`)
    })
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    return this.interactions.resolvePermission(requestId, decision)
  }

  answerQuestion(requestId: string, answer: QuestionAnswer): boolean {
    return this.interactions.resolveQuestion(requestId, answer)
  }

  /** opencode ne relaie pas les élicitations de ses serveurs MCP : rien n'attend jamais. */
  resolveElicitation(requestId: string, answer: ElicitationAnswer): boolean {
    return this.interactions.resolveElicitation(requestId, answer)
  }

  /**
   * opencode ne soumet pas de plan à validation : son mode plan est un agent qu'on
   * choisit, pas une requête bloquante.
   */
  reviewPlan(_requestId: string, _review: PlanReview): boolean {
    return false
  }

  /**
   * Corps d'un message pour opencode.
   *
   * Images et fichiers mentionnés partent en parts `file` désignées par une URL
   * `file://` : opencode lit lui-même le fichier, comme son TUI le fait pour un `@`.
   * Les autres pièces jointes restent un chemin dans le texte.
   */
  private promptBody(text: string, attachments: OutgoingAttachment[], mentions: OutgoingMention[]): PromptBody {
    const parts: PromptPart[] = []
    if (text) parts.push({ type: 'text', text })
    for (const mention of mentions) {
      parts.push({
        type: 'file',
        mime: isDirectory(mention.path) ? 'application/x-directory' : 'text/plain',
        filename: mention.relativePath,
        url: pathToFileURL(mention.path).href,
      })
    }
    for (const attachment of attachments) {
      if (!attachment.inlineImage) continue
      parts.push({
        type: 'file',
        mime: attachment.mimeType,
        filename: attachment.filename,
        url: pathToFileURL(attachment.path).href,
      })
    }

    const model = parseModel(this.config.model)
    // L'équivalent de l'appendice au prompt système des deux autres. `system` ne vaut
    // que pour le message qui le porte : il est donc reposé à chaque envoi.
    const system = this.ctx.projectOverview(this.config)
    return {
      parts,
      agent: this.config.primaryAgent,
      // Sans modèle ni variante, opencode applique les siens.
      ...(model ? { model } : {}),
      ...(this.config.variant ? { variant: this.config.variant } : {}),
      ...(system ? { system } : {}),
    }
  }

  async send(text: string, attachments: OutgoingAttachment[], mentions: OutgoingMention[]): Promise<void> {
    if (!this.server || !this.sessionId) throw new Error("La session opencode n'est pas démarrée.")

    const { blocks, promptText } = describeOutgoingMessage(text, attachments)
    this.ctx.emit({ type: 'message.completed', messageId: randomUUID(), role: 'user', blocks, parentToolCallId: null })
    this.ctx.setStatus('running')
    // Un message parti pendant un rechargement verrait ses événements se perdre.
    if (this.reloading) await this.reloading
    if (!this.server) throw new Error('La session opencode est fermée.')

    // Une commande en `/` n'est pas développée par `prompt_async` : elle a sa route.
    const command = parseSlashCommand(text)
    if (command && this.commandNames.has(command.name)) {
      this.runCommand(command.name, command.args)
      return
    }

    try {
      await this.server.post(`/session/${this.sessionId}/prompt_async`, this.promptBody(promptText, attachments, mentions))
    } catch (error) {
      if (!this.turnActive && this.server) this.ctx.setStatus('idle')
      throw error
    }
  }

  /**
   * `POST /command` ne répond qu'à la fin du tour, sans variante asynchrone : la requête
   * part sans être attendue, et son échec revient par le journal.
   */
  private runCommand(name: string, args: string): void {
    const body: RequestBody<'session.command'> = {
      command: name,
      arguments: args,
      agent: this.config.primaryAgent,
      ...(this.config.model ? { model: this.config.model } : {}),
      ...(this.config.variant ? { variant: this.config.variant } : {}),
    }
    this.server!.post(`/session/${this.sessionId}/command`, body, null).catch((err: unknown) => {
      if (!this.server) return
      this.ctx.emit({
        type: 'error',
        code: 'turn_failed',
        message: err instanceof Error ? err.message : String(err),
        recoverable: true,
      })
      if (!this.turnActive) this.ctx.setStatus('idle')
    })
  }

  /**
   * Infléchit le tour en cours.
   *
   * Sondé : un `prompt_async` reçu pendant un tour n'en ouvre pas un second et
   * n'interrompt rien. Le message est pris à l'étape de modèle suivante, à l'intérieur
   * du même passage `busy` → `idle`.
   */
  async steer(text: string, attachments: OutgoingAttachment[], mentions: OutgoingMention[]): Promise<boolean> {
    if (!this.server || !this.sessionId || !this.turnActive) return false

    const { blocks, promptText } = describeOutgoingMessage(text, attachments)
    await this.server.post(`/session/${this.sessionId}/prompt_async`, this.promptBody(promptText, attachments, mentions))
    this.ctx.emit({ type: 'message.completed', messageId: randomUUID(), role: 'user', blocks, parentToolCallId: null })
    return true
  }

  /**
   * Compaction, par une requête dédiée. Elle exige un modèle : celui de la
   * conversation, sinon celui qu'opencode applique par défaut.
   */
  async compact(): Promise<boolean> {
    const model = parseModel(this.config.model || this.defaultModel || '')
    if (!this.server || !this.sessionId || !model) return false

    this.compacting = true
    this.ctx.emit({ type: 'context.compaction_started' })
    // Comme `/command`, la réponse n'arrive qu'une fois le résumé écrit.
    this.server
      .post(`/session/${this.sessionId}/summarize`, model satisfies RequestBody<'session.summarize'>, null)
      .catch((err: unknown) => {
        if (!this.server) return
        this.compacting = false
        this.notice('compaction_failed', `La compaction a échoué : ${err instanceof Error ? err.message : String(err)}`, 'warning')
        if (!this.turnActive) this.ctx.setStatus('idle')
      })
    return true
  }

  /** opencode n'annonce pas de travaux de fond à arrêter. */
  async stopBackgroundTask(): Promise<boolean> {
    return false
  }

  /**
   * Modèle, variante et agent primaire partent avec chaque message : rien à relancer.
   * Tout ce qui tient à la configuration de lancement demande un nouveau serveur.
   */
  async applyConfig(config: AgentConfig): Promise<boolean> {
    if (config.agent !== 'opencode') return false
    if (!sameLaunchConfig(this.launchConfig(config).launch, this.launched)) return false
    this.config = config
    return true
  }

  /**
   * Sondé : un serveur en marche ne voit pas un skill ajouté, renommé ou retiré après
   * son lancement. Il faut lui faire jeter son instance, ce qui emporterait un tour en
   * cours : la relecture attend donc le repos.
   */
  async reloadSkillLibrary(): Promise<void> {
    if (this.turnActive) {
      this.reloadPending = true
      return
    }
    await this.reloadInstance()
  }

  private reloadInstance(): Promise<void> {
    this.reloadPending = false
    const server = this.server
    if (!server) return Promise.resolve()
    this.reloading ??= server
      .reloadInstance()
      .then(() => {
        void this.publishMcpStatus()
        return this.publishCommands()
      })
      .catch((err: unknown) => {
        process.stderr.write(`[opencode ${this.conversationId}] relecture des skills impossible : ${err instanceof Error ? err.message : String(err)}\n`)
      })
      .finally(() => { this.reloading = null })
    return this.reloading
  }

  async suggestedTitle(): Promise<string | null> {
    return this.suggested
  }

  async interrupt(): Promise<void> {
    // Sans tour en cours il n'y a rien à interrompre. Le geste reste une sortie pour
    // autant : une conversation qui se croit occupée ne doit pas le rester.
    if (!this.server || !this.sessionId || !this.turnActive) {
      this.interactions.expireAll()
      this.ctx.setStatus('idle')
      return
    }
    await this.server.post(`/session/${this.sessionId}/abort`)

    // `session.idle` clôt le tour et fait foi. Le garde-fou couvre le cas où il ne
    // vient jamais.
    this.clearInterruptWatchdog()
    this.interruptWatchdog = setTimeout(() => {
      this.turnAborted = true
      this.endTurn()
    }, INTERRUPT_GRACE_MS)
    this.interruptWatchdog.unref()
  }

  private clearInterruptWatchdog(): void {
    if (this.interruptWatchdog) clearTimeout(this.interruptWatchdog)
    this.interruptWatchdog = null
  }

  async stop(): Promise<void> {
    this.clearInterruptWatchdog()
    // Le serveur part avec ses demandes : inutile de les lui refuser une à une.
    const server = this.server
    this.server = null
    this.interactions.expireAll()
    server?.close()
  }

}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Commandes d'opencode dans la forme commune. `hints` liste les `$1`, `$ARGUMENTS`… attendus. */
export function toSlashCommands(commands: Command[]) {
  return commands.map((command) => ({
    name: command.name,
    description: command.description ?? '',
    argumentHint: command.hints.join(' '),
    aliases: [],
  }))
}
