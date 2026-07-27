import { sql } from 'drizzle-orm'
import type { Db } from '@sillage/db'
import {
  SEARCH_MARK_CLOSE,
  SEARCH_MARK_OPEN,
  type AgentKind,
  type SearchMessageDto,
} from '@sillage/protocol'

/**
 * Traduit une saisie libre en requête FTS5.
 *
 * Chaque terme est cité, ce qui neutralise la syntaxe du moteur : sans ça, un `-` ou
 * un `"` tapé au milieu d'une phrase fait échouer la requête entière. Le dernier terme
 * accepte un préfixe, la frappe étant encore en cours au moment où on interroge.
 *
 * Un terme sans lettre ni chiffre ne produit aucun jeton et ne ramène donc rien, ce qui
 * est le comportement attendu plutôt qu'une erreur.
 */
function toMatchQuery(input: string): string {
  return input
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term, index, terms) => {
      const quoted = `"${term.replaceAll('"', '""')}"`
      return index === terms.length - 1 ? `${quoted}*` : quoted
    })
    .join(' ')
}

interface Row {
  conversationId: string
  projectId: string
  conversationTitle: string
  agent: AgentKind
  seq: number
  role: string
  ts: number
  excerpt: string
}

/**
 * Messages contenant la requête, dans les conversations que ce compte peut voir.
 *
 * La visibilité est appliquée dans la requête et non après coup : un extrait de projet
 * privé qui remonterait jusqu'à la couche HTTP aurait déjà fuité si un filtre y était
 * oublié un jour. La jointure sur `conversations` rend aussi invisibles les lignes
 * orphelines, une table virtuelle FTS5 ne recevant pas les suppressions en cascade.
 *
 * Les conversations archivées sont exclues, comme partout ailleurs dans l'interface :
 * la recherche voit ce que la navigation voit.
 */
export function searchMessages(
  db: Db,
  userId: string,
  query: string,
  limit: number,
): SearchMessageDto[] {
  const match = toMatchQuery(query)
  if (!match) return []

  const rows = db.all<Row>(sql`
    SELECT m.conversation_id AS conversationId,
           c.project_id AS projectId,
           c.title AS conversationTitle,
           c.agent AS agent,
           m.seq AS seq,
           m.role AS role,
           m.ts AS ts,
           snippet(search_messages, 0, ${SEARCH_MARK_OPEN}, ${SEARCH_MARK_CLOSE}, '...', 12) AS excerpt
    FROM search_messages AS m
    JOIN conversations AS c ON c.id = m.conversation_id
    JOIN projects AS p ON p.id = c.project_id
    WHERE search_messages MATCH ${match}
      AND c.archived_at IS NULL
      AND (p.owner_id = ${userId} OR p.visibility = 'shared')
    ORDER BY bm25(search_messages)
    LIMIT ${limit}
  `)

  return rows.map((row) => ({
    conversationId: row.conversationId,
    projectId: row.projectId,
    conversationTitle: row.conversationTitle,
    agent: row.agent,
    seq: row.seq,
    // Le rôle vient de l'index, donc d'un événement déjà validé à l'écriture ; tout
    // ce qui n'est pas un message utilisateur est de l'agent.
    role: row.role === 'user' ? 'user' : 'assistant',
    ts: row.ts,
    excerpt: row.excerpt,
  }))
}
