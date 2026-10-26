import type {
  AgentKind,
  BoardCommentDelivery,
  BoardIdentity,
  BoardNewCards,
  BoardWorkspace,
  CardColumn,
  StoredCardRelationKind,
  CardNotePublication,
  DecisionSourceKind,
  DecisionStatus,
  InstructionsMode, MemoryMode,
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
 * The schema covers the full spec, including tables needed by later batches, so only one
 * initial migration is required. JSON columns are typed through `$type<>` and serialized by the
 * access layer.
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
     * JSON `ProjectAgentDefaults`: one composer preset per CLI, providing project defaults
     * beneath account defaults. The CLI itself is chosen per conversation
     * (`conversations.agent`), not per project, so one project can use both Claude and Codex.
     * Hence one preset per CLI rather than a single preset. The old single-configuration format
     * remains readable (`readProjectDefaults`).
     */
    defaultConfig: text('default_config'),
    /**
     * Manual sidebar order, rewritten in bulk by drag and drop. A new project gets a position
     * above the existing maximum so it appears at the end rather than in the middle.
     */
    position: integer('position').notNull().default(0),
    /**
     * Where project instructions live: in Sillage (`sillage`), injected into both CLIs while
     * repository `CLAUDE.md` and `AGENTS.md` files are hidden, or in the repository (`repo`),
     * where CLIs read them themselves. Set at creation; null for older projects, resolved from
     * the directory (see `instructions/store.ts`).
     */
    instructionsMode: text('instructions_mode').$type<InstructionsMode>(),
    /**
     * Capture workspace state before and after every turn (hidden git refs) to show what the
     * turn changed and allow restoring it. Enabled by default; disable for repositories so
     * large that capture noticeably delays sending a message.
     */
    turnCheckpoints: integer('turn_checkpoints', { mode: 'boolean' }).notNull().default(true),
    /**
     * Where agent memory lives: in Sillage (one directory per project, shared across CLIs and
     * worktrees), or managed by each CLI (`native`, with no Sillage involvement). Set at
     * creation from the account default; `sillage` for older projects.
     */
    memoryMode: text('memory_mode').$type<MemoryMode>().notNull().default('sillage'),
    archivedAt: timestamp('archived_at'),
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [index('idx_projects_owner').on(t.ownerId)],
)

/**
 * SILLAGE.md: instructions maintained by Sillage, shared by Claude and Codex, injected into
 * each session's system prompt. One global row (`id` = `global`, no project) and one per
 * project (`id` = project ID).
 *
 * Stored in the database rather than a file for the same reason as project images: the MCP
 * server, which rewrites it at an agent's request, only has database access.
 */
export const instructions = sqliteTable('instructions', {
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  /** Last editor: a person, or an agent session using the MCP tools. */
  updatedByUserId: text('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  updatedByConversationId: text('updated_by_conversation_id'),
})

/**
 * A project's image makes it recognizable at a glance in navigation.
 *
 * Kept in its own table rather than a `projects` column: otherwise every project read would
 * fetch the blob, although only the image-serving route needs it. Stored in the database
 * because the MCP server, which sets it on behalf of an agent, only has database access;
 * cascading deletion also removes the image with its project without leaving a file to clean
 * up.
 */
export const projectImages = sqliteTable('project_images', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  mimeType: text('mime_type').notNull(),
  data: blob('data', { mode: 'buffer' }).notNull(),
  /**
   * Set by an agent when the project has no logo. While true, sessions are reminded to replace
   * it once a real logo exists; an image chosen by a person is never provisional.
   */
  provisional: integer('provisional', { mode: 'boolean' }).notNull().default(false),
  /** Also serves as the URL version so the browser cache stays current. */
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
 * Absolute paths a conversation has touched outside its working directory.
 *
 * A session recorded at the project root that writes to `~/projects/x-feature` actually works
 * there: the worktree view cross-references this “wrote in” association with repository
 * worktrees. Updated on journal writes, with a one-time migration backfill, to avoid rescanning
 * millions of events on every read. Separate from `conversations.worktree_id`, which determines
 * the resume cwd and must never be rewritten retroactively.
 */
export const conversationPaths = sqliteTable(
  'conversation_paths',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** Absolute path of an edited file or a directory referenced by a command. */
    path: text('path').notNull(),
    lastTs: timestamp('last_ts').notNull(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.path] })],
)

/**
 * Board cards: work to do, distinct from the conversation carrying it out.
 *
 * A card outlives its sessions and can have several; a conversation is one execution attempt
 * that ends and is archived. The association lives on `conversations.card_id`, since a
 * conversation handles only one card at a time.
 */
export const cards = sqliteTable(
  'cards',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /**
     * Short displayed/reference number (`#12`), assigned at creation and never reused.
     *
     * A UUID is awkward to type in a message or read in a branch name. The sequence is per
     * project, like issues on a forge.
     */
    number: integer('number').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    /**
     * Chosen workflow position. Never called `status`: that word describes a conversation's
     * execution state, and the two must not be confused. Activity and merge state are derived,
     * so they have no column here.
     */
    column: text('column').$type<CardColumn>().notNull(),
    /** Ascending manual order within the column. Rewritten in bulk by drag and drop. */
    position: integer('position').notNull().default(0),
    /**
     * Arrival in the current column, for the board's arrival ordering.
     *
     * Maintained by two SQLite triggers (migration 0047) rather than code: a card changes
     * columns through the UI, an agent via the MCP server, GitHub sync, or its first session
     * starting. Missing any of these paths would silently corrupt ordering. `updatedAt` is
     * unsuitable: fixing a typo in the description is not an arrival.
     */
    columnEnteredAt: timestamp('column_entered_at'),
    /**
     * Worktree whose merge moved the card to “Done”. Remembered so it happens only once:
     * someone moving the card back to in-progress has their reasons, and the merged worktree
     * must not move it back on every calculation.
     */
    doneByMerge: text('done_by_merge'),
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
 * `#12` references found in a card description, rewritten on every save.
 *
 * Derived from text, like the search index from the journal: it contains nothing absent from
 * the description and answers “who references me” without scanning every description in the
 * project.
 *
 * The target cascades like the source: a deleted card must not leave a dangling backlink. The
 * text keeps its `#12`, displayed as a dead reference rather than removed from the prose.
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

/** Explicit relationships, independent of mentions derived from the description. */
export const cardRelations = sqliteTable(
  'card_relations',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
    targetId: text('target_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<StoredCardRelationKind>().notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_card_relations_unique').on(t.sourceId, t.targetId, t.kind),
    index('idx_card_relations_target').on(t.targetId),
  ],
)

/**
 * What a session learned or did on a card that the next session needs to know.
 *
 * An append-only stream, unlike the description: the description states the work and is
 * maintained by a person; notes are its history, written mostly by agents. Combining them would
 * let a session report erase the instructions it was supposed to follow.
 *
 * Every note records its author and time. This addresses the concern about the memory store in
 * this roadmap: an anonymous, undated note ages silently and eventually misleads; a note signed
 * by a dated session carries its own context.
 */
export const cardNotes = sqliteTable(
  'card_notes',
  {
    id: text('id').primaryKey(),
    cardId: text('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    /**
     * Author session, null for a manually written note. No cascade: a work report survives
     * deletion of the conversation that produced it; at that point it becomes the only record.
     */
    conversationId: text('conversation_id'),
    userId: text('user_id').references(() => users.id),
    body: text('body').notNull(),
    createdAt: timestamp('created_at').notNull(),
    /**
     * GitHub comment copied into this note, or created when it was published. With
     * `externalAuthor`, it was written on GitHub; without it, it is a Sillage note published
     * there.
     */
    externalId: text('external_id'),
    externalAuthor: text('external_author'),
    externalUrl: text('external_url'),
    /** Publication as a comment on the card's issue; null for a local note. */
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
 * A project board linked to issues from a GitHub repository.
 *
 * One row per project: a board follows one source, otherwise two `#12` issues from different
 * repositories would compete for the same card. Local cards are unaffected; they coexist and
 * never leave on their own.
 */
export const boardLinks = sqliteTable('board_links', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  provider: text('provider').$type<'github'>().notNull().default('github'),
  /** `owner/name`. Immutable: linking another repository requires unlinking this one. */
  repo: text('repo').notNull(),
  /**
   * Account whose github.com credential reads and writes. Issues created from Sillage use its
   * identity, like content its agents already push.
   */
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  labelFilter: text('label_filter').notNull().default(''),
  closedDays: integer('closed_days').notNull().default(14),
  newCards: text('new_cards').$type<BoardNewCards>().notNull().default('local'),
  progressLabel: text('progress_label').notNull().default('in progress'),
  reviewLabel: text('review_label').notNull().default('review'),
  /** An issue opened on GitHub without a session marker opens a session on its card. */
  onIssue: integer('on_issue', { mode: 'boolean' }).notNull().default(false),
  issueInstructions: text('issue_instructions').notNull().default(''),
  /** A comment without a session marker is delivered to its issue's session. */
  onComment: integer('on_comment', { mode: 'boolean' }).notNull().default(false),
  commentInstructions: text('comment_instructions').notNull().default(''),
  commentDelivery: text('comment_delivery').$type<BoardCommentDelivery>().notNull().default('queue'),
  replyStyle: text('reply_style').notNull().default(''),
  identity: text('identity').$type<BoardIdentity>().notNull().default('ai'),
  signature: text('signature').notNull().default(''),
  sessionAgent: text('session_agent').$type<AgentKind>().notNull().default('claude'),
  /** JSON `AgentConfig`; NULL uses project settings for that CLI, read at launch. */
  sessionConfig: text('session_config'),
  workspace: text('workspace').$type<BoardWorkspace>().notNull().default('worktree'),
  maxSessionsPerHour: integer('max_sessions_per_hour').notNull().default(10),
  /** Maintenance sessions may request a human decision. */
  decisionsEnabled: integer('decisions_enabled', { mode: 'boolean' }).notNull().default(false),
  decisionMaxHours: integer('decision_max_hours').notNull().default(24),
  /**
   * Issues manually removed from the board, as JSON. Deleting their cards alone would not
   * suffice: the next sync would recreate them.
   */
  hiddenIssues: text('hidden_issues').notNull().default('[]'),
  /** Latest GitHub `updated_at` already read, the starting point for the next read. */
  cursor: text('cursor'),
  lastSyncedAt: timestamp('last_synced_at'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
})

/**
 * The issue mirrored by a card.
 *
 * A separate table rather than `cards` columns: most cards are local and have none of this.
 * `title`, `body`, `state` and `labels` retain GitHub's values from the last read. Comparing
 * them with the card reveals who changed what, without maintaining flags in every route that
 * touches a card.
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
    /** Session marker removed from the body on read and restored on write. */
    marker: text('marker'),
    state: text('state').$type<'open' | 'closed'>().notNull(),
    stateReason: text('state_reason'),
    /** JSON label names. */
    labels: text('labels').notNull().default('[]'),
    remoteUpdatedAt: text('remote_updated_at').notNull(),
    closedAt: timestamp('closed_at'),
    /** Local again: sync no longer touches it, and the issue lives independently. */
    detached: integer('detached', { mode: 'boolean' }).notNull().default(false),
    /**
     * Conversation replying to this issue's comments: later comments arrive as messages instead
     * of opening a new session with no memory each time.
     */
    responderId: text('responder_id'),
  },
  (t) => [uniqueIndex('idx_card_issues_number').on(t.projectId, t.provider, t.repo, t.number)],
)

/**
 * A message from one session to another in the same project.
 *
 * Deposited by the MCP server, which only has database access, and delivered by the daemon,
 * which alone owns the runners: this table is the mailbox between the two processes. Null
 * `deliveredAt` means “not yet delivered”, which is what the relay scans.
 *
 * No foreign key to `conversations`: an exchange stays readable to the surviving session when
 * the other is deleted, just as a card note outlives its author.
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
     * `message` from one session to another; `broadcast` to all working sessions; `done`,
     * written by the relay, announces that a watched session has finished.
     */
    kind: text('kind', { enum: ['message', 'broadcast', 'done'] }).notNull().default('message'),
    body: text('body').notNull(),
    /** Message this one replies to, used to count exchange depth. */
    replyTo: text('reply_to'),
    createdAt: timestamp('created_at').notNull(),
    /**
     * Set when the relay holds a message instead of waking the recipient. Ensures the hold is
     * announced only once in its thread, including across daemon restarts.
     */
    heldAt: timestamp('held_at'),
    deliveredAt: timestamp('delivered_at'),
    /**
     * `steer` injected into an open turn, `queue` queued behind it, `wake` opening a turn,
     * `read` read by the tool before delivery, `failed` when delivery failed: no retries, to
     * avoid repeatedly launching a CLI that refuses to start, but still readable through the
     * tool. The last three are not deliveries: `discarded` dismissed by a person, `expired`
     * held too long, `skipped` an announcement arriving after the recipient stopped working.
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
 * A session requesting notification when another finishes its work.
 *
 * Instead of repeatedly calling `list_sessions`, which costs a turn per check, the relay
 * watches and deposits a `done` message at the right time.
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
    /** Set when the `done` message is deposited or the watch expires. */
    firedAt: timestamp('fired_at'),
  },
  (t) => [index('idx_session_watches_open').on(t.firedAt)],
)

/**
 * A session request to the daemon: start another session, create a card, read the model
 * catalog.
 *
 * The same mailbox pattern as `session_messages`, but with a response: the MCP server deposits
 * the request, then waits for the daemon to write its result because the agent needs it to
 * continue (the new session ID, or available models after naming an invalid one). Only the
 * daemon owns the CLI catalog, runners and worktree creation.
 *
 * Kept after processing to record who launched what, allowing launch-chain depth and hourly
 * counts to be calculated.
 */
export const agentRequests = sqliteTable(
  'agent_requests',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .references(() => projects.id, { onDelete: 'cascade' }),
    /**
     * Requesting conversation. No foreign key, like inter-session messages. Empty for requests
     * from a sessionless MCP client (`user_id` then determines whose behalf to act on): a local
     * CLI connected to the whole instance; see `docs/mcp.md`.
     */
    conversationId: text('conversation_id').notNull(),
    /** Account to act on behalf of when no conversation is requesting. */
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', {
      enum: [
        'create_project',
        'delete_project',
        'continue_in_project',
        'find_files',
        'write_personal_memory',
        'delete_personal_memory',
        'start_session',
        'rename_session',
        'create_card',
        'update_card',
        'link_cards',
        'unlink_cards',
        'list_models',
        'schedule_task',
        'register_action',
        'remove_action',
        'run_action',
        // An automation launched by a call bearing this session's marker:
        // the row preserves lineage so chain limits apply.
        'webhook_launch',
        'request_decision',
        'withdraw_decision',
        'create_automation',
        // Operations on an existing session, on behalf of an account: used by a sessionless MCP
        // client (`docs/mcp.md`), which has no runner to perform them itself.
        'message_session',
        'steer_session',
        'interrupt_session',
        'reply_session',
        // Worktrees: git and worktree progress live only in the daemon.
        'create_worktree',
        'list_worktrees',
      ],
    }).notNull(),
    /** Tool arguments as JSON, exactly as supplied by the agent. */
    payload: text('payload').notNull(),
    createdAt: timestamp('created_at').notNull(),
    /** Set by the daemon when the request is processed, whether successful or not. */
    settledAt: timestamp('settled_at'),
    /** Text returned to the agent: the outcome, or what prevented it. */
    result: text('result'),
    isError: integer('is_error', { mode: 'boolean' }).notNull().default(false),
    /** Session created by the request, used to trace a launch chain. */
    launchedConversationId: text('launched_conversation_id'),
  },
  (t) => [
    index('idx_agent_requests_pending').on(t.settledAt),
    index('idx_agent_requests_from').on(t.conversationId, t.kind, t.createdAt),
    index('idx_agent_requests_launched').on(t.launchedConversationId),
  ],
)

/** Managed personal directories outlive their conversations. A CLI continuation can reuse its source directory. */
export const personalWorkspaces = sqliteTable('personal_workspaces', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  path: text('path').notNull(),
  createdAt: timestamp('created_at').notNull(),
})

/** Auditable personal-memory edits, including deletions; intentionally independent of session lifetime. */
export const personalMemoryChanges = sqliteTable('personal_memory_changes', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  file: text('file').notNull(),
  before: text('before'),
  after: text('after'),
  conversationId: text('conversation_id'),
  createdAt: timestamp('created_at').notNull(),
}, (t) => [index('idx_personal_memory_changes_user').on(t.userId, t.createdAt)])

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Set only for personal discussions. Its lifetime is independent of conversation deletion. */
    workspaceId: text('workspace_id').references(() => personalWorkspaces.id),
    /** NULL means the project root or managed personal directory. */
    worktreeId: text('worktree_id').references(() => worktrees.id),
    /**
     * Card this conversation handles, if any.
     *
     * An association, not merely a mention: quoting `#12` in a message provides model context
     * without committing the conversation, whereas this column determines card activity.
     * Confusing the two would count a session towards neighboring work it only mentioned.
     *
     * No cascade: deleting a card does not erase the conversations that handled it; they become
     * ordinary conversations again.
     */
    cardId: text('card_id'),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull(),
    /**
     * True as soon as the user renames it: the CLI's suggested title must never overwrite it
     * behind their back.
     */
    titleSetByUser: integer('title_set_by_user', { mode: 'boolean' }).notNull().default(false),
    /** An explicit agent title takes precedence over later native CLI summaries. */
    titleSetByAgent: integer('title_set_by_agent', { mode: 'boolean' }).notNull().default(false),
    // Derived from the protocol enum: adding a CLI does not require changing
    // the column, and the two lists cannot drift apart.
    agent: text('agent').$type<AgentKind>().notNull(),
    /** Native CLI ID, for `--resume` or `thread/resume`. */
    agentSessionId: text('agent_session_id'),
    /**
     * Conversation this one was forked from, if any.
     *
     * No cascade: deleting the original must not delete its branches, which are full
     * conversations in their own right. The reference becomes orphaned and the UI simply stops
     * displaying the origin.
     */
    forkedFromId: text('forked_from_id'),
    /**
     * Conversation this one continues in another CLI, if any.
     *
     * Unlike a fork, the agent does not resume native history; it receives a selection from the
     * thread stored in `conversation_handoffs`. No cascade, like `forkedFromId`: the
     * continuation outlives the original.
     */
    handoffFromId: text('handoff_from_id'),
    /**
     * API token that created the conversation, for auditing and to let `GET /api/v1/tasks`
     * return what a caller launched. No cascade: deleting a token does not erase conversations
     * it opened.
     */
    createdByTokenId: text('created_by_token_id'),
    /**
     * Original token label, frozen at creation. NULL means “created in the UI”.
     *
     * Deliberately duplicated from the token so the sidebar keeps its marker after the token is
     * deleted.
     */
    originLabel: text('origin_label'),
    /**
     * Scheduled task whose run opened this conversation, if any.
     *
     * Keeps it out of the main list: an hourly task would add twenty-four rows a day, so the
     * sidebar groups them under their task instead. The exact run is found through
     * `scheduled_runs.conversation_id`.
     *
     * No cascade, like `cardId`: deleting a task does not erase its runs' output. The deletion
     * route clears the column and archives the threads, which become ordinary conversations
     * again.
     */
    scheduleId: text('schedule_id'),
    /** JSON AgentConfig. */
    config: text('config').notNull(),
    status: text('status')
      .$type<'idle' | 'running' | 'awaiting_input' | 'interrupted' | 'error'>()
      .notNull(),
    /**
     * Active background jobs and loops, as described by the latest `background.updated` and
     * `loops.updated`.
     *
     * Persisted even though they belong to the CLI process and die with it: they are the only
     * indication that an `idle` conversation is still working. Status resets at the end of a
     * turn, not the end of the work. Without them, answering “is this session working?”
     * requires folding each conversation's journal, prohibitively expensive when listing
     * several.
     *
     * Reset at startup by `recoverInterrupted`: the processes died with the daemon, so any
     * nonzero value read at boot is stale.
     */
    backgroundCount: integer('background_count').notNull().default(0),
    loopCount: integer('loop_count').notNull().default(0),
    lastSeq: integer('last_seq').notNull().default(0),
    /**
     * Latest `seq` worth notifying the reader about, used to determine unread state.
     *
     * Separate from `lastSeq` because the journal also advances on its own: a cooling session
     * or usage report is written after everyone leaves. Counting these marked 57 out of 80
     * conversations unread with nothing to read. See `NOTABLE` in `EventLog` for the selected
     * events.
     */
    lastNotableSeq: integer('last_notable_seq').notNull().default(0),
    /**
     * Volume metrics maintained on journal writes.
     *
     * Persisted for the same reason as `backgroundCount`: the sidebar displays them for
     * unopened conversations, and recalculating requires folding each journal, prohibitively
     * expensive when listing several.
     *
     * `turnCount` counts turns, one per user message: the marks on the navigation ruler.
     * Counting agent messages would count steps, since each tool call produces one.
     *
     * This follows thread segmentation, not runner lifecycle: it differs from `turn.started` in
     * both directions, since a turn can open without a message and steering can add a message
     * without opening a turn.
     */
    turnCount: integer('turn_count').notNull().default(0),
    /** Journal size on disk, including payloads and `raw`. */
    journalBytes: integer('journal_bytes').notNull().default(0),
    /**
     * Latest context-window usage reported by the CLI, and model of the latest opened session.
     * NULL until the CLI reports it.
     *
     * Separate from `inputTokens`/`outputTokens`, which accumulate billing from the start:
     * context resets at each compaction and indicates when the next one will occur.
     */
    contextUsedTokens: integer('context_used_tokens'),
    contextMaxTokens: integer('context_max_tokens'),
    model: text('model'),
    costUsd: real('cost_usd').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    /**
     * Ascending manual order within the project, rewritten by drag and drop. A new conversation
     * gets a position below the existing minimum so it appears first, as with the previous date
     * sort.
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
 * Context passed to a conversation continuing another in a different CLI.
 *
 * Frozen at creation, as a fork freezes the journal: the source may continue afterwards, but
 * the continuation starts from that moment's state. Stored separately because it can reach 64
 * KB and is only needed at CLI startup, whereas the conversation row is read on every listing.
 */
export const conversationHandoffs = sqliteTable('conversation_handoffs', {
  conversationId: text('conversation_id')
    .primaryKey()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  fromConversationId: text('from_conversation_id').notNull(),
  /** Last source `seq` included, recording how much the continuation has seen. */
  throughSeq: integer('through_seq').notNull(),
  budgetTokens: integer('budget_tokens').notNull(),
  /** Block injected into the CLI verbatim. */
  text: text('text').notNull(),
  createdAt: timestamp('created_at').notNull(),
})

/**
 * Scheduled tasks: a prompt the daemon replays at a fixed cadence, each run in a fresh session.
 *
 * Managed by Sillage because no CLI has a durable local scheduler: Claude's `CronCreate` dies
 * with its session, and Codex has none. The daemon runs continuously.
 */
export const scheduledTasks = sqliteTable(
  'scheduled_tasks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Account on whose behalf runs open: the task creator. */
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    agent: text('agent').$type<AgentKind>().notNull(),
    /**
     * JSON AgentConfig: model, effort and permissions, frozen per task.
     *
     * A copy rather than project defaults reread on every run: nobody is at the keyboard to
     * answer permission requests, so a run must use the safeguards chosen at task creation, not
     * today's settings.
     */
    config: text('config').notNull(),
    prompt: text('prompt').notNull(),
    /** JSON `ScheduleCadence`: interval, cron expression or one-time date. */
    cadence: text('cadence').notNull(),
    /** `fresh`: a new session per run. Currently the only mode. */
    executionMode: text('execution_mode').$type<'fresh'>().notNull().default('fresh'),
    /** What to do when a run is due while the previous one is still running. */
    overlapPolicy: text('overlap_policy').$type<'skip' | 'wait'>().notNull().default('skip'),
    /** The run is interrupted beyond this limit: nothing else would stop a wandering agent. */
    maxDurationMinutes: integer('max_duration_minutes').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** Conversation that created the task through `schedule_task`; NULL from the UI. */
    createdByConversationId: text('created_by_conversation_id'),
    /**
     * Check script run before the LLM turn; NULL for no check. Its exit code decides whether to
     * launch, and its output joins the prompt (see `scheduler/check.ts`).
     *
     * Stores content, not a path: the daemon executes it outside any session, and this exact
     * text is what gets approved. A file could change afterwards, including by a run executing
     * without permission prompts.
     */
    checkScript: text('check_script'),
    checkTimeoutSeconds: integer('check_timeout_seconds').notNull().default(120),
    /**
     * Human script approval. NULL while an agent-written or edited script remains unreviewed:
     * the run is then skipped, including both script and LLM.
     */
    checkApprovedAt: timestamp('check_approved_at'),
    /** Conversation that proposed the current script; NULL when it comes from the UI. */
    checkProposedBy: text('check_proposed_by'),
    /** Runs may request a human decision (`request_decision`). */
    decisionsEnabled: integer('decisions_enabled', { mode: 'boolean' }).notNull().default(false),
    decisionMaxHours: integer('decision_max_hours').notNull().default(24),
    lastRunAt: timestamp('last_run_at'),
    /** NULL when nothing remains scheduled: a one-time task already ran. */
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
 * A scheduled task run, including those that launched nothing.
 *
 * A skipped run or failed launch leaves a row without a conversation: otherwise a task that
 * never starts would look like one that found nothing.
 */
export const scheduledRuns = sqliteTable(
  'scheduled_runs',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => scheduledTasks.id, { onDelete: 'cascade' }),
    /** No foreign key: the thread can be deleted while the run stays in history. */
    conversationId: text('conversation_id'),
    trigger: text('trigger').$type<'schedule' | 'manual' | 'webhook'>().notNull(),
    /** `checking`: the check is running, or its subsequent session is starting. */
    status: text('status')
      .$type<'checking' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'skipped'>()
      .notNull(),
    /** Scheduled time, which `startedAt` exceeds if the daemon was stopped or busy. */
    scheduledFor: timestamp('scheduled_for').notNull(),
    startedAt: timestamp('started_at').notNull(),
    finishedAt: timestamp('finished_at'),
    /** What prevented or interrupted the run, written for direct display. */
    error: text('error'),
    /**
     * Latest agent reply, truncated and copied at the end of the run.
     *
     * Deliberately duplicated from the journal: the next run receives it in its prompt, even if
     * the thread has since been deleted.
     */
    summary: text('summary'),
    /**
     * Check result; NULL if no check ran. Standard output is what the prompt received; standard
     * error is for debugging.
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
 * An automation webhook: a scheduled task with cadence `{ kind: 'webhook' }`, launched when an
 * incoming call passes its conditions.
 */
export const automationWebhooks = sqliteTable(
  'automation_webhooks',
  {
    taskId: text('task_id')
      .primaryKey()
      .references(() => scheduledTasks.id, { onDelete: 'cascade' }),
    /** Last segment of the public URL: unguessable, but not a signing secret. */
    token: text('token').notNull(),
    /** Encrypted signing secret (JSON `EncryptedValue`): shown again so it can be copied to the caller. */
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
    /** The circuit breaker tripped and paused the task; NULL after reactivation. */
    trippedAt: timestamp('tripped_at'),
    template: text('template'),
  },
  (t) => [uniqueIndex('idx_automation_webhooks_token').on(t.token)],
)

/**
 * Each call received by a webhook and its outcome: launched, filtered, rejected, and why. Used
 * to refine conditions and replay a call. Bounded per webhook: older calls are removed as new
 * ones arrive.
 */
export const automationDeliveries = sqliteTable(
  'automation_deliveries',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => scheduledTasks.id, { onDelete: 'cascade' }),
    receivedAt: timestamp('received_at').notNull(),
    /** Caller-provided ID used to recognize a replay. */
    deliveryId: text('delivery_id'),
    /** Headers as JSON, excluding those carrying secrets. */
    headers: text('headers').notNull(),
    query: text('query').notNull().default('{}'),
    body: text('body').notNull(),
    bytes: integer('bytes').notNull(),
    truncated: integer('truncated', { mode: 'boolean' }).notNull().default(false),
    verdict: text('verdict').notNull(),
    /** JSON `DeliveryReason`: a code translated by the UI, plus its parameters. */
    reason: text('reason'),
    subject: text('subject'),
    /** Variables returned by the script, as JSON, for a queued call. */
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
 * How far each reader has read in each conversation.
 *
 * The journal advances on its own: an agent working while nobody watches produces unseen
 * events, yet its sidebar row looks like a thread that died three weeks ago. Comparing this
 * cursor with `conversations.lastSeq` distinguishes them.
 *
 * Per reader, not per conversation: two accounts in a shared project have read different
 * things. The thread owner has no special status here.
 *
 * Missing row = never opened, so everything is unread. The migration creates an up-to-date row
 * for every existing pair, otherwise the first update would light up everything.
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
    /** Never moves backwards: writes take the maximum of the new and stored values. */
    lastReadSeq: integer('last_read_seq').notNull().default(0),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.userId] })],
)

/**
 * Threads an account has marked as favorites.
 *
 * A table rather than a column, like `conversation_reads` and for the same reason: a favorite
 * belongs to the person who marked it, not the conversation. In shared projects, each sidebar
 * must keep personal bookmarks without imposing them on others. `conversations.pinned` already
 * provides shared thread pinning and remains separate.
 *
 * Purely a navigation aid: auto-archiving ignores it, so a favorited and completed thread is
 * archived like any other.
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
    /** Favorites section order, most recently marked first. */
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.userId] })],
)

/**
 * Projects an account pinned to the top of the picker.
 *
 * Same logic as `conversation_favorites`: a pin is a personal marker, not a project property.
 * Everyone keeps their own order in a shared project. Stored in the database rather than
 * browser `localStorage` to survive device changes or tab cleanup.
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
    /** Pinned section order, oldest pin first. */
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] })],
)

/**
 * Project actions: buttons that launch a command, created in the UI or proposed by an agent
 * through `register_action`.
 *
 * Stored in the database rather than a repository file: Sillage does not impose its tooling on
 * the projects it drives.
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
    /** Relative to the worktree where the action runs; NULL for its root. */
    subdir: text('subdir'),
    /** URL template for opening a service, including `{port}`. */
    url: text('url'),
    /**
     * NULL until someone reviews the command: set on creation in the UI, cleared when an agent
     * changes what executes.
     */
    approvedAt: timestamp('approved_at'),
    /** Latest conversation to create or modify it through MCP; NULL from the UI. */
    agentConversationId: text('agent_conversation_id'),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (t) => [index('idx_project_actions_project').on(t.projectId, t.createdAt)],
)

/**
 * The journal (invariant I2). `seq` is strictly increasing and gapless per conversation.
 * WITHOUT ROWID because the composite primary key already gives the natural read order.
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
    /** Native CLI JSON, retained for specialized tool renderers. */
    raw: text('raw'),
    /**
     * Origin of `raw` (“claude-agent-sdk@0.3”, “codex-app-server@v2”, etc.).
     *
     * Without it, native payload shape is inferred from `conversations.agent`, which fails
     * across CLI protocol changes: two generations of `raw` then coexist in one thread with no
     * way to tell them apart. Nullable: events predating the stamp retain their agent's current
     * generation until the first version bump.
     */
    rawFormat: text('raw_format'),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.seq] }),
    // Diff lookups must not parse unrelated, potentially huge tool outputs.
    index('idx_events_native_tool').on(t.conversationId, t.type, sql`(${t.payload} ->> '$.toolCallId')`, t.seq)
      .where(sql`${t.type} = 'tool.started' or ${t.type} = 'tool.completed'`),
  ],
)

/** Reconstructible Claude import progress, committed atomically with journal batches. */
export const claudeTranscriptCursors = sqliteTable('claude_transcript_cursors', {
  conversationId: text('conversation_id').primaryKey().references(() => conversations.id, { onDelete: 'cascade' }),
  journalSeq: integer('journal_seq').notNull(),
  state: text('state').notNull(),
})

export const permissionRequests = sqliteTable(
  'permission_requests',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** Position of the associated `permission.requested` event in the journal. */
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
     * Null until the attachment is sent: it is uploaded before the conversation exists, since
     * the first message creates a conversation.
     */
    conversationId: text('conversation_id').references(() => conversations.id, {
      onDelete: 'cascade',
    }),
    /** An attachment belongs to either a conversation or a ticket. */
    cardId: text('card_id').references(() => cards.id, { onDelete: 'set null' }),
    /** Uploader; ticket files are shared with the project. */
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    /** Determined by content, never by the client-supplied extension. */
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    storagePath: text('storage_path').notNull(),
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [index('idx_attachments_conversation').on(t.conversationId), index('idx_attachments_card').on(t.cardId)],
)

/**
 * Web Push subscriptions, one per device and account.
 *
 * The browser-provided `endpoint` uniquely identifies the subscription: it is the natural
 * primary key, and two subscriptions to the same endpoint would refer to the same device.
 */
export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    endpoint: text('endpoint').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Browser encryption keys required to send it a message. */
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at').notNull(),
    /**
     * VAPID subject for this subscription: the instance's public address, read at subscription
     * time. Apple rejects a `localhost` subject, and a self-hosted instance has no address to
     * provide other than the one used to reach it.
     */
    subject: text('subject'),
  },
  (t) => [index('idx_push_user').on(t.userId)],
)

/**
 * Decisions requested by autonomous sessions (scheduled tasks, automations, board maintenance):
 * deposited without blocking the agent, resolved by a person or the deadline, then delivered to
 * the session as a message.
 *
 * Stored in the database rather than memory like native CLI requests: they may be handled hours
 * later, and a daemon restart must not lose them.
 */
export const decisions = sqliteTable(
  'decisions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** No foreign key: the decision retains its record when the conversation disappears. */
    conversationId: text('conversation_id').notNull(),
    /** Account that must answer: the owner of the source. */
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sourceKind: text('source_kind').$type<DecisionSourceKind>().notNull(),
    sourceLabel: text('source_label').notNull(),
    taskId: text('task_id'),
    cardId: text('card_id'),
    question: text('question').notNull(),
    context: text('context').notNull().default(''),
    /** JSON labels of the suggested choices. */
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
     * When the answer (or deadline) was delivered to the session. NULL for a resolved decision
     * whose delivery failed: the daemon retries.
     */
    deliveredAt: timestamp('delivered_at'),
    /**
     * For a cleanup proposal (`source_kind = 'worktree'`): the target worktree. The answer goes
     * to no session; it cleans up this tree. Also the key preventing repeated questions for an
     * already resolved tree.
     */
    worktreePath: text('worktree_path'),
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [
    index('idx_decisions_user_status').on(t.userId, t.status),
    index('idx_decisions_conversation').on(t.conversationId, t.status),
  ],
)

/**
 * Instance settings: values shared by everyone that an administrator can change without editing
 * `config.toml` or restarting the service, which would kill child CLI processes.
 *
 * Key-value storage rather than typed columns avoids a migration for every new setting. Values
 * are JSON, and only the access layer needs to know. An absent key means “not configured yet”
 * and leaves the `config.toml` default in effect, preserving it as the entry point for
 * provisioning an instance.
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
  /** JSON: theme, density, display preferences. */
  data: text('data').notNull().default(sql`'{}'`),
})

/**
 * MCP server registry, shared by all CLIs and projects.
 *
 * Declared once here, enabled per conversation through `AgentConfig.mcpServers`. Nothing is
 * written to `~/.claude.json` or Codex's `config.toml`: Sillage passes these servers in memory
 * at each session launch and does not become a co-owner of files it did not write. Accepted
 * consequence: a conversation resumed in a native CLI does not have these servers.
 */
export const mcpServers = sqliteTable('mcp_servers', {
  id: text('id').primaryKey(),
  /**
   * Unique: the name is the CLI-side key; two servers sharing a name would silently overwrite
   * each other in the table passed to the CLI.
   */
  name: text('name').notNull().unique(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** JSON McpTransport: shape depends on transport; the column need not know it. */
  transport: text('transport').notNull(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
})

/**
 * Git repositories from which the skill library installs skills.
 *
 * Installation copies a skill and records its commit: subsequent repository changes do not
 * enter agent context until an admin reviews them. Preconfigured sources are inserted by the
 * table-creation migration, not at startup, so a deleted source stays deleted.
 */
export const skillSources = sqliteTable('skill_sources', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Anything `git clone` accepts, including private repositories. */
  url: text('url').notNull(),
  /** Branch or tag. Null means the repository's default branch. */
  ref: text('ref'),
  /** Repository directory to search for skills. Null means the entire repository. */
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
 * Skill library: what Sillage delivers to CLIs as native skills.
 *
 * Content on disk under `<data>/skill-library` is authoritative: description and body are
 * reread from `SKILL.md`. This table holds what disk does not tell us: scope, activation and
 * origin. The directory is derived from the row; see `skill-library/layout.ts`.
 */
export const librarySkills = sqliteTable(
  'library_skills',
  {
    id: text('id').primaryKey(),
    scope: text('scope', { enum: ['global', 'project'] }).notNull(),
    /** Null for global scope. Cascading deletion does not touch disk; the route handles it. */
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    /**
     * Directory name and frontmatter `name`. Unique across “global + one project”, which no
     * index can express since SQLite treats `NULL` values as distinct: the service enforces it.
     */
    name: text('name').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    sourceId: text('source_id').references(() => skillSources.id, { onDelete: 'set null' }),
    sourcePath: text('source_path'),
    sourceCommit: text('source_commit'),
    /**
     * Skill hash as stored in the source at installation. Compared with the catalog to detect
     * updates; differs from `installedHash` when the skill was renamed on import and its
     * frontmatter rewritten.
     */
    sourceHash: text('source_hash'),
    /** Content hash at installation, used to recognize local changes. */
    installedHash: text('installed_hash'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (t) => [index('idx_library_skills_project').on(t.projectId)],
)

/**
 * Instance secret store, encrypted at rest.
 *
 * The name is the primary key: it appears in `{{secret.NOM}}`, and two secrets sharing a name
 * could not be distinguished. Values use AES-256-GCM with the data-directory key; `iv` and
 * `authTag` belong to the ciphertext and need not be secret, but must be kept alongside it.
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
 * Git credentials per user and host, encrypted like secrets.
 *
 * A separate table from `secrets`, not a naming convention within it: secrets are admin-only
 * and feed MCP servers' `{{secret.NOM}}` namespace. Combining them would expose GitHub tokens
 * in the MCP secret picker and prevent non-admin accounts from cloning private repositories.
 *
 * `username` exists because forges expect different values: GitHub ignores it for personal
 * tokens but requires `x-access-token` for installation tokens; GitLab expects `oauth2`.
 * Storing it avoids hardcoding a per-forge mapping.
 */
export const gitCredentials = sqliteTable(
  'git_credentials',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Host only, without scheme or port: `github.com`, `gitlab.example.org`. */
    host: text('host').notNull(),
    username: text('username').notNull(),
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    authTag: text('auth_tag').notNull(),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  // Only one credential per host and account: two github.com tokens could not
  // be distinguished when git requests one.
  (t) => [uniqueIndex('idx_git_credentials_owner_host').on(t.ownerId, t.host)],
)

/**
 * Additional Claude accounts per user: each has a long-lived OAuth token from `claude
 * setup-token`, encrypted like git credentials.
 *
 * Per user rather than per instance for the same reason as git credentials: it is someone's
 * subscription, and an administrator should not borrow another person's. The label is displayed
 * in the account picker: a token carries no readable email or organization name without
 * spending a turn.
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
     * Secret kind: an OAuth token from `claude setup-token` (subscription, passed in
     * `CLAUDE_CODE_OAUTH_TOKEN`) or a Console API key (usage billing, passed in
     * `ANTHROPIC_API_KEY`). Inferred from the prefix on write and retained so launch does not
     * need to decrypt it to find out.
     */
    kind: text('kind').$type<'oauth' | 'apiKey'>().notNull().default('oauth'),
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    authTag: text('auth_tag').notNull(),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  // Two identically named accounts would be indistinguishable in the picker.
  (t) => [uniqueIndex('idx_claude_accounts_owner_label').on(t.ownerId, t.label)],
)

/**
 * Additional Codex accounts per user.
 *
 * No secret here, unlike Claude accounts: login lives in `auth.json` under the home Sillage
 * assigns to the account (`<data>/codex-accounts/<id>`), written and refreshed by Codex itself.
 * The row holds only the label and what Codex reported at the last login, so listing accounts
 * does not require launching an app-server.
 */
export const codexAccounts = sqliteTable(
  'codex_accounts',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    /** `chatgpt` or `apiKey` after login; NULL while the home is empty. */
    authMode: text('auth_mode').$type<'chatgpt' | 'apiKey'>(),
    email: text('email'),
    planType: text('plan_type'),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (t) => [uniqueIndex('idx_codex_accounts_owner_label').on(t.ownerId, t.label)],
)

/**
 * Additional Grok Build accounts per user.
 *
 * Same approach as Codex accounts: no secret here. Login lives in `auth.json` under the
 * account's Sillage-assigned `GROK_HOME` (`<data>/grok-accounts/<id>`), written and refreshed
 * by Grok. The row retains the label and reported account details so listing does not require
 * launching a process.
 */
export const grokAccounts = sqliteTable(
  'grok_accounts',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    /** `grok` (subscription, grok.com login) or `apiKey` after login; NULL beforehand. */
    authMode: text('auth_mode').$type<'grok' | 'apiKey'>(),
    email: text('email'),
    /** Plan reported by Grok billing (“X Premium”, “SuperGrok”, etc.). */
    plan: text('plan'),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (t) => [uniqueIndex('idx_grok_accounts_owner_label').on(t.ownerId, t.label)],
)

/** Google accounts; credentials stay in their private CLI homes. */
export const antigravityAccounts = sqliteTable(
  'antigravity_accounts',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    authMode: text('auth_mode').$type<'oauth-personal' | 'oauth-business' | 'gemini-api-key' | 'agent-platform'>(),
    email: text('email'),
    plan: text('plan'),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (t) => [uniqueIndex('idx_antigravity_accounts_owner_label').on(t.ownerId, t.label)],
)

/**
 * API tokens carrying machine-client identities.
 *
 * Stored like sessions: only the secret's SHA-256 hash is retained; the cleartext token exists
 * only in the creation response. Revocation keeps the row so its label remains readable when
 * auditing conversations it launched.
 */
export const apiTokens = sqliteTable(
  'api_tokens',
  {
    id: text('id').primaryKey(),
    tokenHash: text('token_hash').notNull().unique(),
    /** First characters of the secret, to identify a row without revealing it. */
    hint: text('hint').notNull(),
    label: text('label').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** JSON ApiScope[]. */
    scopes: text('scopes').notNull(),
    /** JSON string[] of project IDs; empty means “all projects it can see”. */
    projectIds: text('project_ids').notNull(),
    agent: text('agent').$type<AgentKind>().notNull(),
    /** JSON AgentConfig: default settings for tasks launched with this token. */
    config: text('config').notNull(),
    /** JSON ApiExecutionPolicy; NULL preserves the permissions of existing tokens. */
    executionPolicy: text('execution_policy'),
    /** URL called on task events; NULL if the token requests none. */
    webhookUrl: text('webhook_url'),
    /**
     * Delivery HMAC secret, in cleartext: the server must sign, so encrypting it with a key
     * beside the database would offer no protection. It grants no Sillage access, only the
     * ability to forge deliveries to the consumer's endpoint, which also requires knowing its
     * URL.
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
 * Settings specific to API-launched tasks: webhook override and response deadline. Separate
 * from `conversations`, which belongs to the core and should not carry machine-caller concerns.
 */
export const apiTaskOptions = sqliteTable('api_task_options', {
  conversationId: text('conversation_id')
    .primaryKey()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  webhookUrl: text('webhook_url'),
  /** 0 means “no deadline”, explicitly chosen by the caller. */
  replyDeadlineSec: integer('reply_deadline_sec').notNull(),
})

/**
 * Webhook deliveries, persisted before the first attempt.
 *
 * A service restart must not swallow the only notification a caller was waiting for: recovery
 * rereads undelivered entries and resumes the retry schedule where it left off. NULL
 * `nextAttemptAt` marks abandonment after all attempts are exhausted.
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
 * Idempotency keys for task creation.
 *
 * Send deduplication lives in memory for five minutes, suitable for network retransmissions but
 * not an agent retrying ten minutes later: without this table it would open a second
 * conversation.
 *
 * The key is reserved before creation, hence nullable `conversation_id`: a concurrent request
 * must see the reservation and wait instead of launching a second turn. No reference either, so
 * the reservation can precede its conversation; a deleted conversation leaves an orphaned key
 * that cleanup eventually removes.
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
export type GrokAccountRow = typeof grokAccounts.$inferSelect
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect

/** Shared cache per URL; subscriptions remain private in account settings. */
export const newsFeeds = sqliteTable('news_feeds', {
  url: text('url').primaryKey(),
  data: text('data').notNull(),
  checkedAt: timestamp('checked_at').notNull(),
  error: text('error'),
})

/** Disposable display projection; the immutable journal remains authoritative. */
export const threadProjections = sqliteTable('thread_projections', {
  conversationId: text('conversation_id').primaryKey().references(() => conversations.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  cursor: integer('cursor').notNull(),
  state: text('state').notNull(),
})

/** Collections live in indexed rows so rebuilding and paging never retain the whole thread. */
export const threadProjectionRows = sqliteTable('thread_projection_rows', {
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  category: text('category').notNull(),
  position: integer('position').notNull(),
  entryKey: text('entry_key').notNull(),
  itemKind: text('item_kind').notNull(),
  related: text('related'),
  live: integer('live').notNull(),
  updatedSeq: integer('updated_seq').notNull(),
  bytes: integer('bytes').notNull(),
  payload: text('payload').notNull(),
}, (t) => [
  primaryKey({ columns: [t.conversationId, t.category, t.position] }),
  index('idx_thread_projection_key').on(t.conversationId, t.category, t.entryKey),
  index('idx_thread_projection_live').on(t.conversationId, t.live),
  index('idx_thread_projection_updated').on(t.conversationId, t.updatedSeq),
  index('idx_thread_projection_related').on(t.conversationId, t.related),
  index('idx_thread_projection_kind').on(t.conversationId, t.itemKind, t.position),
])

export type AntigravityAccountRow = typeof antigravityAccounts.$inferSelect
