import type {
  AgentQuestion,
  ContentBlock,
  ElicitationField,
  ElicitationValue,
  PermissionOption,
  PlanFollowUpOption,
  SillageEvent,
} from '@sillage/protocol'
import { translate } from './i18n'

/**
 * Fold du journal vers le modèle d'affichage (invariant I2 : le rendu est une
 * fonction pure du journal, rejouable depuis zéro).
 *
 * Aucune information affichée ne doit provenir d'ailleurs que d'ici. Si un état de
 * l'UI n'est pas dérivable de cette fonction, c'est que l'événement manque côté
 * serveur, pas qu'il faut une variable d'état supplémentaire côté client.
 */

export interface MessageItem {
  kind: 'message'
  id: string
  role: 'user' | 'assistant'
  /** Date du premier événement qui a créé le message, en millisecondes. */
  ts: number
  /** Position dans le journal, seul repère utilisable pour couper le fil (fork). */
  seq: number
  blocks: ContentBlock[]
  /** Texte en cours de réception, vidé dès que le message correspondant arrive. */
  streamingText: string
  streamingThinking: string
  /** Appel qui a lancé le sous-agent auteur du message. Null pour l'agent principal. */
  parentToolCallId: string | null
}

export interface ToolItem {
  kind: 'tool'
  id: string
  /** Date d'ouverture de l'appel : la seule base pour un chronomètre en cours. */
  ts: number
  name: string
  input: unknown
  output: unknown
  status: 'running' | 'done' | 'failed' | 'interrupted'
  durationMs: number | null
  parentToolCallId: string | null
}

export interface PermissionItem {
  kind: 'permission'
  id: string
  toolName: string
  input: unknown
  suggestions: PermissionOption[]
  status: 'pending' | 'allowed' | 'denied' | 'expired'
  /** Phrase rédigée par le CLI, qui sait pourquoi il demande. Null s'il n'en donne pas. */
  title: string | null
  description: string | null
}

/** Une question posée par l'agent, en attente ou déjà tranchée. */
export interface QuestionItem {
  kind: 'question'
  id: string
  questions: AgentQuestion[]
  status: 'pending' | 'answered' | 'cancelled' | 'expired'
  /** Réponses retenues, par identifiant de question. Vide tant qu'on n'a pas répondu. */
  answers: Record<string, string[]>
}

/** Une saisie réclamée par un serveur MCP. */
export interface ElicitationItem {
  kind: 'elicitation'
  id: string
  serverName: string
  mode: 'form' | 'url'
  message: string
  url: string | null
  fields: ElicitationField[]
  title: string | null
  status: 'pending' | 'accept' | 'decline' | 'cancel' | 'expired'
  content: Record<string, ElicitationValue>
}

/** Un plan soumis à validation avant passage à l'exécution. */
export interface PlanItem {
  kind: 'plan'
  id: string
  plan: string
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  /** Suites proposées par l'adaptateur ; vide sur les journaux d'avant le champ. */
  followUpOptions: PlanFollowUpOption[]
  /** L'`id` de l'option retenue, opaque pour l'UI. */
  followUpMode: string | null
}

export interface ErrorItem {
  kind: 'error'
  id: string
  code: string
  message: string
  recoverable: boolean
}

/** Repère discret dans le fil, sans contenu propre (changement de modèle, reprise). */
export interface NoticeItem {
  kind: 'notice'
  id: string
  text: string
}

export type ChatItem =
  | MessageItem
  | ToolItem
  | PermissionItem
  | QuestionItem
  | ElicitationItem
  | PlanItem
  | ErrorItem
  | NoticeItem

/** Vrai si un élément attend une décision de l'utilisateur pour que le tour reprenne. */
export function isAwaitingUser(item: ChatItem): boolean {
  return (
    (item.kind === 'permission' ||
      item.kind === 'question' ||
      item.kind === 'elicitation' ||
      item.kind === 'plan') &&
    item.status === 'pending'
  )
}

/**
 * Un message en attente de la fin du tour courant.
 *
 * Volontairement hors de `items` : il ne fait pas partie du fil, il s'affiche après
 * l'indicateur d'activité pour montrer que l'agent traite ce qui est au-dessus. Le
 * mettre dans `items` obligerait la réglette et le regroupement d'outils à l'ignorer.
 */
export interface QueuedMessage {
  queueId: string
  text: string
  attachmentCount: number
}

/** Un fichier touché par l'agent pendant un tour. */
export interface EditedFile {
  path: string
  action: 'created' | 'modified' | 'deleted'
  /**
   * Appels ayant touché ce fichier pendant le tour, dans l'ordre.
   *
   * Le fichier n'apparaît qu'une fois, mais un agent le reprend souvent en plusieurs
   * passes : garder chaque appel permet de montrer chaque modification, alors que ne
   * retenir que la dernière effacerait les précédentes.
   */
  toolCallIds: string[]
}

/**
 * Modifications d'un tour, dans l'ordre où les tours ont eu lieu.
 *
 * Regroupées par message utilisateur plutôt que par `turn.started` : c'est la demande
 * qui donne son sens à une série de modifications, et l'ordre des deux événements
 * diffère selon le CLI.
 */
export interface EditTurn {
  /** Identifiant du message utilisateur qui a ouvert le tour. */
  id: string
  ts: number
  /** Début du message, pour reconnaître le tour dans la liste. */
  label: string
  files: EditedFile[]
}

/** Dernier état de quota connu, tel qu'annoncé par le CLI. */
export interface RateLimitState {
  type: string
  status: 'allowed' | 'allowed_warning' | 'rejected'
  utilization: number | null
  resetsAt: number | null
}

/** Occupation de la fenêtre de contexte, telle que le CLI la rapporte. */
export interface ContextState {
  usedTokens: number
  maxTokens: number
  ratio: number
}

export interface ChatState {
  items: ChatItem[]
  queued: QueuedMessage[]
  lastSeq: number
  /** Coût API équivalent. Sur un compte par abonnement, il n'est pas facturé. */
  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  model: string | null
  rateLimit: RateLimitState | null
  context: ContextState | null
  /** Les tours terminés, pour afficher un indicateur d'activité fiable. */
  turnRunning: boolean
  /** Historique des modifications, tour par tour, dérivé de `file.edited`. */
  editTurns: EditTurn[]
  /**
   * Une compaction est en cours.
   *
   * Distinct de `turnRunning` : pendant une compaction l'agent ne répond pas, il
   * réécrit sa mémoire, et l'annoncer comme une réflexion fait attendre une réponse
   * qui ne viendra pas.
   */
  compacting: boolean
}

export function emptyChatState(): ChatState {
  return {
    items: [],
    queued: [],
    lastSeq: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    model: null,
    rateLimit: null,
    context: null,
    editTurns: [],
    turnRunning: false,
    compacting: false,
  }
}

/**
 * Ce qu'un tour a fait d'un fichier, quand il y touche plusieurs fois.
 *
 * Créé puis réécrit reste une création ; supprimé en dernier l'emporte sur tout, le
 * fichier n'étant plus là à la fin du tour.
 */
function mergeAction(current: EditedFile['action'], next: EditedFile['action']): EditedFile['action'] {
  if (next === 'deleted') return 'deleted'
  return current
}

/** Tokens en milliers, la maille sous laquelle le chiffre n'apprend plus rien. */
function thousands(tokens: number): string {
  return `${Math.round(tokens / 1000)} k`
}

/**
 * Ce que la compaction a réellement libéré, dans la limite de ce que le CLI en dit :
 * Claude donne les deux tailles, Codex n'en donne aucune.
 */
function describeCompaction(preTokens: number | null, postTokens: number | null): string {
  if (preTokens === null) return translate('activity.compaction.done')
  if (postTokens === null) {
    return translate('activity.compaction.doneWithPre', { tokens: thousands(preTokens) })
  }
  return translate('activity.compaction.doneWithBoth', {
    pre: thousands(preTokens),
    post: thousands(postTokens),
  })
}

/**
 * Ce que l'agent est en train de faire, ou null quand il n'y a rien à signaler.
 *
 * Dérivé du seul journal, comme tout le reste de l'affichage : c'est ce qui permet à
 * l'indicateur de rester juste après un rechargement, sans état parallèle à tenir.
 * Une demande de permission en attente ne renvoie rien, la demande elle-même étant
 * déjà l'information.
 */
export function describeActivity(state: ChatState): string | null {
  // Avant le tour : la compaction déclenchée depuis le menu n'ouvre pas toujours un
  // tour, et c'est de toute façon elle qu'il faut nommer quand les deux coexistent.
  // La taille annoncée est celle d'avant, la seule connue tant qu'elle n'est pas finie.
  if (state.compacting) {
    return state.context
      ? translate('activity.compacting.tokens', { tokens: thousands(state.context.usedTokens) })
      : translate('activity.compacting')
  }
  if (!state.turnRunning) return null

  return activityOf(state.items, null)
}

/**
 * Ce que fait l'auteur d'un fil, d'après son dernier élément.
 *
 * `thread` désigne l'auteur : `null` pour l'agent principal, l'appel de spawn pour un
 * sous-agent. Sans ce filtre, un sous-agent occupé fait dire au fil principal qu'il
 * cherche dans les fichiers alors qu'il attend son rapport.
 */
export function activityOf(items: ChatItem[], thread: string | null): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (!item) continue
    if ((item.kind === 'tool' || item.kind === 'message') && item.parentToolCallId !== thread) {
      continue
    }

    if (isAwaitingUser(item)) return null
    if (
      item.kind === 'permission' ||
      item.kind === 'question' ||
      item.kind === 'elicitation' ||
      item.kind === 'plan'
    ) {
      return translate('message.thinking.label')
    }
    if (item.kind === 'tool') {
      return item.status === 'running'
        ? translate('activity.toolRunning', { name: item.name })
        : translate('message.thinking.label')
    }
    if (item.kind === 'message') {
      if (item.role === 'user') return translate('message.thinking.label')
      if (item.streamingText) return translate('activity.writing')
      return translate('message.thinking.label')
    }
  }

  return translate('message.thinking.label')
}

/** Au-delà, l'intitulé d'un tour déborde de la colonne du panneau. */
const TURN_LABEL_MAX = 60

/**
 * Le message utilisateur qui a ouvert le tour en cours.
 *
 * Un tour peut n'en avoir aucun (une compaction, une reprise) : le repère devient
 * alors la position dans le journal, qui reste unique.
 */
function lastUserMessage(state: ChatState): { id: string; label: string } {
  for (let i = state.items.length - 1; i >= 0; i -= 1) {
    const item = state.items[i]
    if (item?.kind !== 'message' || item.role !== 'user') continue

    const text = item.blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()

    return {
      id: item.id,
      label: text.length > TURN_LABEL_MAX ? `${text.slice(0, TURN_LABEL_MAX).trimEnd()}...` : text,
    }
  }

  return { id: `seq-${state.lastSeq}`, label: translate('activity.turn.noMessage') }
}

/**
 * Blocs qui ont leur place dans la bulle.
 *
 * Les `tool_use` sont rendus comme éléments propres. Les blocs de texte et de
 * réflexion sans contenu sont écartés : Fable et Opus raisonnent côté serveur et
 * renvoient un bloc `thinking` vide, réduit à sa signature chiffrée, dont le seul
 * effet à l'écran serait un volet « Réflexion » qui ne s'ouvre sur rien.
 */
export function renderableBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.filter((block) => {
    if (block.type === 'tool_use' || block.type === 'tool_result') return false
    if (block.type === 'text' || block.type === 'thinking') return block.text.trim() !== ''
    return true
  })
}

/**
 * Vrai si l'élément produit quelque chose à l'écran.
 *
 * Un message d'agent qui ne porte que des `tool_use` n'affiche rien : ses blocs sont
 * rendus à part, comme appels d'outils. Il reste pourtant dans le fil, et le compter
 * comme visible laissait une ligne vide dans la gouttière, en plus de couper une suite
 * d'outils en deux groupes sans raison apparente.
 */
export function hasVisibleContent(item: ChatItem): boolean {
  if (item.kind !== 'message') return true
  if (item.streamingText.trim() || item.streamingThinking.trim()) return true
  return renderableBlocks(item.blocks).length > 0
}

/**
 * Ajoute un élément en renouvelant le tableau.
 *
 * Le tableau doit changer d'identité à chaque modification, sinon tout `useMemo` ou
 * `useEffect` qui en dépend ne se déclenche jamais : c'est exactement ce qui rendait
 * la réglette des tours définitivement vide.
 */
function appendItem(state: ChatState, item: ChatItem): void {
  state.items = [...state.items, item]
}

/**
 * Remplace un élément par une copie modifiée, au lieu de le muter.
 *
 * C'est ce qui rend la mémoïsation des lignes possible : muter en place laisse la
 * référence inchangée, donc `React.memo` conclurait que rien n'a bougé et le message
 * en cours de frappe ne se redessinerait jamais. Les voisins, eux, gardent leur
 * identité et ne sont pas redessinés.
 */
function replaceItem<T extends ChatItem>(state: ChatState, index: number, next: T): void {
  const items = [...state.items]
  items[index] = next
  state.items = items
}

function findLastIndex(items: ChatItem[], predicate: (item: ChatItem) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (item && predicate(item)) return i
  }
  return -1
}

/** Index du message, en le créant s'il n'existe pas encore. */
function messageIndex(
  state: ChatState,
  id: string,
  role: 'user' | 'assistant',
  ts: number,
  seq: number,
  parentToolCallId: string | null,
): number {
  const existing = findLastIndex(state.items, (item) => item.kind === 'message' && item.id === id)
  if (existing !== -1) return existing

  appendItem(state, {
    kind: 'message',
    id,
    role,
    // Date et position du premier fragment reçu : un message livré en plusieurs
    // morceaux garde l'heure à laquelle il a commencé, pas celle de son dernier bloc.
    ts,
    seq,
    blocks: [],
    streamingText: '',
    streamingThinking: '',
    parentToolCallId,
  })
  return state.items.length - 1
}

function updateMessage(
  state: ChatState,
  id: string,
  role: 'user' | 'assistant',
  ts: number,
  seq: number,
  parentToolCallId: string | null,
  update: (message: MessageItem) => MessageItem,
): void {
  const index = messageIndex(state, id, role, ts, seq, parentToolCallId)
  const current = state.items[index] as MessageItem
  // Un même message peut arriver en morceaux de provenances mêlées : des deltas
  // journalisés avant l'ajout du champ (parent absent), puis un `message.completed`
  // qui le porte. Le premier événement qui nomme un parent fait foi ; on n'oublie
  // jamais un parent connu, une resynchronisation de transcript émettant null.
  const parent = current.parentToolCallId ?? parentToolCallId
  replaceItem(state, index, { ...update(current), parentToolCallId: parent })
}

/**
 * Clôt les appels restés ouverts à la fin d'un tour ou d'une session.
 *
 * Un CLI interrompu n'envoie pas le résultat des appels en vol : sans ce filet ils
 * restent « en cours » pour toujours, y compris après rechargement, et un `Task`
 * abandonné annonce alors un sous-agent qui travaille encore, chronomètre à l'appui.
 *
 * Un `tool.completed` en retard reprend la main : il réécrit le statut sans condition.
 */
function closeRunningTools(state: ChatState): void {
  state.items.forEach((item, index) => {
    if (item.kind === 'tool' && item.status === 'running') {
      replaceItem(state, index, { ...item, status: 'interrupted' as const })
    }
  })
}

/**
 * Applique un événement. L'état est muté puis renvoyé dans un nouvel objet : les
 * conversations longues rendent une copie profonde par événement trop coûteuse sur
 * un téléphone, et seule la référence racine sert à déclencher le rendu React.
 *
 * `ts` vient du journal : c'est la date d'écriture côté serveur, la seule qui ait un
 * sens partagé. Une date posée par le client varierait d'un appareil à l'autre pour un
 * même message.
 */
export function applyEvent(
  state: ChatState,
  seq: number,
  ts: number,
  event: SillageEvent,
): ChatState {
  // Un tour se reconnaît à ce qu'il produit, pas seulement à son marqueur d'ouverture.
  //
  // `turn.started` n'est émis que quand Sillage envoie un message, alors que
  // `turn.completed` l'est à chaque `result` du CLI : un redémarrage de session laisse
  // donc des complétions orphelines, et le fil se croyait au repos pendant que l'agent
  // travaillait, sans bouton Stop ni indicateur d'activité. Du texte qui arrive ou un
  // outil qui démarre prouvent le contraire, et `turn.completed` refermera de toute
  // façon.
  if (event.type === 'message.delta' || event.type === 'tool.started') {
    state.turnRunning = true
  }

  switch (event.type) {
    case 'session.started': {
      // Le CLI ré-émet son init quand le modèle change en cours de session : c'est
      // le seul signal fiable pour marquer la bascule dans le fil.
      if (state.model && state.model !== event.model && state.items.length > 0) {
        appendItem(state, {
          kind: 'notice',
          id: `model-${seq}`,
          text: translate('activity.modelChanged', { model: event.model }),
        })
      }
      state.model = event.model
      break
    }

    case 'turn.started': {
      state.turnRunning = true
      break
    }

    case 'turn.completed': {
      state.turnRunning = false
      closeRunningTools(state)
      // Filet : une compaction qui se termine sans frontière ni erreur laisserait
      // sinon l'indicateur allumé jusqu'au rechargement.
      state.compacting = false
      state.costUsd += event.costUsd
      state.inputTokens += event.inputTokens
      state.outputTokens += event.outputTokens
      state.cacheCreationTokens += event.cacheCreationTokens
      state.cacheReadTokens += event.cacheReadTokens
      break
    }

    case 'session.ended': {
      state.turnRunning = false
      state.compacting = false
      closeRunningTools(state)
      break
    }

    case 'message.delta': {
      updateMessage(state, event.messageId, 'assistant', ts, seq, event.parentToolCallId, (message) => ({
        ...message,
        streamingText: message.streamingText + event.text,
      }))
      break
    }

    case 'thinking.delta': {
      updateMessage(state, event.messageId, 'assistant', ts, seq, event.parentToolCallId, (message) => ({
        ...message,
        streamingThinking: message.streamingThinking + event.text,
      }))
      break
    }

    case 'message.completed': {
      updateMessage(state, event.messageId, event.role, ts, seq, event.parentToolCallId, (message) => ({
        ...message,
        // Un message arrive en plusieurs morceaux sous le même identifiant : les
        // blocs s'ajoutent, ils ne remplacent pas. Le contenu reçu en flux est
        // maintenant porté par ces blocs, donc les tampons sont vidés.
        blocks: [...message.blocks, ...event.blocks],
        streamingText: '',
        streamingThinking: '',
      }))
      break
    }

    case 'file.edited': {
      const opener = lastUserMessage(state)
      const current = state.editTurns.at(-1)
      const turn =
        current && current.id === opener.id
          ? current
          : { id: opener.id, ts, label: opener.label, files: [] }

      const existing = turn.files.find((file) => file.path === event.path)
      const files = existing
        ? turn.files.map((file) =>
            file.path === event.path
              ? {
                  ...file,
                  action: mergeAction(file.action, event.action),
                  toolCallIds: [...file.toolCallIds, event.toolCallId],
                }
              : file,
          )
        : [...turn.files, { path: event.path, action: event.action, toolCallIds: [event.toolCallId] }]

      // Remplacé plutôt que muté : le fil se re-rend par comparaison de références.
      state.editTurns =
        turn === current
          ? [...state.editTurns.slice(0, -1), { ...turn, files }]
          : [...state.editTurns, { ...turn, files }]
      break
    }

    case 'tool.started': {
      appendItem(state, {
        kind: 'tool',
        id: event.toolCallId,
        ts,
        name: event.name,
        input: event.input,
        output: null,
        status: 'running',
        durationMs: null,
        parentToolCallId: event.parentToolCallId,
      })
      break
    }

    case 'tool.completed': {
      const index = findLastIndex(
        state.items,
        (item) => item.kind === 'tool' && item.id === event.toolCallId,
      )
      if (index !== -1) {
        replaceItem(state, index, {
          ...(state.items[index] as ToolItem),
          output: event.output,
          status: event.isError ? 'failed' : 'done',
          durationMs: event.durationMs,
        })
      }
      break
    }

    case 'permission.requested': {
      appendItem(state, {
        kind: 'permission',
        id: event.requestId,
        toolName: event.toolName,
        input: event.input,
        suggestions: event.suggestions,
        status: 'pending',
        title: event.title ?? null,
        description: event.description ?? null,
      })
      break
    }

    case 'permission.resolved': {
      const index = findLastIndex(
        state.items,
        (item) => item.kind === 'permission' && item.id === event.requestId,
      )
      if (index !== -1) {
        replaceItem(state, index, {
          ...(state.items[index] as PermissionItem),
          status: event.decision === 'allowed' ? 'allowed' : event.decision,
        })
      }
      break
    }

    case 'question.requested': {
      appendItem(state, {
        kind: 'question',
        id: event.requestId,
        questions: event.questions,
        status: 'pending',
        answers: {},
      })
      break
    }

    case 'question.resolved': {
      const index = findLastIndex(
        state.items,
        (item) => item.kind === 'question' && item.id === event.requestId,
      )
      if (index !== -1) {
        replaceItem(state, index, {
          ...(state.items[index] as QuestionItem),
          status: event.status,
          answers: event.answers,
        })
      }
      break
    }

    case 'context.compaction_started': {
      state.compacting = true
      break
    }

    case 'context.compacted': {
      state.compacting = false
      // Repère discret : le fil ne perd rien à l'écran, mais tout ce qui précède n'est
      // plus dans la mémoire de l'agent sous sa forme d'origine.
      appendItem(state, {
        kind: 'notice',
        id: `compact-${seq}`,
        text: describeCompaction(event.preTokens, event.postTokens),
      })
      // La jauge doit repartir de ce que le CLI annoncera au prochain tour : garder
      // l'ancienne valeur afficherait un contexte plein juste après l'avoir vidé.
      state.context = null
      break
    }

    case 'message.queued': {
      state.queued = [
        ...state.queued,
        { queueId: event.queueId, text: event.text, attachmentCount: event.attachmentCount },
      ]
      break
    }

    case 'message.dequeued': {
      state.queued = state.queued.filter((entry) => entry.queueId !== event.queueId)
      break
    }

    case 'elicitation.requested': {
      appendItem(state, {
        kind: 'elicitation',
        id: event.requestId,
        serverName: event.serverName,
        mode: event.mode,
        message: event.message,
        url: event.url,
        fields: event.fields,
        title: event.title,
        status: 'pending',
        content: {},
      })
      break
    }

    case 'elicitation.resolved': {
      const index = findLastIndex(
        state.items,
        (item) => item.kind === 'elicitation' && item.id === event.requestId,
      )
      if (index !== -1) {
        replaceItem(state, index, {
          ...(state.items[index] as ElicitationItem),
          status: event.status,
          content: event.content,
        })
      }
      break
    }

    case 'plan.review_requested': {
      appendItem(state, {
        kind: 'plan',
        id: event.requestId,
        plan: event.plan,
        status: 'pending',
        followUpOptions: event.followUpOptions,
        followUpMode: null,
      })
      break
    }

    case 'plan.review_resolved': {
      const index = findLastIndex(
        state.items,
        (item) => item.kind === 'plan' && item.id === event.requestId,
      )
      if (index !== -1) {
        replaceItem(state, index, {
          ...(state.items[index] as PlanItem),
          status: event.decision,
          followUpMode: event.followUpMode,
        })
      }
      break
    }

    case 'error': {
      state.compacting = false
      appendItem(state, {
        kind: 'error',
        id: `error-${seq}`,
        code: event.code,
        message: event.message,
        recoverable: event.recoverable,
      })
      break
    }

    case 'usage.updated': {
      if (event.rateLimit) state.rateLimit = event.rateLimit
      if (event.context) state.context = event.context
      break
    }

    // Métadonnées sans rendu propre pour l'instant. Elles restent dans le journal et
    // deviendront des affichages dédiés (plan, diff) aux lots suivants.
    case 'plan.updated':
    case 'diff.updated':
    case 'message.started':
      break
  }

  state.lastSeq = Math.max(state.lastSeq, seq)
  return { ...state }
}
