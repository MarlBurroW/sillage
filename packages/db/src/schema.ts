import type { AgentKind, CardColumn } from '@sillage/protocol'
import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  real,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

/**
 * Le schéma couvre l'ensemble de la spec, y compris les tables que les lots suivants
 * utiliseront, pour n'avoir qu'une migration initiale à appliquer. Les colonnes JSON
 * sont typées via `$type<>` et sérialisées par la couche d'accès.
 */

const timestamp = (name: string) => integer(name, { mode: 'number' })

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
  createdAt: timestamp('created_at').notNull(),
})

export const authSessions = sqliteTable(
  'auth_sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    userAgent: text('user_agent'),
  },
  (t) => [index('idx_auth_sessions_user').on(t.userId)],
)

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    workspacePath: text('workspace_path').notNull(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    visibility: text('visibility').$type<'private' | 'shared'>().notNull(),
    color: text('color'),
    /**
     * JSON AgentConfig, préréglages de la barre de saisie. Le CLI lui-même n'est pas
     * une propriété du projet : il est choisi par conversation (colonne
     * `conversations.agent`), pour qu'un même projet porte du Claude et du Codex.
     */
    defaultConfig: text('default_config'),
    /**
     * Ordre manuel dans la sidebar, réécrit en bloc par le glisser-déposer. Un
     * nouveau projet prend une position supérieure au maximum existant, pour se
     * ranger en fin de liste plutôt que de s'insérer au milieu.
     */
    position: integer('position').notNull().default(0),
    archivedAt: timestamp('archived_at'),
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [index('idx_projects_owner').on(t.ownerId)],
)

export const worktrees = sqliteTable(
  'worktrees',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    path: text('path').notNull(),
    baseRef: text('base_ref').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at').notNull(),
    removedAt: timestamp('removed_at'),
  },
  (t) => [uniqueIndex('idx_worktrees_project_name').on(t.projectId, t.name)],
)

/**
 * Cartes du board : le travail à faire, distinct de la conversation qui l'exécute.
 *
 * Une carte survit à ses sessions et en porte plusieurs ; c'est ce qui la sépare d'une
 * conversation, laquelle est une tentative d'exécution qui se termine et s'archive. Le
 * rattachement vit sur `conversations.card_id`, une conversation ne traitant qu'une
 * carte à la fois.
 */
export const cards = sqliteTable(
  'cards',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /**
     * Numéro court affiché et cité (`#12`), attribué à la création et jamais réutilisé.
     *
     * Un UUID ne se tape pas dans un message et ne se lit pas dans un nom de branche.
     * La séquence est par projet, comme les issues d'une forge.
     */
    number: integer('number').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    /**
     * Position choisie dans le workflow. Jamais nommée `status` : ce mot désigne l'état
     * d'exécution d'une conversation, et les deux ne doivent pas se confondre.
     * L'activité et l'état de merge sont dérivés et n'ont donc pas de colonne ici.
     */
    column: text('column').$type<CardColumn>().notNull(),
    /** Ordre manuel dans sa colonne, croissant. Réécrit en bloc par le glisser-déposer. */
    position: integer('position').notNull().default(0),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_cards_project_number').on(t.projectId, t.number),
    index('idx_cards_project_column').on(t.projectId, t.column, t.position),
  ],
)

/**
 * Références `#12` trouvées dans la description d'une carte, réécrites à chaque
 * enregistrement.
 *
 * Table dérivée du texte, comme l'index de recherche l'est du journal : elle ne porte
 * rien que la description n'ait déjà, et sert à répondre « qui me référence » sans
 * balayer toutes les descriptions du projet.
 *
 * La cible cascade comme la source : une carte supprimée ne doit pas laisser de
 * backlink vers le vide. Le texte, lui, garde son `#12`, qui s'affichera comme une
 * référence morte plutôt que de disparaître de la prose.
 */
export const cardRefs = sqliteTable(
  'card_refs',
  {
    sourceId: text('source_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    targetId: text('target_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.targetId] }), index('idx_card_refs_target').on(t.targetId)],
)

/**
 * Ce qu'une session a appris ou fait sur une carte, et que la suivante doit savoir.
 *
 * Un flux ajouté, jamais réécrit, et c'est ce qui le distingue de la description : la
 * description est l'énoncé du travail, tenu par une personne ; les notes sont son
 * historique, écrit surtout par les agents. Les fondre ferait qu'un compte rendu de
 * session efface la consigne qu'il était censé suivre.
 *
 * Chaque note dit qui l'a écrite et quand. C'est ce qui répond à l'objection faite au
 * magasin de mémoire dans cette roadmap : une note anonyme et sans date vieillit en
 * silence et finit par tromper, une note signée d'une session datée se relativise seule.
 */
export const cardNotes = sqliteTable(
  'card_notes',
  {
    id: text('id').primaryKey(),
    cardId: text('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    /**
     * Session auteure, null quand la note est écrite à la main. Sans cascade : le compte
     * rendu d'un travail survit à la suppression de la conversation qui l'a produit,
     * c'est même à ce moment-là qu'il devient la seule trace.
     */
    conversationId: text('conversation_id'),
    userId: text('user_id').references(() => users.id),
    body: text('body').notNull(),
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [index('idx_card_notes_card').on(t.cardId, t.createdAt)],
)

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** NULL signifie que l'agent travaille à la racine du projet. */
    worktreeId: text('worktree_id').references(() => worktrees.id),
    /**
     * Carte que cette conversation traite, si elle en traite une.
     *
     * Rattachement, et non simple mention : citer `#12` dans un message donne du
     * contexte au modèle sans engager la conversation, alors que cette colonne est ce
     * dont l'activité d'une carte se déduit. Poser l'un pour l'autre ferait compter une
     * session au chantier voisin dont elle a seulement parlé.
     *
     * Sans cascade : supprimer une carte n'efface pas les conversations qui l'ont
     * traitée, elles redeviennent des conversations ordinaires.
     */
    cardId: text('card_id'),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull(),
    /**
     * Vrai dès que l'utilisateur renomme : le titre proposé par le CLI ne doit plus
     * jamais l'écraser derrière son dos.
     */
    titleSetByUser: integer('title_set_by_user', { mode: 'boolean' }).notNull().default(false),
    // Dérivé de l'enum du protocole : ajouter un CLI ne demande pas de retoucher
    // la colonne, et une divergence entre les deux listes ne peut plus s'installer.
    agent: text('agent').$type<AgentKind>().notNull(),
    /** Identifiant natif du CLI, pour `--resume` ou `thread/resume`. */
    agentSessionId: text('agent_session_id'),
    /**
     * Conversation dont celle-ci est issue par fork, si elle l'est.
     *
     * Sans cascade : supprimer l'originale ne doit pas emporter ses branches, qui
     * sont des conversations à part entière. La référence devient alors orpheline et
     * l'UI cesse simplement d'afficher la provenance.
     */
    forkedFromId: text('forked_from_id'),
    /**
     * Jeton d'API qui a créé la conversation, pour l'audit et pour que `GET /api/v1/tasks`
     * puisse rendre à un appelant ce qu'il a lui-même lancé. Sans cascade : supprimer un
     * jeton n'efface pas les conversations qu'il a ouvertes.
     */
    createdByTokenId: text('created_by_token_id'),
    /**
     * Libellé du jeton d'origine, figé à la création. NULL vaut « créée dans l'interface ».
     *
     * Dupliqué du jeton à dessein : c'est ce qui permet à la sidebar de garder son
     * marqueur quand le jeton a été supprimé.
     */
    originLabel: text('origin_label'),
    /** JSON AgentConfig. */
    config: text('config').notNull(),
    status: text('status')
      .$type<'idle' | 'running' | 'awaiting_input' | 'interrupted' | 'error'>()
      .notNull(),
    /**
     * Travaux de fond et boucles vivants, tels que le dernier `background.updated` et
     * le dernier `loops.updated` les décrivent.
     *
     * Persistés alors qu'ils appartiennent au process CLI et meurent avec lui, parce
     * qu'ils sont le seul signe qu'une conversation `idle` travaille encore : le statut
     * retombe à la fin du tour, pas à la fin du travail. Sans eux, répondre « cette
     * session travaille-t-elle » demande de replier le journal de chaque conversation,
     * ce qui est ruineux dès qu'on en énumère plus d'une.
     *
     * Remis à zéro au démarrage par `recoverInterrupted` : les process sont morts avec
     * le daemon, donc toute valeur non nulle relue au boot est un reste.
     */
    backgroundCount: integer('background_count').notNull().default(0),
    loopCount: integer('loop_count').notNull().default(0),
    lastSeq: integer('last_seq').notNull().default(0),
    /**
     * Dernier `seq` qui valait qu'on prévienne le lecteur, d'où se déduit le non-lu.
     *
     * Distinct de `lastSeq` parce que le journal avance aussi tout seul : une session
     * qui se refroidit ou un relevé d'usage sont écrits après le départ de tout le
     * monde, et les compter allumait 57 conversations sur 80 sans que personne n'ait
     * rien à y lire. Voir `NOTABLE` dans l'`EventLog` pour la liste retenue.
     */
    lastNotableSeq: integer('last_notable_seq').notNull().default(0),
    /**
     * Métriques de volume, tenues à jour à l'écriture du journal.
     *
     * Persistées pour la même raison que `backgroundCount` : la sidebar en affiche pour
     * des conversations qu'elle n'a pas ouvertes, et les recalculer demanderait de
     * replier le journal de chacune, ce qui est ruineux dès qu'on en énumère plus d'une.
     *
     * `turnCount` compte les tours, un par message de l'utilisateur : les traits de la
     * réglette de repères. Compter les messages de l'agent reviendrait à compter ses
     * étapes, chaque appel d'outil en produisant un.
     *
     * Le découpage du fil, pas le cycle de vie du runner : le compte s'écarte des
     * `turn.started` dans les deux sens, un tour pouvant s'ouvrir sans message et un
     * steer ajoutant un message sans ouvrir de tour.
     */
    turnCount: integer('turn_count').notNull().default(0),
    /** Poids du journal sur disque, payloads et `raw` compris. */
    journalBytes: integer('journal_bytes').notNull().default(0),
    /**
     * Dernière occupation de la fenêtre de contexte annoncée par le CLI, et modèle de la
     * dernière session ouverte. NULL tant que le CLI n'en a rien dit.
     *
     * Distincts de `inputTokens`/`outputTokens`, qui cumulent la facturation depuis le
     * début : le contexte se vide à chaque compaction, et c'est lui qui dit quand la
     * prochaine arrivera.
     */
    contextUsedTokens: integer('context_used_tokens'),
    contextMaxTokens: integer('context_max_tokens'),
    model: text('model'),
    costUsd: real('cost_usd').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    /**
     * Ordre manuel dans le projet, réécrit par le glisser-déposer. Croissant : une
     * nouvelle conversation reçoit une position inférieure au minimum existant, pour
     * apparaître en tête comme le faisait le tri par date.
     */
    position: integer('position').notNull().default(0),
    archivedAt: timestamp('archived_at'),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (t) => [
    index('idx_conversations_project').on(t.projectId, t.position),
    index('idx_conversations_user').on(t.userId),
  ],
)

/**
 * Jusqu'où chaque lecteur est allé dans chaque conversation.
 *
 * Le journal avance tout seul : un agent qui travaille pendant qu'on regarde ailleurs
 * produit des événements que personne ne voit passer, et la ligne de sidebar reste
 * identique à celle d'un fil mort depuis trois semaines. Comparer ce curseur à
 * `conversations.lastSeq` est ce qui distingue les deux.
 *
 * Par lecteur et non par conversation : dans un projet partagé, deux comptes n'ont pas
 * lu la même chose. Le propriétaire du fil n'a aucun statut particulier ici.
 *
 * Ligne absente = jamais ouvert, donc tout est non lu. La migration qui crée la table
 * pose une ligne à jour pour chaque couple existant, faute de quoi la fonctionnalité
 * s'allumerait partout à la première mise à jour.
 */
export const conversationReads = sqliteTable(
  'conversation_reads',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Ne recule jamais : l'écriture prend le maximum avec la valeur déjà en base. */
    lastReadSeq: integer('last_read_seq').notNull().default(0),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.userId] })],
)

/**
 * Le journal (invariant I2). `seq` est strictement croissant et sans trou par
 * conversation. WITHOUT ROWID parce que la clé primaire composite est déjà l'ordre
 * de lecture naturel.
 */
export const events = sqliteTable(
  'events',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    ts: timestamp('ts').notNull(),
    type: text('type').notNull(),
    /** JSON SillageEvent. */
    payload: text('payload').notNull(),
    /** JSON natif du CLI, conservé pour les renderers d'outils spécialisés. */
    raw: text('raw'),
    /**
     * Provenance du `raw` (« claude-agent-sdk@0.3 », « codex-app-server@v2 »...).
     *
     * Sans elle, la forme du payload natif se devine par `conversations.agent`, ce
     * qui ne survit pas à un changement de protocole du CLI : deux générations de
     * `raw` se mélangent alors dans un même fil sans que rien ne les distingue.
     * Nullable : les événements d'avant l'estampille restent de la génération
     * courante de leur agent, jusqu'au premier bump.
     */
    rawFormat: text('raw_format'),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.seq] })],
)

export const permissionRequests = sqliteTable(
  'permission_requests',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** Position de l'événement `permission.requested` associé dans le journal. */
    seq: integer('seq').notNull(),
    toolName: text('tool_name').notNull(),
    input: text('input').notNull(),
    status: text('status')
      .$type<'pending' | 'allowed' | 'denied' | 'expired'>()
      .notNull(),
    decisionScope: text('decision_scope').$type<'once' | 'session' | 'always'>(),
    decidedBy: text('decided_by').references(() => users.id),
    createdAt: timestamp('created_at').notNull(),
    decidedAt: timestamp('decided_at'),
  },
  (t) => [index('idx_permission_requests_pending').on(t.conversationId, t.status)],
)

export const attachments = sqliteTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    /**
     * Null tant que la pièce jointe n'a pas été envoyée : elle est téléversée avant
     * que la conversation existe, puisqu'une conversation naît de son premier message.
     */
    conversationId: text('conversation_id').references(() => conversations.id, {
      onDelete: 'cascade',
    }),
    /** Propriétaire du fichier téléversé, seul habilité à le relire ou à l'envoyer. */
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    /** Déterminé par le contenu, jamais par l'extension fournie par le client. */
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    storagePath: text('storage_path').notNull(),
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [index('idx_attachments_conversation').on(t.conversationId)],
)

/**
 * Abonnements Web Push, un par appareil et par compte.
 *
 * L'`endpoint` fourni par le navigateur identifie l'abonnement de façon unique : c'est
 * la clé primaire naturelle, et deux abonnements au même endpoint désigneraient le même
 * appareil.
 */
export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    endpoint: text('endpoint').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Clés de chiffrement du navigateur, requises pour lui adresser un message. */
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [index('idx_push_user').on(t.userId)],
)

/**
 * Réglages d'instance : ce qui vaut pour tout le monde et que l'administrateur doit
 * pouvoir changer sans éditer `config.toml` ni redémarrer le service, un redémarrage
 * tuant les process CLI enfants.
 *
 * Clé-valeur plutôt que colonnes typées, sinon chaque réglage suivant traînerait sa
 * migration. La valeur est du JSON, et seule la couche d'accès a besoin de le savoir.
 * Une clé absente vaut « pas encore réglé » et laisse le défaut du `config.toml`
 * s'appliquer, qui reste le point d'entrée d'une instance qu'on provisionne.
 */
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
})

export const userSettings = sqliteTable('user_settings', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** JSON : thème, densité, préférences d'affichage. */
  data: text('data').notNull().default(sql`'{}'`),
})

/**
 * Registre des serveurs MCP, partagé par tous les CLI et tous les projets.
 *
 * Déclarés une fois ici, activés conversation par conversation via `mcpServers` de
 * l'`AgentConfig`. Rien n'est écrit dans `~/.claude.json` ni dans le `config.toml` de
 * Codex : Sillage transmet ces serveurs en mémoire à chaque lancement de session, et
 * ne devient donc pas copropriétaire de fichiers qu'il n'a pas écrits. Conséquence
 * assumée : une conversation reprise dans un CLI natif n'a pas ces serveurs.
 */
export const mcpServers = sqliteTable('mcp_servers', {
  id: text('id').primaryKey(),
  /**
   * Unique : le nom sert de clé côté CLI, deux serveurs homonymes s'écraseraient
   * l'un l'autre dans la table qu'on lui transmet, en silence.
   */
  name: text('name').notNull().unique(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** JSON McpTransport : la forme dépend du transport, la colonne n'a pas à le savoir. */
  transport: text('transport').notNull(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
})

/**
 * Dépôt de secrets de l'instance, chiffré au repos.
 *
 * Le nom est la clé primaire : c'est lui qu'on écrit dans `{{secret.NOM}}`, et deux
 * secrets homonymes n'auraient aucun moyen d'être départagés. La valeur est chiffrée
 * en AES-256-GCM avec la clé du dossier de données ; `iv` et `authTag` appartiennent
 * au chiffré et n'ont pas à être secrets, mais doivent être conservés avec lui.
 */
export const secrets = sqliteTable('secrets', {
  name: text('name').primaryKey(),
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  authTag: text('auth_tag').notNull(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
})

/**
 * Credentials git par utilisateur et par hôte, chiffrées comme les secrets.
 *
 * Table distincte de `secrets`, et non une convention de nommage dedans : les secrets
 * sont réservés aux administrateurs et alimentent le namespace `{{secret.NOM}}` des
 * serveurs MCP. Les fusionner ferait apparaître un jeton GitHub dans le sélecteur de
 * secrets MCP et interdirait à un compte non administrateur de cloner un dépôt privé.
 *
 * `username` existe parce que les forges n'attendent pas la même chose : GitHub ignore
 * la valeur pour un jeton personnel mais impose `x-access-token` pour un jeton
 * d'installation, GitLab veut `oauth2`. Le stocker évite de coder en dur une table de
 * correspondance par forge.
 */
export const gitCredentials = sqliteTable(
  'git_credentials',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Hôte seul, sans schéma ni port : `github.com`, `gitlab.example.org`. */
    host: text('host').notNull(),
    username: text('username').notNull(),
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    authTag: text('auth_tag').notNull(),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  // Une seule credential par hôte et par compte : deux jetons pour github.com n'auraient
  // aucun moyen d'être départagés au moment où git en réclame un.
  (t) => [uniqueIndex('idx_git_credentials_owner_host').on(t.ownerId, t.host)],
)

/**
 * Jetons d'API, porteurs d'identité des clients machine.
 *
 * Même stockage que les sessions : seul le SHA-256 du secret est retenu, le jeton en
 * clair n'existe que dans la réponse à sa création. Une révocation garde la ligne, pour
 * que le libellé reste lisible dans l'audit des conversations qu'il a lancées.
 */
export const apiTokens = sqliteTable(
  'api_tokens',
  {
    id: text('id').primaryKey(),
    tokenHash: text('token_hash').notNull().unique(),
    /** Premiers caractères du secret, pour reconnaître une ligne sans la révéler. */
    hint: text('hint').notNull(),
    label: text('label').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** JSON ApiScope[]. */
    scopes: text('scopes').notNull(),
    /** JSON string[] d'identifiants de projets ; vide signifie « tous ceux qu'il voit ». */
    projectIds: text('project_ids').notNull(),
    agent: text('agent').$type<AgentKind>().notNull(),
    /** JSON AgentConfig : avec quoi les tâches de ce jeton travaillent par défaut. */
    config: text('config').notNull(),
    /** URL appelée sur les événements de tâche ; NULL quand le jeton n'en veut pas. */
    webhookUrl: text('webhook_url'),
    /**
     * Secret HMAC des livraisons, en clair : le serveur doit pouvoir signer, donc le
     * chiffrer avec une clé posée à côté de la base ne protégerait de rien. Il ne donne
     * aucun accès à Sillage, seulement la capacité de forger des livraisons vers
     * l'endpoint du consommateur, qui exige aussi de connaître l'URL.
     */
    webhookSecret: text('webhook_secret'),
    createdAt: timestamp('created_at').notNull(),
    lastUsedAt: timestamp('last_used_at'),
    expiresAt: timestamp('expires_at'),
    revokedAt: timestamp('revoked_at'),
  },
  (t) => [index('idx_api_tokens_user').on(t.userId)],
)

/**
 * Réglages propres aux tâches lancées par l'API : surcharge de webhook, échéance de
 * réponse. Table à part plutôt que des colonnes sur `conversations`, qui appartient au
 * noyau et n'a pas à porter les préoccupations d'un appelant machine.
 */
export const apiTaskOptions = sqliteTable('api_task_options', {
  conversationId: text('conversation_id')
    .primaryKey()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  webhookUrl: text('webhook_url'),
  /** 0 signifie « pas d'échéance », choisi explicitement par l'appelant. */
  replyDeadlineSec: integer('reply_deadline_sec').notNull(),
})

/**
 * Livraisons de webhook, persistées avant le premier essai.
 *
 * Un redémarrage du service ne doit pas avaler la seule notification qu'attendait
 * l'appelant : la reprise relit ce qui n'a pas été livré et reprend le barème là où
 * il en était. `nextAttemptAt` NULL marque l'abandon après épuisement des essais.
 */
export const webhookDeliveries = sqliteTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    tokenId: text('token_id')
      .notNull()
      .references(() => apiTokens.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id').notNull(),
    url: text('url').notNull(),
    type: text('type').notNull(),
    /** JSON WebhookPayload. */
    payload: text('payload').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at'),
    deliveredAt: timestamp('delivered_at'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [index('idx_webhook_deliveries_due').on(t.deliveredAt, t.nextAttemptAt)],
)

/**
 * Clés d'idempotence des créations de tâche.
 *
 * La déduplication des envois vit en mémoire sur cinq minutes, ce qui convient à un
 * renvoi réseau mais pas à un agent qui réessaie dix minutes plus tard : sans cette
 * table, il ouvrirait une seconde conversation.
 *
 * La clé se réserve avant la création, d'où un `conversation_id` nullable : entre les
 * deux, une requête concurrente doit voir la réservation et attendre plutôt que de
 * lancer un second tour. Sans référence non plus, pour que la réservation puisse
 * exister avant sa conversation ; la conversation supprimée laisse une clé orpheline,
 * que la purge finit par emporter.
 */
export const apiIdempotency = sqliteTable(
  'api_idempotency',
  {
    tokenId: text('token_id')
      .notNull()
      .references(() => apiTokens.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    conversationId: text('conversation_id'),
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tokenId, t.key] })],
)

export type UserRow = typeof users.$inferSelect
export type ApiTokenRow = typeof apiTokens.$inferSelect
export type ProjectRow = typeof projects.$inferSelect
export type ConversationRow = typeof conversations.$inferSelect
export type ConversationReadRow = typeof conversationReads.$inferSelect
export type EventRow = typeof events.$inferSelect
export type WorktreeRow = typeof worktrees.$inferSelect
export type CardRow = typeof cards.$inferSelect
export type CardNoteRow = typeof cardNotes.$inferSelect
export type PermissionRequestRow = typeof permissionRequests.$inferSelect
export type McpServerRow = typeof mcpServers.$inferSelect
export type SecretRow = typeof secrets.$inferSelect
export type GitCredentialRow = typeof gitCredentials.$inferSelect
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect
