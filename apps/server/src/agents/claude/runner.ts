import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  getSessionInfo,
  query,
  type CanUseTool,
  type ElicitationRequest,
  type ElicitationResult,
  type HookCallback,
  type McpServerConfig,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SlashCommand,
} from '@anthropic-ai/claude-agent-sdk'
import {
  claudePermissionModeSchema,
  parseElicitationFields,
  usableSlashCommands,
  type AgentConfig,
  type ClaudeConfig,
  type ContentBlock,
  type McpServerStatus,
  type PlanFollowUpOption,
} from '@sillage/protocol'
import { failedStatuses } from '../mcp-registry.js'
import { AsyncQueue } from '../async-queue.js'
import { PendingInteractions } from '../interactions.js'
import { describeOutgoingMessage } from '../outgoing.js'
import { toWorkspacePath } from '../paths.js'
import { ToolDurations } from '../tool-durations.js'
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
import { editedPath, fileExists } from './file-edits.js'
import { fromSdkMcpStatus, toSdkMcpServers } from './mcp.js'
import { toPermissionMode } from './permission-mode.js'
import {
  ASK_USER_QUESTION,
  EXIT_PLAN_MODE,
  toPlan,
  toQuestions,
  toUpdatedInput,
} from './prompts.js'

/**
 * Messages natifs volontairement ignorés : ils décrivent une progression interne
 * (changements d'état de session) sans rien apporter au fil de conversation. Liste
 * nommée plutôt qu'un `default:` muet, pour qu'un nouveau type de message inconnu
 * soit visible et non avalé.
 */
const IGNORED_SUBTYPES = new Set(['session_state_changed'])

/**
 * Pas du compteur de réflexion, en tokens estimés.
 *
 * Le CLI en publie un par fragment reçu, soit plusieurs par seconde. Chaque événement
 * étant journalisé, les relayer tous ferait grossir le journal pour une valeur que
 * l'œil ne distingue pas. Ce pas laisse l'indicateur bouger plusieurs fois par seconde
 * sur une réflexion soutenue, et n'écrit qu'une poignée de lignes sur une courte.
 */
const THINKING_TOKENS_STEP = 100

/**
 * Délai laissé au CLI pour refermer lui-même un tour dont on soupçonne qu'il ne
 * produira pas de `result`. Voir `armTurnWatchdog`.
 */
const TURN_CLOSE_GRACE_MS = 15_000

/**
 * Suites proposées à la validation d'un plan. Les identifiants sont des modes de
 * permission de Claude Code : c'est cet adaptateur qui les propose et qui les
 * revalide au retour, le schéma commun n'y voit que des chaînes opaques.
 */
const PLAN_FOLLOW_UP_OPTIONS: PlanFollowUpOption[] = [
  {
    id: 'acceptEdits',
    label: 'Valider et laisser écrire',
    hint: 'Les modifications de fichiers passent sans demande',
  },
  {
    id: 'manual',
    label: 'Valider et demander',
    hint: 'Chaque outil reste soumis à ton accord',
  },
]

/**
 * Blocs acceptés dans un message utilisateur, dérivés du type du SDK plutôt que
 * recopiés : la liste des formats d'image admis change avec l'API, et une copie
 * manuelle finirait par diverger sans que rien ne le signale.
 */
type PromptBlock = Exclude<SDKUserMessage['message']['content'], string>[number]
type InlineImageSource = Extract<
  Extract<PromptBlock, { type: 'image' }>['source'],
  { type: 'base64' }
>

/**
 * Traduit un message et ses pièces jointes vers le protocole du SDK. Les blocs
 * journalisés viennent du module commun ; les images partent en base64, les autres
 * fichiers par leur chemin, seule façon pour l'agent de les ouvrir avec ses outils.
 */
async function buildUserMessage(
  text: string,
  attachments: OutgoingAttachment[],
): Promise<{ blocks: ContentBlock[]; prompt: PromptBlock[] }> {
  const { blocks, promptText } = describeOutgoingMessage(text, attachments)
  const prompt: PromptBlock[] = []

  if (promptText) {
    prompt.push({ type: 'text', text: promptText })
  }

  for (const attachment of attachments) {
    if (!attachment.inlineImage) continue
    const data = await readFile(attachment.path)
    prompt.push({
      type: 'image',
      source: {
        type: 'base64',
        // Le type est déjà restreint aux formats acceptés par l'API au moment de
        // décider `inlineImage` : c'est ce contrôle qui rend ce cast sûr.
        media_type: attachment.mimeType as InlineImageSource['media_type'],
        data: data.toString('base64'),
      },
    })
  }

  return { blocks, prompt }
}

export class ClaudeRunner implements AgentRunner {
  readonly conversationId: string

  private readonly input = new AsyncQueue<SDKUserMessage>()
  private readonly interactions: PendingInteractions
  private readonly durations = new ToolDurations()
  /**
   * Écritures en cours, par appel : le chemin visé et son existence avant l'appel.
   * Le résultat d'outil ne porte ni l'un ni l'autre, il faut donc les retenir.
   */
  private readonly pendingEdits = new Map<string, { path: string; existed: boolean }>()
  private readonly abort = new AbortController()
  private session: Query | null = null
  /** Message en cours de réception, par auteur : l'agent principal (null) et chaque sous-agent. */
  private readonly streamingMessageIds = new Map<string | null, string>()
  /** Dernier compteur de réflexion relayé, pour n'en relayer qu'un par `THINKING_TOKENS_STEP`. */
  private thinkingTokensSent = 0
  /** Identifiant natif, requis pour relire le résumé de session. */
  private sessionId: string | null = null
  private stopped = false
  /** Vrai entre l'ouverture d'un tour et le `result` qui le referme. */
  private turnOpen = false
  /** Échéance de clôture d'office, armée quand aucun `result` n'est attendu. */
  private turnWatchdog: ReturnType<typeof setTimeout> | null = null
  /** Suit les changements appliqués à chaud, contrairement à `ctx.config` qui est figé. */
  private config: ClaudeConfig
  /**
   * La session a été lancée en `bypassPermissions`, donc avec le drapeau qui coupe les
   * demandes. Retenu à part : `this.config` le perd au premier changement appliqué à
   * chaud, or c'est le lancement qui décide, pas le réglage courant.
   */
  private readonly launchedWithBypass: boolean
  /**
   * Ce que la session a réellement reçu, pour ne renvoyer `setMcpServers` que sur un
   * vrai changement. Le SDK relance chaque serveur à l'appel, donc un appel inutile
   * coupe des connexions qui marchaient.
   */
  private appliedMcpServers: Record<string, McpServerConfig> = {}
  /** Serveurs qu'on n'a pas pu lancer, à joindre à l'inventaire que le CLI rapporte. */
  private mcpFailures: McpServerStatus[] = []

  /** Voir `AgentRunner`. `this.config` n'avance qu'après une application réussie. */
  get appliedConfig(): AgentConfig {
    return this.config
  }

  constructor(private readonly ctx: RunnerContext) {
    this.conversationId = ctx.conversationId
    this.config = ctx.config as ClaudeConfig
    this.launchedWithBypass = this.config.permissionMode === 'bypassPermissions'
    this.interactions = new PendingInteractions(ctx)
  }

  async start(): Promise<void> {
    const config = this.config
    const resolved = this.ctx.resolveMcpServers(config)
    this.appliedMcpServers = toSdkMcpServers(resolved.servers)
    this.mcpFailures = failedStatuses(resolved.failures)

    // Par le prompt système et non par le hook `SessionStart`, essayé d'abord : les
    // hooks s'enregistrent dans la requête d'initialisation, et `SessionStart` est le
    // premier événement de la session. Le rappel n'a produit aucun effet, vérifié sur
    // une session neuve qui n'a rien reçu. Le mode `preset` conserve le prompt par
    // défaut de Claude Code et n'y ajoute que cet appendice.
    const overview = this.ctx.projectOverview(config)

    this.session = query({
      prompt: this.input,
      options: {
        ...(overview
          ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: overview } }
          : {}),
        cwd: this.ctx.cwd,
        model: config.model,
        effort: config.effort,
        permissionMode: toPermissionMode(config.permissionMode),
        // Les pièces jointes sont stockées hors du workspace : sans ce dossier
        // autorisé, l'agent se verrait refuser la lecture des fichiers qu'on lui joint.
        additionalDirectories: [...config.additionalDirectories, this.ctx.attachmentsRoot],
        // Transmis en mémoire, à chaque lancement. Rien n'en est écrit dans
        // `~/.claude.json` : une conversation reprise dans le CLI natif n'aura donc pas
        // ces serveurs, ce qui est le prix de ne pas toucher aux fichiers de
        // l'utilisateur. Relevé par sonde, ce n'est pas déductible de la documentation.
        mcpServers: this.appliedMcpServers,
        strictMcpConfig: config.strictMcp,
        includePartialMessages: true,
        // Sans ça le SDK ne transmet des sous-agents que leurs appels d'outils, de
        // quoi faire battre un compteur mais pas de quoi rendre leur fil : ni
        // raisonnement, ni messages intermédiaires. Sillage les affiche comme des
        // conversations à part entière, donc il lui faut tout.
        forwardSubagentText: true,
        abortController: this.abort,
        ...(this.ctx.resumeSessionId ? { resume: this.ctx.resumeSessionId } : {}),
        // Toujours renseigné, jamais laissé au SDK. Sa résolution interne cherche le
        // binaire dans le paquet plateforme `@anthropic-ai/claude-agent-sdk-<os>-<arch>`,
        // que la release ne transporte plus : sans ce chemin, le SDK échouerait sur
        // « Native CLI binary not found » au lieu d'utiliser le CLI du système.
        pathToClaudeCodeExecutable: this.ctx.binary,
        canUseTool: this.handleToolRequest,
        onElicitation: this.handleElicitation,
        // Seul canal par lequel le CLI livre les tâches planifiées de la session. Ni
        // le flux ni le canal de contrôle n'en portent l'état : `CronList` n'existe
        // que comme outil du modèle, et aucun message ne joue pour les boucles le rôle
        // que `background_tasks_changed` joue pour le travail de fond.
        hooks: { Stop: [{ hooks: [this.handleStop] }] },
        stderr: (data) => {
          // La sortie d'erreur du CLI n'est pas un événement de conversation, mais la
          // perdre rend tout diagnostic impossible.
          process.stderr.write(`[claude ${this.conversationId}] ${data}`)
        },
      },
    })

    // Le niveau des travaux de fond appartient au process : le CLI n'en annonce rien
    // au démarrage, il n'émet qu'aux changements. Sillage pose donc le zéro lui-même,
    // sans quoi une relecture du journal garderait allumés les travaux du process
    // précédent, qui sont morts avec lui.
    this.ctx.emit({ type: 'background.updated', tasks: [] })
    // Même raison pour les boucles, qui meurent elles aussi avec le process. Le hook
    // les rétablira à la fin du premier tour si le CLI en a restauré à la reprise.
    this.ctx.emit({ type: 'loops.updated', loops: [] })
    void this.publishMcpStatus()

    // Consommé en tâche de fond : le runner survit à la requête HTTP qui l'a créé.
    void this.consume()
  }

  private async consume(): Promise<void> {
    if (!this.session) return

    try {
      for await (const message of this.session) {
        this.translate(message)
      }
      this.ctx.emit({ type: 'session.ended', reason: this.stopped ? 'interrupted' : 'completed' })
      this.ctx.setStatus('idle')
    } catch (err) {
      if (this.stopped) {
        this.ctx.emit({ type: 'session.ended', reason: 'interrupted' })
        this.ctx.setStatus('idle')
      } else {
        this.ctx.emit({
          type: 'error',
          code: 'runner_failed',
          message: err instanceof Error ? err.message : String(err),
          recoverable: false,
        })
        this.ctx.setStatus('error')
      }
    } finally {
      this.clearTurnWatchdog()
      this.turnOpen = false
      this.interactions.expireAll()
    }
  }

  /**
   * Note l'écriture qu'un appel s'apprête à faire.
   *
   * L'existence est relevée maintenant, et de façon synchrone : c'est le seul moment
   * où elle distingue une création d'une réécriture, et une lecture différée peut se
   * résoudre après que l'outil a écrit, donc répondre sur un disque déjà modifié.
   */
  private trackEdit(toolCallId: string, name: string, input: unknown): void {
    const path = editedPath(name, input)
    if (path === null) return

    this.pendingEdits.set(toolCallId, { path, existed: fileExists(path) })
  }

  /**
   * Ouvre un tour s'il n'y en a pas déjà un.
   *
   * Claude Code n'annonce pas le début d'un tour, contrairement à Codex : le SDK émet
   * `result` à chaque fin, mais rien à l'ouverture. Un tour que Sillage n'a pas
   * déclenché (reprise de session, relance après un réglage appliqué à chaud) ne
   * passait donc par aucun `setStatus('running')`, et la conversation restait `idle`
   * en base pendant tout le travail. Le fil ouvert s'en sortait en repliant son
   * journal, la liste des conversations n'a pas de journal et n'affichait rien.
   */
  private openTurn(): void {
    if (this.turnOpen) return

    this.turnOpen = true
    this.ctx.emit({ type: 'turn.started' })
    this.ctx.setStatus('running')
  }

  /**
   * Referme le tour d'office si le CLI ne donne plus signe de vie.
   *
   * `openTurn` fait foi pour l'ouverture, mais un `result` fait foi pour la fermeture,
   * et il ne vient pas toujours. Une commande de barre oblique traitée en local par le
   * CLI (`/model`, par exemple) répond par sa seule sortie et n'engage aucun tour de
   * modèle ; une interruption alors qu'aucun tour n'est réellement en cours ne fait rien
   * remonter non plus. Dans les deux cas la conversation restait occupée pour de bon :
   * `isBusy` mettait en file tout message suivant, la récolte d'inactivité réarmait au
   * lieu de récolter, et le fil web gardait son indicateur allumé puisque son
   * `turnRunning` ne retombe que sur `turn.completed`.
   *
   * L'échéance est désarmée par le premier message du CLI, quel qu'il soit : s'il parle,
   * c'est qu'un tour vit et que son `result` viendra. Codex a le même filet sur son
   * interruption, pour la même raison.
   */
  private armTurnWatchdog(stopReason: string): void {
    this.clearTurnWatchdog()
    this.turnWatchdog = setTimeout(() => {
      this.turnWatchdog = null
      if (!this.turnOpen) return

      this.turnOpen = false
      this.ctx.emit({
        type: 'turn.completed',
        stopReason,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      })
      this.ctx.setStatus('idle')
    }, TURN_CLOSE_GRACE_MS)
    this.turnWatchdog.unref()
  }

  private clearTurnWatchdog(): void {
    if (this.turnWatchdog) clearTimeout(this.turnWatchdog)
    this.turnWatchdog = null
  }

  private translate(message: SDKMessage): void {
    this.clearTurnWatchdog()

    // Tout ce que le CLI raconte de son travail vaut ouverture : ces trois types
    // portent le texte de l'agent, ses appels d'outil et leurs résultats.
    if (message.type === 'stream_event' || message.type === 'assistant' || message.type === 'user') {
      this.openTurn()
    }

    switch (message.type) {
      case 'system': {
        if (message.subtype === 'thinking_tokens') {
          // Le compteur repart à zéro à chaque bloc de réflexion : une valeur plus
          // basse que la précédente annonce un nouveau bloc, pas un recul.
          const estimated = message.estimated_tokens
          if (estimated < this.thinkingTokensSent) this.thinkingTokensSent = 0
          if (estimated - this.thinkingTokensSent < THINKING_TOKENS_STEP) return
          this.thinkingTokensSent = estimated
          this.ctx.emit({ type: 'thinking.progress', estimatedTokens: estimated })
          return
        }
        if (message.subtype === 'compact_boundary') {
          const meta = message.compact_metadata
          this.ctx.emit(
            {
              type: 'context.compacted',
              trigger: meta.trigger === 'manual' || meta.trigger === 'auto' ? meta.trigger : 'unknown',
              preTokens: meta.pre_tokens,
              postTokens: meta.post_tokens ?? null,
            },
            message,
          )
          return
        }
        if (message.subtype === 'status') {
          // Le CLI annonce lui-même qu'il compacte, que la compaction ait été demandée
          // depuis Sillage ou déclenchée toute seule par le seuil d'auto-compaction.
          if (message.status === 'compacting') {
            this.ctx.emit({ type: 'context.compaction_started' }, message)
          }
          // L'échec ne produit aucune frontière de compaction : sans ce relais, le
          // contexte reste plein et rien ne le dit.
          if (message.compact_result === 'failed') {
            this.ctx.emit(
              {
                type: 'error',
                code: 'compact_failed',
                message: message.compact_error ?? 'La compaction du contexte a échoué.',
                recoverable: true,
              },
              message,
            )
          }
          return
        }
        // Le seul signal que le CLI donne du travail qu'il poursuit hors du tour :
        // workflows, commandes lancées en fond, sous-agents basculés en arrière-plan.
        // Rien de tout ça n'apparaît dans le flux des messages, et l'attribution par
        // `parentToolCallId` ne le voit pas non plus : l'orchestration d'un workflow
        // se fait au-dessus de ce que le SDK expose en sous-agents.
        if (message.subtype === 'background_tasks_changed') {
          this.ctx.emit(
            {
              type: 'background.updated',
              tasks: message.tasks.map((task) => ({
                id: task.task_id,
                kind: task.task_type,
                description: task.description,
              })),
            },
            message,
          )
          return
        }
        if (message.subtype === 'task_started') {
          this.ctx.emit(
            {
              type: 'task.started',
              taskId: message.task_id,
              toolCallId: message.tool_use_id ?? null,
              // `task_type` manque sur les sous-agents lancés par l'outil Task, que le
              // CLI décrit par leur type d'agent. Le repli garde la même famille que
              // celle annoncée dans la liste de niveau.
              kind: message.task_type ?? 'local_agent',
              description: message.description,
            },
            message,
          )
          return
        }
        if (message.subtype === 'task_progress') {
          this.ctx.emit(
            {
              type: 'task.progress',
              taskId: message.task_id,
              activity: message.description,
              lastTool: message.last_tool_name ?? null,
              toolUses: message.usage.tool_uses,
              totalTokens: message.usage.total_tokens,
              durationMs: message.usage.duration_ms,
            },
            message,
          )
          return
        }
        if (message.subtype === 'task_notification') {
          this.ctx.emit(
            {
              type: 'task.completed',
              taskId: message.task_id,
              status: message.status,
              summary: message.summary,
              durationMs: message.usage?.duration_ms ?? null,
              ambient: message.skip_transcript ?? false,
            },
            message,
          )
          return
        }
        if (message.subtype === 'commands_changed') {
          this.publishCommands(message.commands)
          return
        }
        if (message.subtype === 'init') {
          this.sessionId = message.session_id
          this.ctx.setAgentSessionId(message.session_id)
          // `slash_commands` de l'init ne porte que des noms. La liste proposée à la
          // saisie a besoin des descriptions et de la forme des arguments, que seule
          // cette requête donne.
          void this.publishSupportedCommands()
          this.ctx.emit(
            {
              type: 'session.started',
              agent: 'claude',
              agentSessionId: message.session_id,
              model: message.model,
              cwd: message.cwd,
              tools: message.tools,
            },
            message,
          )
        }
        return
      }

      case 'stream_event': {
        const event = message.event

        // `message.uuid` identifie l'evenement de flux, pas le message : l'utiliser
        // comme messageId produit un identifiant different a chaque token. Le seul
        // identifiant stable est celui de l'API, annonce par message_start et repris
        // par le message assistant final.
        //
        // Le flux de l'agent principal et celui de chaque sous-agent passent par le
        // même canal, entrelacés. L'identifiant courant est donc retenu par auteur :
        // un seul suffisait tant qu'un seul agent parlait, mais le `message_start`
        // d'un sous-agent l'écrasait, et la suite de la réponse principale partait
        // grossir le message du sous-agent.
        const parentToolCallId = message.parent_tool_use_id
        if (event.type === 'message_start') {
          this.streamingMessageIds.set(parentToolCallId, event.message.id)
          return
        }
        if (event.type !== 'content_block_delta') return

        const messageId = this.streamingMessageIds.get(parentToolCallId)
        if (!messageId) return

        const delta = event.delta
        if (delta.type === 'text_delta') {
          this.ctx.emit({ type: 'message.delta', messageId, text: delta.text, parentToolCallId })
        } else if (delta.type === 'thinking_delta') {
          this.ctx.emit({ type: 'thinking.delta', messageId, text: delta.thinking, parentToolCallId })
        }
        return
      }

      case 'assistant': {
        const blocks: ContentBlock[] = []

        for (const block of message.message.content) {
          if (block.type === 'text') {
            blocks.push({ type: 'text', text: block.text })
          } else if (block.type === 'thinking') {
            blocks.push({ type: 'thinking', text: block.thinking })
          } else if (block.type === 'tool_use') {
            this.durations.start(block.id)
            this.trackEdit(block.id, block.name, block.input)
            blocks.push({
              type: 'tool_use',
              toolCallId: block.id,
              name: block.name,
              input: block.input,
            })
            this.ctx.emit(
              {
                type: 'tool.started',
                toolCallId: block.id,
                name: block.name,
                input: block.input,
                parentToolCallId: message.parent_tool_use_id,
              },
              block,
            )
          }
        }

        if (blocks.length > 0) {
          this.ctx.emit(
            {
              type: 'message.completed',
              messageId: message.message.id,
              role: 'assistant',
              blocks,
              parentToolCallId: message.parent_tool_use_id,
            },
            message,
          )
        }
        return
      }

      case 'user': {
        // Les messages user émis par le CLI portent les résultats d'outils. Le message
        // saisi par l'utilisateur, lui, est journalisé par send().
        const content = message.message.content
        if (typeof content === 'string') {
          // Reste le texte nu, que ni l'un ni l'autre ne produit : c'est une consigne
          // que le CLI se réinjecte, typiquement une boucle qui vient d'échoir, ou la
          // sortie d'une commande de barre oblique qu'il a traitée sans le modèle.
          this.ctx.emit({ type: 'prompt.injected', text: content }, message)
          this.armTurnWatchdog('local_command')
          return
        }

        for (const block of content) {
          if (block.type !== 'tool_result') continue

          this.ctx.emit(
            {
              type: 'tool.completed',
              toolCallId: block.tool_use_id,
              output: block.content ?? null,
              isError: block.is_error === true,
              durationMs: this.durations.stop(block.tool_use_id),
            },
            block,
          )

          const edit = this.pendingEdits.get(block.tool_use_id)
          this.pendingEdits.delete(block.tool_use_id)
          // Un appel en échec n'a rien écrit : le journaliser ferait apparaître une
          // modification qui n'existe pas sur le disque.
          if (edit && block.is_error !== true) {
            this.ctx.emit({
              type: 'file.edited',
              toolCallId: block.tool_use_id,
              path: toWorkspacePath(this.ctx.cwd, edit.path),
              action: edit.existed ? 'modified' : 'created',
            })
          }
        }
        return
      }

      case 'result': {
        this.ctx.emit(
          {
            type: 'turn.completed',
            stopReason: message.subtype,
            costUsd: message.total_cost_usd,
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
            // Le contexte du CLI passe presque entièrement par le cache : sans ces
            // deux champs, le total affiché n'a aucun rapport avec la consommation.
            cacheCreationTokens: message.usage.cache_creation_input_tokens,
            cacheReadTokens: message.usage.cache_read_input_tokens,
          },
          message,
        )
        this.turnOpen = false
        this.ctx.setStatus('idle')
        // Le contexte n'est connu qu'en interrogeant le CLI : le message `result`
        // n'en dit rien. Fait après coup pour ne pas retarder la fin du tour.
        void this.emitContextUsage()
        return
      }

      case 'rate_limit_event': {
        const info = message.rate_limit_info
        this.ctx.emit(
          {
            type: 'usage.updated',
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            rateLimit: {
              type: info.rateLimitType ?? 'unknown',
              status: info.status,
              // `resetsAt` est en secondes côté CLI, le reste de Sillage compte en
              // millisecondes : convertir ici évite une date en 1970 dans l'UI.
              utilization: info.utilization ?? null,
              resetsAt: info.resetsAt === undefined ? null : info.resetsAt * 1000,
            },
          },
          message,
        )
        return
      }

      default: {
        const subtype = 'subtype' in message ? String(message.subtype) : message.type
        if (IGNORED_SUBTYPES.has(subtype)) return
        // Types non traduits, donc non journalisés : le journal est la source
        // d'affichage (I2), et y écrire un événement que rien ne sait rendre le
        // ferait grossir sans que personne le lise. Ce qui manquerait à l'écran
        // devient un événement traduit, pas une ligne brute de plus.
        return
      }
    }
  }

  /**
   * Occupation de la fenêtre de contexte, lue par requête de contrôle. Une erreur ici
   * ne doit rien casser : c'est un indicateur, pas une étape du tour.
   */
  private async emitContextUsage(): Promise<void> {
    if (!this.session) return
    try {
      const usage = await this.session.getContextUsage()
      this.ctx.emit({
        type: 'usage.updated',
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        context: {
          usedTokens: usage.totalTokens,
          maxTokens: usage.maxTokens,
          // Le CLI donne un pourcentage ; le schéma stocke un ratio de 0 à 1.
          ratio: usage.percentage / 100,
        },
      })
    } catch {
      // Session déjà fermée, ou CLI trop ancien pour cette requête de contrôle.
    }
  }

  /**
   * Tout ce que le CLI soumet à l'utilisateur passe par ce rappel, y compris ce qui
   * n'est pas une permission : deux outils y servent en réalité à poser une question
   * et à faire valider un plan. Les traiter comme des permissions donnerait un
   * « Autoriser / Refuser » sur une question à choix multiples.
   *
   * Champ défini plutôt que méthode : le SDK appelle la référence telle quelle, sans
   * la relier à l'instance.
   */
  private readonly handleToolRequest: CanUseTool = (toolName, input, options) => {
    if (toolName === ASK_USER_QUESTION) return this.requestQuestion(input)
    if (toolName === EXIT_PLAN_MODE) return this.requestPlanReview(input)
    return this.requestPermission(toolName, input, options)
  }

  private requestPermission(
    toolName: string,
    input: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    /**
     * Mises à jour de permission proposées par le CLI pour ne plus reposer la
     * question. Sans les renvoyer, « autoriser pour la session » n'autorise que cet
     * appel-là et la demande revient à l'identique au suivant.
     */
    const suggestions = options.suggestions ?? []

    return new Promise<PermissionResult>((resolve) => {
      this.interactions.requestPermission(
        {
          toolName,
          input,
          // Les libellés viennent du CLI, qui sait pourquoi il demande : chemin hors
          // des dossiers autorisés, règle déclenchée, portée réclamée. Une phrase
          // reconstruite depuis le nom de l'outil perdrait tout ça.
          title: options.title ?? null,
          description: options.description ?? null,
          displayName: options.displayName ?? null,
        },
        (decision) => {
          if (decision === null) {
            resolve({ behavior: 'deny', message: 'Session terminée avant la réponse.' })
          } else if (decision.decision === 'allowed') {
            // Une autorisation ponctuelle ne change aucune règle ; au-delà, on renvoie
            // les mises à jour que le CLI a lui-même proposées, seule façon qu'il
            // cesse de reposer la question.
            resolve({
              behavior: 'allow',
              ...(decision.scope === 'once' ? {} : { updatedPermissions: suggestions }),
            })
          } else {
            resolve({ behavior: 'deny', message: 'Refusé depuis Sillage.' })
          }
        },
      )
    })
  }

  private requestQuestion(input: Record<string, unknown>): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      this.interactions.requestQuestion(toQuestions(input), (answer) => {
        if (answer === null || answer.status === 'cancelled') {
          // Autoriser sans réponse : le CLI produit alors « The user did not answer
          // the questions », et le modèle poursuit sans être bloqué. Un refus, lui,
          // ferait remonter une erreur d'outil pour un geste parfaitement légitime.
          resolve({ behavior: 'allow' })
        } else {
          resolve({
            behavior: 'allow',
            // L'entrée d'origine est complétée par la réponse, pas remplacée.
            updatedInput: toUpdatedInput(input, answer.answers),
          })
        }
      })
    })
  }

  private requestPlanReview(input: Record<string, unknown>): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      this.interactions.requestPlanReview(
        { plan: toPlan(input), followUpOptions: PLAN_FOLLOW_UP_OPTIONS },
        (review) => {
          if (review === null) {
            resolve({ behavior: 'deny', message: 'Session terminée avant la réponse.' })
            return
          }
          if (review.decision === 'rejected') {
            resolve({
              behavior: 'deny',
              message: "Plan refusé : continue à planifier sans rien exécuter.",
            })
            return
          }

          // Sortir du mode plan ne dit pas comment continuer : sans ce changement de
          // mode, l'agent retomberait dans celui qui l'a fait planifier et
          // replanifierait. La valeur vient du client : revalidée ici, un identifiant
          // inconnu vaut « pas de changement de mode » plutôt qu'un mode inventé.
          const parsed = claudePermissionModeSchema.safeParse(review.followUpMode)
          const mode = parsed.success ? parsed.data : null
          resolve({
            behavior: 'allow',
            ...(mode
              ? {
                  updatedPermissions: [
                    { type: 'setMode', mode: toPermissionMode(mode), destination: 'session' },
                  ],
                }
              : {}),
          })
          if (mode) {
            this.config = { ...this.config, permissionMode: mode }
            // Persisté tout de suite : le mode adopté doit survivre au runner, sinon
            // les réglages affichent l'ancien et une reprise repartirait en mode plan.
            this.ctx.updateConfig(this.config)
          }
        },
      )
    })
  }

  answerQuestion(requestId: string, answer: QuestionAnswer): boolean {
    return this.interactions.resolveQuestion(requestId, answer)
  }

  /**
   * Observateur pur : il relève les boucles armées et rend la main sans rien décider.
   *
   * La cadence est celle des fins de tour, ce qui suffit ici : une tâche planifiée ne
   * tire qu'entre deux tours, jamais pendant. Un relevé par fin de tour voit donc tout
   * ce qui peut changer, au moment où ça change.
   *
   * Champ défini plutôt que méthode : le SDK appelle la référence telle quelle.
   */
  private readonly handleStop: HookCallback = async (input) => {
    if (input.hook_event_name === 'Stop') {
      this.ctx.emit({
        type: 'loops.updated',
        loops: (input.session_crons ?? []).map((cron) => ({
          id: cron.id,
          schedule: cron.schedule,
          recurring: cron.recurring,
          prompt: cron.prompt,
        })),
      })
      // Un serveur peut tomber ou finir de s'authentifier en cours de session : sans ce
      // relevé, l'inventaire resterait celui du démarrage.
      void this.publishMcpStatus()
    }
    return { continue: true }
  }

  /**
   * Publie l'inventaire MCP tel que le CLI le voit.
   *
   * Interrogé plutôt que déduit de ce que Sillage a transmis : c'est la seule façon de
   * savoir qu'un serveur a échoué à démarrer, et la seule qui montre aussi ceux venus
   * du disque du CLI, que l'utilisateur subit sans les avoir déclarés ici.
   */
  private async publishMcpStatus(): Promise<void> {
    const session = this.session
    if (!session) return

    try {
      // Les serveurs écartés faute d'un secret n'ont jamais été transmis au CLI : il
      // ne peut pas les rapporter, et sans cet ajout ils disparaîtraient au lieu de
      // s'afficher en échec.
      this.ctx.emit({
        type: 'mcp.updated',
        servers: [...this.mcpFailures, ...fromSdkMcpStatus(await session.mcpServerStatus())],
      })
    } catch (err) {
      // Un inventaire manquant ne justifie pas de faire tomber la session : la
      // conversation reste utilisable, seul l'écran d'état est en retard.
      process.stderr.write(
        `[claude ${this.conversationId}] inventaire MCP indisponible : ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }

  /**
   * Publie les commandes en `/` reconnues par la session.
   *
   * Le CLI en pousse lui-même la liste dès qu'elle bouge ; celle-ci n'est demandée
   * qu'au démarrage, où rien n'a encore été poussé.
   */
  private async publishSupportedCommands(): Promise<void> {
    const session = this.session
    if (!session) return

    try {
      this.publishCommands(await session.supportedCommands())
    } catch (err) {
      // Une liste manquante ne coûte que l'aide à la saisie : une commande tapée en
      // entier part quand même. Rien qui justifie de faire tomber la session.
      process.stderr.write(
        `[claude ${this.conversationId}] commandes indisponibles : ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }

  private publishCommands(commands: SlashCommand[]): void {
    this.ctx.emit({
      type: 'commands.updated',
      commands: usableSlashCommands(
        commands.map((command) => ({
          name: command.name,
          description: command.description,
          argumentHint: command.argumentHint,
          aliases: command.aliases ?? [],
        })),
      ),
    })
  }

  /**
   * Élicitation MCP : un serveur réclame une saisie à l'utilisateur.
   *
   * Canal distinct de `canUseTool` : ce n'est ni une permission d'outil ni une question
   * de l'agent, mais une demande d'un serveur MCP tierce. Sans ce rappel, le CLI répond
   * lui-même « decline » et le serveur reçoit un refus que personne n'a formulé.
   *
   * Champ défini plutôt que méthode : le SDK appelle la référence telle quelle.
   */
  private readonly handleElicitation = (request: ElicitationRequest): Promise<ElicitationResult> => {
    return new Promise<ElicitationResult>((resolve) => {
      this.interactions.requestElicitation(
        {
          serverName: request.serverName,
          // `mode` est facultatif côté SDK ; le formulaire est le comportement historique.
          mode: request.mode === 'url' ? 'url' : 'form',
          message: request.message,
          url: request.url ?? null,
          fields: parseElicitationFields(request.requestedSchema),
          title: request.title ?? null,
        },
        (answer) => {
          if (answer === null) {
            // `cancel` plutôt que `decline` : le serveur MCP distingue un refus
            // explicite d'une demande qui n'a jamais atteint personne.
            resolve({ action: 'cancel' })
            return
          }
          // Le contenu n'accompagne qu'une acceptation : MCP ne prévoit rien à
          // transporter avec un refus ou une annulation.
          resolve(
            answer.action === 'accept'
              ? { action: 'accept', content: answer.content }
              : { action: answer.action },
          )
        },
      )
    })
  }

  resolveElicitation(requestId: string, answer: ElicitationAnswer): boolean {
    return this.interactions.resolveElicitation(requestId, answer)
  }

  reviewPlan(requestId: string, review: PlanReview): boolean {
    // Normalisé avant journalisation : la valeur vient du client et le schéma commun
    // n'y voit qu'une chaîne opaque. Un identifiant que cet adaptateur ne connaît
    // pas vaut « pas de changement de mode », et c'est cette lecture-là qui doit se
    // retrouver dans le journal, pas la chaîne inventée.
    const parsed = claudePermissionModeSchema.safeParse(review.followUpMode)
    return this.interactions.resolvePlanReview(requestId, {
      ...review,
      followUpMode: parsed.success ? parsed.data : null,
    })
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    return this.interactions.resolvePermission(requestId, decision)
  }

  /**
   * Les mentions ne sont pas reprises ici : Claude Code développe lui-même les
   * `@chemin` présents dans le texte, relativement à son répertoire de travail. Le
   * comportement a été vérifié sur le CLI installé, en posant une question sur un
   * fichier mentionné avec tous les outils refusés : la réponse est arrivée sans
   * qu'aucun outil ne soit appelé, donc le contenu était déjà dans le contexte.
   *
   * Les compétences non plus : Claude expose les siennes parmi ses commandes en `/`,
   * qui partent dans le texte. Rien ne les publie ici, donc la liste arrive vide.
   */
  async send(
    text: string,
    attachments: OutgoingAttachment[],
    _mentions: OutgoingMention[],
    _skills: string[],
  ): Promise<void> {
    const { blocks, prompt } = await buildUserMessage(text, attachments)

    this.ctx.emit({
      type: 'message.completed',
      messageId: randomUUID(),
      role: 'user',
      blocks,
      parentToolCallId: null,
    })
    this.openTurn()

    this.input.push({
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
      session_id: '',
    } as SDKUserMessage)
  }

  /**
   * Infléchit le tour en cours.
   *
   * Il n'y a pas de requête dédiée comme le `turn/steer` de Codex : le message part
   * par le flux ordinaire, et c'est `priority` qui dit au CLI où le poser. `next`
   * replie le message dans le tour courant, à la prochaine frontière de lot d'outils,
   * où il arrive au modèle précédé de « The user sent a new message while you were
   * working ». `later` lui ferait attendre le tour suivant, ce que fait déjà la file.
   *
   * La valeur est écrite plutôt que laissée au défaut, qui vaut `next` : elle est le
   * seul écart entre ce geste et `send`, et le lecteur doit pouvoir le voir.
   *
   * Deux limites, relevées à la sonde sur le CLI installé et absentes de la
   * documentation. Le repli n'a lieu qu'à une frontière de lot d'outils : si l'agent
   * rédige déjà sa réponse finale sans autre appel, le tour se termine et le message
   * ouvre le suivant. Et rien dans le flux ne dit laquelle des deux choses s'est
   * produite, donc `true` affirme que le message est parti dans un tour ouvert, pas
   * qu'il l'a réorienté.
   */
  async steer(
    text: string,
    attachments: OutgoingAttachment[],
    _mentions: OutgoingMention[],
    _skills: string[],
  ): Promise<boolean> {
    if (!this.session || !this.turnOpen) return false

    const { blocks, prompt } = await buildUserMessage(text, attachments)

    this.ctx.emit({
      type: 'message.completed',
      messageId: randomUUID(),
      role: 'user',
      blocks,
      parentToolCallId: null,
    })

    // Pas de `openTurn()`, contrairement à `send` : le tour est déjà ouvert, c'est la
    // condition même du geste, et en ouvrir un second fausserait le compte.
    this.input.push({
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
      session_id: '',
      priority: 'next',
    } as SDKUserMessage)

    return true
  }

  /**
   * Compaction.
   *
   * Claude n'expose pas de requête de contrôle pour ça : `/compact` est une commande de
   * barre oblique, que le CLI reconnaît dans un message utilisateur ordinaire. Elle est
   * donc envoyée par le même canal qu'un message, et produit un tour comme un autre.
   *
   * Le message n'est pas journalisé comme contenu utilisateur : ce n'est pas quelque
   * chose que l'utilisateur a dit à l'agent, c'est une commande adressée au CLI.
   */
  async compact(): Promise<boolean> {
    if (!this.session) return false

    this.openTurn()
    this.input.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '/compact' }] },
      parent_tool_use_id: null,
      session_id: '',
    } as SDKUserMessage)

    return true
  }

  /**
   * Requête de contrôle `stopTask` du SDK. Le CLI clôt la tâche puis publie la liste
   * restante en `background_tasks_changed` : rien à émettre ici, le journal apprend
   * l'arrêt par le chemin qui lui a appris le lancement.
   */
  async stopBackgroundTask(taskId: string): Promise<boolean> {
    if (!this.session) return false
    try {
      await this.session.stopTask(taskId)
    } catch {
      // Course ordinaire : la tâche s'est terminée entre le clic et la requête, le CLI
      // ne la connaît plus. Même réponse qu'une session absente, pas une erreur.
      return false
    }
    return true
  }

  /**
   * Le SDK expose des requêtes de contrôle pour ces réglages : les changer ne demande
   * pas de relancer le CLI, donc la session garde son contexte chargé.
   */
  async applyConfig(config: AgentConfig): Promise<boolean> {
    if (config.agent !== 'claude' || !this.session) return false

    // `strictMcpConfig` n'est qu'une option de lancement : le SDK n'expose aucune
    // requête de contrôle pour l'inverser. Refuser ici fait redémarrer le runner, qui
    // repartira en reprise avec la bonne valeur.
    if (config.strictMcp !== this.config.strictMcp) return false

    // Sortir de `bypassPermissions` demande de relancer, au même titre qu'y entrer. Le
    // contournement est donné au lancement, et `set_permission_mode` ne le reprend pas :
    // il accepte le nouveau mode sans rien changer, `canUseTool` n'est plus jamais
    // rappelé, et la conversation continue à tout autoriser sous un réglage qui affiche
    // le contraire. Contrairement au sens inverse, qui échoue franchement, celui-ci
    // passait pour appliqué et n'a donc jamais fait repartir le runner.
    if (this.launchedWithBypass && config.permissionMode !== 'bypassPermissions') return false

    await this.session.setModel(config.model)
    await this.session.applyFlagSettings({ effortLevel: config.effort })
    await this.session.setPermissionMode(toPermissionMode(config.permissionMode))

    // Comparé sur les serveurs résolus et non sur les identifiants : une entrée du
    // registre corrigée entre-temps doit repartir, alors que la liste d'identifiants,
    // elle, n'a pas bougé.
    const resolved = this.ctx.resolveMcpServers(config)
    const desired = toSdkMcpServers(resolved.servers)
    if (JSON.stringify(desired) !== JSON.stringify(this.appliedMcpServers)) {
      await this.session.setMcpServers(desired)
      this.appliedMcpServers = desired
      this.mcpFailures = failedStatuses(resolved.failures)
      await this.publishMcpStatus()
    }

    this.config = config
    return true
  }

  /**
   * Claude Code résume la session dès le premier tour et le persiste à côté du
   * transcript. On le lit par `getSessionInfo`, pas par un hook `SessionStart` : un
   * hook forke un process à chaque événement, ce que le budget mémoire exclut.
   */
  async suggestedTitle(): Promise<string | null> {
    const sessionId = this.sessionId
    if (!sessionId) return null

    try {
      const info = await getSessionInfo(sessionId, { dir: this.ctx.cwd })
      const title = info?.customTitle ?? info?.summary ?? null
      return title && title.trim().length > 0 ? title.trim() : null
    } catch {
      // Un titre absent n'est pas une panne : la conversation garde le sien.
      return null
    }
  }

  async interrupt(): Promise<void> {
    await this.session?.interrupt()
    this.ctx.setStatus('idle')

    // Le tour n'est pas refermé ici : le CLI répond à l'interruption d'un tour vivant
    // par un `result`, qui porte le `turn.completed` sur lequel le fil web raccroche son
    // indicateur d'activité. Le fermer d'avance ferait taire le statut sans que le fil
    // le sache, et le geste paraîtrait sans effet, activité et bouton Stop toujours à
    // l'écran. Quand aucun tour n'était réellement en cours, ce `result` ne vient pas :
    // c'est le filet qui referme.
    this.armTurnWatchdog('interrupted')
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.clearTurnWatchdog()
    this.input.close()
    this.abort.abort()
    this.interactions.expireAll()
  }
}
