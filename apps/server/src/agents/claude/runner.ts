import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import {
  getSessionInfo,
  query,
  type CanUseTool,
  type ElicitationRequest,
  type ElicitationResult,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import {
  parseElicitationFields,
  type AgentConfig,
  type ClaudeConfig,
  type ContentBlock,
} from '@sillage/protocol'
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
 * (compteurs de tokens de réflexion, changements d'état de session) sans rien
 * apporter au fil de conversation. Liste nommée plutôt qu'un `default:` muet, pour
 * qu'un nouveau type de message inconnu soit visible et non avalé.
 */
const IGNORED_SUBTYPES = new Set(['thinking_tokens', 'session_state_changed', 'commands_changed'])

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
  private streamingMessageId: string | null = null
  /** Identifiant natif, requis pour relire le résumé de session. */
  private sessionId: string | null = null
  private stopped = false
  /** Suit les changements appliqués à chaud, contrairement à `ctx.config` qui est figé. */
  private config: ClaudeConfig

  constructor(private readonly ctx: RunnerContext) {
    this.conversationId = ctx.conversationId
    this.config = ctx.config as ClaudeConfig
    this.interactions = new PendingInteractions(ctx)
  }

  async start(): Promise<void> {
    const config = this.config

    this.session = query({
      prompt: this.input,
      options: {
        cwd: this.ctx.cwd,
        model: config.model,
        effort: config.effort,
        permissionMode: toPermissionMode(config.permissionMode),
        // Les pièces jointes sont stockées hors du workspace : sans ce dossier
        // autorisé, l'agent se verrait refuser la lecture des fichiers qu'on lui joint.
        additionalDirectories: [...config.additionalDirectories, this.ctx.attachmentsRoot],
        includePartialMessages: true,
        abortController: this.abort,
        ...(this.ctx.resumeSessionId ? { resume: this.ctx.resumeSessionId } : {}),
        // Le SDK sait résoudre son propre exécutable ; on ne l'écrase que si la
        // configuration désigne explicitement un chemin absolu.
        ...(isAbsolute(this.ctx.binary) ? { pathToClaudeCodeExecutable: this.ctx.binary } : {}),
        canUseTool: this.handleToolRequest,
        onElicitation: this.handleElicitation,
        stderr: (data) => {
          // La sortie d'erreur du CLI n'est pas un événement de conversation, mais la
          // perdre rend tout diagnostic impossible.
          process.stderr.write(`[claude ${this.conversationId}] ${data}`)
        },
      },
    })

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

  private translate(message: SDKMessage): void {
    switch (message.type) {
      case 'system': {
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
        if (message.subtype === 'init') {
          this.sessionId = message.session_id
          this.ctx.setAgentSessionId(message.session_id)
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
        if (event.type === 'message_start') {
          this.streamingMessageId = event.message.id
          return
        }
        if (event.type !== 'content_block_delta') return

        const messageId = this.streamingMessageId
        if (!messageId) return

        const delta = event.delta
        if (delta.type === 'text_delta') {
          this.ctx.emit({ type: 'message.delta', messageId, text: delta.text })
        } else if (delta.type === 'thinking_delta') {
          this.ctx.emit({ type: 'thinking.delta', messageId, text: delta.thinking })
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
        if (typeof content === 'string') return

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
        // Types non traduits : conservés bruts dans le journal pour ne rien perdre,
        // sans polluer le fil. Ils deviendront des événements typés si besoin.
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
      this.interactions.requestPlanReview(toPlan(input), (review) => {
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
        // replanifierait.
        const mode = review.followUpMode
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
          // Persisté tout de suite : le mode adopté doit survivre au runner, sinon les
          // réglages affichent l'ancien et une reprise repartirait en mode plan.
          this.ctx.updateConfig(this.config)
        }
      })
    })
  }

  answerQuestion(requestId: string, answer: QuestionAnswer): boolean {
    return this.interactions.resolveQuestion(requestId, answer)
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
    return this.interactions.resolvePlanReview(requestId, review)
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
   */
  async send(
    text: string,
    attachments: OutgoingAttachment[],
    _mentions: OutgoingMention[],
  ): Promise<void> {
    const { blocks, prompt } = await buildUserMessage(text, attachments)

    this.ctx.emit({ type: 'message.completed', messageId: randomUUID(), role: 'user', blocks })
    this.ctx.emit({ type: 'turn.started' })
    this.ctx.setStatus('running')

    this.input.push({
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
      session_id: '',
    } as SDKUserMessage)
  }

  /**
   * Claude Code n'a pas d'équivalent de `turn/steer` : un message poussé en cours de
   * tour s'y mêle au contexte courant au lieu de l'infléchir, ce qui a été observé sur
   * le CLI installé (réponse sortie avant la fin du tour, puis une seconde fois).
   * Renvoyer false le dit franchement, et la file d'attente couvre le besoin.
   */
  async steer(): Promise<boolean> {
    return false
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

    this.ctx.emit({ type: 'turn.started' })
    this.ctx.setStatus('running')
    this.input.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '/compact' }] },
      parent_tool_use_id: null,
      session_id: '',
    } as SDKUserMessage)

    return true
  }

  /**
   * Le SDK expose des requêtes de contrôle pour ces trois réglages : les changer ne
   * demande pas de relancer le CLI, donc la session garde son contexte chargé.
   */
  async applyConfig(config: AgentConfig): Promise<boolean> {
    if (config.agent !== 'claude' || !this.session) return false

    await this.session.setModel(config.model)
    await this.session.applyFlagSettings({ effortLevel: config.effort })
    await this.session.setPermissionMode(toPermissionMode(config.permissionMode))

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
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.input.close()
    this.abort.abort()
    this.interactions.expireAll()
  }
}
