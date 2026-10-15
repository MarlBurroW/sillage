import type {
  AgentKind,
  BoardCommentDelivery,
  BoardIdentity,
  BoardNewCards,
  BoardWorkspace,
  CardColumn,
  CardNotePublication,
  DecisionSourceKind,
  DecisionStatus,
  InstructionsMode,
} from '@sillage/protocol'
import { sql } from 'drizzle-orm'
import {
  blob,
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
     * JSON `ProjectAgentDefaults` : un préréglage de la barre de saisie par CLI, socle
     * des conversations du projet sous les défauts du compte. Le CLI lui-même n'est
     * pas une propriété du projet : il est choisi par conversation (colonne
     * `conversations.agent`), pour qu'un même projet porte du Claude et du Codex — d'où
     * un préréglage par CLI plutôt qu'un seul. La forme d'avant, une configuration
     * seule, se relit encore (`readProjectDefaults`).
     */
    defaultConfig: text('default_config'),
    /**
     * Ordre manuel dans la sidebar, réécrit en bloc par le glisser-déposer. Un
     * nouveau projet prend une position supérieure au maximum existant, pour se
     * ranger en fin de liste plutôt que de s'insérer au milieu.
     */
    position: integer('position').notNull().default(0),
    /**
     * Où vivent les consignes du projet : dans Sillage (`sillage`), injectées aux deux
     * CLI pendant que les `CLAUDE.md` et `AGENTS.md` du dépôt sont masqués, ou dans le
     * dépôt (`repo`), que les CLI lisent d'eux-mêmes. Fixé à la création ; null pour
     * les projets d'avant, résolu d'après le dossier (voir `instructions/store.ts`).
     */
    instructionsMode: text('instructions_mode').$type<InstructionsMode>(),
    archivedAt: timestamp('archived_at'),
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [index('idx_projects_owner').on(t.ownerId)],
)

/**
 * SILLAGE.md : des consignes tenues par Sillage, communes à Claude et à Codex, injectées
 * dans le prompt système de chaque session. Une ligne globale (`id` = `global`, sans
 * projet) et une par projet (`id` = l'identifiant du projet).
 *
 * En base et non en fichier pour la même raison que l'image : le serveur MCP, qui y
 * réécrit à la demande d'un agent, n'a que la base.
 */
export const instructions = sqliteTable('instructions', {
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  /** Dernière main : une personne, ou la session d'un agent passé par les outils MCP. */
  updatedByUserId: text('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  updatedByConversationId: text('updated_by_conversation_id'),
})

/**
 * L'image d'un projet, ce qui le fait reconnaître d'un coup d'œil dans la navigation.
 *
 * Dans sa propre table et non en colonne de `projects` : chaque lecture d'un projet
 * ramènerait sinon le blob, alors qu'il ne sert qu'à la route qui le sert. En base
 * plutôt que sur disque parce que le serveur MCP, qui la pose au nom d'un agent, n'a
 * que la base ; et la cascade retire l'image avec le projet sans fichier à ramasser.
 */
export const projectImages = sqliteTable('project_images', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  mimeType: text('mime_type').notNull(),
  data: blob('data', { mode: 'buffer' }).notNull(),
  /**
   * Posée par un agent faute de logo dans le projet. Tant que c'est vrai, les sessions
   * se voient rappeler de la remplacer dès qu'un vrai logo existe ; une image choisie
   * par une personne n'est jamais provisoire.
   */
  provisional: integer('provisional', { mode: 'boolean' }).notNull().default(false),
  /** Sert aussi de version dans l'URL, pour que le cache du navigateur suive. */
  updatedAt: timestamp('updated_at').notNull(),
})

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
    /**
     * Le commentaire GitHub dont la note est la copie, ou qu'elle est devenue une fois
     * publiée. Avec `externalAuthor`, c'est un commentaire écrit sur GitHub ; sans, une
     * note de Sillage publiée là-bas.
     */
    externalId: text('external_id'),
    externalAuthor: text('external_author'),
    externalUrl: text('external_url'),
    /** Publication en commentaire sur l'issue de la carte ; null pour une note locale. */
    publication: text('publication').$type<CardNotePublication>(),
    publicationError: text('publication_error'),
  },
  (t) => [
    index('idx_card_notes_card').on(t.cardId, t.createdAt),
    uniqueIndex('idx_card_notes_external').on(t.cardId, t.externalId),
    index('idx_card_notes_publication').on(t.publication),
  ],
)

/**
 * Le board d'un projet relié aux issues d'un dépôt GitHub.
 *
 * Une ligne par projet : un board suit une seule source, sans quoi deux `#12` venus de
 * deux dépôts se disputeraient la même carte. Les cartes locales ne sont pas concernées,
 * elles vivent à côté et ne partent jamais d'elles-mêmes.
 */
export const boardLinks = sqliteTable('board_links', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  provider: text('provider').$type<'github'>().notNull().default('github'),
  /** `owner/nom`. Ne change pas : relier un autre dépôt passe par délier celui-ci. */
  repo: text('repo').notNull(),
  /**
   * Le compte dont l'identifiant github.com lit et écrit. Les issues créées depuis
   * Sillage le sont à son nom, comme ce que ses agents poussent déjà.
   */
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  labelFilter: text('label_filter').notNull().default(''),
  closedDays: integer('closed_days').notNull().default(14),
  newCards: text('new_cards').$type<BoardNewCards>().notNull().default('local'),
  progressLabel: text('progress_label').notNull().default('in progress'),
  reviewLabel: text('review_label').notNull().default('review'),
  /** Une issue ouverte sur GitHub, sans marque de session, ouvre une session sur sa carte. */
  onIssue: integer('on_issue', { mode: 'boolean' }).notNull().default(false),
  issueInstructions: text('issue_instructions').notNull().default(''),
  /** Un commentaire sans marque de session arrive dans la session de son issue. */
  onComment: integer('on_comment', { mode: 'boolean' }).notNull().default(false),
  commentInstructions: text('comment_instructions').notNull().default(''),
  commentDelivery: text('comment_delivery').$type<BoardCommentDelivery>().notNull().default('queue'),
  replyStyle: text('reply_style').notNull().default(''),
  identity: text('identity').$type<BoardIdentity>().notNull().default('ai'),
  signature: text('signature').notNull().default(''),
  sessionAgent: text('session_agent').$type<AgentKind>().notNull().default('claude'),
  /** JSON `AgentConfig` ; NULL : les réglages du projet pour ce CLI, lus au lancement. */
  sessionConfig: text('session_config'),
  workspace: text('workspace').$type<BoardWorkspace>().notNull().default('worktree'),
  maxSessionsPerHour: integer('max_sessions_per_hour').notNull().default(10),
  /** Les sessions de maintenance peuvent demander une décision humaine. */
  decisionsEnabled: integer('decisions_enabled', { mode: 'boolean' }).notNull().default(false),
  decisionMaxHours: integer('decision_max_hours').notNull().default(24),
  /**
   * Issues retirées du board à la main, en JSON. Supprimer leur carte ne suffirait pas :
   * la synchronisation suivante la recréerait.
   */
  hiddenIssues: text('hidden_issues').notNull().default('[]'),
  /** `updated_at` GitHub le plus récent déjà lu, point de départ de la lecture suivante. */
  cursor: text('cursor'),
  lastSyncedAt: timestamp('last_synced_at'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
})

/**
 * L'issue dont une carte est le reflet.
 *
 * Table à part plutôt que colonnes de `cards` : la plupart des cartes sont locales et
 * n'ont rien de tout ceci. Les champs `title`, `body`, `state` et `labels` gardent ce
 * que GitHub disait à la dernière lecture : c'est en les comparant à la carte qu'on sait
 * qui a changé quoi, sans drapeau à tenir à jour dans chaque route qui touche une carte.
 */
export const cardIssues = sqliteTable(
  'card_issues',
  {
    cardId: text('card_id')
      .primaryKey()
      .references(() => cards.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<'github'>().notNull().default('github'),
    repo: text('repo').notNull(),
    number: integer('number').notNull(),
    url: text('url').notNull(),
    author: text('author'),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    /** La marque de session retirée du corps à la lecture, remise à l'écriture. */
    marker: text('marker'),
    state: text('state').$type<'open' | 'closed'>().notNull(),
    stateReason: text('state_reason'),
    /** JSON, noms des labels. */
    labels: text('labels').notNull().default('[]'),
    remoteUpdatedAt: text('remote_updated_at').notNull(),
    closedAt: timestamp('closed_at'),
    /** Redevenue locale : la synchronisation ne la touche plus, l'issue vit sans elle. */
    detached: integer('detached', { mode: 'boolean' }).notNull().default(false),
    /**
     * La conversation qui répond aux commentaires de cette issue : les suivants lui
     * arrivent en message plutôt que d'ouvrir chaque fois une session sans mémoire.
     */
    responderId: text('responder_id'),
  },
  (t) => [uniqueIndex('idx_card_issues_number').on(t.projectId, t.provider, t.repo, t.number)],
)

/**
 * Un message d'une session à une autre du même projet.
 *
 * Déposé par le serveur MCP, qui n'a qu'un accès à la base, et remis par le daemon, qui
 * seul tient les runners : la table est la boîte aux lettres entre les deux process.
 * `deliveredAt` nul veut dire « pas encore remis », et c'est ce que le relais balaie.
 *
 * Sans clé étrangère vers `conversations` : un échange reste lisible par celle qui
 * reste quand l'autre est supprimée, comme une note de carte survit à son auteure.
 */
export const sessionMessages = sqliteTable(
  'session_messages',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fromConversationId: text('from_conversation_id').notNull(),
    toConversationId: text('to_conversation_id').notNull(),
    /**
     * `message` d'une session à une autre ; `broadcast` annoncé à toutes celles qui
     * travaillent ; `done`, écrit par le relais, prévient qu'une session surveillée a fini.
     */
    kind: text('kind', { enum: ['message', 'broadcast', 'done'] }).notNull().default('message'),
    body: text('body').notNull(),
    /** Message auquel celui-ci répond, pour compter la profondeur d'un échange. */
    replyTo: text('reply_to'),
    createdAt: timestamp('created_at').notNull(),
    /**
     * Posé quand le relais retient le message au lieu de relancer le destinataire. Sert
     * à n'annoncer la retenue qu'une fois dans son fil, redémarrage du daemon compris.
     */
    heldAt: timestamp('held_at'),
    deliveredAt: timestamp('delivered_at'),
    /**
     * `steer` injecté dans un tour ouvert, `queue` mis en file derrière lui, `wake` en
     * ouvrant un tour, `read` lu par l'outil avant d'avoir été remis, `failed` quand la
     * remise a échoué : il n'est pas retenté, pour ne pas relancer en boucle un CLI qui
     * refuse de démarrer, mais reste lisible par l'outil. Les trois derniers ne sont pas
     * des remises : `discarded` écarté par une personne, `expired` retenu trop
     * longtemps, `skipped` une annonce arrivée quand le destinataire ne travaillait plus.
     */
    deliveredVia: text('delivered_via', {
      enum: ['steer', 'queue', 'wake', 'read', 'failed', 'discarded', 'expired', 'skipped'],
    }),
  },
  (t) => [
    index('idx_session_messages_to').on(t.toConversationId, t.createdAt),
    index('idx_session_messages_pending').on(t.deliveredAt),
  ],
)

/**
 * Une session qui a demandé à être prévenue de la fin du travail d'une autre.
 *
 * Plutôt que de relancer `list_sessions` en boucle, ce qui coûte un tour à chaque
 * coup d'œil : le relais surveille, et dépose un message `done` au moment voulu.
 */
export const sessionWatches = sqliteTable(
  'session_watches',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    watcherConversationId: text('watcher_conversation_id').notNull(),
    targetConversationId: text('target_conversation_id').notNull(),
    createdAt: timestamp('created_at').notNull(),
    /** Posé quand le message `done` est déposé, ou quand la surveillance expire. */
    firedAt: timestamp('fired_at'),
  },
  (t) => [index('idx_session_watches_open').on(t.firedAt)],
)

/**
 * Une demande qu'une session adresse au daemon : lancer une autre session, créer une
 * carte, lire le catalogue des modèles.
 *
 * Même boîte aux lettres que `session_messages`, mais avec retour : le serveur MCP
 * dépose la demande puis attend que le daemon y écrive son résultat, parce que
 * l'agent a besoin de la réponse pour continuer (l'identifiant de la session lancée,
 * ou la liste des modèles qui existent quand il en a nommé un faux). Seul le daemon
 * tient le catalogue des CLI, les runners et la création de worktrees.
 *
 * Gardée après traitement : c'est elle qui dit qui a lancé quoi, et donc la profondeur
 * d'une chaîne de lancements et leur nombre dans l'heure.
 */
export const agentRequests = sqliteTable(
  'agent_requests',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /**
     * Conversation qui demande. Sans clé étrangère, comme les messages entre sessions.
     * Vide quand la demande vient d'un client MCP hors session (`user_id` dit alors
     * pour qui agir) : un CLI local branché sur toute l'instance, voir `docs/mcp.md`.
     */
    conversationId: text('conversation_id').notNull(),
    /** Compte au nom duquel agir quand aucune conversation ne demande. */
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', {
      enum: [
        'start_session',
        'create_card',
        'list_models',
        'schedule_task',
        'register_action',
        'remove_action',
        'run_action',
        // Une automatisation lancée par un appel qui porte la marque de cette session :
        // la ligne garde la filiation, pour que les limites de chaîne s'y appliquent.
        'webhook_launch',
        'request_decision',
        'withdraw_decision',
        'create_automation',
        // Gestes sur une session existante, au nom d'un compte : ceux d'un client MCP
        // hors session (`docs/mcp.md`), qui n'a pas de runner pour les faire lui-même.
        'message_session',
        'steer_session',
        'interrupt_session',
        'reply_session',
      ],
    }).notNull(),
    /** Arguments de l'outil, en JSON, tels que l'agent les a donnés. */
    payload: text('payload').notNull(),
    createdAt: timestamp('created_at').notNull(),
    /** Posé par le daemon quand la demande est traitée, réussie ou non. */
    settledAt: timestamp('settled_at'),
    /** Texte rendu à l'agent : le compte rendu, ou ce qui l'a empêché. */
    result: text('result'),
    isError: integer('is_error', { mode: 'boolean' }).notNull().default(false),
    /** Session née de la demande, pour remonter une chaîne de lancements. */
    launchedConversationId: text('launched_conversation_id'),
  },
  (t) => [
    index('idx_agent_requests_pending').on(t.settledAt),
    index('idx_agent_requests_from').on(t.conversationId, t.kind, t.createdAt),
    index('idx_agent_requests_launched').on(t.launchedConversationId),
  ],
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
    /**
     * Tâche planifiée dont un tir a ouvert cette conversation, si c'en est un.
     *
     * C'est ce qui la sort de la liste principale : une tâche horaire y poserait
     * vingt-quatre lignes par jour, que la sidebar range à la place sous leur tâche.
     * Le tir précis se retrouve par `scheduled_runs.conversation_id`.
     *
     * Sans cascade, comme `cardId` : supprimer une tâche n'efface pas ce que ses tirs
     * ont produit. La route de suppression vide la colonne et range les fils, qui
     * redeviennent des conversations ordinaires.
     */
    scheduleId: text('schedule_id'),
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
    index('idx_conversations_schedule').on(t.scheduleId),
  ],
)

/**
 * Tâches planifiées : un prompt que le daemon rejoue à cadence fixe, chaque tir dans une
 * session neuve.
 *
 * Portées par Sillage parce qu'aucun CLI n'a de planificateur local durable : le
 * `CronCreate` de Claude meurt avec sa session, Codex n'en a pas. Le daemon, lui,
 * tourne en permanence.
 */
export const scheduledTasks = sqliteTable(
  'scheduled_tasks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Compte au nom duquel les tirs s'ouvrent : celui qui a créé la tâche. */
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    agent: text('agent').$type<AgentKind>().notNull(),
    /**
     * JSON AgentConfig : modèle, effort et permissions, figés par tâche.
     *
     * Une copie et non les défauts du projet relus à chaque tir : personne n'est au
     * clavier pour répondre à une demande de permission, donc le garde-fou d'un tir
     * doit être celui qu'on a choisi en créant la tâche, pas celui du jour.
     */
    config: text('config').notNull(),
    prompt: text('prompt').notNull(),
    /** JSON `ScheduleCadence` : intervalle, motif cron ou date unique. */
    cadence: text('cadence').notNull(),
    /** `fresh` : une session neuve par tir. Seul mode pour l'instant. */
    executionMode: text('execution_mode').$type<'fresh'>().notNull().default('fresh'),
    /** Que faire d'un tir qui arrive pendant que le précédent tourne encore. */
    overlapPolicy: text('overlap_policy').$type<'skip' | 'wait'>().notNull().default('skip'),
    /** Au-delà, le tir est interrompu : rien d'autre n'arrêterait un agent qui s'égare. */
    maxDurationMinutes: integer('max_duration_minutes').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** Conversation qui a créé la tâche par `schedule_task` ; NULL depuis l'interface. */
    createdByConversationId: text('created_by_conversation_id'),
    /**
     * Script de vérification joué avant le tour LLM, NULL sans vérification. Son code de
     * sortie décide du lancement et sa sortie rejoint le prompt (voir `scheduler/check.ts`).
     *
     * Le contenu et non un chemin : le daemon l'exécute hors de toute session, et c'est ce
     * texte précis qu'on valide. Un fichier pourrait changer après coup, y compris sous la
     * main d'un tir qui tourne sans demander de permission.
     */
    checkScript: text('check_script'),
    checkTimeoutSeconds: integer('check_timeout_seconds').notNull().default(120),
    /**
     * Validation du script par une personne. NULL tant qu'un agent l'a écrit ou modifié
     * sans qu'on l'ait relu : le tir est alors écarté, ni script ni LLM.
     */
    checkApprovedAt: timestamp('check_approved_at'),
    /** Conversation qui a proposé le script actuel ; NULL quand il vient de l'interface. */
    checkProposedBy: text('check_proposed_by'),
    /** Les tirs peuvent demander une décision humaine (`request_decision`). */
    decisionsEnabled: integer('decisions_enabled', { mode: 'boolean' }).notNull().default(false),
    decisionMaxHours: integer('decision_max_hours').notNull().default(24),
    lastRunAt: timestamp('last_run_at'),
    /** NULL quand plus rien n'est prévu : tâche ponctuelle déjà tirée. */
    nextRunAt: timestamp('next_run_at'),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (t) => [
    index('idx_scheduled_tasks_project').on(t.projectId),
    index('idx_scheduled_tasks_due').on(t.enabled, t.nextRunAt),
  ],
)

/**
 * Un tir d'une tâche planifiée, y compris ceux qui n'ont rien lancé.
 *
 * Un tir sauté ou raté au lancement y laisse une ligne sans conversation : sans elle,
 * une tâche qui ne part jamais ressemblerait à une tâche qui n'a rien trouvé.
 */
export const scheduledRuns = sqliteTable(
  'scheduled_runs',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => scheduledTasks.id, { onDelete: 'cascade' }),
    /** Sans clé étrangère : le fil peut être supprimé, le tir reste dans l'historique. */
    conversationId: text('conversation_id'),
    trigger: text('trigger').$type<'schedule' | 'manual' | 'webhook'>().notNull(),
    /** `checking` : la vérification tourne, ou la session démarre derrière elle. */
    status: text('status')
      .$type<'checking' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'skipped'>()
      .notNull(),
    /** L'heure prévue, que `startedAt` dépasse quand le daemon était arrêté ou occupé. */
    scheduledFor: timestamp('scheduled_for').notNull(),
    startedAt: timestamp('started_at').notNull(),
    finishedAt: timestamp('finished_at'),
    /** Ce qui a empêché ou coupé le tir, rédigé pour être lu tel quel. */
    error: text('error'),
    /**
     * Dernière réponse de l'agent, tronquée, recopiée à la fin du tir.
     *
     * Dupliquée du journal à dessein : c'est ce que le tir suivant reçoit dans son
     * prompt, et il doit le recevoir même si le fil a été supprimé entre-temps.
     */
    summary: text('summary'),
    /**
     * Ce qu'a donné la vérification, NULL quand le tir n'en a pas joué. La sortie standard
     * est celle que le prompt a reçue ; l'erreur standard sert au débogage.
     */
    checkExitCode: integer('check_exit_code'),
    checkOutput: text('check_output'),
    checkStderr: text('check_stderr'),
    checkDurationMs: integer('check_duration_ms'),
  },
  (t) => [
    index('idx_scheduled_runs_task').on(t.taskId, t.startedAt),
    index('idx_scheduled_runs_open').on(t.status),
  ],
)

/**
 * Le webhook d'une automatisation : une tâche planifiée dont la cadence vaut
 * `{ kind: 'webhook' }` et qui part quand un appel reçu passe ses conditions.
 */
export const automationWebhooks = sqliteTable(
  'automation_webhooks',
  {
    taskId: text('task_id')
      .primaryKey()
      .references(() => scheduledTasks.id, { onDelete: 'cascade' }),
    /** Dernier segment de l'URL publique : impossible à deviner, mais pas un secret de signature. */
    token: text('token').notNull(),
    /** Secret de signature chiffré (JSON `EncryptedValue`) : on le réaffiche pour le recopier chez l'appelant. */
    secret: text('secret').notNull(),
    /** JSON `WebhookVerification`. */
    verification: text('verification').notNull(),
    deliveryHeader: text('delivery_header').notNull().default(''),
    /** JSON `AutomationConditions`. */
    conditions: text('conditions').notNull(),
    script: text('script').notNull().default(''),
    subjectPath: text('subject_path').notNull().default(''),
    markerPaths: text('marker_paths').notNull().default('*'),
    maxRunsPerHour: integer('max_runs_per_hour').notNull(),
    /** Le disjoncteur a sauté et mis la tâche en pause ; NULL une fois réactivée. */
    trippedAt: timestamp('tripped_at'),
    template: text('template'),
  },
  (t) => [uniqueIndex('idx_automation_webhooks_token').on(t.token)],
)

/**
 * Chaque appel reçu par un webhook, avec son sort : lancé, filtré, refusé et pourquoi.
 * C'est ce qui permet de mettre des conditions au point, et de rejouer un appel.
 * Borné par webhook : les plus anciens partent quand les nouveaux arrivent.
 */
export const automationDeliveries = sqliteTable(
  'automation_deliveries',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => scheduledTasks.id, { onDelete: 'cascade' }),
    receivedAt: timestamp('received_at').notNull(),
    /** Identifiant donné par l'appelant, pour reconnaître un rejeu. */
    deliveryId: text('delivery_id'),
    /** En-têtes en JSON, sans ceux qui portent un secret. */
    headers: text('headers').notNull(),
    query: text('query').notNull().default('{}'),
    body: text('body').notNull(),
    bytes: integer('bytes').notNull(),
    truncated: integer('truncated', { mode: 'boolean' }).notNull().default(false),
    verdict: text('verdict').notNull(),
    /** JSON `DeliveryReason` : un code que l'interface traduit, et ses paramètres. */
    reason: text('reason'),
    subject: text('subject'),
    /** Variables rendues par le script, en JSON, pour un appel mis en attente. */
    vars: text('vars'),
    summary: text('summary'),
    runId: text('run_id'),
    conversationId: text('conversation_id'),
    originConversationId: text('origin_conversation_id'),
  },
  (t) => [
    index('idx_automation_deliveries_task').on(t.taskId, t.receivedAt),
    index('idx_automation_deliveries_queue').on(t.verdict, t.receivedAt),
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
 * Les fils qu'un compte a mis en favori.
 *
 * Une table plutôt qu'une colonne, comme `conversation_reads` et pour la même raison :
 * un favori appartient à celui qui l'a posé, pas à la conversation. Sur un projet
 * partagé, la sidebar de chacun doit pouvoir garder ses propres signets sans imposer
 * les siens aux autres — ce que fait déjà `conversations.pinned`, qui est un épinglage
 * du fil et reste distinct.
 *
 * Purement une aide à la navigation : l'archivage automatique n'en tient pas compte,
 * un fil marqué puis terminé se range comme les autres.
 */
export const conversationFavorites = sqliteTable(
  'conversation_favorites',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Ordre de la section « Favoris », du plus récemment marqué au plus ancien. */
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.userId] })],
)

/**
 * Les projets qu'un compte a épinglés en tête du sélecteur.
 *
 * Même logique que `conversation_favorites` : une épingle est un repère personnel, pas
 * une propriété du projet. Sur un projet partagé, chacun garde son propre tri. Tenue
 * en base plutôt que dans le `localStorage` du navigateur, pour survivre à un
 * changement d'appareil ou au ménage d'un onglet.
 */
export const projectPins = sqliteTable(
  'project_pins',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Ordre de la section « Épinglés », du plus ancien épinglage au plus récent. */
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] })],
)

/**
 * Actions de projet : des boutons qui lancent une commande, créés depuis l'interface ou
 * proposés par un agent avec `register_action`.
 *
 * En base et non dans un fichier du dépôt : Sillage n'impose pas son outillage aux
 * projets qu'il pilote.
 */
export const projectActions = sqliteTable(
  'project_actions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    description: text('description'),
    kind: text('kind').$type<'task' | 'service'>().notNull(),
    command: text('command').notNull(),
    /** Relatif au worktree où l'action est lancée ; NULL pour sa racine. */
    subdir: text('subdir'),
    /** Gabarit d'URL où ouvrir un service, `{port}` compris. */
    url: text('url'),
    /**
     * NULL tant qu'une personne n'a pas relu la commande : posée à la création depuis
     * l'interface, effacée quand un agent change ce qui s'exécute.
     */
    approvedAt: timestamp('approved_at'),
    /** Dernière conversation à l'avoir créée ou modifiée par MCP ; NULL depuis l'interface. */
    agentConversationId: text('agent_conversation_id'),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (t) => [index('idx_project_actions_project').on(t.projectId, t.createdAt)],
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
    /** Une pièce appartient soit à une conversation, soit à un ticket. */
    cardId: text('card_id').references(() => cards.id, { onDelete: 'set null' }),
    /** Auteur du téléversement ; les fichiers de ticket se partagent avec le projet. */
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
  (t) => [index('idx_attachments_conversation').on(t.conversationId), index('idx_attachments_card').on(t.cardId)],
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
    /**
     * Sujet VAPID à présenter pour cet abonnement : l'adresse publique de l'instance, lue
     * à l'abonnement. Apple refuse un sujet en `localhost`, et une instance auto-hébergée
     * n'a pas d'autre adresse à donner que celle par laquelle on l'a jointe.
     */
    subject: text('subject'),
  },
  (t) => [index('idx_push_user').on(t.userId)],
)

/**
 * Les décisions demandées par les sessions autonomes (tâche planifiée, automatisation,
 * maintenance du board) : déposées sans bloquer l'agent, tranchées par une personne ou
 * par l'échéance, puis transmises à la session en message.
 *
 * En base plutôt qu'en mémoire comme les demandes natives des CLI : on les traite des
 * heures plus tard, et un redémarrage du daemon ne doit pas les faire oublier.
 */
export const decisions = sqliteTable(
  'decisions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Sans clé étrangère : la décision garde sa trace quand la conversation disparaît. */
    conversationId: text('conversation_id').notNull(),
    /** Le compte qui doit répondre : celui à qui appartient la source. */
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sourceKind: text('source_kind').$type<DecisionSourceKind>().notNull(),
    sourceLabel: text('source_label').notNull(),
    taskId: text('task_id'),
    cardId: text('card_id'),
    question: text('question').notNull(),
    context: text('context').notNull().default(''),
    /** JSON, libellés des choix proposés. */
    options: text('options').notNull().default('[]'),
    defaultOption: text('default_option'),
    expiresAt: timestamp('expires_at').notNull(),
    status: text('status').$type<DecisionStatus>().notNull(),
    answerOption: text('answer_option'),
    answerText: text('answer_text'),
    answeredBy: text('answered_by'),
    resolvedAt: timestamp('resolved_at'),
    withdrawnReason: text('withdrawn_reason'),
    /**
     * Quand la réponse (ou l'échéance) a été remise à la session. NULL pour une décision
     * tranchée dont la remise a échoué : le daemon réessaie.
     */
    deliveredAt: timestamp('delivered_at'),
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [
    index('idx_decisions_user_status').on(t.userId, t.status),
    index('idx_decisions_conversation').on(t.conversationId, t.status),
  ],
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
 * Dépôts git d'où la bibliothèque de skills s'installe.
 *
 * Une installation copie le skill et retient le commit : rien de ce qui arrive ensuite
 * dans le dépôt n'entre dans le contexte des agents sans qu'un admin l'ait relu. Les
 * sources préconfigurées sont insérées par la migration qui crée la table, et non au
 * démarrage, pour qu'une source supprimée ne revienne pas.
 */
export const skillSources = sqliteTable('skill_sources', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Tout ce que `git clone` accepte, dépôts privés compris. */
  url: text('url').notNull(),
  /** Branche ou tag. Null : la branche par défaut du dépôt. */
  ref: text('ref'),
  /** Dossier du dépôt où chercher les skills. Null : tout le dépôt. */
  subpath: text('subpath'),
  builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastCommit: text('last_commit'),
  lastFetchedAt: timestamp('last_fetched_at'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
})

/**
 * Bibliothèque de skills : ce que Sillage livre aux CLI comme des skills natifs.
 *
 * Le contenu vit sur le disque, sous `<data>/skill-library`, et c'est lui qui fait foi :
 * description et corps se relisent dans le `SKILL.md`. Cette table porte ce que le disque
 * ne dit pas, à savoir la portée, l'activation et la provenance. Le dossier se déduit
 * de la ligne, voir `skill-library/layout.ts`.
 */
export const librarySkills = sqliteTable(
  'library_skills',
  {
    id: text('id').primaryKey(),
    scope: text('scope', { enum: ['global', 'project'] }).notNull(),
    /** Null en portée globale. La cascade ne touche pas le disque, la route s'en charge. */
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    /**
     * Nom du dossier, et `name` du frontmatter. Unique sur l'ensemble « global + un
     * projet », ce qu'aucun index ne sait dire puisque SQLite tient les `NULL` pour
     * distincts : le contrôle est dans le service.
     */
    name: text('name').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    sourceId: text('source_id').references(() => skillSources.id, { onDelete: 'set null' }),
    sourcePath: text('source_path'),
    sourceCommit: text('source_commit'),
    /**
     * Empreinte du skill tel que la source le portait à l'installation. Comparée au
     * catalogue, elle dit si une mise à jour existe ; elle diffère de `installedHash`
     * quand le skill a été renommé en entrant, son frontmatter réécrit.
     */
    sourceHash: text('source_hash'),
    /** Empreinte du contenu à l'installation, pour reconnaître une modification locale. */
    installedHash: text('installed_hash'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (t) => [index('idx_library_skills_project').on(t.projectId)],
)

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
 * Comptes Claude supplémentaires, par utilisateur : un jeton OAuth longue durée de
 * `claude setup-token` chacun, chiffré comme les credentials git.
 *
 * Par utilisateur et non par instance, pour la même raison que les credentials git :
 * c'est l'abonnement de quelqu'un, et un administrateur n'a pas à emprunter celui d'un
 * autre. Le libellé est ce que le sélecteur de compte affiche : un jeton ne porte ni
 * courriel ni nom d'organisation lisibles sans dépenser un tour.
 */
export const claudeAccounts = sqliteTable(
  'claude_accounts',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    /**
     * Ce qu'est le secret : un jeton OAuth de `claude setup-token` (abonnement, passé
     * dans `CLAUDE_CODE_OAUTH_TOKEN`) ou une clé API Console (facturée à l'usage, passée
     * dans `ANTHROPIC_API_KEY`). Déduit du préfixe à l'écriture, retenu pour que le
     * lancement n'ait pas à déchiffrer pour le savoir.
     */
    kind: text('kind').$type<'oauth' | 'apiKey'>().notNull().default('oauth'),
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    authTag: text('auth_tag').notNull(),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  // Deux comptes du même nom seraient indiscernables dans le sélecteur.
  (t) => [uniqueIndex('idx_claude_accounts_owner_label').on(t.ownerId, t.label)],
)

/**
 * Comptes Codex supplémentaires, par utilisateur.
 *
 * Aucun secret ici, contrairement aux comptes Claude : la connexion vit dans l'`auth.json`
 * du home que Sillage donne au compte (`<données>/codex-accounts/<id>`), écrit et
 * rafraîchi par Codex lui-même. La ligne ne porte que le libellé et ce que Codex a dit
 * du compte à la dernière connexion, pour que la liste se lise sans lancer d'app-server.
 */
export const codexAccounts = sqliteTable(
  'codex_accounts',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    /** `chatgpt` ou `apiKey` une fois connecté, NULL tant que le home est vide. */
    authMode: text('auth_mode').$type<'chatgpt' | 'apiKey'>(),
    email: text('email'),
    planType: text('plan_type'),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (t) => [uniqueIndex('idx_codex_accounts_owner_label').on(t.ownerId, t.label)],
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
export type InstructionsRow = typeof instructions.$inferSelect
export type ConversationRow = typeof conversations.$inferSelect
export type ScheduledTaskRow = typeof scheduledTasks.$inferSelect
export type ScheduledRunRow = typeof scheduledRuns.$inferSelect
export type AutomationWebhookRow = typeof automationWebhooks.$inferSelect
export type AutomationDeliveryRow = typeof automationDeliveries.$inferSelect
export type ProjectActionRow = typeof projectActions.$inferSelect
export type ConversationReadRow = typeof conversationReads.$inferSelect
export type ConversationFavoriteRow = typeof conversationFavorites.$inferSelect
export type EventRow = typeof events.$inferSelect
export type WorktreeRow = typeof worktrees.$inferSelect
export type CardRow = typeof cards.$inferSelect
export type CardNoteRow = typeof cardNotes.$inferSelect
export type BoardLinkRow = typeof boardLinks.$inferSelect
export type DecisionRow = typeof decisions.$inferSelect
export type CardIssueRow = typeof cardIssues.$inferSelect
export type SessionMessageRow = typeof sessionMessages.$inferSelect
export type AgentRequestRow = typeof agentRequests.$inferSelect
export type SessionWatchRow = typeof sessionWatches.$inferSelect
export type PermissionRequestRow = typeof permissionRequests.$inferSelect
export type McpServerRow = typeof mcpServers.$inferSelect
export type SkillSourceRow = typeof skillSources.$inferSelect
export type LibrarySkillRow = typeof librarySkills.$inferSelect
export type SecretRow = typeof secrets.$inferSelect
export type GitCredentialRow = typeof gitCredentials.$inferSelect
export type ClaudeAccountRow = typeof claudeAccounts.$inferSelect
export type CodexAccountRow = typeof codexAccounts.$inferSelect
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect
