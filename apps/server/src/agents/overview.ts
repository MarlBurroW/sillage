import { and, count, desc, eq, gt, isNull, ne, or, sql } from 'drizzle-orm'
import { cards, conversations, worktrees, type Db } from '@sillage/db'

/**
 * Ce qui se passe sur le projet, injecté au démarrage d'une session.
 *
 * Un CLI arrive sans rien savoir de ce que les autres ont fait, et rien ne le pousse à
 * aller le demander : les outils du serveur MCP répondent quand on les interroge, encore
 * faut-il y penser. Cet aperçu est le seul élément qui arrive sans initiative de l'agent,
 * et c'est ce qui le justifie malgré son coût en jetons.
 *
 * Calculé et non stocké. Une note écrite quelque part et jamais relue vieillit et finit
 * par tromper avec l'autorité d'une note ; recalculer à chaque démarrage coûte une
 * requête et ne peut pas mentir. C'est aussi pour ça qu'aucun magasin de mémoire ne
 * vient s'ajouter à `CLAUDE.md`, à la roadmap et au journal.
 *
 * Le projet entier et non le seul worktree, contrairement à `find_file_edits` : ici on
 * cherche à savoir quels chantiers sont ouverts, et un chantier sur une autre branche
 * en est un. Le worktree est dit ligne par ligne, pour que l'agent fasse la part des
 * choses lui-même.
 */

/** Au-delà, l'aperçu pèse plus qu'il n'oriente. */
const MAX_SESSIONS = 6

/**
 * Fenêtre des sessions dites « récentes ».
 *
 * Trois jours plutôt qu'une journée : un chantier ouvert vendredi est toujours le
 * chantier en cours le lundi, et l'ignorer ferait repartir de zéro sur un sujet déjà
 * traité. Les sessions qui travaillent en ce moment sortent de toute façon, quelle que
 * soit leur ancienneté.
 */
const RECENT_MS = 3 * 24 * 60 * 60 * 1000

interface OverviewInput {
  projectId: string
  conversationId: string
  /** L'agent a-t-il les outils du serveur MCP de Sillage sous la main. */
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

/** Ancienneté en clair, l'horodatage absolu obligeant le modèle à faire la soustraction. */
function ago(ts: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - ts) / 60_000))
  if (minutes < 1) return "à l'instant"
  if (minutes < 60) return `il y a ${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `il y a ${hours} h` : `il y a ${Math.round(hours / 24)} j`
}

/** Taille du chantier, arrondie : ce qui compte est l'ordre de grandeur. */
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
  return `- ${row.title}\n  ${row.agent}, ${state}, ${where}, ${size(row.tokens)}, ouverte ${ago(row.createdAt, now)}, dernier échange ${ago(row.updatedAt, now)}`
}

/**
 * La carte que cette conversation traite, et ce qui l'a précédée dessus.
 *
 * C'est la partie de l'aperçu qui parle du travail demandé plutôt que de son voisinage,
 * et la seule qui manquait vraiment : un agent qui reprend un chantier à la quatrième
 * session repartait de zéro sans savoir qu'il y en avait eu trois.
 */
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
      `\`read_card\` avec le numéro ${card.number} rend sa description entière, les notes des sessions précédentes et les cartes qui la citent ; \`add_card_note\` laisse à la suivante ce qu'elle ne pourra pas redécouvrir seule, et c'est à faire avant de terminer. La colonne d'une carte, elle, se change dans l'interface et jamais par toi.`,
    )
  }

  return lines.join(' ')
}

/** Les colonnes en toutes lettres : les valeurs stockées sont des identifiants. */
const COLUMN_WORDS: Record<string, string> = {
  todo: 'à faire',
  in_progress: 'en cours',
  review: 'à vérifier',
  done: 'marquée terminée',
  abandoned: 'marquée abandonnée',
}

/**
 * Null quand il n'y a rien à dire, et c'est important : un aperçu vide répété à chaque
 * démarrage apprend au modèle à ne plus le lire, et le jour où il porte quelque chose
 * il passe inaperçu.
 */
export function projectOverview(db: Db, input: OverviewInput): string | null {
  const now = Date.now()
  const briefing = cardBriefing(db, input)

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

  // La carte parle même quand le projet est calme : elle dit ce qui est demandé, ce que
  // le voisinage ne dit pas.
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
      'Les outils du serveur `sillage` donnent la suite : `search_history` et `read_conversation` pour ce qui a été décidé avant, `list_sessions` et `find_file_edits` pour ce que les autres font en ce moment, `list_cards` et `read_card` pour le travail que ce projet s\'est donné.',
    )
  }

  return parts.join('\n\n')
}
