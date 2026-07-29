import type { AgentKind } from '@sillage/protocol'
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

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** NULL signifie que l'agent travaille à la racine du projet. */
    worktreeId: text('worktree_id').references(() => worktrees.id),
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
    /** JSON AgentConfig. */
    config: text('config').notNull(),
    status: text('status')
      .$type<'idle' | 'running' | 'awaiting_input' | 'interrupted' | 'error'>()
      .notNull(),
    lastSeq: integer('last_seq').notNull().default(0),
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

export type UserRow = typeof users.$inferSelect
export type ProjectRow = typeof projects.$inferSelect
export type ConversationRow = typeof conversations.$inferSelect
export type EventRow = typeof events.$inferSelect
export type WorktreeRow = typeof worktrees.$inferSelect
export type PermissionRequestRow = typeof permissionRequests.$inferSelect
export type McpServerRow = typeof mcpServers.$inferSelect
