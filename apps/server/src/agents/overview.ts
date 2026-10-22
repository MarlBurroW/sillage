import { and, count, desc, eq, gt, isNull, ne, or, sql } from 'drizzle-orm'
import { automationWebhooks, cards, conversations, projectImages, scheduledTasks, worktrees, type Db } from '@sillage/db'
import { MAX_SESSION_TITLE_CHARS, sessionReference, sessionMarker, sessionTrailer } from '@sillage/protocol'

/** Project activity injected at session startup. CLIs lack others' history and may not think to query MCP; this unsolicited overview justifies its token cost. Compute rather than store notes that grow stale with undeserved authority: one fresh query per start. Durable user-managed instructions belong separately in SILLAGE.md (`instructions/store.ts`). Cover the whole project rather than `find_file_edits`' worktree scope because other branches are active work too; identify worktrees per row for agents to distinguish. */

/** Beyond this size, overviews cost more context than guidance. */
const MAX_SESSIONS = 6

/** Recent-session window: three days rather than one so Friday work remains relevant Monday. Currently working sessions always appear regardless of age. */
const RECENT_MS = 3 * 24 * 60 * 60 * 1000

interface OverviewInput {
  projectId: string
  conversationId: string
  /** Whether Sillage MCP tools are available to agents. */
  sillageMcp: boolean
}

interface Row {
  id: string
  title: string
  agent: string
  status: string
  background: number
  loops: number
  createdAt: number
  updatedAt: number
  tokens: number
  worktree: string | null
}

/** Readable ages avoid model subtraction of absolute timestamps. */
function ago(ts: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - ts) / 60_000))
  if (minutes < 1) return "à l'instant"
  if (minutes < 60) return `il y a ${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `il y a ${hours} h` : `il y a ${Math.round(hours / 24)} j`
}

/** Rounded work size: scale matters rather than exact counts. */
function size(tokens: number): string {
  if (tokens < 1000) return 'quelques échanges'
  return `~${Math.round(tokens / 1000)} k jetons`
}

function describe(row: Row, now: number): string {
  const working = row.status === 'running' || row.background > 0 || row.loops > 0
  const state = working
    ? row.status === 'running'
      ? 'en cours'
      : `travail de fond en cours`
    : row.status === 'awaiting_input'
      ? 'attend une réponse'
      : row.status === 'interrupted'
        ? 'interrompue'
        : 'terminée'

  const where = row.worktree ? `worktree ${row.worktree}` : 'racine du projet'
  return `- ${row.title} | ${sessionReference(row.id)}\n  ${row.agent}, ${state}, ${where}, ${size(row.tokens)}, ouverte ${ago(row.createdAt, now)}, dernier échange ${ago(row.updatedAt, now)}`
}

/** Current card and preceding sessions working on it. Unlike neighboring activity, this explains the requested work; agents resuming a fourth session otherwise would miss three previous sessions. */
function cardBriefing(db: Db, input: OverviewInput): string | null {
  const card = db
    .select({ number: cards.number, title: cards.title, column: cards.column, id: cards.id })
    .from(cards)
    .innerJoin(conversations, eq(conversations.cardId, cards.id))
    .where(eq(conversations.id, input.conversationId))
    .get()
  if (!card) return null

  const [before] = db
    .select({ total: count() })
    .from(conversations)
    .where(and(eq(conversations.cardId, card.id), ne(conversations.id, input.conversationId)))
    .all()

  const previous = before?.total ?? 0
  const lines = [
    `Cette conversation traite la carte #${card.number} « ${card.title} », ${COLUMN_WORDS[card.column]}.`,
  ]

  if (previous > 0) {
    lines.push(
      `${previous} autre(s) session(s) ont déjà travaillé dessus : ce n'est pas un sujet neuf.`,
    )
  }

  if (input.sillageMcp) {
    lines.push(
      `\`read_card\` avec le numéro ${card.number} rend sa description entière, les chemins locaux de ses pièces jointes à consulter avec tes outils de lecture, les notes des sessions précédentes et les cartes qui la citent ; \`add_card_note\` laisse à la suivante ce qu'elle ne pourra pas redécouvrir seule, et c'est à faire avant de terminer. \`move_card\` la passe en « à vérifier » quand ton travail est prêt à relire ; « terminé » et « abandonné » restent à l'utilisateur, sauf s'il te le demande.`,
    )
  }

  return lines.join(' ')
}

/** Readable column names: stored values are identifiers. */
const COLUMN_WORDS: Record<string, string> = {
  todo: 'à faire',
  in_progress: 'en cours',
  review: 'à vérifier',
  done: 'marquée terminée',
  abandoned: 'marquée abandonnée',
}

/** Project image reminder while missing or provisional. Navigation images aid recognition but humans forget them; agents can find repository logos. New projects may lack logos, so provisional placeholders keep reminders active until replaced. Permanent images and agents without relevant tools suppress reminders. */
function imageReminder(db: Db, input: OverviewInput): string | null {
  if (!input.sillageMcp) return null

  const image = db
    .select({ provisional: projectImages.provisional })
    .from(projectImages)
    .where(eq(projectImages.projectId, input.projectId))
    .get()

  if (!image) {
    return "Ce projet n'a pas d'image dans Sillage, alors que c'est elle qui permet à l'utilisateur de le reconnaître d'un coup d'œil parmi les autres. Sans détourner le travail demandé, par exemple une fois qu'il est fini, donne-lui en une avec `set_project_image`. Cherche d'abord un logo ou une icône dans le dépôt : favicon, `logo.*`, `icon.*`, dossiers `public`, `assets` ou `static`, image en tête du README. S'il n'y en a pas, dessine un SVG simple qui évoque le projet, ou génère une image si tu as un outil pour ça, et pose-la avec `provisional: true` : les sessions suivantes sauront qu'elle attend un vrai logo."
  }

  if (image.provisional) {
    return "L'image de ce projet dans Sillage est provisoire : elle a été posée faute de logo. Dès que le projet en a un vrai, et en particulier si c'est toi qui le crées ou l'ajoutes, remplace-la avec `set_project_image`."
  }

  return null
}

/** Forge markers for webhook-enabled projects identify session-originated issues/PRs and bound launch chains. Omit instructions without webhooks to avoid needless context cost. */
function forgeMarkerReminder(db: Db, input: OverviewInput): string | null {
  const hooks = db
    .select({ name: scheduledTasks.name, enabled: scheduledTasks.enabled })
    .from(automationWebhooks)
    .innerJoin(scheduledTasks, eq(scheduledTasks.id, automationWebhooks.taskId))
    .where(eq(scheduledTasks.projectId, input.projectId))
    .all()
  if (hooks.length === 0) return null
  const names = hooks.map((hook) => `« ${hook.name} »${hook.enabled ? '' : ' (en pause)'}`).join(', ')
  return `Ce projet a des automatisations déclenchées par webhook (${names}). Ce que tu publies sur une forge pour lui (issue, pull request, commentaire, revue) se termine par ${sessionMarker(input.conversationId)}, et tes messages de commit par le trailer \`${sessionTrailer(input.conversationId)}\` : c'est ce qui permet à Sillage de reconnaître ton travail et d'empêcher des agents de se relancer en chaîne. Ne pose jamais un label et n'écris jamais une commande qui déclenche l'une d'elles, sauf si l'utilisateur te le demande.`
}

/** A session-specific instruction reaches every CLI through the same startup context. */
function sessionTitleReminder(db: Db, input: OverviewInput): string | null {
  if (!input.sillageMcp) return null
  const current = db.select({ title: conversations.title, user: conversations.titleSetByUser, agent: conversations.titleSetByAgent })
    .from(conversations)
    .where(and(eq(conversations.id, input.conversationId), eq(conversations.projectId, input.projectId)))
    .get()
  if (!current || current.user) return null
  if (current.agent) {
    return `Titre de cette session : ${JSON.stringify(current.title)}. Conserve-le tant que le sujet principal ne change pas. Si la demande change réellement de sujet, ajuste-le avec \`rename_session\` du serveur \`sillage\`, en 3 à 6 mots dans la langue de l'utilisateur (${MAX_SESSION_TITLE_CHARS} caractères maximum).`
  }
  return `Dès que tu as compris la demande, appelle \`rename_session\` du serveur \`sillage\` pour donner à cette session un titre court et parlant : vise 3 à 6 mots, ${MAX_SESSION_TITLE_CHARS} caractères maximum, dans la langue de l'utilisateur. Nomme le sujet concret, par exemple « Refonte de la sidebar » ou « Corriger la connexion », plutôt que recopier sa phrase ou annoncer un état d'avancement. Ce titre aide l'utilisateur à retrouver le fil ; fais-le sans lui demander de confirmer et sans interrompre le travail demandé. Ne le change ensuite que si le sujet principal change.`
}

/** Null when empty: repeated empty overviews teach models to ignore them, making future relevant content unnoticed. */
export function projectOverview(db: Db, input: OverviewInput): string | null {
  const now = Date.now()
  // Cards before images: requested work precedes suggestions.
  const referenceReminder = input.sillageMcp
    ? 'Pour citer une session dans tes réponses, écris session:<id> avec son identifiant Sillage exact : l’interface en fait un lien avec son titre et ses détails. read_conversation accepte cet identifiant ou cette référence pour consulter le fil, archives comprises. Une mention seule ne demande pas d’envoyer un message à un autre agent.'
    : null
  const briefing = [referenceReminder, sessionTitleReminder(db, input), cardBriefing(db, input), forgeMarkerReminder(db, input), imageReminder(db, input)]
    .filter((part) => part !== null)
    .join('\n\n') || null

  const rows = db
    .select({
      id: conversations.id,
      title: conversations.title,
      agent: conversations.agent,
      status: conversations.status,
      background: conversations.backgroundCount,
      loops: conversations.loopCount,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt,
      tokens: sql<number>`${conversations.inputTokens} + ${conversations.outputTokens}`,
      worktree: worktrees.name,
    })
    .from(conversations)
    .leftJoin(worktrees, eq(worktrees.id, conversations.worktreeId))
    .where(
      and(
        eq(conversations.projectId, input.projectId),
        ne(conversations.id, input.conversationId),
        isNull(conversations.archivedAt),
        or(
          eq(conversations.status, 'running'),
          gt(conversations.backgroundCount, 0),
          gt(conversations.loopCount, 0),
          gt(conversations.updatedAt, now - RECENT_MS),
        ),
      ),
    )
    .orderBy(desc(conversations.updatedAt))
    .limit(MAX_SESSIONS)
    .all() as Row[]

  // Cards matter even on quiet projects because they state requested work,
  // unlike neighboring activity.
  if (rows.length === 0) return briefing

  const working = rows.filter(
    (row) => row.status === 'running' || row.background > 0 || row.loops > 0,
  )

  const parts = briefing ? [briefing] : []
  parts.push(
    `Autres sessions Sillage sur ce projet, ${working.length > 0 ? `dont ${working.length} en cours` : 'aucune en cours'} :`,
    rows.map((row) => describe(row, now)).join('\n'),
  )

  if (working.length > 0) {
    parts.push(
      "Une session en cours travaille peut-être dans le même arbre : avant de défaire une modification que tu n'as pas faite, regarde d'où elle vient.",
    )
  }

  if (input.sillageMcp) {
    parts.push(
      'Les outils du serveur `sillage` donnent la suite : `search_history` et `read_conversation` pour ce qui a été décidé avant, `list_sessions` et `find_file_edits` pour ce que les autres font en ce moment, `send_session_message` pour prévenir l\'une d\'elles ou lui poser une question quand ça ne peut pas attendre l\'utilisateur, `notify_when_done` pour être relancé quand elle aura fini plutôt que de la surveiller, `broadcast_session_message` avant un geste qui touche toutes celles qui travaillent, `list_cards` et `read_card` pour le travail que ce projet s\'est donné, `create_card` pour y noter ce qui sort de ton sujet, `start_session` pour confier un travail à une nouvelle session quand l\'utilisateur le demande, `list_worktrees` et `create_worktree` pour travailler dans un arbre à l\'écart des autres plutôt que par `git worktree add`, que Sillage ne verrait pas, `schedule_task` pour planifier un travail récurrent ou différé qui survit à cette session, `create_automation` pour lancer une session à chaque appel d\'un webhook (une issue étiquetée, une CI en échec), `list_actions` et `register_action` pour les boutons du projet qui lancent d\'un clic un serveur, des tests ou un script.',
    )
  }

  return parts.join('\n\n')
}
