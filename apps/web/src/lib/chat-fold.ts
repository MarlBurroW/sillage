import type {
  AgentQuestion,
  AgentSkillDto,
  BackgroundTask,
  ContentBlock,
  ElicitationField,
  ElicitationValue,
  Loop,
  McpServerStatus,
  PermissionOption,
  PlanFollowUpOption,
  SillageEvent,
  SlashCommandDto,
} from '@sillage/protocol'
import { locale, translate } from './i18n'

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

/**
 * Le compte rendu d'un travail que le fil ne suivait plus.
 *
 * Seuls les travaux devenus autonomes en ont un. Un sous-agent que le fil suit rend
 * déjà son résultat dans l'appel qui l'a lancé : le répéter ici mettrait deux fois la
 * même chose à l'écran.
 */
export interface TaskItem {
  kind: 'task'
  id: string
  description: string
  status: 'completed' | 'failed' | 'stopped'
  summary: string
  durationMs: number | null
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
  | TaskItem

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
  /**
   * Taille de la réflexion en cours, révélée ou non.
   *
   * Non nulle veut dire « l'agent réfléchit en ce moment » : tout autre signe de
   * progrès la remet à null, de sorte que l'indicateur n'annonce jamais une réflexion
   * pendant que du texte s'écrit ou qu'un outil tourne.
   */
  thinkingTokens: number | null
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
  /**
   * Les travaux que le CLI poursuit hors du tour : workflows, commandes lancées en
   * fond, sous-agents basculés en arrière-plan.
   *
   * Remplacée à chaque `background.updated` et jamais complétée : c'est un niveau, pas
   * une suite de débuts et de fins. Non vide alors que `turnRunning` est faux décrit
   * l'état que le fil ne savait pas montrer, celui où l'agent a rendu la main mais où
   * des fichiers changent encore.
   */
  background: BackgroundTask[]
  /**
   * Les boucles armées, telles que le dernier relevé de fin de tour les décrit.
   *
   * Remplacée et jamais complétée, comme `background` : le CLI ne raconte ni la
   * création ni la fin d'une boucle, il ne répond qu'à l'inventaire.
   */
  loops: Loop[]
  /**
   * Les serveurs MCP de la session, tels que le CLI les rapporte.
   *
   * Remplacée et jamais complétée, comme `background` et `loops` : le CLI publie
   * l'inventaire entier à chaque changement. Contient aussi les serveurs venus de sa
   * propre configuration, marqués `external`, que l'utilisateur subit sans les avoir
   * déclarés dans Sillage et doit pouvoir voir échouer.
   */
  mcp: McpServerStatus[]
  /**
   * Les commandes en `/` reconnues par la session, déjà réduites par le serveur à ce
   * qui est proposable ici.
   *
   * Remplacée et jamais complétée, comme `mcp` : le CLI republie la liste entière.
   * Vide tant qu'aucune session n'a démarré, et pour un CLI qui ne les publie pas.
   */
  commands: SlashCommandDto[]
  /**
   * Les compétences que le CLI met à disposition, référencées en `$`.
   *
   * Remplacée et jamais complétée, comme `commands`. Publiée par Codex seul : Claude
   * expose les siennes parmi ses commandes.
   */
  skills: AgentSkillDto[]
  /**
   * Les réveils observés, par consigne réinjectée : combien, et le dernier quand.
   *
   * Tenue à part de `loops` parce qu'elle doit survivre au remplacement de la liste.
   * Indexée sur la consigne faute de mieux : le CLI réinjecte le texte seul, sans dire
   * de quelle tâche il vient. Deux boucles partageant leurs 200 premiers caractères
   * mêleraient donc leurs comptes, ce qui reste préférable à ne rien compter.
   */
  loopFires: Map<string, { count: number; lastAt: number }>
  /**
   * Ce que le CLI dit de chaque travail enregistré, de son lancement à son arrêt.
   *
   * Tenue à part de `background` : la liste de niveau dit qui vit, cette table dit
   * quoi. Elle garde aussi les travaux déjà finis, dont on affiche encore le compte
   * rendu.
   */
  tasks: Map<string, TaskState>
}

/** L'avancement d'un travail, tel que les événements `task.*` le décrivent. */
export interface TaskState {
  id: string
  /** L'appel d'outil qui l'a lancé, nul quand le harnais l'a lancé de lui-même. */
  toolCallId: string | null
  kind: string
  description: string
  /** Ce qu'il fait à l'instant, nul tant qu'il n'a pas rendu compte une première fois. */
  activity: string | null
  lastTool: string | null
  toolUses: number
  totalTokens: number
  durationMs: number
  /**
   * Vrai dès que le travail a continué alors que le fil ne le suivait plus : son appel
   * d'outil était déjà rendu, ou il n'en avait aucun.
   *
   * C'est ce qui sépare un workflow d'un sous-agent ordinaire, les deux étant annoncés
   * dans la même liste. Une fois posé, l'indicateur ne retombe pas : un travail rendu
   * à lui-même le reste, et son compte rendu de fin doit arriver dans le fil même si
   * la dernière liste de niveau l'a déjà retiré.
   */
  unattended: boolean
  /** Vrai une fois son compte rendu reçu. Le travail peut alors être cru sur parole. */
  done: boolean
  /**
   * Comment il s'est terminé, nul tant qu'il tourne.
   *
   * Tenu à part de `done` parce qu'un travail détaché ne finit pas toujours de lui-même :
   * arrêté avec sa session, il est fini sans avoir abouti, et la ligne du sous-agent doit
   * le dire plutôt que d'afficher la fin normale de l'appel qui l'a lancé.
   */
  outcome: 'completed' | 'failed' | 'stopped' | null
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
    thinkingTokens: null,
    compacting: false,
    background: [],
    loops: [],
    mcp: [],
    commands: [],
    skills: [],
    loopFires: new Map(),
    tasks: new Map(),
  }
}

/**
 * Clé d'appariement entre une consigne réinjectée et la boucle qui la porte.
 *
 * Tronquée bien en deçà des 1000 caractères auxquels le CLI coupe les consignes qu'il
 * inventorie : comparer les chaînes entières ferait manquer l'appariement des longues,
 * seules celles-là étant coupées d'un côté et pas de l'autre.
 */
export function loopKey(prompt: string): string {
  return prompt.slice(0, 200)
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
 * Tokens au token près, groupés selon la langue.
 *
 * Distinct de `thousands` : celui-ci mesure une taille qu'on lit d'un coup d'œil, alors
 * qu'un compteur qui avance est lu deux fois de suite, et c'est l'écart entre les deux
 * lectures qui l'anime. Arrondi au millier, il affiche « 0 k » un long moment puis saute
 * à « 1 k » : le chiffre est juste, mais il ne bouge plus, donc il ne prouve plus rien.
 */
function exactTokens(tokens: number): string {
  return tokens.toLocaleString(locale())
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

  // Le compteur prime sur le dernier élément du fil : il n'est renseigné que pendant
  // une réflexion en cours, et il en dit plus que le « Réflexion » nu déduit d'un outil
  // déjà rendu. C'est aussi le seul signe de vie quand le modèle cache son texte.
  if (state.thinkingTokens !== null) {
    return translate('activity.thinking.tokens', { tokens: exactTokens(state.thinkingTokens) })
  }

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
/**
 * Remplace un travail dans la table. La table entière est recopiée, pour la même
 * raison que les éléments du fil : muter en place laisserait la référence inchangée,
 * et les vues mémoïsées sur elle ne se redessineraient pas.
 */
function putTask(state: ChatState, task: TaskState): void {
  const tasks = new Map(state.tasks)
  tasks.set(task.id, task)
  state.tasks = tasks
}

/** L'état d'un appel d'outil du fil, ou null s'il n'y en a pas trace. */
function toolStatus(state: ChatState, toolCallId: string): ToolItem['status'] | null {
  const index = findLastIndex(state.items, (item) => item.kind === 'tool' && item.id === toolCallId)
  const item = index === -1 ? null : state.items[index]
  return item && item.kind === 'tool' ? item.status : null
}

function closeRunningTools(state: ChatState): void {
  state.items.forEach((item, index) => {
    if (item.kind === 'tool' && item.status === 'running') {
      replaceItem(state, index, { ...item, status: 'interrupted' as const })
    }
  })
}

/**
 * Le pendant de `closeRunningTools` pour les travaux, à la fin d'une session.
 *
 * Un sous-agent passé en arrière-plan a son appel d'outil déjà rendu : `closeRunningTools`
 * ne le voit donc pas, et c'est son travail, resté sans compte rendu, qui le maintenait
 * affiché comme actif. Sans cette clôture il l'était pour toujours, y compris au
 * rechargement, puisque plus rien n'allait être écrit à son sujet.
 */
function closePendingTasks(state: ChatState): void {
  const tasks = new Map(state.tasks)
  for (const [id, task] of tasks) {
    if (!task.done) tasks.set(id, { ...task, activity: null, done: true, outcome: 'stopped' })
  }
  state.tasks = tasks
}

/**
 * Ce qui prouve qu'une réflexion est finie.
 *
 * Liste explicite plutôt que « tout sauf `thinking.progress` » : un relevé d'usage ou
 * un rapport de sous-agent arrive au milieu d'une réflexion sans rien y mettre fin, et
 * éteindrait le compteur le temps d'un battement.
 *
 * `thinking.delta` en est absent, et c'est tout l'enjeu : les deux alternent frame par
 * frame quand la pensée est révélée. L'y mettre effaçait chaque valeur avant qu'elle
 * soit rendue, et le compteur ne s'affichait jamais.
 */
const THINKING_ENDED_BY = new Set<SillageEvent['type']>([
  'message.started',
  'message.delta',
  'message.completed',
  'tool.started',
  'tool.completed',
  'turn.started',
  'turn.completed',
  'session.ended',
  'context.compaction_started',
])

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

  // La réflexion muette n'a pas de fin annoncée : c'est ce qui la suit qui la referme.
  // Sans cette remise à zéro, le compteur resterait affiché pendant la rédaction ou
  // l'exécution d'un outil, et annoncerait une réflexion déjà terminée.
  if (THINKING_ENDED_BY.has(event.type)) state.thinkingTokens = null

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
      // Le travail de fond appartient au process du CLI : il s'arrête avec lui, sans
      // que rien ne vienne l'annoncer. Les boucles aussi, une tâche planifiée ne tirant
      // que pendant que le CLI tourne. Les réveils déjà comptés restent, eux : ce sont
      // des faits du journal, pas un état de process.
      state.background = []
      state.loops = []
      closeRunningTools(state)
      closePendingTasks(state)
      break
    }

    case 'message.delta': {
      updateMessage(state, event.messageId, 'assistant', ts, seq, event.parentToolCallId, (message) => ({
        ...message,
        streamingText: message.streamingText + event.text,
      }))
      break
    }

    case 'thinking.progress': {
      // Un tour reprise de session n'a pas de `turn.started` : réfléchir suffit à
      // prouver qu'il tourne, comme le fait déjà un delta de texte plus haut.
      state.turnRunning = true
      state.thinkingTokens = event.estimatedTokens
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
      // L'appel est rendu alors que le travail qu'il a lancé vit encore : personne ne
      // le suit plus. La liste de niveau pose la même marque de son côté, parce que
      // rien ne garantit lequel des deux événements arrive en premier.
      for (const task of state.tasks.values()) {
        if (task.toolCallId !== event.toolCallId || task.unattended) continue
        if (state.background.some((live) => live.id === task.id)) {
          putTask(state, { ...task, unattended: true })
        }
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
      // Un réglage qui attend la fin du tour n'est pas une panne : le tour continue et
      // le choix est déjà enregistré. Un bandeau d'alerte le ferait passer pour un échec.
      if (event.code === 'config_restart_deferred') {
        appendItem(state, {
          kind: 'notice',
          id: `config-deferred-${seq}`,
          text: translate('activity.configRestartDeferred'),
        })
        break
      }
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

    case 'background.updated': {
      // Remplacement et non fusion : l'événement porte la liste entière, et c'est ce
      // qui rend l'indicateur increvable. Un événement perdu se rattrape au suivant
      // au lieu de laisser un travail allumé pour toujours.
      state.background = event.tasks
      // Un travail encore vivant alors que son appel d'outil est rendu n'est plus
      // suivi par personne. C'est le seul moment où la question se pose : la liste
      // est justement ce qui dit qu'il vit encore.
      for (const task of event.tasks) {
        const known = state.tasks.get(task.id)
        if (!known || known.unattended) continue
        if (known.toolCallId === null || toolStatus(state, known.toolCallId) !== 'running') {
          putTask(state, { ...known, unattended: true })
        }
      }
      break
    }

    case 'loops.updated': {
      state.loops = event.loops
      break
    }

    case 'mcp.updated': {
      state.mcp = event.servers
      break
    }

    case 'commands.updated': {
      state.commands = event.commands
      break
    }

    case 'skills.updated': {
      state.skills = event.skills
      break
    }

    case 'prompt.injected': {
      const key = loopKey(event.text)
      const seen = state.loopFires.get(key)
      state.loopFires.set(key, { count: (seen?.count ?? 0) + 1, lastAt: ts })
      break
    }

    case 'task.started': {
      putTask(state, {
        id: event.taskId,
        toolCallId: event.toolCallId,
        kind: event.kind,
        description: event.description,
        activity: null,
        lastTool: null,
        toolUses: 0,
        totalTokens: 0,
        durationMs: 0,
        unattended: false,
        done: false,
        outcome: null,
      })
      break
    }

    case 'task.progress': {
      const known = state.tasks.get(event.taskId)
      // Un avancement sans lancement connu vient d'un journal tronqué par la
      // rétention : il n'y a rien à quoi le rattacher, et l'inventer donnerait un
      // travail sans nom ni origine.
      if (!known) break
      putTask(state, {
        ...known,
        activity: event.activity,
        lastTool: event.lastTool,
        toolUses: event.toolUses,
        totalTokens: event.totalTokens,
        durationMs: event.durationMs,
      })
      break
    }

    case 'task.completed': {
      const known = state.tasks.get(event.taskId)
      if (known) {
        putTask(state, {
          ...known,
          activity: null,
          durationMs: event.durationMs ?? known.durationMs,
          done: true,
          outcome: event.status,
        })
      }
      // La liste de niveau est remplacée, jamais amendée, et le CLI la republie en
      // effet juste après. Mais s'il meurt entre les deux, sa dernière liste garde le
      // travail allumé pour toujours : une fin annoncée vaut retrait.
      state.background = state.background.filter((live) => live.id !== event.taskId)
      if (known?.unattended && !event.ambient) {
        appendItem(state, {
          kind: 'task',
          id: `task-${event.taskId}`,
          description: known.description,
          status: event.status,
          summary: event.summary,
          durationMs: event.durationMs,
        })
      }
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
