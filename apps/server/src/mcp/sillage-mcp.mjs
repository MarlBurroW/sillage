/**
 * Serveur MCP de Sillage : rend au CLI ce que la plateforme sait et qu'il ignore.
 *
 * Un CLI redémarre amnésique à chaque conversation, alors que Sillage garde le journal
 * de toutes les précédentes et le board du projet. Les outils exposés ici ouvrent cette
 * mémoire et cet état, cadrés au projet courant.
 *
 * Un seul outil écrit, `add_card_note`, et il n'écrit que dans un flux ajouté. La
 * frontière est là et pas ailleurs : un agent peut raconter ce qu'il a fait, il ne peut
 * ni déplacer une carte ni réécrire sa description. Déplacer serait se donner un
 * satisfecit, et la colonne cesserait d'être la position choisie qu'elle est censée
 * rester ; réécrire la description ferait qu'un compte rendu de session efface la
 * consigne qu'il était censé suivre.
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
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

const DB_PATH = process.env.SILLAGE_MCP_DB
const PROJECT_ID = process.env.SILLAGE_MCP_PROJECT
/** Exclue des résultats : sans ça l'agent se relit lui-même et tourne en rond. */
const CURRENT_CONVERSATION = process.env.SILLAGE_MCP_CONVERSATION ?? ''

/** Au-delà, le fil ne tient plus dans un contexte sans en chasser le travail en cours. */
const MAX_THREAD_CHARS = 20000

/**
 * Part du budget qu'un seul message peut prendre.
 *
 * Un quart et non une valeur fixe basse : une session de vérification tient parfois
 * toute entière dans son dernier message, et un plafond serré coupait exactement la
 * conclusion qu'on venait chercher. Un quart laisse passer un rapport de plusieurs
 * milliers de caractères sans qu'un seul message puisse monopoliser un long fil.
 */
const MAX_MESSAGE_CHARS = Math.floor(MAX_THREAD_CHARS / 4)

/**
 * Fenêtre par défaut de `list_sessions`.
 *
 * Quinze minutes répond à « qui travaille en ce moment », qui est la question posée dans
 * la plupart des cas. Un défaut plus large inviterait à tout ramener à chaque appel ;
 * un modèle qui veut savoir sur quoi on a travaillé aujourd'hui demande vingt-quatre
 * heures de lui-même.
 */
const RECENT_MINUTES = 15

/**
 * Fenêtre par défaut de `find_file_edits`.
 *
 * Plus large que celle des sessions : une modification non commitée reste dans l'arbre
 * après la fin de la session qui l'a faite, et c'est justement quand plus rien ne tourne
 * qu'on cherche d'où elle vient. Bornée quand même, et c'est le point : le journal garde
 * les éditions indéfiniment, y compris celles commitées depuis des jours, qui
 * n'expliquent plus rien de l'état de l'arbre et feraient passer une session close pour
 * une session en train d'écrire.
 */
const EDIT_MINUTES = 120

/** Plafond de couples session-fichier rendus, annoncé quand il mord. */
const EDIT_ROW_LIMIT = 40

/**
 * Libellés des colonnes du board, en clair.
 *
 * Les valeurs stockées (`todo`, `in_progress`) sont des identifiants, pas de la langue :
 * les rendre telles quelles obligerait le modèle à deviner que `review` veut dire « à
 * relire par un humain » et non « en cours de relecture par un agent ».
 */
const COLUMN_LABELS = {
  todo: 'à faire',
  in_progress: 'en cours',
  review: 'à vérifier',
  done: 'terminé',
  abandoned: 'abandonné',
}

/** Au-delà, le board pèse plus qu'il n'oriente. Annoncé quand il mord. */
const CARD_LIMIT = 40

/** Une description entière peut faire des pages ; le board n'en rend qu'un aperçu. */
const CARD_EXCERPT_CHARS = 160

const log = (msg) => process.stderr.write(`[sillage-mcp] ${msg}\n`)
const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`)

if (!DB_PATH || !PROJECT_ID) {
  log('SILLAGE_MCP_DB et SILLAGE_MCP_PROJECT sont requis')
  process.exit(1)
}

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })

/**
 * Connexion d'écriture, ouverte au premier besoin et gardée ensuite.
 *
 * Séparée de la connexion de lecture, qui reste en lecture seule : la quasi-totalité de
 * ce serveur observe, et un seul outil écrit. Deux handles rendent cette asymétrie
 * visible et empêchent qu'une requête de lecture mal écrite touche quoi que ce soit.
 */
let writable = null
function writeDb() {
  writable ??= new Database(DB_PATH, { fileMustExist: true })
  return writable
}

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
  {
    name: 'list_sessions',
    description:
      "Liste les conversations de ce projet qui travaillent en ce moment, et celles qui ont travaillé récemment, avec leur worktree et leur branche. Appelle cet outil avant d'ouvrir un chantier, pour vérifier qu'une autre session n'est pas déjà dessus, et avant toute manipulation de l'arbre de travail git : une autre conversation peut l'avoir laissé sur sa propre branche.",
    inputSchema: {
      type: 'object',
      properties: {
        within_minutes: {
          type: 'integer',
          description:
            "Fenêtre de « récemment », en minutes. 15 par défaut. Élargir à 1440 pour voir le travail de la journée. Les conversations qui travaillent en ce moment sont rendues quelle que soit la fenêtre.",
        },
      },
    },
  },
  {
    name: 'find_file_edits',
    description:
      "Dit quelle autre session a modifié un fichier, et ce qu'elle fait maintenant. Appelle cet outil quand tu trouves dans l'arbre de travail des modifications que tu n'as pas faites, avant de les annuler, de les contourner ou d'abandonner le tour : elles viennent souvent d'une session qui travaille en ce moment sur le même arbre, et la réponse dit si elle est encore active. Sans `path`, rend les fichiers récemment modifiés par les autres sessions du même arbre.",
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            "Chemin du fichier, relatif au répertoire de travail. À défaut de correspondance exacte, un fichier de même nom ailleurs est rendu, avec son chemin réel. Omettre pour voir tous les fichiers récemment modifiés.",
        },
        within_minutes: {
          type: 'integer',
          description:
            "Fenêtre de recherche, en minutes. 120 par défaut. Élargir si la réponse est vide alors qu'une modification inexpliquée est bien là : les éditions restent dans le journal indéfiniment, mais celles d'hier n'expliquent en général plus l'état de l'arbre.",
        },
      },
    },
  },
  {
    name: 'list_cards',
    description:
      "Liste le board de ce projet : les cartes, c'est-à-dire le travail à faire, en cours, à vérifier ou terminé. Une carte est un chantier, distinct des conversations qui l'exécutent : elle leur survit et en porte plusieurs. Appelle cet outil avant d'ouvrir un sujet neuf, pour vérifier que ce qu'on te demande n'est pas déjà décrit dans une carte, et quand l'utilisateur cite une carte par son numéro (`#12`). Rend un résumé par carte, pas les descriptions entières : utiliser read_card ensuite pour en lire une.",
    inputSchema: {
      type: 'object',
      properties: {
        column: {
          type: 'string',
          enum: ['todo', 'in_progress', 'review', 'done', 'abandoned'],
          description:
            "Ne rendre que cette colonne. Omettre pour tout le board, terminé et abandonné compris.",
        },
      },
    },
  },
  {
    name: 'read_card',
    description:
      "Lit une carte de ce projet en entier : sa description, la colonne où elle est posée, les sessions qui l'ont déjà traitée et les cartes qui la citent. Appelle cet outil quand une carte t'est assignée ou citée, avant de commencer : la description dit ce qui est attendu, et les sessions passées disent ce qui a déjà été tenté. La colonne d'une carte se change dans l'interface, par une personne, jamais par toi.",
    inputSchema: {
      type: 'object',
      properties: {
        number: {
          type: 'integer',
          description: "Numéro de la carte, tel qu'il s'écrit après le `#`.",
        },
      },
      required: ['number'],
    },
  },
  {
    name: 'add_card_note',
    description:
      "Ajoute une note au fil de la carte que traite cette conversation. Sert à laisser aux sessions suivantes ce qu'elles ne pourront pas redécouvrir seules : ce qui a été fait et où en est le travail, ce qui a été essayé sans marcher et pourquoi, une décision prise en route, une contrainte trouvée dans le code. Appelle cet outil en fin de travail, et avant toute interruption longue. N'y recopie pas ce que le dépôt dit déjà, ni ce que `git log` raconte : une note utile est celle qui aurait fait gagner du temps si on l'avait lue au début. Les notes s'ajoutent et ne s'effacent pas ; elles ne remplacent pas la description de la carte, qui appartient à la personne qui l'a écrite.",
    inputSchema: {
      type: 'object',
      properties: {
        body: {
          type: 'string',
          description:
            "Texte de la note, en markdown. Quelques phrases ou une courte liste, pas un rapport : elle sera relue en entier au début de chaque session suivante.",
        },
      },
      required: ['body'],
    },
  },
  {
    name: 'count_active_sessions',
    description:
      "Compte, sur toute l'instance et non plus sur le seul projet, les conversations en train de travailler. Sert à décider s'il est sûr de redémarrer le service Sillage, ce qui tue tous les process CLI en cours, y compris celui de cette conversation. Ne rend que des nombres : ni titres, ni projets, ni contenu.",
    inputSchema: { type: 'object', properties: {} },
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

/**
 * Une conversation travaille si un tour est en cours, ou si un travail détaché continue
 * après lui.
 *
 * Les deux compteurs sont sur la ligne de conversation et non déduits du journal : le
 * statut retombe à `idle` à la fin du tour, pas à la fin du travail, et le déduire
 * demanderait de replier le journal de chaque ligne énumérée. Ils sont remis à zéro au
 * démarrage du daemon, donc une valeur non nulle décrit bien un process vivant.
 */
const WORKING = `(c.status = 'running' OR c.background_count > 0 OR c.loop_count > 0)`

/**
 * Conversations du projet qui travaillent, plus celles vues récemment.
 *
 * Celles qui travaillent sortent quelle que soit la fenêtre : une session lancée il y a
 * trois heures et toujours en train de tourner est exactement ce qu'on cherche à ne pas
 * manquer. La fenêtre ne gouverne que les autres.
 */
function listSessions(withinMinutes) {
  return db
    .prepare(
      `SELECT c.id AS id,
              c.title AS title,
              c.agent AS agent,
              c.status AS status,
              c.background_count AS background,
              c.loop_count AS loops,
              c.updated_at AS updatedAt,
              w.name AS worktree
       FROM conversations AS c
       LEFT JOIN worktrees AS w ON w.id = c.worktree_id
       WHERE c.project_id = ?
         AND c.id != ?
         AND c.archived_at IS NULL
         AND (${WORKING} OR c.updated_at >= ?)
       ORDER BY c.updated_at DESC
       LIMIT 50`,
    )
    .all(PROJECT_ID, CURRENT_CONVERSATION, Date.now() - withinMinutes * 60_000)
}

/**
 * Le worktree de la conversation courante, `undefined` si on ne sait pas qui elle est.
 *
 * Sert à ne comparer que ce qui est comparable : deux conversations dans deux worktrees
 * différents éditent le même chemin relatif sans jamais se marcher dessus, ce sont deux
 * fichiers distincts sur le disque. Ne restent donc que celles qui partagent l'arbre.
 */
function currentWorktree() {
  const row = db
    .prepare(`SELECT worktree_id AS worktreeId FROM conversations WHERE id = ?`)
    .get(CURRENT_CONVERSATION)
  return row ? row.worktreeId : undefined
}

/**
 * Qui d'autre a touché à ce fichier, et où en est cette session.
 *
 * L'activité de la conversation voyage avec la modification plutôt que d'être à
 * rechercher ensuite : la question n'est jamais « qui a édité » seule, elle est « qui a
 * édité, et est-ce que ça bouge encore », dont dépend le fait d'attendre ou de passer.
 *
 * Un chemin donné cherche sans fenêtre de temps : une modification non commitée reste
 * dans l'arbre longtemps après la session qui l'a faite, et la borner ferait répondre
 * « personne » au moment où la question se pose. La fenêtre ne sert qu'à la liste
 * générale, qui n'aurait sinon pas de fin.
 *
 * Balayage de la table d'événements, sans index sur le type : mesuré à 30 ms sur 115 000
 * lignes, pour un outil appelé quand un doute survient et non en boucle. Un index
 * partiel serait la sortie si ça devenait chaud.
 */
/**
 * La modification la plus récente hors fenêtre, pour que la réponse vide dise s'il y a
 * quelque chose à aller chercher.
 *
 * Sans ça, « rien dans les 120 dernières minutes » se lit comme « personne n'y a
 * touché », et l'appelant conclut à tort plutôt que d'élargir. Une requête de plus,
 * seulement quand la réponse est vide.
 */
function oldestOutsideWindow({ path, byName, withinMinutes }) {
  const worktree = currentWorktree()
  const filters = [
    `e.type = 'file.edited'`,
    `c.project_id = ?`,
    `c.id != ?`,
    worktree === undefined ? null : `c.worktree_id IS ?`,
    `e.ts < ?`,
    path === null
      ? null
      : byName
        ? `e.payload ->> '$.path' LIKE '%/' || ?`
        : `e.payload ->> '$.path' = ?`,
  ].filter(Boolean)

  const params = [PROJECT_ID, CURRENT_CONVERSATION]
  if (worktree !== undefined) params.push(worktree)
  params.push(Date.now() - withinMinutes * 60_000)
  if (path !== null) params.push(path)

  const row = db
    .prepare(
      `SELECT max(e.ts) AS ts
       FROM events AS e
       JOIN conversations AS c ON c.id = e.conversation_id
       WHERE ${filters.join(' AND ')}`,
    )
    .get(...params)
  return row?.ts ?? null
}

function findFileEdits({ path, withinMinutes }) {
  const exact = path ? path.replace(/^\.\//, '') : null
  const rows = queryEdits({ path: exact, byName: false, withinMinutes })
  if (rows.length > 0 || !exact) return rows

  // Repli et non cumul : tant qu'un chemin exact répond, un homonyme ailleurs dans
  // l'arbre n'est que du bruit. Il ne sert qu'au cas où l'appelant ne connaît que le
  // nom du fichier, ou l'a écrit depuis un autre répertoire que celui du journal.
  return queryEdits({ path: exact.split('/').pop(), byName: true, withinMinutes })
}

function queryEdits({ path, byName, withinMinutes }) {
  const worktree = currentWorktree()

  const filters = [
    `e.type = 'file.edited'`,
    `c.project_id = ?`,
    `c.id != ?`,
    // `IS` et non `=` : le worktree nul, qui vaut « racine du projet », est le cas le
    // plus courant et une égalité SQL ne le rapproche de rien.
    worktree === undefined ? null : `c.worktree_id IS ?`,
    // La fenêtre vaut aussi pour une recherche par chemin. Le journal garde les
    // éditions indéfiniment, y compris celles commitées depuis longtemps : sans borne,
    // la réponse mêle des modifications qui n'expliquent plus rien de l'état de l'arbre
    // à celles qu'on cherche, et laisse croire qu'une session travaille encore dessus.
    `e.ts >= ?`,
    path === null
      ? null
      : byName
        ? `e.payload ->> '$.path' LIKE '%/' || ?`
        : `e.payload ->> '$.path' = ?`,
  ].filter(Boolean)

  const params = [PROJECT_ID, CURRENT_CONVERSATION]
  if (worktree !== undefined) params.push(worktree)
  params.push(Date.now() - withinMinutes * 60_000)
  if (path !== null) params.push(path)

  return db
    .prepare(
      `SELECT e.conversation_id AS id,
              c.title AS title,
              c.agent AS agent,
              c.status AS status,
              c.background_count AS background,
              c.loop_count AS loops,
              w.name AS worktree,
              e.payload ->> '$.path' AS path,
              e.payload ->> '$.action' AS action,
              max(e.ts) AS ts,
              count(*) AS edits
       FROM events AS e
       JOIN conversations AS c ON c.id = e.conversation_id
       LEFT JOIN worktrees AS w ON w.id = c.worktree_id
       WHERE ${filters.join(' AND ')}
       -- Sur les expressions et non sur les alias : la table worktrees a une colonne
       -- path et la table events une colonne ts, que SQLite préfère aux alias de
       -- sortie. Le regroupement se faisait alors par conversation seulement, avec des
       -- comptes cumulés sur tous les fichiers et un chemin pris au hasard dans le lot.
       GROUP BY e.conversation_id, e.payload ->> '$.path'
       ORDER BY max(e.ts) DESC
       LIMIT ${EDIT_ROW_LIMIT}`,
    )
    .all(...params)
}

/**
 * Décompte sur toute l'instance, pour la seule question qui justifie d'en sortir :
 * peut-on redémarrer le service.
 *
 * Des nombres et rien d'autre. Le besoin est de savoir si on va couper quelqu'un, pas
 * de savoir qui ni sur quoi, et rendre des titres ferait de cet outil une fenêtre sur
 * les projets auxquels la conversation n'a pas affaire.
 */
function countActiveSessions() {
  const row = db
    .prepare(
      `SELECT
         sum(CASE WHEN ${WORKING} THEN 1 ELSE 0 END) AS working,
         sum(CASE WHEN ${WORKING} AND c.project_id = ? THEN 1 ELSE 0 END) AS here,
         sum(CASE WHEN c.status = 'awaiting_input' THEN 1 ELSE 0 END) AS awaiting,
         min(CASE WHEN ${WORKING} THEN c.updated_at END) AS oldest
       FROM conversations AS c
       WHERE c.archived_at IS NULL`,
    )
    .get(PROJECT_ID)

  const self = db
    .prepare(`SELECT 1 AS yes FROM conversations AS c WHERE c.id = ? AND ${WORKING}`)
    .get(CURRENT_CONVERSATION)

  return {
    working: row?.working ?? 0,
    here: row?.here ?? 0,
    awaiting: row?.awaiting ?? 0,
    oldest: row?.oldest ?? null,
    includesSelf: Boolean(self),
  }
}

const asDate = (ts) => new Date(ts).toISOString().slice(0, 10)

/** Ancienneté en clair : un horodatage absolu obligerait le modèle à faire la soustraction. */
function ago(ts) {
  const minutes = Math.max(0, Math.round((Date.now() - ts) / 60_000))
  if (minutes < 1) return "à l'instant"
  if (minutes < 60) return `il y a ${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `il y a ${hours} h` : `il y a ${Math.round(hours / 24)} j`
}

const STATUS_LABELS = {
  running: 'en cours',
  idle: 'au repos',
  awaiting_input: 'attend une réponse',
  interrupted: 'interrompue',
  error: 'en erreur',
}

/** Ce que fait une conversation, statut et travail détaché réunis en une clause. */
function describeActivity(row) {
  const parts = [STATUS_LABELS[row.status] ?? row.status]
  if (row.background > 0) parts.push(`${row.background} travail(aux) de fond`)
  if (row.loops > 0) parts.push(`${row.loops} boucle(s)`)
  return parts.join(', ')
}

function renderSessions(rows, withinMinutes) {
  if (rows.length === 0) {
    return `Aucune autre conversation de ce projet n'a travaillé dans les ${withinMinutes} dernières minutes.`
  }

  const lines = rows.map((row) => {
    const where = row.worktree ? `worktree ${row.worktree}` : 'racine du projet'
    return `- ${row.id} | ${row.agent} | ${describeActivity(row)} | ${where} | ${ago(row.updatedAt)}\n  ${row.title}`
  })
  return `${rows.length} conversation(s), fenêtre de ${withinMinutes} min :\n${lines.join('\n')}`
}

const ACTION_LABELS = { created: 'créé', modified: 'modifié', deleted: 'supprimé' }

/**
 * Une conclusion en tête plutôt qu'une table à interpréter.
 *
 * L'outil est appelé au moment d'un doute, et ce que l'appelant doit décider est
 * d'attendre ou de passer. La réponse le dit donc explicitement quand une des sessions
 * travaille encore, au lieu de laisser déduire d'un statut noyé dans une liste.
 */
function renderFileEdits(rows, { path, withinMinutes, older }) {
  if (rows.length === 0) {
    const scope = path ? `n'a touché à « ${path} »` : `n'a modifié de fichier`
    const head = `Aucune autre session de cet arbre de travail ${scope} dans les ${withinMinutes} dernières minutes.`
    return older === null
      ? `${head} Rien de plus ancien non plus.`
      : `${head} La dernière fois remonte à ${ago(older)} : rappeler avec une fenêtre plus large pour la voir.`
  }

  const busy = rows.filter((row) => row.status === 'running' || row.background > 0 || row.loops > 0)
  const lead = busy.length > 0
    ? `Attention, ${busy.length} de ces sessions travaillent encore : attendre peut valoir mieux qu'annuler leurs modifications.`
    : "Aucune de ces sessions ne travaille plus : leurs modifications sont figées."

  // Deux regroupements pour deux questions. Sur un chemin, le sujet est le fichier et
  // chaque ligne dit une session qui y a touché. Sans chemin, le sujet est la session :
  // regrouper par fichier y répétait son titre et son état à chaque ligne, quinze fois
  // à l'identique sur un cas réel, pour un outil censé économiser du contexte.
  const lines = path ? renderByFile(rows) : renderBySession(rows)
  const capped =
    rows.length >= EDIT_ROW_LIMIT
      ? `\n\n[Liste plafonnée à ${EDIT_ROW_LIMIT} couples session-fichier : il peut en manquer.]`
      : ''

  return `${lead}\n\n${lines.join('\n')}${capped}`
}

function renderByFile(rows) {
  return rows.map((row) => {
    const where = row.worktree ? `worktree ${row.worktree}` : 'racine du projet'
    const times = row.edits > 1 ? ` (${row.edits} fois)` : ''
    return `- ${row.path} | ${ACTION_LABELS[row.action] ?? row.action}${times} | ${ago(row.ts)}\n  par ${row.id} (${row.agent}, ${describeActivity(row)}, ${where})\n  ${row.title}`
  })
}

/** Au-delà, la liste de fichiers d'une seule session noie les autres. */
const FILES_PER_SESSION = 8

function renderBySession(rows) {
  const sessions = new Map()
  for (const row of rows) {
    const found = sessions.get(row.id)
    if (found) found.files.push(row)
    else sessions.set(row.id, { head: row, files: [row] })
  }

  return [...sessions.values()].map(({ head, files }) => {
    const where = head.worktree ? `worktree ${head.worktree}` : 'racine du projet'
    // Par nombre d'éditions et non par date : le fichier le plus remué est celui sur
    // lequel une collision est la plus probable, et c'est ce qu'on cherche à voir en tête.
    const sorted = [...files].sort((a, b) => b.edits - a.edits)
    const shown = sorted
      .slice(0, FILES_PER_SESSION)
      .map((file) => `${file.path}${file.edits > 1 ? ` (${file.edits}×)` : ''}`)
    const rest = sorted.length - shown.length
    const tail = rest > 0 ? `, et ${rest} autre(s)` : ''

    return `- ${head.id} (${head.agent}, ${describeActivity(head)}, ${where}), ${ago(head.ts)}\n  ${head.title}\n  ${files.length} fichier(s) : ${shown.join(', ')}${tail}`
  })
}

/**
 * Le board du projet, une ligne par carte.
 *
 * Le compte de sessions vient d'une sous-requête et non d'une jointure : joindre
 * `conversations` dupliquerait la carte autant de fois qu'elle a de sessions, et le
 * `GROUP BY` qu'il faudrait ensuite masquerait les cartes qui n'en ont aucune.
 */
function listCards(column) {
  return db
    .prepare(
      `SELECT c.number   AS number,
              c.title    AS title,
              c.column   AS column,
              c.description AS description,
              c.updated_at  AS updatedAt,
              (SELECT COUNT(*) FROM conversations AS v WHERE v.card_id = c.id) AS sessions
       FROM cards AS c
       WHERE c.project_id = ?
         AND (? IS NULL OR c.column = ?)
       ORDER BY CASE c.column
                  WHEN 'todo' THEN 0
                  WHEN 'in_progress' THEN 1
                  WHEN 'review' THEN 2
                  WHEN 'done' THEN 3
                  ELSE 4
                END,
                c.position
       LIMIT ?`,
    )
    .all(PROJECT_ID, column, column, CARD_LIMIT + 1)
}

function readCard(number) {
  const card = db
    .prepare(
      `SELECT id, number, title, column, description, created_at AS createdAt
       FROM cards WHERE project_id = ? AND number = ?`,
    )
    .get(PROJECT_ID, number)
  if (!card) return null

  card.sessions = db
    .prepare(
      `SELECT v.id AS id, v.title AS title, v.agent AS agent, v.status AS status,
              v.background_count AS background, v.loop_count AS loops,
              v.updated_at AS updatedAt, w.name AS worktree
       FROM conversations AS v
       LEFT JOIN worktrees AS w ON w.id = v.worktree_id
       WHERE v.card_id = ?
       ORDER BY v.created_at`,
    )
    .all(card.id)

  card.references = db
    .prepare(
      `SELECT t.number AS number, t.title AS title, t.column AS column
       FROM card_refs AS r JOIN cards AS t ON t.id = r.target_id
       WHERE r.source_id = ? ORDER BY t.number`,
    )
    .all(card.id)

  card.referencedBy = db
    .prepare(
      `SELECT sc.number AS number, sc.title AS title, sc.column AS column
       FROM card_refs AS r JOIN cards AS sc ON sc.id = r.source_id
       WHERE r.target_id = ? ORDER BY sc.number`,
    )
    .all(card.id)

  return card
}

/** La carte que traite la conversation courante, s'il y en a une. */
function currentCard() {
  return (
    db
      .prepare(
        `SELECT c.id AS id, c.number AS number, c.title AS title
         FROM conversations AS v JOIN cards AS c ON c.id = v.card_id
         WHERE v.id = ?`,
      )
      .get(CURRENT_CONVERSATION) ?? null
  )
}

/** Les notes d'une carte, du plus ancien au plus récent, avec leur auteur. */
function cardNotes(cardId) {
  return db
    .prepare(
      `SELECT n.body AS body, n.created_at AS createdAt,
              n.conversation_id AS conversationId,
              v.title AS conversationTitle, v.agent AS agent,
              u.display_name AS userName
       FROM card_notes AS n
       LEFT JOIN conversations AS v ON v.id = n.conversation_id
       LEFT JOIN users AS u ON u.id = n.user_id
       WHERE n.card_id = ?
       ORDER BY n.created_at`,
    )
    .all(cardId)
}

function addCardNote(cardId, body) {
  writeDb()
    .prepare(
      `INSERT INTO card_notes (id, card_id, conversation_id, user_id, body, created_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    )
    .run(randomUUID(), cardId, CURRENT_CONVERSATION || null, body, Date.now())
}

function renderCards(rows, column) {
  const truncated = rows.length > CARD_LIMIT
  const shown = truncated ? rows.slice(0, CARD_LIMIT) : rows

  if (shown.length === 0) {
    return column
      ? `Aucune carte dans la colonne « ${COLUMN_LABELS[column]} » de ce projet.`
      : "Ce projet n'a aucune carte. Le board est vide, ce qui ne veut pas dire qu'il n'y a rien à faire : tout n'y est pas forcément décrit."
  }

  const mine = currentCard()?.number ?? null
  const lines = shown.map((row) => {
    const excerpt = (row.description ?? '').trim().replace(/\s+/g, ' ')
    const summary = excerpt
      ? `\n  ${excerpt.length > CARD_EXCERPT_CHARS ? `${excerpt.slice(0, CARD_EXCERPT_CHARS)}...` : excerpt}`
      : ''
    const sessions = row.sessions > 0 ? `, ${row.sessions} session(s)` : ''
    const self = row.number === mine ? ' <- celle de cette conversation' : ''
    return `- #${row.number} [${COLUMN_LABELS[row.column] ?? row.column}] ${row.title}${sessions}${self}${summary}`
  })

  const head = `${shown.length} carte(s)${column ? ` en « ${COLUMN_LABELS[column]} »` : ''} :`
  const tail = truncated
    ? `\n\n${rows.length - CARD_LIMIT} carte(s) de plus ne sont pas rendues. Filtrer par colonne pour voir le reste.`
    : ''
  return `${head}\n${lines.join('\n')}${tail}`
}

function renderCard(card) {
  const parts = [
    `#${card.number} [${COLUMN_LABELS[card.column] ?? card.column}] ${card.title}`,
  ]

  parts.push(card.description.trim() || '(aucune description)')

  if (card.sessions.length > 0) {
    const lines = card.sessions.map((session) => {
      const where = session.worktree ? `worktree ${session.worktree}` : 'racine du projet'
      const self = session.id === CURRENT_CONVERSATION ? ' <- celle-ci' : ''
      return `- ${session.agent} | ${describeActivity(session)} | ${where} | ${ago(session.updatedAt)}${self}\n  ${session.title}`
    })
    parts.push(`${card.sessions.length} session(s) sur cette carte :\n${lines.join('\n')}`)
  } else {
    parts.push("Aucune session n'a encore travaillé sur cette carte.")
  }

  const notes = cardNotes(card.id)
  if (notes.length > 0) {
    const lines = notes.map((note) => {
      const who = note.userName
        ? note.userName
        : note.conversationId === CURRENT_CONVERSATION
          ? 'cette conversation'
          : `session ${note.agent ?? '?'}${note.conversationTitle ? ` « ${note.conversationTitle} »` : ''}`
      return `[${who}, ${ago(note.createdAt)}]\n${note.body}`
    })
    parts.push(`${notes.length} note(s) laissée(s) sur cette carte :\n\n${lines.join('\n\n')}`)
  }

  const link = (rows) =>
    rows.map((row) => `- #${row.number} [${COLUMN_LABELS[row.column] ?? row.column}] ${row.title}`).join('\n')
  if (card.references.length > 0) parts.push(`Cette carte cite :\n${link(card.references)}`)
  if (card.referencedBy.length > 0) parts.push(`Citée par :\n${link(card.referencedBy)}`)

  return parts.join('\n\n')
}

function renderCount(state) {
  if (state.working === 0) {
    const suffix =
      state.awaiting > 0
        ? ` ${state.awaiting} attend(ent) une réponse : un redémarrage expirera ces sollicitations.`
        : ''
    return `Aucune conversation ne travaille sur l'instance.${suffix}`
  }

  const parts = [`${state.working} conversation(s) travaillent sur l'instance`]
  if (state.here > 0) parts.push(`dont ${state.here} dans ce projet`)
  if (state.includesSelf) parts.push('dont celle-ci')
  if (state.oldest !== null) parts.push(`la plus ancienne active depuis ${ago(state.oldest)}`)

  const awaiting =
    state.awaiting > 0
      ? ` ${state.awaiting} autre(s) attend(ent) une réponse : un redémarrage expirera ces sollicitations.`
      : ''
  return `${parts.join(', ')}. Un redémarrage du service les coupe toutes.${awaiting}`
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n[...]` : text
}

function renderSearch(query, results) {
  if (results.length === 0) {
    return `Aucune conversation de ce projet ne contient « ${query} ».`
  }

  const lines = results.map(
    (row) =>
      `- ${row.id} | ${row.agent} | échange du ${asDate(row.ts)} | ${row.title}\n  ${row.excerpt}`,
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
  // « ouverte le » et non une date nue : search_history date le message qui correspond,
  // celle-ci date la création du fil. Deux dates justes pour un même objet se lisent
  // comme une contradiction tant qu'aucune des deux ne dit ce qu'elle mesure.
  const header = `${conversation.title} (${conversation.agent}, ouverte le ${asDate(conversation.createdAt)})`
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

  if (name === 'list_sessions') {
    const asked = Number.isInteger(args?.within_minutes) ? args.within_minutes : RECENT_MINUTES
    const within = Math.min(Math.max(asked, 1), 60 * 24 * 7)
    return text(renderSessions(listSessions(within), within))
  }

  if (name === 'find_file_edits') {
    const path = typeof args?.path === 'string' && args.path.trim() ? args.path.trim() : null
    const asked = Number.isInteger(args?.within_minutes) ? args.within_minutes : EDIT_MINUTES
    const withinMinutes = Math.min(Math.max(asked, 1), 60 * 24 * 7)
    const rows = findFileEdits({ path, withinMinutes })
    // Sondé seulement quand la fenêtre ne rend rien : c'est le seul cas où la réponse
    // risque de se lire comme « personne n'y a touché ».
    const older =
      rows.length === 0
        ? oldestOutsideWindow({
            path: path ? path.replace(/^\.\//, '') : null,
            byName: false,
            withinMinutes,
          })
        : null
    return text(renderFileEdits(rows, { path, withinMinutes, older }))
  }

  if (name === 'list_cards') {
    const column = typeof args?.column === 'string' && COLUMN_LABELS[args.column] ? args.column : null
    return text(renderCards(listCards(column), column))
  }

  if (name === 'read_card') {
    const number = Number.isInteger(args?.number) ? args.number : null
    if (number === null) {
      return { ...text('Le paramètre `number` est requis, et doit être un entier.'), isError: true }
    }
    const card = readCard(number)
    if (!card) {
      return {
        ...text(`Aucune carte #${number} dans ce projet. Appeler list_cards pour voir celles qui existent.`),
        isError: true,
      }
    }
    return text(renderCard(card))
  }

  if (name === 'add_card_note') {
    const body = typeof args?.body === 'string' ? args.body.trim() : ''
    if (!body) return { ...text('Le paramètre `body` est requis.'), isError: true }

    const card = currentCard()
    if (!card) {
      return {
        ...text(
          "Cette conversation n'est rattachée à aucune carte, il n'y a donc pas de fil où écrire. Le rattachement se fait dans l'interface de Sillage, sur la carte ou depuis la conversation ; demande-le plutôt que de choisir une carte toi-même.",
        ),
        isError: true,
      }
    }

    addCardNote(card.id, body)
    return text(`Note ajoutée à la carte #${card.number} « ${card.title} ».`)
  }

  if (name === 'count_active_sessions') {
    return text(renderCount(countActiveSessions()))
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
