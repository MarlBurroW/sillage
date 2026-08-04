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
      "Lit le fil d'une conversation passée de ce projet, identifiée par le `id` rendu par search_history. Rend les messages de l'utilisateur et de l'agent, sans les appels d'outils. D'un fil trop long pour tenir d'un coup, rend la demande initiale et la fin, en annonçant combien de messages ont été élidés et comment les lire.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Identifiant rendu par search_history.' },
        before: {
          type: 'integer',
          description:
            "Remonte dans le fil : rend la tranche qui précède ce numéro de message, tel qu'annoncé par un appel précédent. Omettre pour lire la demande et la fin.",
        },
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
      `SELECT event.seq AS seq,
              event.payload ->> '$.role' AS role,
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

const block = (role, body) => `## ${role === 'user' ? 'Utilisateur' : 'Agent'}\n${body}`

/**
 * Remplit un budget en partant de la fin, sans casser l'ordre chronologique.
 *
 * Un message seul plus gros que le budget entier est rendu quand même, tronqué : rendre
 * une tranche vide en disant qu'elle ne tient pas laisserait l'appelant sans recours.
 */
function fillFromEnd(messages, budget) {
  const kept = []
  let total = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const body = clip(messages[i].text ?? '', MAX_MESSAGE_CHARS)
    if (total + body.length > budget && kept.length > 0) break
    total += body.length
    kept.unshift({ ...messages[i], body })
  }
  return kept
}

/**
 * Le fil, ou ce qui en tient dans le budget.
 *
 * Les deux bouts plutôt que le début : la fin porte les conclusions, mais le premier
 * message porte la demande, et des conclusions sans énoncé se lisent de travers. Le
 * milieu est ce qu'on sacrifie, en annonçant combien de messages manquent et par où les
 * reprendre.
 *
 * Le curseur est le numéro de message et non un numéro de page : les messages ont des
 * tailles très inégales, donc une page n'est pas une unité stable, et une conversation
 * reprise plus tard décalerait toute numérotation partant de la fin.
 */
function renderThread(found, before) {
  const { conversation, messages } = found
  const header = `${conversation.title} (${conversation.agent}, ${asDate(conversation.createdAt)})`
  if (messages.length === 0) return `${header}\n\nAucun message dans ce fil.`

  const scoped = before === null ? messages : messages.filter((message) => message.seq < before)
  if (scoped.length === 0) return `${header}\n\nAucun message avant ${before} dans ce fil.`

  // La demande n'est reprise qu'à la première lecture : en remontant le fil, l'appelant
  // l'a déjà, et la lui resservir mangerait le budget de ce qu'il est venu chercher.
  const head = before === null && scoped[0].role === 'user' ? scoped[0] : null
  const rest = head ? scoped.slice(1) : scoped
  const headBody = head ? clip(head.text ?? '', MAX_MESSAGE_CHARS) : ''
  const tail = fillFromEnd(rest, MAX_THREAD_CHARS - headBody.length)

  const parts = head ? [block(head.role, headBody)] : []

  const elided = rest.length - tail.length
  if (elided > 0) {
    parts.push(
      `[${elided} message(s) élidés. Rappeler read_conversation avec before=${tail[0].seq} pour lire ce qui précède.]`,
    )
  }
  for (const message of tail) parts.push(block(message.role, message.body))

  return `${header}\n\n${parts.join('\n\n')}`
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
    const before = Number.isInteger(args?.before) ? args.before : null
    return text(renderThread(found, before))
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
