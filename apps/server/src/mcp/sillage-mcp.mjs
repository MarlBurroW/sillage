/** Sillage MCP server exposes platform knowledge unavailable to CLIs. Each CLI conversation starts without knowledge of previous conversations, whereas Sillage retains their journals and project board; these tools expose that memory and state within the current project. Any session can edit project cards and relations without attachment; notes retain work history while descriptions hold current requirements. Content and relation edits go through the daemon to share interface validation. Inter-session messages are only deposited here: this process holds a database, no runners; the daemon delivers them by steering or waking recipients (`apps/server/src/sessions/session-relay.ts`). Keep this as `.mjs`, like probes, rather than compiled TypeScript: CLIs launch it directly, and excluding it from the server module graph prevents accidental imports from bundling half the app. Its only dependency is existing `better-sqlite3`. Reads use the database directly, read-only, avoiding HTTP tokens and ports; the environment carries scope, never secrets. This is convenience rather than a security boundary because agents already have shell and disk access. Conversation mode is project-scoped and acts as that session. Manual launches without `SILLAGE_MCP_PROJECT` are global (`docs/mcp.md`): tools accept `project`, `list_projects` lists projects, and writes use `SILLAGE_MCP_USER` rather than a session. Session-only messaging, watches and decisions are omitted. */
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'

const DB_PATH = process.env.SILLAGE_MCP_DB
/** Global mode: no fixed project; each call names its own (see header). */
const GLOBAL = !process.env.SILLAGE_MCP_PROJECT
/** Served project: fixed for conversation-mode processes, set from each tool call's `project` parameter in global mode. Serialize calls to prevent interference. */
let PROJECT_ID = process.env.SILLAGE_MCP_PROJECT ?? ''
// Keep the reference prefix aligned with packages/protocol/src/session-references.ts.
const sessionReference = (id) => `session:${id}`
/** Exclude from results so agents do not reread themselves and loop. */
const CURRENT_CONVERSATION = process.env.SILLAGE_MCP_CONVERSATION ?? ''
/** Project memory directory shared with Claude automatic memory. In global mode, `SILLAGE_MCP_MEMORY` identifies the memory root (default `memory/` beside the database, like the daemon), and each call selects its project's directory. */
let MEMORY_DIR = GLOBAL ? '' : (process.env.SILLAGE_MCP_MEMORY ?? '')
const MEMORY_TOOLS = new Set(['read_memory', 'write_memory', 'delete_memory'])
const MEMORY_ROOT = GLOBAL && DB_PATH ? process.env.SILLAGE_MCP_MEMORY || join(dirname(DB_PATH), 'memory') : ''
/** Global write identity: configured username or the database's sole account. */
const USER_NAME = process.env.SILLAGE_MCP_USER ?? ''
/** Global allowed project IDs, comma-separated; empty means everything visible to the account. API-token allowlist supplied by the HTTP bridge. */
const ALLOWED_PROJECTS = (process.env.SILLAGE_MCP_PROJECTS ?? '').split(',').map((id) => id.trim()).filter(Boolean)

/** Beyond this size, history displaces ongoing work from context. */
const MAX_THREAD_CHARS = 20000

/** Maximum budget share for one message. Use a quarter rather than a low fixed limit: verification sessions sometimes fit entirely in their final message, and tight caps truncated the sought conclusion. A quarter allows reports of thousands of characters without letting one message monopolize long conversations. */
const MAX_MESSAGE_CHARS = Math.floor(MAX_THREAD_CHARS / 4)

/** Default `list_sessions` window. Fifteen minutes answers the usual question of who is working now. Wider defaults encourage fetching everything; models seeking today's work can explicitly request twenty-four hours. */
const RECENT_MINUTES = 15

/** Default `find_file_edits` window. Wider than session discovery because uncommitted edits outlive their sessions and provenance is often sought after work stops. Still bounded: journals retain committed edits indefinitely, which no longer explain current tree state and could imply closed sessions are still writing. */
const EDIT_MINUTES = 120

/** Maximum session/file pairs returned; report truncation when reached. */
const EDIT_ROW_LIMIT = 40

/** Readable board column labels. Stored values (`todo`, `in_progress`) are identifiers, not language: raw values would force models to infer that `review` means awaiting human review rather than an agent actively reviewing. */
const COLUMN_LABELS = {
  todo: 'to do',
  in_progress: 'in progress',
  review: 'awaiting review',
  done: 'done',
  abandoned: 'abandoned',
}

/** Beyond this limit, boards cost more context than guidance. Report truncation. */
const CARD_LIMIT = 40

/** Full descriptions may span pages; board lists show previews only. */
const CARD_EXCERPT_CHARS = 160

/** Maximum inter-session message length. Messages enter recipients' context unsolicited during their own work: brief colleague notes rather than reports. Longer content belongs in files or `read_conversation`. */
const MAX_PEER_MESSAGE_CHARS = 4000

/** How long tools wait for daemon request processing. Session starts launch CLIs and sometimes worktrees, usually seconds but longer under load. After this timeout, report that processing continues rather than remain suspended. */
const REQUEST_WAIT_MS = {
  rename_session: 15000,
  start_session: 90000,
  create_card: 15000,
  update_card: 15000,
  link_cards: 15000,
  unlink_cards: 15000,
  list_models: 30000,
  schedule_task: 30000,
  register_action: 15000,
  remove_action: 20000,
  // Start a systemd unit, then wait to confirm it stays running.
  run_action: 30000,
  create_automation: 30000,
  request_decision: 15000,
  withdraw_decision: 15000,
  message_session: 20000,
  steer_session: 20000,
  interrupt_session: 20000,
  reply_session: 20000,
  // `git worktree add` checks out the whole tree, taking seconds for large repositories.
  create_worktree: 60000,
  // The first progress assessment launches several Git commands per tree.
  list_worktrees: 30000,
}

/** Maximum wait_for_session timeout, below the HTTP bridge's two-minute limit. */
const MAX_WAIT_SECONDS = 100
const WAIT_POLL_MS = 1000

/** Project action limits matching protocol `MAX_ACTION_LABEL_CHARS` and `MAX_ACTION_COMMAND_CHARS` (`packages/protocol/src/actions.ts`). The daemon revalidates; these only inform tool descriptions. */
const MAX_ACTION_LABEL_CHARS = 60
const MAX_ACTION_COMMAND_CHARS = 4000
const REQUEST_POLL_MS = 200

/** Must match `MAX_LAUNCH_PROMPT_CHARS` in `agent-requests.ts`. */
const MAX_LAUNCH_PROMPT_CHARS = 20000

/** Must match protocol `MAX_SESSION_TITLE_CHARS` in session-title.ts. */
const MAX_SESSION_TITLE_CHARS = 60

/** Scheduled task limits matching protocol `MAX_SCHEDULE_PROMPT_CHARS`, `DEFAULT_SCHEDULE_DURATION_MINUTES` and `MIN_AGENT_SCHEDULE_MINUTES` in `apps/server/src/sessions/agent-requests.ts`. The daemon revalidates; these only inform descriptions. */
const MAX_SCHEDULE_PROMPT_CHARS = 20000
const DEFAULT_SCHEDULE_DURATION_MINUTES = 30
const MIN_AGENT_SCHEDULE_MINUTES = 15
/** Pre-turn checks matching protocol `CHECK_SKIP_EXIT_CODE`, `MAX_CHECK_SCRIPT_CHARS` and `DEFAULT_CHECK_TIMEOUT_SECONDS`. */
const CHECK_SKIP_EXIT_CODE = 10
const MAX_CHECK_SCRIPT_CHARS = 20000
const DEFAULT_CHECK_TIMEOUT_SECONDS = 120

/** Most recent messages returned by read_session_messages. */
const PEER_HISTORY_LIMIT = 20

/** Relay safeguards informing senders immediately when messages will be held. Must match `apps/server/src/sessions/session-relay.ts`, the authoritative decision maker, which this standalone module cannot import. */
const MAX_HOPS = 6
const WAKES_PER_HOUR = 6

/** Project image size and classification must match protocol `MAX_PROJECT_IMAGE_BYTES` and `apps/server/src/projects/image.ts`, which this module cannot import. */
const MAX_PROJECT_IMAGE_BYTES = 1024 * 1024

function sniffProjectImage(buffer) {
  const head = buffer.subarray(0, 4).toString('latin1')
  if (head === '\x89PNG') return 'image/png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (head === 'GIF8') return 'image/gif'
  if (head === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (!buffer.includes(0) && /<svg[\s>]/i.test(buffer.subarray(0, 4096).toString('utf8'))) {
    return 'image/svg+xml'
  }
  return null
}

/** SILLAGE.md section limit matching protocol `MAX_INSTRUCTIONS_CHARS`. */
const MAX_INSTRUCTIONS_CHARS = 40000

/** Project memory constants must match protocol `memoryFileSchema`, `MEMORY_INDEX_FILE`, `MAX_MEMORY_FILE_CHARS` and `apps/server/src/memory/store.ts`. */
const MEMORY_INDEX = 'MEMORY.md'
const MEMORY_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.md$/
const MAX_MEMORY_FILE_CHARS = 100000

/** Must match protocol `REPO_INSTRUCTION_FILES`. */
const REPO_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md']

const log = (msg) => process.stderr.write(`[sillage-mcp] ${msg}\n`)
const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`)

if (!DB_PATH) {
  log('SILLAGE_MCP_DB is required')
  process.exit(1)
}

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })

/** Global account resolved at startup from the environment or the database's sole account, covering most instances. Without one, cards and sessions have no author; fail immediately rather than reject every write later. */
const USER = GLOBAL ? resolveUser() : null
function resolveUser() {
  const columns = 'id, username, display_name AS displayName, is_admin AS admin'
  if (USER_NAME) {
    const row = db.prepare(`SELECT ${columns} FROM users WHERE username = ?`).get(USER_NAME)
    if (!row) {
      log(`no account “${USER_NAME}” (SILLAGE_MCP_USER)`)
      process.exit(1)
    }
    return row
  }
  const rows = db.prepare(`SELECT ${columns} FROM users ORDER BY created_at LIMIT 2`).all()
  if (rows.length !== 1) {
    log(rows.length === 0 ? 'no account in the database' : 'multiple accounts: SILLAGE_MCP_USER must select one')
    process.exit(1)
  }
  return rows[0]
}

/** Write connection opened lazily and retained. Separate from the read-only connection: almost all tools observe and only one writes. Two handles expose this asymmetry and prevent faulty reads from mutating data. Set `busy_timeout` because the daemon continuously journals while agents work; without waiting, card notes fail on the first overlap. Match server connection settings in `packages/db`. */
let writable = null
function writeDb() {
  if (!writable) {
    writable = new Database(DB_PATH, { fileMustExist: true })
    writable.pragma('busy_timeout = 5000')
    writable.pragma('foreign_keys = ON')
  }
  return writable
}

const TOOLS = [
  {
    name: 'rename_session',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      "Give your own session a short, descriptive title for the sidebar. Do this once you understand the request: use 3 to 6 words in the user's language, naming the concrete topic (for example “Sidebar redesign”), without a preamble or progress report. Change it only if the main topic changes. A title manually chosen by the user takes priority: if Sillage preserves it, do not retry. Cannot rename another session.",
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', minLength: 1, maxLength: MAX_SESSION_TITLE_CHARS, description: `Single-line title, at most ${MAX_SESSION_TITLE_CHARS} characters.` } },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_history',
    description:
      "Search past Sillage conversations in this project across CLIs. Returns conversations with excerpts, not their full contents; use read_conversation to read one. Call before concluding that a topic is new, when a decision may already exist, a bug seems familiar, or the user refers to earlier work.",
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Words to search for. Full-text search over message bodies.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum conversations returned. Defaults to 10, at most 50.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_conversation',
    description:
      "Read a past conversation in this project using the `id` returned by search_history. Returns user and agent messages without tool calls. For a thread too long to fit, returns the initial request and the end, stating how many messages were omitted and how to read them.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Sillage identifier or session:<id> reference returned by search_history or list_sessions, including archived sessions.' },
        before: {
          type: 'integer',
          description:
            "Read earlier messages: returns the slice before this message number, as reported by a previous call. Omit to read the initial request and the end.",
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_sessions',
    description:
      "List conversations in this project that are working now or worked recently, with their worktree, branch and modified file count. Call before starting work to check whether another session is already handling it, and before manipulating the Git working tree: another conversation may have left it on its own branch.",
    inputSchema: {
      type: 'object',
      properties: {
        within_minutes: {
          type: 'integer',
          description:
            "Recent activity window in minutes. Defaults to 15. Use 1440 for the day's work. Currently working conversations are returned regardless of this window.",
        },
      },
    },
  },
  {
    name: 'find_file_edits',
    description:
      "Find which other session edited a file and what it is doing now. Call when you find changes you did not make, before reverting or working around them or abandoning your turn: they often come from a session working in the same tree, and the result says whether it is still active. Without `path`, returns files recently edited by other sessions in the same tree.",
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            "File path relative to the working directory. If no exact match exists, returns a same-named file elsewhere with its actual path. Omit to see all recently edited files.",
        },
        within_minutes: {
          type: 'integer',
          description:
            "Search window in minutes. Defaults to 120. Expand if unexplained changes exist but the result is empty: edits remain in the journal indefinitely, but yesterday's edits usually no longer explain the working tree.",
        },
      },
    },
  },
  {
    name: 'list_cards',
    description:
      "List this project's board: cards representing work to do, in progress, awaiting review or done. A card survives the conversations working on it and can have several. Call before starting a new topic to check for an existing card, and when the user cites a card number (`#12`). Returns a summary per card; use read_card for full descriptions.",
    inputSchema: {
      type: 'object',
      properties: {
        column: {
          type: 'string',
          enum: ['todo', 'in_progress', 'review', 'done', 'abandoned'],
          description:
            "Return only this column. Omit for the whole board, including done and abandoned cards.",
        },
      },
    },
  },
  {
    name: 'read_card',
    description:
      "Read a project card in full: description, attachments with local paths, column, sessions that worked on it and referring cards. Call before starting work on an assigned or cited card: its description states expectations, and previous sessions show what has been tried. Use move_card to change its column.",
    inputSchema: {
      type: 'object',
      properties: {
        number: {
          type: 'integer',
          description: "Card number, as written after `#`.",
        },
      },
      required: ['number'],
    },
  },
  {
    name: 'add_card_note',
    description:
      "Add a note to any card in this project; attachment to the card is not required. Leave later sessions information they cannot rediscover: work completed and current state, failed attempts and why, decisions or constraints found in the code. Call when finishing work and before a long interruption. Do not duplicate repository content or `git log`: useful notes save time at the next session's start. Notes are appended, not deleted; use update_card to change the title or description.",
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'integer', description: 'Project card number. Omit for this conversation\'s card.' },
        body: {
          type: 'string',
          description:
            "Note in Markdown. A few sentences or a short list, not a report: later sessions read it in full at startup.",
        },
        github: {
          type: 'boolean',
          description:
            "For a card tracking a GitHub issue (shown by read_card), also publish the note as an issue comment, visible to everyone if the repository is public. Sillage adds your invisible session marker and the board signature if configured. Notes stay local by default.",
        },
      },
      required: ['body'],
    },
  },
  {
    name: 'move_card',
    description:
      "Change the column of any project card; attachment is not required. Move cards affected by your work to review when ready for a person to check. Set done or abandoned only when the user asks: they decide when work is closed. The move is recorded in card activity. For cards tracking a GitHub issue, Sillage synchronizes the column through labels, closing or reopening.",
    inputSchema: {
      type: 'object',
      properties: {
        number: {
          type: 'integer',
          description: "Card number as written after `#`. Omit for this conversation's card.",
        },
        column: {
          type: 'string',
          enum: ['todo', 'in_progress', 'review', 'done', 'abandoned'],
          description: 'Destination column: todo, in_progress, review (awaiting human review), done, abandoned.',
        },
        reason: {
          type: 'string',
          description: "Optional one-sentence reason, added to the activity entry.",
        },
      },
      required: ['column'],
    },
  },
  ...['link_cards', 'unlink_cards'].map((name) => ({
    name,
    description: `${name === 'link_cards' ? 'Add' : 'Remove'} an explicit relation between two project cards; attachment is not required. Direction runs from number to target: blocks, blocked_by, related, duplicates, duplicated_by, parent (contains target as a sub-ticket), child (is a sub-ticket of target), replaces, replaced_by. The inverse link appears automatically. Relations stay local to Sillage, without column changes or GitHub synchronization. Read cards before changing their relations.`,
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'integer', description: 'Source card number in this project.' },
        target: { type: 'integer', description: 'Target card number in the same project.' },
        // Must match cardRelationKindSchema in @sillage/protocol.
        kind: { type: 'string', enum: ['blocks', 'blocked_by', 'related', 'duplicates', 'duplicated_by', 'parent', 'child', 'replaces', 'replaced_by'] },
      },
      required: ['number', 'target', 'kind'],
    },
  })),
  {
    name: 'update_card',
    description:
      "Edit the title or description of any card in this project; attachment is not required. Read the card first to preserve useful information. The supplied description replaces the full text; an empty string clears it. Changes to GitHub-linked cards are also synchronized to the issue. Use add_card_note for notes and move_card to change columns.",
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'integer', description: 'Card number in this project.' },
        title: { type: 'string', description: 'New nonempty title (at most 200 characters).' },
        description: { type: 'string', description: 'New full description in Markdown (at most 20,000 characters).' },
      },
      required: ['number'],
    },
  },
  {
    name: 'create_card',
    description:
      "Create a card in this project's todo column to retain work outside this conversation's scope: a bug, technical debt or a follow-up mentioned by the user. This is the default for discoveries you make yourself; start a session with start_session only when the user asks. Call list_cards first to avoid duplicates. Use update_card to extend an existing card and move_card to change columns.",
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short ticket-style title: what needs doing, not what was observed.',
        },
        description: {
          type: 'string',
          description:
            "Markdown description understandable without this thread: symptoms, relevant files and lines, reproduction steps and a possible fix. Use `#12` to cite another card.",
        },
        github: {
          type: 'boolean',
          description:
            "Only for boards linked to GitHub (reported by list_cards): true publishes an issue, visible to everyone if the repository is public; false keeps the card local. If omitted, the board setting applies, as shown by list_cards. Force true only at the user's request; write public issues for outsiders, without internal details.",
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'request_decision',
    description:
      "Request a user decision without waiting for the answer. Only for autonomous sessions (scheduled tasks, automations, board maintenance) whose source allows it. Use when instructed to ask or when a choice exceeds your instructions; otherwise decide yourself. The request appears in Decisions and notifies the user. Then end your turn or continue independent work; the reply arrives as a message. Only one pending request at a time.",
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Short, self-contained question (at most 300 characters).' },
        context: {
          type: 'string',
          description: "Context needed to decide, in Markdown: findings, links (PR, issue, files), and consequences of each choice.",
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: '2 to 6 short suggested answers. A free-text answer is always available.',
        },
        default: { type: 'string', description: "Choice applied if nobody answers in time; must exactly match one of `options`." },
        expires_in_hours: {
          type: 'number',
          description: "Response deadline in hours, bounded by the source's maximum, which applies when omitted.",
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'withdraw_decision',
    description:
      "Withdraw your pending decision request when it no longer applies, for example because the situation changed or you found the answer elsewhere.",
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'One-sentence reason shown to the user in history.' } },
    },
  },
  {
    name: 'update_issue',
    description:
      "Close or reopen the GitHub issue tracked by a project card; attachment is not required. Closing as completed moves the card to done, not_planned to abandoned, and reopening to todo. Sillage applies the change on GitHub within seconds. Refused for local cards.",
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'integer', description: 'Project card number. Omit for this conversation\'s card.' },
        state: { type: 'string', enum: ['closed', 'open'], description: 'closed to close, open to reopen.' },
        reason: {
          type: 'string',
          enum: ['completed', 'not_planned'],
          description: 'When closing: completed (default) or not_planned.',
        },
      },
      required: ['state'],
    },
  },
  {
    name: 'list_actions',
    description:
      "List project actions: buttons in Sillage's Actions panel that run a command (development server, tests, seed). Returns each action's ID, kind, command and user approval status. Call before register_action to update an existing button instead of creating a duplicate.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'register_action',
    description:
      `Create or update a project action: a button the user runs from Sillage in the worktree of the conversation where they click. Use at their request, or when setting up a command they will reuse: development server, tests, debug script or database seed. Not for one-off commands. Two kinds: \`service\` runs continuously in a sillage-app-* systemd unit, visible on Services and surviving this session; \`task\` finishes in a panel terminal with an exit code. Nothing is written to the repository. New actions, or changes to their command, kind or directory, require user approval before their first one-click launch. Supply \`id\` to update an existing action; only supplied fields change.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: "ID of an existing action to update (see list_actions). Omit to create one." },
        label: { type: 'string', description: `Short button label (at most ${MAX_ACTION_LABEL_CHARS} characters), such as “Dev server” or “E2E tests”.` },
        kind: { type: 'string', enum: ['task', 'service'], description: '`service` runs continuously; `task` finishes.' },
        command: {
          type: 'string',
          description: `Shell command (at most ${MAX_ACTION_COMMAND_CHARS} characters), run by \`$SHELL -lc\`. It must work from any project worktree: no absolute path to the current one. Servers must listen on 127.0.0.1.`,
        },
        description: { type: 'string', description: 'One sentence explaining the button, shown below its label.' },
        subdir: { type: 'string', description: 'Relative subdirectory to run in (e.g. `apps/web`). Omit for the worktree root.' },
        url: {
          type: 'string',
          description:
            "For a `service`: URL displayed as a link while running. `{port}` is replaced by its listening port (e.g. `http://my-host:{port}`). It must be reachable from the user's browser: do not use localhost when Sillage runs on another machine; use the address in your instructions if provided.",
        },
      },
    },
  },
  {
    name: 'remove_action',
    description: "Delete a project action and stop its service if running. Only at the user's request, or for a button you created that is no longer needed.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: "Action ID (see list_actions)." } },
      required: ['id'],
    },
  },
  {
    name: 'run_action',
    description:
      "Run a project action in this conversation's worktree, as a user click would. A `service` starts its systemd unit; the result reports whether it stayed up, its ports and how to read logs. A `task` opens in a panel terminal visible to the user, but you cannot read its output: run the command in your shell if you need the result yourself. An already running action is not duplicated.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: "Action ID (see list_actions)." } },
      required: ['id'],
    },
  },
  {
    name: 'create_automation',
    description:
      "Create a webhook-triggered automation in this project: each matching call opens a new session visible to the user. Use when requested, for example to handle labeled issues or failed CI. Returns the URL and signing secret to configure at the caller, using `gh api repos/OWNER/REPO/hooks` for GitHub. Templates prefill conditions, subject and prompt: `github_issue_label` (label `sillage`), `github_comment_command` (comment starting with `/sillage`), `github_pr_opened` (PR review), `github_ci_failed` (failed workflow), `gitlab_generic`. Reference call data with `{{payload.…}}` and `{{headers.…}}`. Launch-chain limits match start_session; include the session marker from your instructions in forge publications. The user adjusts conditions, scripts and safeguards in Automations.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "Short automation name." },
        template: {
          type: 'string',
          enum: ['github_issue_label', 'github_comment_command', 'github_pr_opened', 'github_ci_failed', 'gitlab_generic'],
          description: 'Starting template. Omit for a generic webhook and provide `prompt` and `conditions`.',
        },
        prompt: { type: 'string', description: "Instructions for each session, with `{{payload.path}}` placeholders. Optional with a template, which provides a prompt." },
        conditions: {
          type: 'array',
          description: "Replace template conditions. Each rule: `path` (e.g. `headers.x-github-event`, `payload.action`, `payload.issue.labels.*.name`), `op` (equals, not_equals, contains, not_contains, in, matches, exists, missing), `value`.",
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, op: { type: 'string' }, value: { type: 'string' } },
            required: ['path', 'op'],
          },
        },
        match: { type: 'string', enum: ['all', 'any'], description: 'Match all conditions (default) or at least one.' },
        subject_path: { type: 'string', description: 'Subject path (e.g. `payload.issue.number`): pending calls with the same subject merge.' },
        verification: { type: 'string', enum: ['github', 'gitlab', 'none'], description: 'Override template verification.' },
        agent: { type: 'string', description: 'Session CLI: claude, codex, opencode, grok or antigravity. Defaults to yours.' },
        model: { type: 'string', description: 'Session model (see list_models).' },
        effort: { type: 'string', description: 'Session effort level.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'start_session',
    description:
      "Start a new Sillage conversation in this project, visible and resumable by the user. Use when the user asks to delegate work to another session, such as a Codex session at maximum effort, or to handle a board card separately. For unsolicited discoveries, use create_card instead. For subtasks supporting your own task, use your subagents instead. The new session has no context from this thread: `prompt` must stand alone. It starts with project defaults for that CLI, including permissions, plus model and effort if supplied. Returns its ID; use notify_when_done if you need to resume when it finishes.",
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: `Self-contained mission in Markdown, at most ${MAX_LAUNCH_PROMPT_CHARS} characters: context, relevant files, expectations, verification and what must remain untouched. Do not refer to “what we discussed”: the session cannot see this thread.`,
        },
        title: {
          type: 'string',
          description: 'Conversation title in Sillage. Omit to derive it from the mission.',
        },
        agent: {
          type: 'string',
          enum: ['claude', 'codex', 'opencode', 'grok', 'antigravity'],
          description: 'Session CLI. Omit to use yours.',
        },
        model: {
          type: 'string',
          description:
            "Model value or display name as named by the user (“opus”, “Astra”). Omit for the project default. Use list_models for available models.",
        },
        effort: {
          type: 'string',
          description:
            "Effort level (`low`, `medium`, `high`, etc., depending on the model). `max` uses that level if available, otherwise the highest supported level. Omit for the project default.",
        },
        worktree: {
          type: 'string',
          description:
            "Working location. Omit for your current tree; `@root` for the project root; otherwise an existing worktree name or a branch to create as a worktree from HEAD (e.g. `fix/truncated-title`). Prefer a separate worktree for unrelated work to avoid mixing changes.",
        },
        card: {
          type: 'integer',
          description: 'Card number to handle. The session is attached to it; todo cards move to in_progress.',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'create_worktree',
    description:
      "Create a Git worktree through Sillage and attach your session to it. The user sees its branch and state in the sidebar and can clean it up after merging from Worktrees. Use this to work separately from the main tree; do not run `git worktree add` yourself, as Sillage would not track the tree or your work in it. Your working directory does not change: use the absolute paths returned. Call list_worktrees first to reuse an existing tree. To delegate work to a new session in a separate tree, prefer start_session with `worktree`.",
    inputSchema: {
      type: 'object',
      properties: {
        branch: {
          type: 'string',
          description:
            "Branch name, also used for the worktree: letters, digits, . _ - /, e.g. `fix/truncated-title`. Existing branches are reused as-is; an existing Sillage worktree with this name is returned without recreation.",
        },
        base: {
          type: 'string',
          description: "Starting point for a new branch. Omit for the project's default branch (origin/HEAD, otherwise main).",
        },
      },
      required: ['branch'],
    },
  },
  {
    name: 'list_worktrees',
    description:
      "List project worktrees, including those created outside Sillage, with their state relative to the default branch (uncommitted, awaiting merge, merged, missing) and sessions working in them. Use before create_worktree to reuse a tree and check whether work is already merged.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'schedule_task',
    description:
      "Create a scheduled project task: Sillage replays `prompt` at the requested cadence in a fresh session, even with no open sessions and after restarts. This durable scheduler works across CLIs; session-specific loops (`/loop`, `CronCreate`) die with their session. Use only when the user requests recurring or deferred work: each run consumes quota. Runs are unattended, at the project root, with project default permissions for the CLI. They appear under the task rather than in the session list; the user manages them in Scheduling. Supply exactly one of `every_minutes`, `cron` and `at`.",
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Short task name shown in the sidebar, such as “CLI watch” or “Dependency audit”.',
        },
        prompt: {
          type: 'string',
          description: `Instructions replayed at each run, in Markdown, at most ${MAX_SCHEDULE_PROMPT_CHARS} characters. Must stand alone: what to check, where, how to handle findings (card, report), and what to leave untouched. Sillage adds the run date and the previous run's date, link and final answer; use \`{{date}}\`, \`{{previous_run_date}}\`, \`{{previous_run_url}}\` and \`{{previous_run_summary}}\` to place them.`,
        },
        every_minutes: {
          type: 'integer',
          description: `Interval in minutes, at least ${MIN_AGENT_SCHEDULE_MINUTES}. The first run starts one interval after creation.`,
        },
        cron: {
          type: 'string',
          description:
            "Five-field cron pattern (minute hour day month weekday), in server time: `0 9 * * 1` for Mondays at 09:00.",
        },
        at: {
          type: 'string',
          description: 'Date and time for a single run, ISO 8601 with timezone: `2026-10-12T09:00:00+02:00`.',
        },
        agent: {
          type: 'string',
          enum: ['claude', 'codex', 'opencode', 'grok', 'antigravity'],
          description: 'CLI for runs. Omit to use yours.',
        },
        model: {
          type: 'string',
          description: 'Model value or display name. Omit for the project default. Use list_models for available models.',
        },
        effort: {
          type: 'string',
          description: 'Effort level, as in start_session. Omit for the project default.',
        },
        max_duration_minutes: {
          type: 'integer',
          description: `Maximum run duration in minutes before interruption. Defaults to ${DEFAULT_SCHEDULE_DURATION_MINUTES}.`,
        },
        overlap: {
          type: 'string',
          enum: ['skip', 'wait'],
          description:
            'If the previous run is still active: `skip` skips this run (default); `wait` starts it once the previous run finishes.',
        },
        check_script: {
          type: 'string',
          description: `Check script run by Sillage before each turn, waking the LLM only when work is needed (new release, changed file, failing test). Shell by default, or any language with a shebang; at most ${MAX_CHECK_SCRIPT_CHARS} characters. Runs at the project root. Exit 0 starts the turn; ${CHECK_SKIP_EXIT_CODE} skips it without a session (first stdout line gives the reason); any other code fails without starting a session. Stdout is passed to the turn (place it with \`{{check_output}}\`). Variables: SILLAGE_STATE_DIR (persistent across runs for comparisons), SILLAGE_FIRED_AT, SILLAGE_TRIGGER, SILLAGE_PREVIOUS_RUN_AT, SILLAGE_PROJECT_DIR. The script runs only after user approval: tell them.`,
        },
        check_timeout_seconds: {
          type: 'integer',
          description: `Check script timeout in seconds. Defaults to ${DEFAULT_CHECK_TIMEOUT_SECONDS}.`,
        },
      },
      required: ['name', 'prompt'],
    },
  },
  {
    name: 'list_models',
    description:
      "List models offered by each CLI, their effort levels, and defaults for sessions in this project. Call when the user names a model for start_session and you are unsure of its value.",
    inputSchema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          enum: ['claude', 'codex', 'opencode', 'grok', 'antigravity'],
          description: 'Return only this CLI. Omit for all.',
        },
      },
    },
  },
  {
    name: 'set_project_image',
    description:
      "Set or replace the project image used for recognition in Sillage navigation. It appears in a small square: prefer a text-free icon or logo to a banner. First use an existing repository logo or icon; otherwise draw a simple SVG or generate an image with an available tool, setting `provisional: true` in either case. Also call when the project gains or changes its real logo.",
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            "Absolute image path: PNG, JPEG, GIF, WebP or SVG, preferably square, at most 1 MiB. The file is copied and may then be deleted.",
        },
        provisional: {
          type: 'boolean',
          description:
            "True for a temporary image drawn or generated because the project lacks a logo: later sessions are reminded to replace it when a real logo exists. False by default for the project's real logo.",
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'send_session_message',
    description:
      "Send a message to another project conversation using an `id` from list_sessions or find_file_edits. Sillage delivers it within seconds, during its turn if working or by resuming it otherwise. Any reply arrives the same way. Use when coordination cannot wait for the user: warn before editing shared files, request release of a tree or branch, announce a dependency is ready, or ask about a decision. Not for chat or reports: each message costs the recipient a turn. If you need a reply to continue, end your turn after sending; the reply resumes you. Do not poll.",
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient conversation ID from list_sessions.',
        },
        body: {
          type: 'string',
          description: `Self-contained message in Markdown, at most ${MAX_PEER_MESSAGE_CHARS} characters. The recipient cannot see your thread or the user's request to you.`,
        },
        reply_to: {
          type: 'string',
          description:
            "ID of the message you are replying to, if applicable, included in the received message. Allows Sillage to bound looping exchanges.",
        },
      },
      required: ['to', 'body'],
    },
  },
  {
    name: 'broadcast_session_message',
    description:
      "Broadcast to all other currently working conversations in this project only; idle sessions are not resumed. Use for actions affecting everyone: restarting Sillage or a shared development server, changing branches or rebasing a shared tree, or regenerating files others read. Recipients do not reply. Use send_session_message for a question to a specific session.",
    inputSchema: {
      type: 'object',
      properties: {
        body: {
          type: 'string',
          description: `Announcement, at most ${MAX_PEER_MESSAGE_CHARS} characters: what you will do, when, and what others should avoid until then.`,
        },
      },
      required: ['body'],
    },
  },
  {
    name: 'notify_when_done',
    description:
      "Request notification when another project conversation finishes working: no active turn, background work or loop. Sillage resumes you with its state and last message. Use when you depend on its work or it occupies a file or tree you need. Then end your turn instead of polling list_sessions. The watch expires after 24 hours.",
    inputSchema: {
      type: 'object',
      properties: {
        session: {
          type: 'string',
          description: 'Conversation ID to watch, from list_sessions.',
        },
      },
      required: ['session'],
    },
  },
  {
    name: 'read_session_messages',
    description:
      "Read messages exchanged with other project sessions, sent and received, with delivery status. Incoming messages arrive automatically; use this to recover them after compaction, check delivery, or read messages held without waking the session.",
    inputSchema: {
      type: 'object',
      properties: {
        with: {
          type: 'string',
          description: 'Return exchanges with this conversation only. Omit for all.',
        },
      },
    },
  },
  {
    name: 'read_instructions',
    description:
      "Read SILLAGE.md, the project or global user instructions injected into each session across CLIs. Your prompt contains the version from session startup; read the current version before editing.",
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          description:
            "`project` (default) for this project; `global` for all projects. Global writes require an administrator account.",
        },
      },
    },
  },
  {
    name: 'edit_instructions',
    description:
      "Edit SILLAGE.md like a file: replace an exact passage. `old_text` must occur once unless `replace_all` is set. Read with read_instructions first. Use to add, correct or remove instructions at the user's request, or retain durable instructions they give. Do not store task-specific details. Applies to sessions starting afterward.",
    inputSchema: {
      type: 'object',
      properties: {
        old_text: {
          type: 'string',
          description: 'Exact passage to replace, including newlines. Empty to append `new_text`.',
        },
        new_text: { type: 'string', description: 'Replacement text. Empty to delete the passage.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence. Defaults to false.' },
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          description:
            "`project` (default) for this project; `global` for all projects. Global writes require an administrator account.",
        },
      },
      required: ['old_text', 'new_text'],
    },
  },
  {
    name: 'write_instructions',
    description:
      "Rewrite an entire SILLAGE.md section: supplied content replaces everything in it. Prefer edit_instructions for small changes. Read with read_instructions first to preserve existing information.",
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Full new content in Markdown. Empty to clear it.' },
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          description:
            "`project` (default) for this project; `global` for all projects. Global writes require an administrator account.",
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'read_memory',
    description:
      "Read project memory left by previous sessions across CLIs. Without `file`, returns the `MEMORY.md` index and note list; with `file`, the full note. Notes can become outdated: verify them before relying on them.",
    inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Note to read. Omit for the index.' } } },
  },
  {
    name: 'write_memory',
    description:
      "Write a project memory note, replacing existing content like a file. Retain useful information the repository does not provide: user preferences, decisions and reasons, pitfalls or external resources. Begin with `---` frontmatter containing `name`, one-line `description` for relevance, and `type` (`user`, `feedback`, `project` or `reference`), followed by the information. New notes are automatically added to `MEMORY.md`, which can also be edited directly. Update an existing note rather than duplicating a topic. Rules the user sets for all agents belong in SILLAGE.md instead.",
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Flat `.md` filename: `MEMORY.md` for the index, otherwise a short kebab-case name (`dev-server-port.md`).',
        },
        content: { type: 'string', description: 'Full note content in Markdown.' },
      },
      required: ['file', 'content'],
    },
  },
  {
    name: 'delete_memory',
    description:
      "Remove a project memory note and its index entry when it becomes false or irrelevant.",
    inputSchema: { type: 'object', properties: { file: {
          type: 'string',
          description: 'Flat `.md` filename: `MEMORY.md` for the index, otherwise a short kebab-case name (`dev-server-port.md`).',
        }, }, required: ['file'] },
  },
  {
    name: 'count_active_sessions',
    description:
      "Count working conversations across the entire instance, not just this project. Use to assess whether restarting Sillage is safe: restarting kills all running CLI processes, including this conversation's. Returns counts only, without titles, projects or content.",
    inputSchema: { type: 'object', properties: {} },
  },
]

/** Global-only tools acting on existing sessions. Sillage sessions use send_session_message and daemon delivery instead. External clients act like interface users: inspect progress, send messages, answer requests, interrupt and wait. */
const SESSION_PARAM = { type: 'string', description: 'Session ID returned by list_sessions or start_session.' }
const GLOBAL_ONLY_TOOLS = [
  {
    name: 'read_session',
    description:
      "Read session progress: state, current activity, last message and any pending request (question, permission, plan, input), with the information needed for reply_session. Call after start_session or message_session, and before replying to a session listed as awaiting input.",
    inputSchema: { type: 'object', properties: { session: SESSION_PARAM }, required: ['session'] },
  },
  {
    name: 'wait_for_session',
    description:
      "Wait until a session finishes its turn or pauses for a question, then return its state as read_session does. Blocks up to `timeout_seconds`; on timeout, returns current state while the session continues. Use after start_session or message_session to avoid polling.",
    inputSchema: {
      type: 'object',
      properties: {
        session: SESSION_PARAM,
        timeout_seconds: { type: 'integer', description: `Maximum wait in seconds. Defaults to 60, at most ${MAX_WAIT_SECONDS}.` },
      },
      required: ['session'],
    },
  },
  {
    name: 'message_session',
    description:
      "Send a message to an existing session as if typed by the user in Sillage. An idle session resumes with its context; a working session receives it after its turn. Prefer start_session for a new mission and steer_session for mid-turn corrections.",
    inputSchema: {
      type: 'object',
      properties: { session: SESSION_PARAM, body: { type: 'string', description: 'Message in Markdown.' } },
      required: ['session', 'body'],
    },
  },
  {
    name: 'steer_session',
    description:
      "Steer a session's current turn: the CLI reads the message immediately during work. If no turn is active or the CLI does not support steering, sends an ordinary message instead.",
    inputSchema: {
      type: 'object',
      properties: { session: SESSION_PARAM, body: { type: 'string', description: 'Short correction: what to change or stop doing.' } },
      required: ['session', 'body'],
    },
  },
  {
    name: 'interrupt_session',
    description:
      "Interrupt a session's current turn. Context is retained; message_session resumes it. Use when a session heads in the wrong direction and steering would not suffice.",
    inputSchema: { type: 'object', properties: { session: SESSION_PARAM }, required: ['session'] },
  },
  {
    name: 'reply_session',
    description:
      "Answer a session's pending request as described by read_session. Fields depend on the request: permission takes `decision` (allowed or denied) and `scope` (once, session, always); question takes `answers`, an object { question ID: [answers] }, or `status: cancelled`; plan takes `decision` (approved or rejected) and optional `followUpMode`; input takes `action` (accept, decline, cancel) and `content`. Without `request_id`, answers the pending request if exactly one exists.",
    inputSchema: {
      type: 'object',
      properties: {
        session: SESSION_PARAM,
        request_id: { type: 'string', description: 'Request ID returned by read_session.' },
        decision: { type: 'string', description: 'Permission: allowed or denied. Plan: approved or rejected.' },
        scope: { type: 'string', enum: ['once', 'session', 'always'], description: 'Permission scope, once by default.' },
        answers: { type: 'object', description: 'Question: { "<id>": ["answer"] }, multiple answers if allowed.' },
        status: { type: 'string', enum: ['answered', 'cancelled'], description: 'Question: cancelled to decline answering.' },
        followUpMode: { type: 'string', description: 'Accepted plan: follow-up identifier offered by read_session.' },
        action: { type: 'string', enum: ['accept', 'decline', 'cancel'], description: 'MCP input: accept with `content`, or decline.' },
        content: { type: 'object', description: 'MCP input: requested values.' },
      },
      required: ['session'],
    },
  },
]

/** Global tool list replacing project-scoped tools. Add `list_projects` and `project` parameters, required except where calls make sense without projects (instance-wide account or global SILLAGE.md). Omit inter-session tools because external clients have neither a sender identity nor a turn receiving messages. */
const LIST_PROJECTS = {
  name: 'list_projects',
  description:
    "List projects on this Sillage instance, their directories, working sessions and latest activity. Other tools accept `project`: a name or ID returned here. Call first when you do not know a project's Sillage name.",
  inputSchema: { type: 'object', properties: {} },
}

const SESSION_ONLY_TOOLS = new Set([
  'rename_session',
  'send_session_message',
  'broadcast_session_message',
  'notify_when_done',
  'read_session_messages',
  'request_decision',
  'withdraw_decision',
])

/** Tools permitting some calls without projects. */
const PROJECT_OPTIONAL_TOOLS = new Set(['count_active_sessions', 'read_instructions', 'edit_instructions', 'write_instructions'])

const PROJECT_PARAM = {
  type: 'string',
  description: 'Target project name or ID from list_projects.',
}

/** `card` replaces the current conversation's card, unavailable to external clients. */
const CARD_PARAM = { type: 'integer', description: 'Target card number from list_cards.' }

function globalTools() {
  return [
    LIST_PROJECTS,
    ...[...TOOLS.filter((tool) => !SESSION_ONLY_TOOLS.has(tool.name)), ...GLOBAL_ONLY_TOOLS].map((tool) => {
      const byCard = tool.name === 'add_card_note' || tool.name === 'update_issue'
      const optional = PROJECT_OPTIONAL_TOOLS.has(tool.name)
      const required = [...(optional ? [] : ['project']), ...(byCard ? ['card'] : []), ...(tool.inputSchema.required ?? [])]
      const properties = Object.fromEntries(
        Object.entries(tool.inputSchema.properties ?? {}).map(([key, value]) =>
          // Outside sessions, 'yours' identifies no CLI: the daemon selects Claude.
          key === 'agent' && typeof value.description === 'string'
            ? [key, { ...value, description: value.description.replace('Omit to use yours.', 'Omit to use Claude.').replace('Defaults to yours.', 'Defaults to Claude.') }]
            : [key, value],
        ),
      )
      return {
        ...tool,
        description: byCard ? `${tool.description} Outside a session, select the card with the required card parameter.` : tool.description,
        inputSchema: {
          ...tool.inputSchema,
          properties: {
            project: optional ? { ...PROJECT_PARAM, description: `${PROJECT_PARAM.description} Omit for ${tool.name === 'count_active_sessions' ? 'the whole instance' : 'global scope only'}.` } : PROJECT_PARAM,
            ...(byCard ? { card: CARD_PARAM } : {}),
            ...properties,
          },
          ...(required.length > 0 ? { required } : {}),
        },
      }
    }),
  ]
}

/** Global call project set in `PROJECT_ID` and `MEMORY_DIR`, or rejection returned unchanged. Resolve by ID, exact name, then unique approximate name; guessing between two would write to the wrong project. */
function selectProject(name, args) {
  if (name === 'list_projects') return null
  const wanted = typeof args?.project === 'string' ? args.project.trim() : ''
  if (!wanted) {
    if (name === 'count_active_sessions' || (PROJECT_OPTIONAL_TOOLS.has(name) && args?.scope === 'global')) {
      PROJECT_ID = ''
      MEMORY_DIR = ''
      return null
    }
    return { ...text('The `project` parameter is required: a project name or ID from list_projects.'), isError: true }
  }
  const rows = visibleProjects()
  const lower = wanted.toLowerCase()
  let found = rows.filter((row) => row.id === wanted)
  if (found.length === 0) found = rows.filter((row) => row.name.toLowerCase() === lower)
  if (found.length === 0) found = rows.filter((row) => row.name.toLowerCase().includes(lower))
  if (found.length !== 1) {
    return {
      ...text(
        found.length === 0
          ? `No project “${wanted}”. Use list_projects for names and IDs.`
          : `Multiple projects match “${wanted}”: ${found.map((row) => `${row.name} (${row.id})`).join(', ')}. Be more specific.`,
      ),
      isError: true,
    }
  }
  PROJECT_ID = found[0].id
  MEMORY_DIR = join(MEMORY_ROOT, 'projects', PROJECT_ID)
  return null
}

/** Global projects visible in the account's interface (owned and shared), further restricted by optional allowlists. Combine both filters like API tokens: borrowing identities never expands them. */
function visibleProjects() {
  return db
    .prepare(
      `SELECT id, name FROM projects
       WHERE archived_at IS NULL AND (owner_id = ? OR visibility = 'shared')
       ORDER BY position, name`,
    )
    .all(USER.id)
    .filter((row) => ALLOWED_PROJECTS.length === 0 || ALLOWED_PROJECTS.includes(row.id))
}

function listProjects() {
  const visible = new Set(visibleProjects().map((row) => row.id))
  return db
    .prepare(
      `SELECT p.id AS id, p.name AS name, p.workspace_path AS path,
              sum(CASE WHEN ${WORKING} THEN 1 ELSE 0 END) AS working,
              max(c.updated_at) AS lastActivity
       FROM projects AS p
       LEFT JOIN conversations AS c ON c.project_id = p.id AND c.archived_at IS NULL
       GROUP BY p.id
       ORDER BY p.position, p.name`,
    )
    .all()
    .filter((row) => visible.has(row.id))
}

function renderProjects(rows) {
  if (rows.length === 0) return 'No projects in this instance.'
  return [
    `${rows.length} project(s):`,
    ...rows.map(
      (row) =>
        `- ${row.name} (id ${row.id}) — ${row.path}${row.working ? ` — ${row.working} working session(s)` : ''}${row.lastActivity ? ` — latest activity ${ago(row.lastActivity)}` : ' — no conversations'}`,
    ),
  ].join('\n')
}

/** Converts free text to FTS5 queries. Quote every term to neutralize engine syntax: `-` or `\"` inside sentences must not fail queries. Unlike interface search, omit final-term prefixes because complete queries arrive without ongoing typing. Must match `apps/server/src/search/search-messages.ts`. */
function toMatchQuery(input) {
  return input
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(' ')
}

/** Project conversations with matching messages. Retain only each conversation's highest-ranked message because agents seek conversations to open, not isolated messages; overfetch SQL results then trim. Read server-maintained `search_messages` (`apps/server/src/search/search-index.ts`), a derived index rather than authority, repairable with `pnpm search:reindex`. */
function searchHistory(query, limit) {
  const match = toMatchQuery(query)
  if (!match) return []

  const rows = db
    .prepare(
      `SELECT m.conversation_id AS id,
              c.title AS title,
              c.agent AS agent,
              c.archived_at AS archivedAt,
              m.ts AS ts,
              snippet(search_messages, 0, '', '', '...', 15) AS excerpt
       FROM search_messages AS m
       JOIN conversations AS c ON c.id = m.conversation_id
       WHERE search_messages MATCH ?
         AND c.project_id = ?
         AND c.id != ?
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

/** Conversation messages excluding tools. Match search extraction: same text blocks and exclusion of subagent messages belonging to side panels. Check `project_id` here as well as during search because agents can fabricate IDs. */
function readConversation(id) {
  id = id.replace(/^session:/i, '')
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

/** Conversations work while turns run or detached work continues afterward. Read counters from conversation rows rather than derive them from journals: `idle` means turn completion, not work completion, and replaying every listed journal would be expensive. Daemon startup zeroes counters so nonzero values describe live processes. */
const WORKING = `(c.status = 'running' OR c.background_count > 0 OR c.loop_count > 0)`

/** Working and recently seen project conversations. Include working conversations regardless of window: sessions started three hours ago but still running are precisely what must not be missed. The window limits only others. */
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
              w.name AS worktree,
              coalesce(w.path, p.workspace_path) AS path
       FROM conversations AS c
       JOIN projects AS p ON p.id = c.project_id
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

/** Worktree branch and modified-file count, or null if git fails. Read disk at call time: journals cannot reliably describe current trees when sessions change branches beneath others. One call per distinct tree rather than session, so ten root sessions share one `git status`. */
function gitState(path, cache) {
  if (cache.has(path)) return cache.get(path)
  let state = null
  try {
    const out = execFileSync('git', ['-C', path, 'status', '--porcelain=v1', '--branch'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const [head = '', ...files] = out.split('\n').filter(Boolean)
    const branch = head.startsWith('## HEAD (no branch)')
      ? 'detached HEAD'
      : head.replace(/^## (No commits yet on )?/, '').split('...')[0].split(' ')[0]
    state = { branch, dirty: files.length }
  } catch {
    // Nonrepository, missing directory, or absent Git: information is simply unavailable.
  }
  cache.set(path, state)
  return state
}

/** Whether a conversation works, from a row containing status and counters. */
const isWorking = (row) => row.status === 'running' || row.background > 0 || row.loops > 0

/** Whether messages would be held instead of waking idle recipients. Apply relay rules during send so senders awaiting replies immediately know human intervention is required. */
function predictHold(to, replyTo) {
  let depth = 0
  let parent = replyTo
  const up = db.prepare(`SELECT reply_to AS replyTo FROM session_messages WHERE id = ?`)
  while (parent && depth < MAX_HOPS) {
    depth++
    parent = up.get(parent)?.replyTo ?? null
  }
  if (depth >= MAX_HOPS) return 'loop'

  const row = db
    .prepare(
      `SELECT count(*) AS total FROM session_messages
       WHERE to_conversation_id = ? AND kind = 'message' AND delivered_via = 'wake'
         AND delivered_at > ?`,
    )
    .get(to, Date.now() - 60 * 60 * 1000)
  return row.total >= WAKES_PER_HOUR ? 'rate' : null
}

function broadcast(body) {
  const targets = db
    .prepare(
      `SELECT c.id AS id FROM conversations AS c
       WHERE c.project_id = ? AND c.id != ? AND c.archived_at IS NULL AND ${WORKING}`,
    )
    .all(PROJECT_ID, CURRENT_CONVERSATION)
  if (targets.length === 0) return 0

  const insert = writeDb().prepare(
    `INSERT INTO session_messages
       (id, project_id, from_conversation_id, to_conversation_id, kind, body, created_at)
     VALUES (?, ?, ?, ?, 'broadcast', ?, ?)`,
  )
  const now = Date.now()
  writeDb().transaction(() => {
    for (const target of targets) insert.run(randomUUID(), PROJECT_ID, CURRENT_CONVERSATION, target.id, body, now)
  })()
  return targets.length
}

/** Adds a watch unless an open watch for the same target already exists. */
function watch(target) {
  const open = db
    .prepare(
      `SELECT 1 AS yes FROM session_watches
       WHERE watcher_conversation_id = ? AND target_conversation_id = ? AND fired_at IS NULL`,
    )
    .get(CURRENT_CONVERSATION, target)
  if (open) return false
  writeDb()
    .prepare(
      `INSERT INTO session_watches (id, project_id, watcher_conversation_id, target_conversation_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), PROJECT_ID, CURRENT_CONVERSATION, target, Date.now())
  return true
}

/** Current conversation worktree, or `undefined` when its identity is unknown. Compare only shared trees: identical relative paths in separate worktrees represent different disk files and cannot collide. */
function currentWorktree() {
  const row = db
    .prepare(`SELECT worktree_id AS worktreeId FROM conversations WHERE id = ?`)
    .get(CURRENT_CONVERSATION)
  return row ? row.worktreeId : undefined
}

/** Other sessions editing this file and their current state. Include activity with edits: callers need both provenance and whether work continues to decide whether to wait. Specific-path queries are unbounded because uncommitted edits outlive sessions; general lists need bounded windows. Scan events without type indexes: measured 30 ms over 115,000 rows for an occasional diagnostic tool. A partial index is the next step if this becomes hot. */
/** Most recent edit outside the window, so empty results disclose older evidence. Otherwise 'nothing in 120 minutes' would imply nobody touched the file. Run one extra query only when results are empty. */
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

  // Fallback rather than union: exact-path matches make same-named files elsewhere
  // irrelevant. Basename matching serves callers knowing only filenames or using
  // a directory different from journal paths.
  return queryEdits({ path: exact.split('/').pop(), byName: true, withinMinutes })
}

function queryEdits({ path, byName, withinMinutes }) {
  const worktree = currentWorktree()

  const filters = [
    `e.type = 'file.edited'`,
    `c.project_id = ?`,
    `c.id != ?`,
    // `IS` rather than `=`: null worktrees mean project roots, the common case,
    // and SQL equality never matches nulls.
    worktree === undefined ? null : `c.worktree_id IS ?`,
    // Apply windows to path searches too. Journals retain edits indefinitely, including
    // long-committed ones: unbounded results would mix edits unrelated to current
    // tree state with relevant changes
    // and imply sessions are still working on them.
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
       -- Group by expressions rather than aliases: worktrees has a path column
       -- and events has a ts column, which SQLite prefers over output aliases.
       -- Grouping by aliases used to group only by conversation, accumulating
       -- counts across files and choosing an arbitrary path from each group.
       GROUP BY e.conversation_id, e.payload ->> '$.path'
       ORDER BY max(e.ts) DESC
       LIMIT ${EDIT_ROW_LIMIT}`,
    )
    .all(...params)
}

/** Instance-wide counts solely to answer whether restarting the service is safe. Return numbers only: callers need to know if anyone would be interrupted, not identities or work titles that would expose unrelated projects. */
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

/** Readable age avoids requiring models to subtract absolute timestamps. */
function ago(ts) {
  const minutes = Math.max(0, Math.round((Date.now() - ts) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}

const STATUS_LABELS = {
  running: 'running',
  idle: 'idle',
  awaiting_input: 'awaiting a reply',
  interrupted: 'interrupted',
  error: 'failed',
}

/** Conversation activity summarized in one clause combining status and detached work. */
function describeActivity(row) {
  const parts = [STATUS_LABELS[row.status] ?? row.status]
  if (row.background > 0) parts.push(`${row.background} background job(s)`)
  if (row.loops > 0) parts.push(`${row.loops} loop(s)`)
  return parts.join(', ')
}

function renderSessions(rows, withinMinutes) {
  if (rows.length === 0) {
    return `No other project conversation has worked in the last ${withinMinutes} minutes.`
  }

  const cache = new Map()
  const lines = rows.map((row) => {
    const where = row.worktree ? `worktree ${row.worktree}` : 'project root'
    const git = row.path ? gitState(row.path, cache) : null
    const tree = git
      ? `, branch ${git.branch}${git.dirty > 0 ? `, ${git.dirty} modified file(s)` : ''}`
      : ''
    return `- ${row.id} | ${sessionReference(row.id)} | ${row.agent} | ${describeActivity(row)} | ${where}${tree} | ${ago(row.updatedAt)}\n  ${row.title}`
  })
  return `${rows.length} conversation(s), ${withinMinutes} min window:\n${lines.join('\n')}`
}

const ACTION_LABELS = { created: 'created', modified: 'modified', deleted: 'deleted' }

/** Lead with a conclusion instead of a table requiring interpretation. Called when uncertain whether to wait or proceed, so explicitly report ongoing work rather than bury it in statuses. */
function renderFileEdits(rows, { path, withinMinutes, older }) {
  if (rows.length === 0) {
    const scope = path ? `touched “${path}”` : 'edited any file'
    const head = `No other session in this working tree ${scope} in the last ${withinMinutes} minutes.`
    return older === null
      ? `${head} No older edits either.`
      : `${head} The latest edit was ${ago(older)}: call again with a wider window to see it.`
  }

  const busy = rows.filter((row) => row.status === 'running' || row.background > 0 || row.loops > 0)
  const lead = busy.length > 0
    ? `Warning: ${busy.length} of these sessions are still working; waiting may be preferable to undoing their changes.`
    : 'None of these sessions is still working: their changes are no longer evolving.'

  // Two groupings answer different questions. With paths, each row describes a session
  // that touched the file. Without paths, group by session:
  // grouping by file repeated titles and states identically fifteen times in a real
  // case, wasting context in a tool intended to save it.
  const lines = path ? renderByFile(rows) : renderBySession(rows)
  const capped =
    rows.length >= EDIT_ROW_LIMIT
      ? `\n\n[List capped at ${EDIT_ROW_LIMIT} session/file pairs; some may be missing.]`
      : ''

  return `${lead}\n\n${lines.join('\n')}${capped}`
}

function renderByFile(rows) {
  return rows.map((row) => {
    const where = row.worktree ? `worktree ${row.worktree}` : 'project root'
    const times = row.edits > 1 ? ` (${row.edits} times)` : ''
    return `- ${row.path} | ${ACTION_LABELS[row.action] ?? row.action}${times} | ${ago(row.ts)}\n  by ${row.id} (${row.agent}, ${describeActivity(row)}, ${where})\n  ${row.title}`
  })
}

/** Beyond this limit, one session's files overwhelm the others. */
const FILES_PER_SESSION = 8

function renderBySession(rows) {
  const sessions = new Map()
  for (const row of rows) {
    const found = sessions.get(row.id)
    if (found) found.files.push(row)
    else sessions.set(row.id, { head: row, files: [row] })
  }

  return [...sessions.values()].map(({ head, files }) => {
    const where = head.worktree ? `worktree ${head.worktree}` : 'project root'
    // Sort by edit count rather than date: heavily edited files carry higher collision
    // risk and belong first.
    const sorted = [...files].sort((a, b) => b.edits - a.edits)
    const shown = sorted
      .slice(0, FILES_PER_SESSION)
      .map((file) => `${file.path}${file.edits > 1 ? ` (${file.edits}×)` : ''}`)
    const rest = sorted.length - shown.length
    const tail = rest > 0 ? `, and ${rest} other(s)` : ''

    return `- ${head.id} (${head.agent}, ${describeActivity(head)}, ${where}), ${ago(head.ts)}\n  ${head.title}\n  ${files.length} file(s): ${shown.join(', ')}${tail}`
  })
}

/** Project board, one row per card. Count sessions with subqueries rather than joins: joining `conversations` duplicates cards per session, and compensating `GROUP BY` would hide cards without sessions. */
function listCards(column) {
  return db
    .prepare(
      `SELECT c.number   AS number,
              c.title    AS title,
              c.column   AS column,
              c.description AS description,
              c.updated_at  AS updatedAt,
              (SELECT COUNT(*) FROM conversations AS v WHERE v.card_id = c.id) AS sessions,
              i.number AS issue, i.author AS issueAuthor, i.detached AS detached
       FROM cards AS c
       LEFT JOIN card_issues AS i ON i.card_id = c.id
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

function listActions() {
  return db
    .prepare(
      `SELECT id, label, description, kind, command, subdir, url,
              approved_at AS approvedAt
       FROM project_actions
       WHERE project_id = ?
       ORDER BY created_at`,
    )
    .all(PROJECT_ID)
}

function renderActions(actions) {
  if (actions.length === 0) {
    return 'No actions in this project. Use register_action to create a button the user can run with one click.'
  }
  return actions
    .map((action) => {
      const status = action.approvedAt ? 'approved' : 'awaiting user approval'
      const where = action.subdir ? ` — in \`${action.subdir}\`` : ''
      const about = action.description ? `\n  ${action.description}` : ''
      const link = action.url ? `\n  open ${action.url}` : ''
      return `- « ${action.label} » (${action.kind}, ${status}, id \`${action.id}\`)${where}${about}${link}\n  \`${action.command.replace(/\n/g, ' ⏎ ')}\``
    })
    .join('\n')
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

  // Labels must match protocol CARD_RELATION_INVERSE.
  const labels = {
    blocks: ['Blocks', 'Blocked by'], related: ['Related to', 'Related to'],
    duplicates: ['Duplicates', 'Duplicated by'], parent: ['Contains', 'Child of'],
    replaces: ['Replaces', 'Replaced by'],
  }
  card.relations = db.prepare(
    `SELECT r.source_id AS sourceId, r.kind, c.number, c.title, c.column
     FROM card_relations r JOIN cards c ON c.id = CASE WHEN r.source_id = ? THEN r.target_id ELSE r.source_id END
     WHERE (r.source_id = ? OR r.target_id = ?) AND c.project_id = ? ORDER BY c.number`
  ).all(card.id, card.id, card.id, PROJECT_ID).map(r => ({
    ...r, label: labels[r.kind]?.[r.sourceId === card.id ? 0 : 1] ?? r.kind,
  }))

  card.attachments = db.prepare(
    'SELECT filename, mime_type AS mimeType, size_bytes AS sizeBytes, storage_path AS path FROM attachments WHERE card_id = ? ORDER BY created_at'
  ).all(card.id)
  card.issue = cardIssue(card.id)
  return card
}

/** GitHub board connection when present. Column names and meanings must match `board_links` in `packages/db/src/schema.ts`. */
function boardLink() {
  return (
    db
      .prepare(
        `SELECT repo, new_cards AS newCards, identity, signature
         FROM board_links WHERE project_id = ?`,
      )
      .get(PROJECT_ID) ?? null
  )
}

/** Issue tracked by a card, attached or detached. */
function cardIssue(cardId) {
  return (
    db
      .prepare(
        `SELECT number, url, author, state, labels, detached
         FROM card_issues WHERE card_id = ?`,
      )
      .get(cardId) ?? null
  )
}

/** Linked board header identifying where new cards go. */
function describeBoardLink(link) {
  const where =
    link.newCards === 'github'
      ? 'new cards become GitHub issues, including create_card unless `github: false`'
      : 'new cards stay local unless create_card uses `github: true`'
  return `Board linked to issues at github.com/${link.repo}: a card marked “GitHub #n” is an issue, public if the repository is public; other cards are local. Here, ${where}.`
}

/** Card handled by the current conversation, if any. */
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

const DECISION_TOOLS = new Set(['request_decision', 'withdraw_decision'])

/** Whether the current session may request decisions. Must match `DecisionService.sourceOf` (`apps/server/src/decisions/service.ts`): scheduled tasks or automations through `schedule_id`, maintenance sessions through tracked issues (`card_issues.responder_id`). */
function decisionsAllowed() {
  if (!CURRENT_CONVERSATION) return false
  try {
    const conversation = db.prepare('SELECT schedule_id AS scheduleId FROM conversations WHERE id = ?').get(CURRENT_CONVERSATION)
    if (!conversation) return false
    if (conversation.scheduleId) {
      const task = db.prepare('SELECT decisions_enabled AS enabled FROM scheduled_tasks WHERE id = ?').get(conversation.scheduleId)
      return Boolean(task?.enabled)
    }
    const link = db
      .prepare(
        `SELECT l.decisions_enabled AS enabled FROM card_issues AS i
         JOIN board_links AS l ON l.project_id = i.project_id
         WHERE i.responder_id = ?`,
      )
      .get(CURRENT_CONVERSATION)
    return Boolean(link?.enabled)
  } catch {
    // Databases predating these columns have no decisions.
    return false
  }
}

/** Card notes oldest first with authors. */
function cardNotes(cardId) {
  return db
    .prepare(
      `SELECT n.body AS body, n.created_at AS createdAt,
              n.conversation_id AS conversationId,
              v.title AS conversationTitle, v.agent AS agent,
              u.display_name AS userName,
              n.external_author AS githubAuthor, n.publication AS publication
       FROM card_notes AS n
       LEFT JOIN conversations AS v ON v.id = n.conversation_id
       LEFT JOIN users AS u ON u.id = n.user_id
       WHERE n.card_id = ?
       ORDER BY n.created_at`,
    )
    .all(cardId)
}

/** `publish` queues notes: only the daemon decrypts GitHub credentials and posts comments on the next pass. */
function addCardNote(cardId, body, publish) {
  writeDb()
    .prepare(
      `INSERT INTO card_notes (id, card_id, conversation_id, user_id, body, created_at, publication)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), cardId, CURRENT_CONVERSATION || null, USER?.id ?? null, body, Date.now(), publish ? 'pending' : null)
}

/** Moves cards to the end of a column, matching card details. For tracked cards, the daemon detects issue differences and applies them to GitHub. */
function moveCard(cardId, column) {
  const db = writeDb()
  const { last } = db
    .prepare('SELECT MAX(position) AS last FROM cards WHERE project_id = ? AND "column" = ?')
    .get(PROJECT_ID, column)
  db.prepare('UPDATE cards SET "column" = ?, position = ?, updated_at = ? WHERE id = ?').run(
    column,
    (last ?? 0) + 1,
    Date.now(),
    cardId,
  )
}

function setProjectImage(mimeType, data, provisional) {
  writeDb()
    .prepare(
      `INSERT INTO project_images (project_id, mime_type, data, provisional, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project_id) DO UPDATE SET
         mime_type = excluded.mime_type, data = excluded.data,
         provisional = excluded.provisional, updated_at = excluded.updated_at`,
    )
    .run(PROJECT_ID, mimeType, data, provisional ? 1 : 0, Date.now())
}

/** Project instruction mode. Must match `resolveInstructionsMode` in `apps/server/src/instructions/store.ts`: projects predating this setting follow repositories when instruction files exist. */
function projectInstructionsMode() {
  const project = db
    .prepare('SELECT instructions_mode AS mode, workspace_path AS path FROM projects WHERE id = ?')
    .get(PROJECT_ID)
  if (!project) return { mode: 'repo', chosen: true }
  if (project.mode) return { mode: project.mode, chosen: true }
  const hasFile = REPO_INSTRUCTION_FILES.some((name) => {
    try {
      return statSync(resolve(project.path, name)).isFile()
    } catch {
      return false
    }
  })
  return { mode: hasFile ? 'repo' : 'sillage', chosen: false }
}

/** Whether the account that opened this conversation is an administrator. */
function conversationOwnerIsAdmin() {
  if (!CURRENT_CONVERSATION) return false
  const row = db
    .prepare(
      `SELECT u.is_admin AS admin FROM conversations c JOIN users u ON u.id = c.user_id
       WHERE c.id = ?`,
    )
    .get(CURRENT_CONVERSATION)
  return Boolean(row?.admin)
}

/** Target SILLAGE.md section as stored in the database. */
function readInstructionsRow(projectId) {
  return db
    .prepare('SELECT content, updated_at AS updatedAt FROM instructions WHERE id = ?')
    .get(projectId ?? 'global')
}

/** Rewrites SILLAGE.md sections from their current version inside a transaction: edits computed before another session's change must not erase it. `transform` returns new content or an error string inside `{ error }`. */
function saveInstructions(projectId, transform, fixMode) {
  const write = writeDb()
  return write.transaction(() => {
    const id = projectId ?? 'global'
    const current = write.prepare('SELECT content FROM instructions WHERE id = ?').get(id)
    const result = transform(current?.content ?? '')
    if (typeof result !== 'string') return result
    if (result.length > MAX_INSTRUCTIONS_CHARS) {
      return {
        error: `SILLAGE.md would exceed ${MAX_INSTRUCTIONS_CHARS} characters in this scope (${result.length}). It enters every session's context: shorten it.`,
      }
    }

    write
      .prepare(
        `INSERT INTO instructions
           (id, project_id, content, updated_at, updated_by_user_id, updated_by_conversation_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           content = excluded.content, updated_at = excluded.updated_at,
           updated_by_user_id = excluded.updated_by_user_id,
           updated_by_conversation_id = excluded.updated_by_conversation_id`,
      )
      .run(id, projectId, result, Date.now(), USER?.id ?? null, CURRENT_CONVERSATION || null)
    if (fixMode) {
      write
        .prepare(`UPDATE projects SET instructions_mode = 'sillage' WHERE id = ? AND instructions_mode IS NULL`)
        .run(PROJECT_ID)
    }
    return { content: result }
  })()
}

/** Requested scope or rejection returned unchanged. `writing` distinguishes globally readable sections, matching the interface. */
function instructionsTarget(args, writing) {
  const scope = args?.scope === 'global' ? 'global' : 'project'
  if (scope === 'global') {
    if (writing && !(USER ? Boolean(USER.admin) : conversationOwnerIsAdmin())) {
      return {
        refusal:
          "Global SILLAGE.md instructions enter every session on this instance. Only administrators can edit them, and this conversation does not belong to one. Use project scope (`scope: project`), or ask the user to make the change themselves.",
      }
    }
    return { scope, projectId: null, fixMode: false }
  }

  const { mode, chosen } = projectInstructionsMode()
  if (mode === 'repo') {
    return {
      refusal:
        "This project keeps instructions in its repository's `AGENTS.md` or `CLAUDE.md`: read and edit them with your file tools. SILLAGE.md tools apply only to global instructions (`scope: global`).",
    }
  }
  return { scope, projectId: PROJECT_ID, fixMode: !chosen }
}

const scopeLabel = (scope) => (scope === 'global' ? 'global section' : 'project section')

/** Memory notes, index first. */
function memoryFiles() {
  let names = []
  try {
    names = readdirSync(MEMORY_DIR)
  } catch {
    return []
  }
  return names
    .filter((name) => MEMORY_FILE_PATTERN.test(name))
    .sort((a, b) => (a === MEMORY_INDEX ? -1 : b === MEMORY_INDEX ? 1 : a.localeCompare(b)))
}

function readMemoryFile(file) {
  try {
    return readFileSync(join(MEMORY_DIR, file), 'utf8')
  } catch {
    return null
  }
}

/** Note header metadata for its index entry. */
function frontmatterField(content, field) {
  const head = /^---\n([\s\S]*?)\n---/.exec(content)?.[1] ?? ''
  const line = head.split('\n').find((candidate) => candidate.startsWith(`${field}:`))
  return line ? line.slice(field.length + 1).trim().replace(/^["']|["']$/g, '') : null
}

/** Adds index entries for notes not yet listed. Claude maintains its own index; this tool does so for Codex because unindexed notes are notes nobody reads. */
function indexNote(file, content) {
  const index = readMemoryFile(MEMORY_INDEX) ?? ''
  if (index.includes(`](${file})`)) return false
  const name = frontmatterField(content, 'name') ?? file.replace(/\.md$/, '')
  const description = frontmatterField(content, 'description')
  const line = `- [${name}](${file})${description ? ` — ${description}` : ''}`
  writeFileSync(join(MEMORY_DIR, MEMORY_INDEX), index.trimEnd() ? `${index.trimEnd()}\n${line}\n` : `${line}\n`)
  return true
}

/** Reachable project conversation for this session, or null. */
function peerConversation(id) {
  return (
    db
      .prepare(
        `SELECT c.id AS id, c.title AS title, c.agent AS agent, c.status AS status,
                c.background_count AS background, c.loop_count AS loops,
                c.archived_at AS archivedAt
         FROM conversations AS c
         WHERE c.id = ? AND c.project_id = ?`,
      )
      .get(id, PROJECT_ID) ?? null
  )
}

function sendSessionMessage({ to, body, replyTo }) {
  const id = randomUUID()
  writeDb()
    .prepare(
      `INSERT INTO session_messages
         (id, project_id, from_conversation_id, to_conversation_id, body, reply_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, PROJECT_ID, CURRENT_CONVERSATION, to, body, replyTo, Date.now())
  return id
}

/** Inter-session exchanges oldest first. Mark received undelivered messages read: subsequent injection would repeat already-read content and interrupt ongoing work. */
function readSessionMessages(withId) {
  const rows = db
    .prepare(
      `SELECT m.id AS id, m.from_conversation_id AS fromId, m.to_conversation_id AS toId,
              m.body AS body, m.kind AS kind, m.reply_to AS replyTo, m.created_at AS createdAt,
              m.delivered_at AS deliveredAt, m.delivered_via AS via,
              o.title AS otherTitle, o.agent AS otherAgent
       FROM session_messages AS m
       LEFT JOIN conversations AS o
         ON o.id = CASE WHEN m.from_conversation_id = @me THEN m.to_conversation_id
                        ELSE m.from_conversation_id END
       WHERE m.project_id = @project
         AND (m.from_conversation_id = @me OR m.to_conversation_id = @me)
         AND (@with IS NULL OR m.from_conversation_id = @with OR m.to_conversation_id = @with)
       ORDER BY m.created_at DESC
       LIMIT ${PEER_HISTORY_LIMIT}`,
    )
    .all({ me: CURRENT_CONVERSATION, project: PROJECT_ID, with: withId })
    .reverse()

  const unread = rows.filter((row) => row.toId === CURRENT_CONVERSATION && row.deliveredAt === null)
  if (unread.length > 0) {
    const mark = writeDb().prepare(
      `UPDATE session_messages SET delivered_at = ?, delivered_via = 'read'
       WHERE id = ? AND delivered_at IS NULL`,
    )
    const now = Date.now()
    for (const row of unread) mark.run(now, row.id)
  }
  return rows
}

function renderCards(rows, column) {
  const truncated = rows.length > CARD_LIMIT
  const shown = truncated ? rows.slice(0, CARD_LIMIT) : rows

  if (shown.length === 0) {
    return column
      ? `No cards in this project's “${COLUMN_LABELS[column]}” column.`
      : 'This project has no cards. An empty board does not mean there is no work: not everything is necessarily recorded.'
  }

  const mine = currentCard()?.number ?? null
  const lines = shown.map((row) => {
    const excerpt = (row.description ?? '').trim().replace(/\s+/g, ' ')
    const summary = excerpt
      ? `\n  ${excerpt.length > CARD_EXCERPT_CHARS ? `${excerpt.slice(0, CARD_EXCERPT_CHARS)}...` : excerpt}`
      : ''
    const sessions = row.sessions > 0 ? `, ${row.sessions} session(s)` : ''
    const self = row.number === mine ? ' <- this conversation\'s card' : ''
    const issue =
      row.issue === null || row.issue === undefined
        ? ''
        : row.detached
          ? ` (from GitHub issue #${row.issue}, detached)`
          : ` (GitHub #${row.issue}${row.issueAuthor ? ` by @${row.issueAuthor}` : ''})`
    return `- #${row.number} [${COLUMN_LABELS[row.column] ?? row.column}] ${row.title}${issue}${sessions}${self}${summary}`
  })

  const link = boardLink()
  const head = `${link ? `${describeBoardLink(link)}\n\n` : ''}${shown.length} card(s)${column ? ` in “${COLUMN_LABELS[column]}”` : ''}:`
  const tail = truncated
    ? `\n\n${rows.length - CARD_LIMIT} additional card(s) omitted. Filter by column to see more.`
    : ''
  return `${head}\n${lines.join('\n')}${tail}`
}

function renderCard(card) {
  const parts = [
    `#${card.number} [${COLUMN_LABELS[card.column] ?? card.column}] ${card.title}`,
  ]

  if (card.issue && !card.issue.detached) {
    const labels = JSON.parse(card.issue.labels || '[]')
    parts.push(
      `GitHub issue #${card.issue.number} (${card.issue.state === 'open' ? 'open' : 'closed'}${card.issue.author ? `, by @${card.issue.author}` : ''}${labels.length ? `, labels: ${labels.join(', ')}` : ''}): ${card.issue.url}\n` +
        "Title, description and comments synchronize with GitHub; update_card edits the title or description. Notes labeled @login are GitHub comments. Your notes stay local unless add_card_note uses `github: true`; update_issue closes or reopens the issue.",
    )
  } else if (card.issue) {
    parts.push(`From GitHub issue #${card.issue.number} (${card.issue.url}), detached: the card is local and the issue is no longer tracked.`)
  }

  parts.push(card.description.trim() || '(no description)')
  if (card.attachments.length) {
    parts.push('Attachments — local files to inspect with your reading tools:\n' +
      card.attachments.map((file) => JSON.stringify(file)).join('\n'))
  }

  if (card.sessions.length > 0) {
    const lines = card.sessions.map((session) => {
      const where = session.worktree ? `worktree ${session.worktree}` : 'project root'
      const self = session.id === CURRENT_CONVERSATION ? ' <- this session' : ''
      return `- ${session.agent} | ${describeActivity(session)} | ${where} | ${ago(session.updatedAt)}${self}\n  ${session.title}`
    })
    parts.push(`${card.sessions.length} session(s) on this card:\n${lines.join('\n')}`)
  } else {
    parts.push('No session has worked on this card yet.')
  }

  const notes = cardNotes(card.id)
  if (notes.length > 0) {
    const lines = notes.map((note) => {
      const published =
        note.publication === 'published'
          ? ', published on GitHub'
          : note.publication === 'pending'
            ? ', publishing on GitHub'
            : note.publication === 'failed'
              ? ', GitHub publication refused'
              : ''
      const who = note.githubAuthor
        ? `@${note.githubAuthor} on GitHub`
        : note.userName
        ? `${note.userName}${published}`
        : note.conversationId === CURRENT_CONVERSATION
          ? 'this conversation'
          : `session ${note.agent ?? '?'}${note.conversationTitle ? ` « ${note.conversationTitle} »` : ''}`
      const tail = note.githubAuthor || note.userName ? '' : published
      return `[${who}${tail}, ${ago(note.createdAt)}]\n${note.body}`
    })
    parts.push(`${notes.length} note(s) on this card:\n\n${lines.join('\n\n')}`)
  }

  const link = (rows) =>
    rows.map((row) => `- #${row.number} [${COLUMN_LABELS[row.column] ?? row.column}] ${row.title}`).join('\n')
  if (card.relations.length > 0) {
    parts.push(`Relations (local to Sillage):\n${card.relations.map(r => `- ${r.label} #${r.number} “${r.title}” (${COLUMN_LABELS[r.column]})`).join('\n')}`)
  }
  if (card.references.length > 0) parts.push(`This card references:\n${link(card.references)}`)
  if (card.referencedBy.length > 0) parts.push(`Referenced by:\n${link(card.referencedBy)}`)

  return parts.join('\n\n')
}

const DELIVERY_LABELS = {
  steer: 'delivered during the current turn',
  queue: 'delivered at the end of the turn',
  wake: 'delivered by resuming the session',
  read: 'read through read_session_messages',
  failed: 'delivery failed',
  discarded: 'discarded by a person',
  expired: 'expired without delivery',
  skipped: 'not delivered; the session had stopped working',
}

const KIND_LABELS = { message: '', broadcast: 'broadcast ', done: 'work completed ' }

function renderPeerMessages(rows) {
  if (rows.length === 0) {
    return 'No messages exchanged with other project sessions.'
  }

  const lines = rows.map((row) => {
    const outgoing = row.fromId === CURRENT_CONVERSATION
    const other = outgoing ? row.toId : row.fromId
    const who = `${other}${row.otherTitle ? ` « ${row.otherTitle} »` : ''}`
    const state = row.deliveredAt === null
      ? outgoing
        ? 'not delivered yet'
        : 'held, just read'
      : DELIVERY_LABELS[row.via] ?? row.via
    const reply = row.replyTo ? `, replying to ${row.replyTo}` : ''
    const kind = KIND_LABELS[row.kind] ?? ''
    return `[${kind}${outgoing ? 'sent to' : 'received from'} ${who}, ${ago(row.createdAt)}, ${state}${reply}] id ${row.id}\n${row.body}`
  })
  return lines.join('\n\n')
}

function renderCount(state) {
  if (state.working === 0) {
    const suffix =
      state.awaiting > 0
        ? ` ${state.awaiting} awaiting a reply: restarting will expire those requests.`
        : ''
    return `No conversations are working on this instance.${suffix}`
  }

  const parts = [`${state.working} conversation(s) working on this instance`]
  if (state.here > 0) parts.push(`${state.here} in this project`)
  if (state.includesSelf) parts.push('including this one')
  if (state.oldest !== null) parts.push(`oldest active since ${ago(state.oldest)}`)

  const awaiting =
    state.awaiting > 0
      ? ` ${state.awaiting} other(s) awaiting a reply: restarting will expire those requests.`
      : ''
  return `${parts.join(', ')}. Restarting the service interrupts all of them.${awaiting}`
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n[...]` : text
}

function renderSearch(query, results) {
  if (results.length === 0) {
    return `No conversation in this project contains “${query}”.`
  }

  const lines = results.map(
    (row) =>
      `- ${row.id} | ${sessionReference(row.id)} | ${row.agent} | exchange on ${asDate(row.ts)}${row.archivedAt !== null ? ' | archived' : ''} | ${row.title}\n  ${row.excerpt}`,
  )
  return `${results.length} conversation(s) for “${query}”:\n${lines.join('\n')}`
}

const block = (role, body) => `## ${role === 'user' ? 'User' : 'Agent'}\n${body}`

/** Fills budgets newest first while retaining chronological order. Return single oversized messages truncated rather than an empty range that leaves callers no recourse. */
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

/** Conversation history within budget. Retain both ends: conclusions come last but the original request provides context; omit the middle while reporting counts and retrieval instructions. Cursors use message numbers, not pages, because sizes vary and later continuation would shift end-relative numbering. */
function renderThread(found, before) {
  const { conversation, messages } = found
  // Say 'opened on' rather than bare dates: search_history dates matching messages,
  // while this date marks conversation creation. Both correct dates otherwise look
  // contradictory without identifying what they measure.
  const header = `${conversation.title} | ${sessionReference(conversation.id)} (${conversation.agent}, opened on ${asDate(conversation.createdAt)})`
  if (messages.length === 0) return `${header}\n\nNo messages in this thread.`

  const scoped = before === null ? messages : messages.filter((message) => message.seq < before)
  if (scoped.length === 0) return `${header}\n\nNo messages before ${before} in this thread.`

  // Include the original request only on first reads: callers paging backward already
  // have it, and repeating it consumes the budget for sought content.
  const head = before === null && scoped[0].role === 'user' ? scoped[0] : null
  const rest = head ? scoped.slice(1) : scoped
  const headBody = head ? clip(head.text ?? '', MAX_MESSAGE_CHARS) : ''
  const tail = fillFromEnd(rest, MAX_THREAD_CHARS - headBody.length)

  const parts = head ? [block(head.role, headBody)] : []

  const elided = rest.length - tail.length
  if (elided > 0) {
    parts.push(
      `[${elided} message(s) omitted. Call read_conversation with before=${tail[0].seq} to read earlier messages.]`,
    )
  }
  for (const message of tail) parts.push(block(message.role, message.body))

  return `${header}\n\n${parts.join('\n\n')}`
}

const text = (value) => ({ content: [{ type: 'text', text: value }] })

/** Deposits daemon requests and waits for responses. The daemon polls every half-second; this process rereads rows through its read-only connection until handled. */
async function requestDaemon(kind, payload) {
  const id = randomUUID()
  writeDb()
    .prepare(
      `INSERT INTO agent_requests (id, project_id, conversation_id, user_id, kind, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, PROJECT_ID, CURRENT_CONVERSATION, USER?.id ?? null, kind, JSON.stringify(payload), Date.now())

  const read = db.prepare('SELECT settled_at, result, is_error FROM agent_requests WHERE id = ?')
  const deadline = Date.now() + REQUEST_WAIT_MS[kind]
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, REQUEST_POLL_MS))
    const row = read.get(id)
    if (row?.settled_at) return { ...text(row.result ?? ''), ...(row.is_error ? { isError: true } : {}) }
  }
  return {
    ...text(
      kind === 'start_session'
        ? 'Sillage has not finished starting the session (the CLI is slow to start, or the service is not running). Do not resubmit: check list_sessions later.'
        : 'Sillage did not respond in time; the service may not be running. Try again later.',
    ),
    isError: true,
  }
}

/** Explicit numbers select project cards; otherwise retain the conversation card. Global `card` remains backward-compatible for clients. */
function targetCard(args) {
  const explicit = GLOBAL ? (args?.card ?? args?.number) : args?.number
  if (!GLOBAL && explicit === undefined) return currentCard()
  const number = Number.isInteger(explicit) ? explicit : null
  if (number === null) return null
  const card = db
    .prepare('SELECT id, number, title FROM cards WHERE project_id = ? AND number = ?')
    .get(PROJECT_ID, number)
  return card ?? null
}

/** Current session state folded backward from its journal. Must match `digest` in `apps/server/src/http/v1/task-view.ts`: event types, window and pending-request rules. */
const DIGEST_TYPES = [
  'tool.started', 'tool.completed', 'message.completed',
  'permission.requested', 'permission.resolved', 'question.requested', 'question.resolved',
  'plan.review_requested', 'plan.review_resolved', 'elicitation.requested', 'elicitation.resolved',
]
const DIGEST_WINDOW = 300
const PROMPT_KINDS = {
  'permission.requested': 'permission',
  'question.requested': 'question',
  'plan.review_requested': 'plan',
  'elicitation.requested': 'elicitation',
}
const RESOLVED_TYPES = new Set(['permission.resolved', 'question.resolved', 'plan.review_resolved', 'elicitation.resolved'])

function sessionRow(id) {
  return (
    db
      .prepare(
        `SELECT c.id AS id, c.title AS title, c.agent AS agent, c.status AS status,
                c.background_count AS background, c.loop_count AS loops, c.updated_at AS updatedAt,
                c.user_id AS userId, w.name AS worktree
         FROM conversations AS c LEFT JOIN worktrees AS w ON w.id = c.worktree_id
         WHERE c.id = ? AND c.project_id = ? AND c.archived_at IS NULL`,
      )
      .get(id, PROJECT_ID) ?? null
  )
}

function digestSession(id) {
  const rows = db
    .prepare(
      `SELECT type, ts, payload FROM events
       WHERE conversation_id = ? AND type IN (${DIGEST_TYPES.map(() => '?').join(', ')})
       ORDER BY seq DESC LIMIT ${DIGEST_WINDOW}`,
    )
    .all(id, ...DIGEST_TYPES)
  const completed = new Set()
  const resolved = new Set()
  let activity = null
  let lastMessage = null
  let pending = null
  for (const row of rows) {
    const event = JSON.parse(row.payload)
    if (event.type === 'tool.completed') {
      completed.add(event.toolCallId)
    } else if (event.type === 'tool.started') {
      if (!activity && !completed.has(event.toolCallId)) activity = { name: event.name, at: row.ts }
    } else if (event.type === 'message.completed') {
      if (lastMessage || event.role !== 'assistant' || (event.parentToolCallId ?? null) !== null) continue
      const text = (event.blocks ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim()
      if (text) lastMessage = { text, at: row.ts }
    } else if (RESOLVED_TYPES.has(event.type)) {
      resolved.add(event.requestId)
    } else if (PROMPT_KINDS[event.type] && !pending && !resolved.has(event.requestId)) {
      pending = { kind: PROMPT_KINDS[event.type], requestId: event.requestId, at: row.ts, event }
    }
  }
  return { activity, lastMessage, pending }
}

/** Open request with everything needed to answer it. */
function renderPending(pending) {
  const { event } = pending
  const head = `Awaiting a reply (${pending.kind}, request_id ${pending.requestId}, ${ago(pending.at)}):`
  if (pending.kind === 'permission') {
    return `${head}\n  Permission for tool ${event.toolName}${event.input !== undefined ? `, input ${clip(JSON.stringify(event.input), 600)}` : ''}.\n  Use reply_session with decision allowed or denied, scope once, session or always.`
  }
  if (pending.kind === 'question') {
    const questions = (event.questions ?? []).map((question) => {
      const options = (question.options ?? []).map((option) => `« ${option.label}${option.description ? ` : ${option.description}` : ''} »`).join(', ')
      return `  - [${question.id}] ${question.question}${options ? ` Options: ${options}.` : ''}${question.multiSelect ? ' Multiple answers allowed.' : ''}${question.allowOther ? ' Free-text answer allowed.' : ''}`
    })
    return `${head}\n${questions.join('\n')}\n  Use reply_session with answers { "<id>": ["answer"] }, or status cancelled.`
  }
  if (pending.kind === 'plan') {
    const follow = (event.followUpOptions ?? []).map((option) => `${option.id} (${option.label})`).join(', ')
    return `${head}\n  Proposed plan:\n${clip(event.plan ?? '', 4000)}\n  Use reply_session with decision approved or rejected${follow ? `, and followUpMode from ${follow}` : ''}.`
  }
  return `${head}\n  Requested input: ${event.message ?? ''}${event.requestedSchema ? `\n  Schema: ${clip(JSON.stringify(event.requestedSchema), 1500)}` : ''}\n  Use reply_session with action accept and content, or action decline.`
}

function renderSession(row) {
  const { activity, lastMessage, pending } = digestSession(row.id)
  const lines = [
    `Session “${row.title}” (${row.id}), ${row.agent}, ${describeActivity(row)}, ${row.worktree ? `worktree ${row.worktree}` : 'project root'}, latest activity ${ago(row.updatedAt)}.`,
  ]
  if (row.status === 'running' && activity) lines.push(`Calling tool ${activity.name} (since ${ago(activity.at)}).`)
  if (pending) lines.push(renderPending(pending))
  lines.push(lastMessage ? `Latest session message (${ago(lastMessage.at)}):\n${clip(lastMessage.text, MAX_MESSAGE_CHARS)}` : 'No reply yet.')
  if (row.status === 'idle' && !pending) lines.push('Idle: message_session resumes it with its context.')
  return lines.join('\n\n')
}

/** Turns finish only when neither active nor detached work remains. */
const settled = (row) => row.status !== 'running' && row.background <= 0 && row.loops <= 0

async function waitForSession(id, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000
  let row = sessionRow(id)
  // Messages may have just been sent: status takes a moment to become `running`,
  // so immediately reporting idle could miss entire turns.
  const grace = Date.now() + 3000
  while (row && Date.now() < deadline) {
    if (settled(row) && Date.now() >= grace) return { row, timedOut: false }
    await new Promise((done) => setTimeout(done, WAIT_POLL_MS))
    row = sessionRow(id)
  }
  return { row, timedOut: Boolean(row) }
}

const NO_CARD =
  'This conversation is not attached to a card, so there is no card thread to write to. Supply a project card number with `number`, or attach the conversation in Sillage.'
function missingTargetCard(args) {
  const number = GLOBAL ? (args?.card ?? args?.number) : args?.number
  if (!GLOBAL && number === undefined) return NO_CARD
  if (Number.isInteger(number)) return `No card #${number} in this project. Use list_cards to see available cards.`
  const parameter = GLOBAL && (args?.card != null || args?.number === undefined) ? 'card' : 'number'
  return `The \`${parameter}\` parameter must be an integer card number in this project; see list_cards.`
}

async function callTool(name, args) {
  if (name === 'list_projects') {
    return text(renderProjects(listProjects()))
  }

  if (name === 'read_session' || name === 'wait_for_session') {
    const id = typeof args?.session === 'string' ? args.session.trim() : ''
    if (!id) return { ...text('The `session` parameter is required.'), isError: true }
    let row = sessionRow(id)
    if (!row || row.userId !== USER?.id) {
      return { ...text(`No session “${id}” belonging to you in this project. Use list_sessions to see available sessions.`), isError: true }
    }
    if (name === 'wait_for_session') {
      const asked = Number.isInteger(args?.timeout_seconds) ? args.timeout_seconds : 60
      const waited = await waitForSession(id, Math.min(Math.max(asked, 1), MAX_WAIT_SECONDS))
      row = waited.row ?? row
      if (waited.timedOut) return text(`Still running after ${Math.min(Math.max(asked, 1), MAX_WAIT_SECONDS)} s. ${renderSession(row)}`)
    }
    return text(renderSession(row))
  }

  if (name === 'search_history') {
    const query = typeof args?.query === 'string' ? args.query : ''
    if (!query.trim()) return { ...text('The `query` parameter is required.'), isError: true }

    const asked = Number.isInteger(args?.limit) ? args.limit : 10
    const limit = Math.min(Math.max(asked, 1), 50)
    return text(renderSearch(query, searchHistory(query, limit)))
  }

  if (name === 'read_conversation') {
    const id = typeof args?.id === 'string' ? args.id : ''
    const found = id ? readConversation(id) : null
    if (!found) {
      return {
        ...text(`No conversation “${id}” in this project.`),
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
    // Probe only when windows return nothing, the only case where results
    // could imply nobody touched the file.
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

  if (name === 'list_actions') {
    return text(renderActions(listActions()))
  }

  if (name === 'list_cards') {
    const column = typeof args?.column === 'string' && COLUMN_LABELS[args.column] ? args.column : null
    return text(renderCards(listCards(column), column))
  }

  if (name === 'read_card') {
    const number = Number.isInteger(args?.number) ? args.number : null
    if (number === null) {
      return { ...text('The `number` parameter is required and must be an integer.'), isError: true }
    }
    const card = readCard(number)
    if (!card) {
      return {
        ...text(`No card #${number} in this project. Use list_cards to see available cards.`),
        isError: true,
      }
    }
    return text(renderCard(card))
  }

  if (name === 'add_card_note') {
    const body = typeof args?.body === 'string' ? args.body.trim() : ''
    if (!body) return { ...text('The `body` parameter is required.'), isError: true }

    const card = targetCard(args)
    if (!card) return { ...text(missingTargetCard(args)), isError: true }

    if (args?.github === true) {
      const link = boardLink()
      const issue = cardIssue(card.id)
      if (!link || !issue || issue.detached) {
        return {
          ...text(`Card #${card.number} does not track a GitHub issue: the note can only be local. Retry without \`github\`.`),
          isError: true,
        }
      }
      addCardNote(card.id, body, true)
      const signed = link.identity === 'ai' && (link.signature ?? '').trim()
      return text(
        `Note added to card #${card.number} and queued for GitHub issue #${issue.number} (${issue.url}): Sillage publishes it within seconds with your session marker${signed ? ` and signature ${JSON.stringify(link.signature.trim())}` : ', without a visible signature'}.`,
      )
    }

    addCardNote(card.id, body, false)
    return text(`Note added to card #${card.number} “${card.title}”.`)
  }

  if (name === 'move_card') {
    const column = typeof args?.column === 'string' && COLUMN_LABELS[args.column] ? args.column : null
    if (!column) {
      return { ...text('The `column` parameter must be todo, in_progress, review, done or abandoned.'), isError: true }
    }
    const number = Number.isInteger(args?.number) ? args.number : null
    const target = number !== null ? { number } : GLOBAL ? null : currentCard()
    if (!target) {
      return {
        ...text(
          GLOBAL
            ? 'The `number` parameter is required to select the card to move.'
            : 'This conversation is not attached to a card: supply its `number` to move one.',
        ),
        isError: true,
      }
    }
    const card = db
      .prepare('SELECT id, number, title, "column" AS column FROM cards WHERE project_id = ? AND number = ?')
      .get(PROJECT_ID, target.number)
    if (!card) {
      return {
        ...text(`No card #${target.number} in this project. Use list_cards to see available cards.`),
        isError: true,
      }
    }
    if (card.column === column) {
      return text(`Card #${card.number} “${card.title}” is already in “${COLUMN_LABELS[column]}”.`)
    }
    moveCard(card.id, column)
    const reason = typeof args?.reason === 'string' ? args.reason.trim().slice(0, 500) : ''
    addCardNote(
      card.id,
      `Moved from “${COLUMN_LABELS[card.column]}” to “${COLUMN_LABELS[column]}”.${reason ? ` ${reason}` : ''}`,
      false,
    )
    const issue = cardIssue(card.id)
    const tracked = issue && !issue.detached && boardLink()
    return text(
      `Card #${card.number} “${card.title}” moved from “${COLUMN_LABELS[card.column]}” to “${COLUMN_LABELS[column]}”.` +
        (tracked ? ` Issue #${issue.number} will follow on GitHub within seconds.` : ''),
    )
  }

  if (name === 'update_issue') {
    const state = args?.state === 'open' ? 'open' : args?.state === 'closed' ? 'closed' : null
    if (!state) return { ...text('The `state` parameter must be closed or open.'), isError: true }
    const card = targetCard(args)
    if (!card) return { ...text(missingTargetCard(args)), isError: true }
    const issue = cardIssue(card.id)
    if (!issue || issue.detached || !boardLink()) {
      return {
        ...text(
          `Card #${card.number} does not track a GitHub issue: there is nothing to close or reopen.`,
        ),
        isError: true,
      }
    }
    const column = state === 'open' ? 'todo' : args?.reason === 'not_planned' ? 'abandoned' : 'done'
    moveCard(card.id, column)
    const verb = state === 'open' ? 'reopened' : column === 'abandoned' ? 'closed as not planned' : 'closed as completed'
    return text(`Card #${card.number} moved to “${COLUMN_LABELS[column]}”: issue #${issue.number} will be ${verb} on GitHub within seconds.`)
  }

  if (name === 'set_project_image') {
    const path = typeof args?.path === 'string' ? args.path.trim() : ''
    if (!path) return { ...text('The `path` parameter is required.'), isError: true }
    const provisional = args?.provisional === true

    const file = resolve(path)
    let data
    try {
      // Check size before reading: accidentally referenced videos or archives must
      // not enter memory merely to be rejected.
      const info = statSync(file)
      if (!info.isFile()) return { ...text(`${file} is not a file.`), isError: true }
      if (info.size > MAX_PROJECT_IMAGE_BYTES) {
        return {
          ...text(
            `Image too large (${Math.round(info.size / 1024)} KiB, maximum ${MAX_PROJECT_IMAGE_BYTES / 1024} KiB). It is displayed at a small size: resize to 256 pixels per side and retry.`,
          ),
          isError: true,
        }
      }
      data = readFileSync(file)
    } catch (error) {
      return { ...text(`Cannot read ${file}: ${error.message}`), isError: true }
    }

    const mimeType = sniffProjectImage(data)
    if (!mimeType) {
      return {
        ...text(`${file} is not a recognized image. Accepted formats: PNG, JPEG, GIF, WebP, SVG.`),
        isError: true,
      }
    }

    setProjectImage(mimeType, data, provisional)
    return text(
      provisional
        ? 'Project image set as provisional: later sessions will be reminded to replace it when the project has a real logo.'
        : 'Project image updated.',
    )
  }

  if (name === 'send_session_message') {
    const to = typeof args?.to === 'string' ? args.to.trim() : ''
    const body = typeof args?.body === 'string' ? args.body.trim() : ''
    const replyTo = typeof args?.reply_to === 'string' && args.reply_to.trim() ? args.reply_to.trim() : null
    if (!to || !body) return { ...text('The `to` and `body` parameters are required.'), isError: true }
    if (body.length > MAX_PEER_MESSAGE_CHARS) {
      return {
        ...text(`Message too long (${body.length} characters, maximum ${MAX_PEER_MESSAGE_CHARS}). Summarize or put details in a file and provide its path.`),
        isError: true,
      }
    }
    if (!CURRENT_CONVERSATION) {
      return { ...text('This session has no identity and cannot sign a message.'), isError: true }
    }
    if (to === CURRENT_CONVERSATION) {
      return { ...text('That is the ID of this conversation.'), isError: true }
    }

    const peer = peerConversation(to)
    if (!peer) {
      return {
        ...text(`No conversation “${to}” in this project. Use list_sessions to see available sessions.`),
        isError: true,
      }
    }
    if (peer.archivedAt !== null) {
      return { ...text(`Conversation “${peer.title}” is archived: nobody will read this message.`), isError: true }
    }

    const id = sendSessionMessage({ to, body, replyTo })
    if (peer.status === 'running' || peer.status === 'awaiting_input') {
      return text(
        `Message ${id} queued for “${peer.title}” (${peer.agent}). It is working: delivery will occur during or just after its turn. If you need a reply, end your turn; its reply will resume you.`,
      )
    }

    const held = predictHold(to, replyTo)
    if (held) {
      const why = held === 'loop'
        ? `your exchange has already reached ${MAX_HOPS} hops`
        : `other sessions have already resumed it ${WAKES_PER_HOUR} times in the last hour`
      return text(
        `Message ${id} queued for “${peer.title}”, but it will not resume the session: ${why}. It is held and visible in the thread until a person delivers or discards it; it will also be delivered if the session resumes work. Do not expect a quick reply or resend it.`,
      )
    }
    return text(
      `Message ${id} queued for “${peer.title}” (${peer.agent}). It is ${STATUS_LABELS[peer.status] ?? peer.status}: Sillage will resume it to read the message. If you need a reply, end your turn; its reply will resume you.`,
    )
  }

  if (name === 'broadcast_session_message') {
    const body = typeof args?.body === 'string' ? args.body.trim() : ''
    if (!body) return { ...text('The `body` parameter is required.'), isError: true }
    if (body.length > MAX_PEER_MESSAGE_CHARS) {
      return {
        ...text(`Announcement too long (${body.length} characters, maximum ${MAX_PEER_MESSAGE_CHARS}).`),
        isError: true,
      }
    }
    if (!CURRENT_CONVERSATION) {
      return { ...text('This session has no identity and cannot sign an announcement.'), isError: true }
    }
    const sent = broadcast(body)
    return text(
      sent === 0
        ? 'No other project session is working: the announcement was not sent to anyone.'
        : `Announcement queued for ${sent} working session(s). Delivered during their turns; sessions that finish before delivery will not receive it.`,
    )
  }

  if (name === 'notify_when_done') {
    const target = typeof args?.session === 'string' ? args.session.trim() : ''
    if (!target) return { ...text('The `session` parameter is required.'), isError: true }
    if (!CURRENT_CONVERSATION) {
      return { ...text('This session has no identity: Sillage would not know whom to notify.'), isError: true }
    }
    if (target === CURRENT_CONVERSATION) {
      return { ...text('That is the ID of this conversation.'), isError: true }
    }
    const peer = peerConversation(target)
    if (!peer) {
      return {
        ...text(`No conversation “${target}” in this project. Use list_sessions to see available sessions.`),
        isError: true,
      }
    }
    if (!isWorking(peer) && peer.status !== 'awaiting_input') {
      return text(
        `“${peer.title}” is not working: it is ${STATUS_LABELS[peer.status] ?? peer.status}. Nothing to wait for; read_conversation shows where it stopped.`,
      )
    }
    const created = watch(target)
    const pause = peer.status === 'awaiting_input'
      ? ' It is currently awaiting a user reply: the watch will fire only afterward.'
      : ''
    return text(
      `${created ? 'Watch registered' : 'Watch already registered'} for “${peer.title}”. You will resume when it finishes.${pause} End your turn now if you have no independent work to do.`,
    )
  }

  if (name === 'read_session_messages') {
    const withId = typeof args?.with === 'string' && args.with.trim() ? args.with.trim() : null
    return text(renderPeerMessages(readSessionMessages(withId)))
  }

  if (name === 'count_active_sessions') {
    return text(renderCount(countActiveSessions()))
  }

  if (
    name === 'rename_session' ||
    name === 'link_cards' ||
    name === 'unlink_cards' ||
    name === 'update_card' ||
    name === 'create_card' ||
    name === 'start_session' ||
    name === 'list_models' ||
    name === 'schedule_task' ||
    name === 'register_action' ||
    name === 'remove_action' ||
    name === 'run_action' ||
    name === 'create_automation' ||
    name === 'request_decision' ||
    name === 'withdraw_decision' ||
    name === 'message_session' ||
    name === 'steer_session' ||
    name === 'interrupt_session' ||
    name === 'reply_session' ||
    name === 'create_worktree' ||
    name === 'list_worktrees'
  ) {
    if (!CURRENT_CONVERSATION && !USER) {
      return { ...text('This session has no identity: Sillage would not know whom to act for.'), isError: true }
    }
    if (name === 'rename_session') {
      const title = typeof args?.title === 'string' ? args.title.trim() : ''
      if (!title || title.length > MAX_SESSION_TITLE_CHARS) {
        return { ...text(`The \`title\` parameter must contain 1 to ${MAX_SESSION_TITLE_CHARS} characters.`), isError: true }
      }
    }
    if (name === 'request_decision' && !(typeof args?.question === 'string' && args.question.trim())) {
      return { ...text('The `question` parameter is required.'), isError: true }
    }
    if (name === 'create_card' && !(typeof args?.title === 'string' && args.title.trim())) {
      return { ...text('The `title` parameter is required.'), isError: true }
    }
    if (name === 'start_session') {
      const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
      if (!prompt) return { ...text('The `prompt` parameter is required.'), isError: true }
      if (prompt.length > MAX_LAUNCH_PROMPT_CHARS) {
        return {
          ...text(`Mission too long (${prompt.length} characters, maximum ${MAX_LAUNCH_PROMPT_CHARS}). Put details in a file and cite it.`),
          isError: true,
        }
      }
    }
    if (name === 'schedule_task') {
      if (!(typeof args?.name === 'string' && args.name.trim())) {
        return { ...text('The `name` parameter is required.'), isError: true }
      }
      const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
      if (!prompt) return { ...text('The `prompt` parameter is required.'), isError: true }
      if (prompt.length > MAX_SCHEDULE_PROMPT_CHARS) {
        return {
          ...text(`Instructions too long (${prompt.length} characters, maximum ${MAX_SCHEDULE_PROMPT_CHARS}). Put details in a file and cite it.`),
          isError: true,
        }
      }
      if (typeof args?.check_script === 'string' && args.check_script.length > MAX_CHECK_SCRIPT_CHARS) {
        return { ...text(`Check script too long (maximum ${MAX_CHECK_SCRIPT_CHARS} characters).`), isError: true }
      }
    }
    if (name === 'create_worktree' && !(typeof args?.branch === 'string' && args.branch.trim())) {
      return { ...text('The `branch` parameter is required, e.g. `fix/truncated-title`.'), isError: true }
    }
    if (name === 'create_automation' && !(typeof args?.name === 'string' && args.name.trim())) {
      return { ...text('The `name` parameter is required.'), isError: true }
    }
    if ((name === 'remove_action' || name === 'run_action') && !(typeof args?.id === 'string' && args.id.trim())) {
      return { ...text('The `id` parameter is required (see list_actions).'), isError: true }
    }
    return requestDaemon(name, args ?? {})
  }

  if (name === 'read_memory' || name === 'write_memory' || name === 'delete_memory') {
    if (!MEMORY_DIR) return { ...text('Memory is unavailable in this session.'), isError: true }
    const file = typeof args?.file === 'string' ? args.file.trim() : ''

    if (name === 'read_memory') {
      if (!file) {
        const files = memoryFiles()
        if (files.length === 0) return text(`Memory is empty (${MEMORY_DIR}).`)
        const index = readMemoryFile(MEMORY_INDEX)
        return text(
          [
            `Project memory in ${MEMORY_DIR}:`,
            index ? `${MEMORY_INDEX}:\n\n${index.trim()}` : `No ${MEMORY_INDEX}.`,
            `Notes: ${files.filter((candidate) => candidate !== MEMORY_INDEX).join(', ') || 'none'}.`,
          ].join('\n\n'),
        )
      }
      const content = MEMORY_FILE_PATTERN.test(file) ? readMemoryFile(file) : null
      if (content === null) return { ...text(`No note “${file}”. Use read_memory without \`file\` to list notes.`), isError: true }
      return text(content)
    }

    if (!MEMORY_FILE_PATTERN.test(file)) {
      return {
        ...text('`file` must be a flat `.md` filename: letters, digits, dots, hyphens and underscores, without directories.'),
        isError: true,
      }
    }

    if (name === 'delete_memory') {
      if (readMemoryFile(file) === null) return { ...text(`No note “${file}”.`), isError: true }
      rmSync(join(MEMORY_DIR, file), { force: true })
      if (file !== MEMORY_INDEX) {
        const index = readMemoryFile(MEMORY_INDEX)
        if (index !== null) {
          const kept = index.split('\n').filter((line) => !line.includes(`](${file})`))
          writeFileSync(join(MEMORY_DIR, MEMORY_INDEX), kept.join('\n'))
        }
      }
      return text(`Note “${file}” removed from memory.`)
    }

    if (typeof args?.content !== 'string') return { ...text('The `content` parameter is required.'), isError: true }
    if (args.content.length > MAX_MEMORY_FILE_CHARS) {
      return { ...text(`Note too long (${args.content.length} characters, maximum ${MAX_MEMORY_FILE_CHARS}).`), isError: true }
    }
    mkdirSync(MEMORY_DIR, { recursive: true })
    writeFileSync(join(MEMORY_DIR, file), args.content)
    const indexed = file !== MEMORY_INDEX && indexNote(file, args.content)
    return text(
      `Note “${file}” written to project memory${indexed ? ` and added to ${MEMORY_INDEX}` : ''}. Future sessions across CLIs will see it.`,
    )
  }

  if (name === 'read_instructions') {
    const target = instructionsTarget(args, false)
    if (target.refusal) return { ...text(target.refusal), isError: true }
    const row = readInstructionsRow(target.projectId)
    if (!row?.content.trim()) return text(`SILLAGE.md, ${scopeLabel(target.scope)}: empty.`)
    return text(`SILLAGE.md, ${scopeLabel(target.scope)} (${row.content.length} characters):\n\n${row.content}`)
  }

  if (name === 'edit_instructions' || name === 'write_instructions') {
    const target = instructionsTarget(args, true)
    if (target.refusal) return { ...text(target.refusal), isError: true }

    let transform
    if (name === 'write_instructions') {
      if (typeof args?.content !== 'string') return { ...text('The `content` parameter is required.'), isError: true }
      transform = () => args.content
    } else {
      const oldText = typeof args?.old_text === 'string' ? args.old_text : null
      const newText = typeof args?.new_text === 'string' ? args.new_text : null
      if (oldText === null || newText === null) {
        return { ...text('The `old_text` and `new_text` parameters are required.'), isError: true }
      }
      transform = (current) => {
        if (oldText === '') {
          const before = current.trimEnd()
          return before ? `${before}\n${newText}` : newText
        }
        const count = current.split(oldText).length - 1
        if (count === 0) {
          return { error: '`old_text` was not found in SILLAGE.md. Read the current version with read_instructions: it may have changed since session startup.' }
        }
        if (count > 1 && args?.replace_all !== true) {
          return { error: `\`old_text\` occurs ${count} times. Supply more context to select one occurrence, or use \`replace_all: true\`.` }
        }
        return args?.replace_all === true ? current.split(oldText).join(newText) : current.replace(oldText, () => newText)
      }
    }

    const result = saveInstructions(target.projectId, transform, target.fixMode)
    if (result.error) return { ...text(result.error), isError: true }
    return text(
      `SILLAGE.md updated (${scopeLabel(target.scope)}, ${result.content.length} characters). Applies to sessions starting afterward across CLIs (OpenCode from its next message); the user sees the change in Sillage.`,
    )
  }

  return { ...text(`Unknown tool: ${name}`), isError: true }
}

log(GLOBAL ? `ready, global mode, account=${USER.username}` : `ready, project=${PROJECT_ID}`)

/** Serialize tool calls. Calls are normally fast and CLIs seldom overlap them, but global projects are process state: interleaved calls on different projects would write into each other's project. */
let calls = Promise.resolve()

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return

  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    log('unreadable line, ignored')
    return
  }

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        // Client-requested version: the CLI decides, not us.
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'sillage', version: '1' },
      },
    })
    return
  }

  if (msg.method === 'tools/list') {
    // Offer decision tools only to autonomous sessions whose sources allow them:
    // elsewhere they would encourage agents to ask what they should decide themselves.
    const decisions = decisionsAllowed()
    // Without memory directories (native project mode), memory tools have nothing
    // to act on: omit them instead of returning errors.
    const tools = GLOBAL
      ? globalTools()
      : TOOLS.filter((tool) => (decisions || !DECISION_TOOLS.has(tool.name)) && (MEMORY_DIR || !MEMORY_TOOLS.has(tool.name)))
    send({ jsonrpc: '2.0', id: msg.id, result: { tools } })
    return
  }

  if (msg.method === 'tools/call') {
    calls = calls.then(async () => {
      const name = msg.params?.name
      const args = msg.params?.arguments ?? {}
      let result
      try {
        result = GLOBAL && SESSION_ONLY_TOOLS.has(name)
          ? { ...text(`Tool ${name} is unavailable outside a session: no session identity or turn to receive messages.`), isError: true }
          : (GLOBAL && selectProject(name, args)) || (await callTool(name, args))
      } catch (err) {
        // Return tool results rather than JSON-RPC errors so models can correct requests;
        // protocol errors provide no useful guidance.
        log(`tool ${name} failed: ${err.message}`)
        result = { ...text(`Tool call failed: ${err.message}`), isError: true }
      }
      send({ jsonrpc: '2.0', id: msg.id, result })
    })
    return
  }

  if (msg.method === 'ping') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} })
    return
  }

  // Notifications have no IDs and expect no responses.
  if (msg.id === undefined) return

  send({
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: `unknown method: ${msg.method}` },
  })
})
