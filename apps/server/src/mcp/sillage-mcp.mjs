/**
 * Serveur MCP de Sillage : rend au CLI ce que la plateforme sait et qu'il ignore.
 *
 * Un CLI redémarre amnésique à chaque conversation, alors que Sillage garde le journal
 * de toutes les précédentes. Les deux outils exposés ici ouvrent cette mémoire, cadrée
 * au projet courant.
 *
 * En `.mjs` plutôt qu'en TypeScript compilé, comme la sonde : le process est lancé par
 * le CLI, pas par Sillage, et le garder hors du graphe de modules du serveur évite
 * qu'il n'embarque un jour la moitié de l'application par un import distrait. Sa seule
 * dépendance est `better-sqlite3`, déjà présente.
 *
 * Il lit la base directement, en lecture seule, plutôt que d'appeler l'API HTTP. Pas de
 * jeton à faire circuler, pas de port à ouvrir : l'environnement ne porte qu'une portée,
 * jamais un secret. Ce n'est pas une frontière de sécurité pour autant, l'agent ayant
 * déjà un shell et le fichier sur le disque ; c'est le même accès, en plus commode.
 */
import { createInterface } from 'node:readline'
import Database from 'better-sqlite3'

const DB_PATH = process.env.SILLAGE_MCP_DB
const PROJECT_ID = process.env.SILLAGE_MCP_PROJECT
/** Exclue des résultats : sans ça l'agent se relit lui-même et tourne en rond. */
const CURRENT_CONVERSATION = process.env.SILLAGE_MCP_CONVERSATION ?? ''

/** Au-delà, le fil ne tient plus dans un contexte sans en chasser le travail en cours. */
const MAX_THREAD_CHARS = 20000
const MAX_MESSAGE_CHARS = 2000

const log = (msg) => process.stderr.write(`[sillage-mcp] ${msg}\n`)
const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`)

if (!DB_PATH || !PROJECT_ID) {
  log('SILLAGE_MCP_DB et SILLAGE_MCP_PROJECT sont requis')
  process.exit(1)
}

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })

const TOOLS = [
  {
    name: 'search_history',
    description:
      "Cherche dans les conversations passées de ce projet sur Sillage, celles menées avec ce CLI comme avec les autres. Rend une liste de conversations avec un extrait, pas leur contenu : utiliser read_conversation ensuite pour en lire une. Appelle cet outil avant de conclure qu'un sujet est neuf, quand une décision semble avoir déjà été prise, quand un bug ressemble à du déjà-vu, ou quand l'utilisateur fait référence à un travail antérieur.",
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Mots à chercher. Recherche plein texte sur le corps des messages.',
        },
        limit: {
          type: 'integer',
          description: 'Nombre maximum de conversations rendues. 10 par défaut, 50 au plus.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_conversation',
    description:
      "Lit le fil d'une conversation passée de ce projet, identifiée par le `id` rendu par search_history. Rend les messages de l'utilisateur et de l'agent, sans les appels d'outils. Le fil est tronqué s'il est long.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Identifiant rendu par search_history.' },
      },
      required: ['id'],
    },
  },
]

/**
 * Traduit une saisie libre en requête FTS5.
 *
 * Chaque terme est cité, ce qui neutralise la syntaxe du moteur : sans ça un `-` ou un
 * `"` au milieu d'une phrase fait échouer la requête entière. Pas de préfixe sur le
 * dernier terme, contrairement à la recherche de l'interface : ici la requête arrive
 * complète, personne n'est en train de la taper.
 *
 * Doit rester d'accord avec `apps/server/src/search/search-messages.ts`.
 */
function toMatchQuery(input) {
  return input
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(' ')
}

/**
 * Conversations du projet dont un message contient la requête.
 *
 * Une conversation peut avoir plusieurs messages qui répondent ; seul le mieux classé
 * est gardé, l'agent cherchant une conversation à ouvrir et non un message isolé. D'où
 * la marge sur la limite SQL, réduite ensuite au nombre demandé.
 *
 * Lit `search_messages`, l'index plein texte que le serveur maintient à l'écriture
 * (`apps/server/src/search/search-index.ts`). Table dérivée, jamais source : un journal
 * indexé de travers se rattrape par `pnpm search:reindex`.
 */
function searchHistory(query, limit) {
  const match = toMatchQuery(query)
  if (!match) return []

  const rows = db
    .prepare(
      `SELECT m.conversation_id AS id,
              c.title AS title,
              c.agent AS agent,
              m.ts AS ts,
              snippet(search_messages, 0, '', '', '...', 15) AS excerpt
       FROM search_messages AS m
       JOIN conversations AS c ON c.id = m.conversation_id
       WHERE search_messages MATCH ?
         AND c.project_id = ?
         AND c.id != ?
         AND c.archived_at IS NULL
       ORDER BY bm25(search_messages)
       LIMIT ?`,
    )
    .all(match, PROJECT_ID, CURRENT_CONVERSATION, limit * 5)

  const best = new Map()
  for (const row of rows) {
    if (!best.has(row.id)) best.set(row.id, row)
    if (best.size >= limit) break
  }
  return [...best.values()]
}

/**
 * Messages d'un fil, appels d'outils exclus.
 *
 * L'extraction reprend celle de l'index de recherche : mêmes blocs de texte, même
 * exclusion des messages de sous-agents, qui appartiennent à un panneau latéral et non
 * au fil. Le `project_id` est vérifié ici et pas seulement à la recherche : rien
 * n'empêche l'agent de fabriquer un identifiant.
 */
function readConversation(id) {
  const conversation = db
    .prepare(
      `SELECT id, title, agent, created_at AS createdAt
       FROM conversations
       WHERE id = ? AND project_id = ?`,
    )
    .get(id, PROJECT_ID)
  if (!conversation) return null

  const messages = db
    .prepare(
      `SELECT event.payload ->> '$.role' AS role,
              event.ts AS ts,
              group_concat(block.value ->> '$.text', char(10)) AS text
       FROM events AS event, json_each(event.payload ->> '$.blocks') AS block
       WHERE event.conversation_id = ?
         AND event.type = 'message.completed'
         AND block.value ->> '$.type' = 'text'
         AND coalesce(event.payload ->> '$.parentToolCallId', '') = ''
       GROUP BY event.seq
       ORDER BY event.seq`,
    )
    .all(id)

  return { conversation, messages }
}

const asDate = (ts) => new Date(ts).toISOString().slice(0, 10)

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n[...]` : text
}

function renderSearch(query, results) {
  if (results.length === 0) {
    return `Aucune conversation de ce projet ne contient « ${query} ».`
  }

  const lines = results.map(
    (row) => `- ${row.id} | ${asDate(row.ts)} | ${row.agent} | ${row.title}\n  ${row.excerpt}`,
  )
  return `${results.length} conversation(s) pour « ${query} » :\n${lines.join('\n')}`
}

function renderThread(found) {
  const { conversation, messages } = found
  const header = `${conversation.title} (${conversation.agent}, ${asDate(conversation.createdAt)})`
  if (messages.length === 0) return `${header}\n\nAucun message dans ce fil.`

  const rendered = []
  let total = 0
  let dropped = 0

  for (const message of messages) {
    // Tronqué par la fin : dans une conversation, ce sont les derniers échanges qui
    // portent la conclusion, mais les premiers qui portent la demande. On garde donc le
    // début et on annonce ce qui manque, plutôt que de rendre un extrait sans énoncé.
    const body = clip(message.text ?? '', MAX_MESSAGE_CHARS)
    if (total + body.length > MAX_THREAD_CHARS) {
      dropped = messages.length - rendered.length
      break
    }
    total += body.length
    rendered.push(`## ${message.role === 'user' ? 'Utilisateur' : 'Agent'}\n${body}`)
  }

  const suffix = dropped > 0 ? `\n\n[${dropped} message(s) suivants non rendus, fil tronqué]` : ''
  return `${header}\n\n${rendered.join('\n\n')}${suffix}`
}

const text = (value) => ({ content: [{ type: 'text', text: value }] })

function callTool(name, args) {
  if (name === 'search_history') {
    const query = typeof args?.query === 'string' ? args.query : ''
    if (!query.trim()) return { ...text('Le paramètre `query` est requis.'), isError: true }

    const asked = Number.isInteger(args?.limit) ? args.limit : 10
    const limit = Math.min(Math.max(asked, 1), 50)
    return text(renderSearch(query, searchHistory(query, limit)))
  }

  if (name === 'read_conversation') {
    const id = typeof args?.id === 'string' ? args.id : ''
    const found = id ? readConversation(id) : null
    if (!found) {
      return {
        ...text(`Aucune conversation « ${id} » dans ce projet.`),
        isError: true,
      }
    }
    return text(renderThread(found))
  }

  return { ...text(`Outil inconnu : ${name}`), isError: true }
}

log(`prêt, projet=${PROJECT_ID}`)

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return

  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    log('ligne illisible, ignorée')
    return
  }

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        // La version demandée par le client : le CLI décide, pas nous.
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'sillage', version: '1' },
      },
    })
    return
  }

  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } })
    return
  }

  if (msg.method === 'tools/call') {
    let result
    try {
      result = callTool(msg.params?.name, msg.params?.arguments ?? {})
    } catch (err) {
      // Rendu en résultat d'outil et non en erreur JSON-RPC : le modèle peut corriger
      // sa requête, là où une erreur de protocole ne lui apprend rien.
      log(`échec de ${msg.params?.name} : ${err.message}`)
      result = { ...text(`La recherche a échoué : ${err.message}`), isError: true }
    }
    send({ jsonrpc: '2.0', id: msg.id, result })
    return
  }

  if (msg.method === 'ping') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} })
    return
  }

  // Les notifications n'ont pas d'id et n'attendent pas de réponse.
  if (msg.id === undefined) return

  send({
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: `méthode inconnue : ${msg.method}` },
  })
})
