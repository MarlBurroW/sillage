# Sillage

Self-hosted, multi-CLI agentic development platform.

A sillage is the wake a ship leaves behind. Here, it is the ordered, replayable
journal of everything your agents do, and the product's central technical
property: nothing that happens is lost when the network drops.

---

## 0. Locked decisions

| Topic | Decision |
|---|---|
| Name | Sillage |
| Multi-user model | Trusted circle: separate accounts, shareable resources, no system isolation |
| CLI credentials | Host credentials (`~/.claude`, `~/.codex`), shared by all users |
| Backend | Node 22 + TypeScript + Fastify |
| Frontend | React 19 + Vite + Tailwind, installable PWA |
| Database | SQLite (WAL) through Drizzle ORM |
| Deployment | Systemd unit on host machine (installer provided); optional Docker image |
| v1 target CLIs | Claude Code 2.1.x, Codex 0.142.x |

### Docker: optional, not isolation

Initial decision: no Docker because agents need direct host-file-system access
(workspaces are real directories), host credentials, `git`, and SSH keys. This
remains true: the Docker image published since 0.1 provides no isolation, mounting
credentials and projects from the host. It exists to simplify installation
(no Node to manage, agent CLIs installed through the interface), not to isolate.
The reference deployment remains a systemd daemon under your user account, now
installed by `install.sh` with a versioned layout (`app/releases/vX.Y.Z` + `current`
link) enabling UI updates.

### Why not Rust

Both consumed protocols ship TypeScript types and change with every CLI release:

- Claude Code: `@anthropic-ai/claude-agent-sdk`, wrapping the bidirectional control
  protocol (`control_request` / `control_response` frames over stdin/stdout).
  This protocol is not publicly documented and is the only way to get real
  interactive permission requests.
- Codex: `codex app-server generate-ts -o <dir>` generates bindings from the
  installed binary.

Rewriting and tracking both manually in Rust would save about 50 MB RSS against
450 MB used by one `claude` session. The wrong tradeoff.

### Machine constraint to respect

Ryzen 3 3300U, 4 cores, 15.6 GB RAM, about 10 GB already permanently occupied.
The resulting rules are nonnegotiable:

1. No transcript in memory. Events are written to the database as they arrive;
   clients read them from the database.
2. `--max-old-space-size=256` on the daemon.
3. No CLI hook forking a process per event.
4. Frontend built and served statically by Fastify, no frontend Node server.
5. Configurable concurrent-agent-session limit (default: 3), queued beyond it.
   A Claude session costs 400–500 MB, the only significant item.

---

## 1. Non-goals

Explicitly outside scope to prevent drift:

- No cloud or remote-machine agent execution. Sillage drives CLIs installed on
  its own host.
- No agent sandboxing. Rely on CLI permission modes.
- No integrated code editor. Sillage is a conversation client, not an IDE.
- No per-user billing, quotas, or cost reporting in v1 (total conversation cost
  is shown without aggregation).
- No real-time multi-user collaboration on one conversation in v1. Two users can
  watch, but one owner sends messages.

---

## 2. Architectural invariants

These are the four rules directly addressing Omnigent's shortcomings.

### I1. Agent process is decoupled from transport

A dropped WebSocket must never interrupt agents or lose one byte of output.
Daemon supervises agent processes; clients merely subscribe to a journal.
Closing tabs, locking phones, switching Wi-Fi to 4G: no effect on execution.

### I2. Event journal is the source of truth

Each conversation has a strictly increasing event sequence (`seq`, integer,
without gaps). Everything agents produce is appended before broadcasting.
Client stores latest received `seq`; on reconnect it sends this cursor and
receives the delta. UI never needs to guess what it missed.

Corollary: chat rendering is a pure function of the journal. Replaying from zero
must produce exactly the current screen. Display data not coming from the
journal is a bug.

### I3. One CLI-independent event schema

UI never knows whether it is talking to Claude or Codex. Each CLI has an adapter
translating native stream to common schema (section 5). Adding Gemini CLI, Amp,
or another means writing an adapter without touching frontend or database.

Every event's raw native payload is kept in a separate column. Specialized
renderers (section 12.5) can use it later without renormalization.

### I4. Projects belong to no CLI

CLI is a conversation property (`conversations.agent`), never a project property.
One project simultaneously holds Claude and Codex conversations sharing its
workspace/worktrees. Nothing in UI should imply otherwise: no CLI choice at
project creation, no project filtering by CLI.

Corollary: adding a third CLI requires no existing project changes or recreation.
New-conversation CLI selector defaults to the project's last conversation's CLI,
derived from data rather than another setting to maintain.

### I5. Idempotent sending

Client generates `client_message_id` (UUID) per sent message. Retries after network
timeouts using the same ID are ignored server-side. Otherwise, mobile messages
send twice whenever the network falters.

---

## 3. Process topology

```
                    browser (desktop / mobile PWA)
                              │  HTTPS + WSS
                              ▼
      ┌──────────────────────────────────────────────┐
      │  sillage-daemon  (Node 22, one process)       │
      │                                              │
      │   Fastify  ──  REST + WS + static routes      │
      │   SessionManager  ── runner supervision       │
      │   EventLog  ── SQLite append + fan-out        │
      │   PtyManager  ── node-pty terminals           │
      └───────┬───────────────────────┬──────────────┘
              │ child_process         │ child_process
      ┌───────▼────────┐      ┌───────▼─────────┐
      │ claude         │      │ codex           │
      │ --input-format │      │ app-server      │
      │ stream-json    │      │ (JSON-RPC)      │
      └────────────────┘      └─────────────────┘
```

One Node process. Runners are direct children, not extra Node workers (each would
waste 40 MB).

**Runner lifecycle.** A runner starts on a conversation's first message and stays
alive while it is “active”. It stops:

- on explicit request (Stop button),
- after `idle_timeout` without messages (default: 30 minutes), freeing 450 MB,
- on daemon shutdown.

When a stopped runner receives a new message, it relaunches in resume mode
(`--resume <session_id>` for Claude, `thread/resume` for Codex). User sees no
difference: conversation continues. This makes the concurrent-session cap acceptable.

**Daemon crash recovery.** At startup, daemon marks all `running` conversations
`interrupted` and appends explicit `error` events to their journals. None remains
stuck in a misleading “in progress” state.

---

## 4. Data model

SQLite WAL, `synchronous = NORMAL`, `busy_timeout = 5000`. One `sillage.db` file
in the data directory.

```sql
-- Users and authentication sessions

CREATE TABLE users (
  id            TEXT PRIMARY KEY,          -- uuid
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,             -- argon2id
  display_name  TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE auth_sessions (
  token_hash  TEXT PRIMARY KEY,            -- sha256 of cookie token
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  user_agent  TEXT
);

-- Projects

CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  workspace_path TEXT NOT NULL,            -- absolute path, checked at creation
  owner_id      TEXT NOT NULL REFERENCES users(id),
  visibility    TEXT NOT NULL,             -- 'private' | 'shared'
  color         TEXT,                      -- optional UI accent
  default_config TEXT,                     -- JSON: option-bar presets
  archived_at   INTEGER,
  created_at    INTEGER NOT NULL
);

-- Git worktrees attached to a project

CREATE TABLE worktrees (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,               -- branch name
  path        TEXT NOT NULL,               -- absolute worktree path
  base_ref    TEXT NOT NULL,               -- starting ref
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  removed_at  INTEGER,
  UNIQUE(project_id, name)
);

-- Conversations

CREATE TABLE conversations (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  worktree_id     TEXT REFERENCES worktrees(id),   -- NULL = project root
  user_id         TEXT NOT NULL REFERENCES users(id),
  title           TEXT NOT NULL,
  agent           TEXT NOT NULL,           -- 'claude' | 'codex'
  agent_session_id TEXT,                   -- native ID for --resume / thread/resume
  config          TEXT NOT NULL,           -- JSON AgentConfig, see section 6/7
  status          TEXT NOT NULL,           -- 'idle'|'running'|'awaiting_input'|'interrupted'|'error'
  last_seq        INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL NOT NULL DEFAULT 0,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  pinned          INTEGER NOT NULL DEFAULT 0,
  archived_at     INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX idx_conv_project ON conversations(project_id, updated_at DESC);

-- Journal. Most heavily used table.

CREATE TABLE events (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  ts              INTEGER NOT NULL,
  type            TEXT NOT NULL,           -- discriminant, see section 5
  payload         TEXT NOT NULL,           -- normalized JSON
  raw             TEXT,                    -- native CLI JSON for future renderers
  PRIMARY KEY (conversation_id, seq)
) WITHOUT ROWID;

-- Search index. Derived from journal (invariant I2), rebuildable through replay:
-- contains no information absent from `events`.
CREATE VIRTUAL TABLE search_messages USING fts5(
  text,
  conversation_id UNINDEXED,
  seq UNINDEXED,
  role UNINDEXED,
  ts UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Pending permission requests

CREATE TABLE permission_requests (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,        -- associated permission.requested event
  tool_name       TEXT NOT NULL,
  input           TEXT NOT NULL,           -- JSON
  status          TEXT NOT NULL,           -- 'pending'|'allowed'|'denied'|'expired'
  decision_scope  TEXT,                    -- 'once'|'session'|'always'
  decided_by      TEXT REFERENCES users(id),
  created_at      INTEGER NOT NULL,
  decided_at      INTEGER
);

CREATE INDEX idx_perm_pending ON permission_requests(conversation_id, status);

-- Attachments

CREATE TABLE attachments (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  filename        TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  storage_path    TEXT NOT NULL,           -- under data directory
  created_at      INTEGER NOT NULL
);

-- Per-user preferences (CLI defaults, etc.)

CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data    TEXT NOT NULL                    -- JSON
);

-- Skill library, delivered to CLIs as native skills (docs/skill-library.md).
-- Content on disk under <data>/skill-library is authoritative: table contains
-- only scope, enabled state, and provenance.

CREATE TABLE library_skills (
  id             TEXT PRIMARY KEY,         -- uuid
  scope          TEXT NOT NULL,            -- global | project
  project_id     TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- null for global
  name           TEXT NOT NULL,            -- directory name, unique across global + one project
  enabled        INTEGER NOT NULL DEFAULT 1,
  source_id      TEXT REFERENCES skill_sources(id) ON DELETE SET NULL,
  source_path    TEXT,
  source_commit  TEXT,
  source_hash    TEXT,                     -- source fingerprint before renaming
  installed_hash TEXT,                     -- fingerprint at installation
  created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- Git repositories supplying library skills. Two preconfigured sources,
-- inserted by migration: anthropics/skills and openai/skills.

CREATE TABLE skill_sources (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  url             TEXT NOT NULL,           -- anything accepted by git clone
  ref             TEXT,                    -- null: default branch
  subpath         TEXT,                    -- null: entire repository
  builtin         INTEGER NOT NULL DEFAULT 0,
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_commit     TEXT,
  last_fetched_at INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
```

**Retention.** `events` grows quickly (many text deltas). Two measures:

1. `message.delta` and `thinking.delta` events compact into the corresponding
   `message.completed` when the message finishes, then are deleted. Historical
   journal therefore contains complete messages only; only active conversations
   contain deltas.
2. Daily maintenance deletes events from conversations archived more than
   90 days ago (configurable), with weekly `VACUUM`.

---

## 5. Normalized event protocol

Defined once in Zod in `packages/protocol`, imported by server and frontend.
This is I3's contract.

```ts
type SillageEvent =
  // Lifecycle
  | { type: 'session.started';   agent: AgentKind; agentSessionId: string;
                                 model: string; cwd: string; tools: string[] }
  | { type: 'session.ended';     reason: 'completed' | 'interrupted' | 'error' }
  | { type: 'turn.started' }
  | { type: 'turn.completed';    stopReason: string; costUsd: number;
                                 inputTokens: number; outputTokens: number }

  // Content
  | { type: 'message.started';   messageId: string; role: 'user' | 'assistant' }
  | { type: 'message.delta';     messageId: string; text: string }
  | { type: 'message.completed'; messageId: string; role: 'user' | 'assistant';
                                 blocks: ContentBlock[] }
  | { type: 'thinking.delta';    messageId: string; text: string }

  // Tools
  | { type: 'tool.started';      toolCallId: string; name: string;
                                 input: unknown; parentToolCallId?: string }
  | { type: 'tool.output_delta'; toolCallId: string; chunk: string }
  | { type: 'tool.completed';    toolCallId: string; output: unknown;
                                 isError: boolean; durationMs: number }

  // Required interaction
  | { type: 'permission.requested'; requestId: string; toolName: string;
                                    input: unknown; suggestions: PermissionOption[];
                                    // Labels written by the CLI itself
                                    title: string | null; description: string | null;
                                    displayName: string | null }
  | { type: 'permission.resolved';  requestId: string;
                                    decision: 'allowed' | 'denied' | 'expired';
                                    scope: 'once' | 'session' | 'always';
                                    decidedBy: string | null }
  | { type: 'question.requested';   requestId: string; questions: AgentQuestion[] }
  | { type: 'question.resolved';    requestId: string;
                                    status: 'answered' | 'cancelled' | 'expired';
                                    answers: Record<string, string[]>;
                                    decidedBy: string | null }
  | { type: 'plan.review_requested'; requestId: string; plan: string }
  | { type: 'plan.review_resolved';  requestId: string;
                                     decision: 'approved' | 'rejected' | 'expired';
                                     followUpMode: ClaudePermissionMode | null;
                                     decidedBy: string | null }

  // Metadata
  | { type: 'plan.updated';      items: { text: string; status: PlanStatus }[] }
  | { type: 'usage.updated';     costUsd: number; inputTokens: number;
                                 outputTokens: number;
                                 rateLimit?: { type: string; resetsAt: number } }
  | { type: 'diff.updated';      files: { path: string; added: number;
                                          removed: number }[] }
  | { type: 'error';             code: string; message: string;
                                 recoverable: boolean }
```

`ContentBlock` covers `text`, `thinking`, `image`, `file`, `tool_use`, `tool_result`.
`parentToolCallId` identifies the call that launched the subagent producing an
event: this separates the main thread from subagent threads.

### 5.1 User prompts

Three interactions block a turn and must stay distinct:

| Form | Claude Code | Codex |
| --- | --- | --- |
| Tool permission | `canUseTool` callback | `item/*/requestApproval` |
| Choice question | `AskUserQuestion` tool | `item/tool/requestUserInput` |
| Plan approval | `ExitPlanMode` tool | no equivalent |
| MCP elicitation | `onElicitation` callback | `mcpServer/elicitation/request` |

Both Claude tools use the same `canUseTool` callback as permissions, but expected
answers are not “allowed”/“denied”: for `AskUserQuestion` they travel in
`updatedInput.answers`, keyed by question title. This behavior is undocumented in
SDK types; it was observed on the installed CLI, and input shape is anchored by
a compile-time assertion (`apps/server/src/agents/claude/prompts.ts`).

`AgentQuestion` normalizes both protocols: `id`, `header`, `question`, `multiSelect`,
`allowOther`, `secret`, `options[]`. Nothing absent from the protocol is invented:
Codex lacks multi-select and option previews, so these fields are `false`/`null`.

Plan approval requires choosing how execution continues (`followUpMode`): leaving
plan mode without changing modes would return to the mode that requested planning,
making the agent plan again rather than act.

**MCP elicitations.** MCP servers may request user input (`elicitation/create`).
The requester is neither agent nor CLI but a connected third party, so the server
name is displayed and all three protocol responses (`accept`, `decline`, `cancel`)
are offered.

Unlike other forms, this contract is **identical on both sides** because neither
Claude nor Codex invented it: it is MCP. `requestedSchema` is flat JSON Schema
limited to primitives, passed raw by Claude and typed by Codex. One parser
(`packages/protocol/src/elicitation.ts`), belonging to neither adapter, normalizes
it into five field shapes (text, number, boolean, single-select, multi-select).
Response is identical on both sides: action plus content for `accept`.

Parser is tolerant by design: unknown field types are ignored rather than guessed;
unreadable schemas leave the message/action buttons. Misguessed fields would
produce wrong responses unknowingly accepted by the MCP server.

Codex bindings supply types for three compile-time assertions: actions must match
exactly, and every field variant must fit a recognized shape. Removing a variant
was verified to fail typecheck. One installed-CLI caveat: SDK **in-process** MCP
servers (`createSdkMcpServer`) cannot elicit; transport returns
`-32601 Method not found`. Only stdio servers can, the actual MCP server form.

Unanswered requests must never remain open. Two guards: runners close pending
requests on stop, and session manager rereads the journal at startup to close
those left by a forcibly killed daemon (`EventLog.openPrompts`).

**Translation rule.** Adapters encountering untranslatable native events never
silently drop them: write nonblocking `type: 'error'` if meaningful, otherwise
explicitly ignore through a named exclusion list. No silent `default:`.

---

## 6. Claude Code adapter

### Launch

Through `@anthropic-ai/claude-agent-sdk` in streaming-input mode, providing
`canUseTool` and successive messages without process restarts.

Empirically checked on 2.1.220: `--print` without active stdin and
`--permission-mode manual` **denies** tools, returning error `tool_result`
("Claude requested permissions to write to X, but you haven't granted it yet")
without asking anything. Bidirectional control is therefore required for an Allow
button, not merely an optimization.

Options passed:

| UI setting | Flag / SDK option | Values |
|---|---|---|
| Model | `--model` | `opus`, `sonnet`, `haiku`, `fable`, or full ID. Dynamically fetched list, hardcoded fallback |
| Effort | `--effort` | `low`, `medium`, `high`, `xhigh`, `max` |
| Permission mode | `--permission-mode` | `manual`, `auto`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions` |
| Working directory | `cwd` | worktree or project path |
| Additional directories | `--add-dir` | multiple |
| Fast mode | `settings: { fastMode }` then live `applyFlagSettings` | boolean; only offered on `supportsFastMode` models and eligible accounts |
| Output style | `settings: { outputStyle }` then `applyFlagSettings` | one of init's `available_output_styles`, empty for default |
| Advisor | `settings: { advisorModel }` then `applyFlagSettings` | catalog model, empty for none |
| Caps | `maxBudgetUsd`, `maxTurns` | launch options, task API only; changes restart runner |
| Suggestions | `promptSuggestions: true` | fixed; machine `promptSuggestionEnabled: false` disables them |
| Resume | `--resume <uuid>` | through `agent_session_id` |
| Forced ID | `--session-id <uuid>` | impose our ID at creation |
| Output | `--output-format stream-json --include-partial-messages` | fixed |
| Input | `--input-format stream-json` | fixed |

`bypassPermissions` is red in UI, requires explicit confirmation, and cannot be
saved as a project default.

Fast mode, probed on CLI 2.1.263: `initializationResult()` reports `off` with
`sdk_opt_in_required`; `applyFlagSettings({ fastMode: true })` switches `on`
without restart. Session must request it; typed `/fast` says “unavailable”. State
returns on each `init`/`result` (`fast_mode_state`, including post-limit `cooldown`),
and runner journals only changes as stable-ID `agent.notice`. Same probe for
output style: `applyFlagSettings({ outputStyle: 'Concise' })` changes
`output_style` live. Both use the flag settings layer (`--settings`), overriding
machine files for the conversation.

Opt-in does not guarantee API acceptance. Accounts without usage credits get
rejected; CLI falls back to normal speed for that turn and reports a per-turn
`notification` (“Fast mode disabled · usage credits exhausted”), forwarded as
`agent.notice`; state remains `on`. Verified with
`pnpm --filter @sillage/server claude:probe`, replaying the chain in three turns,
costing two real turns plus one at Fast rates.

### Event translation

| Native | Normalized |
|---|---|
| `system/init` | `session.started` (reads `session_id`, `tools`, `cwd`, `model`) |
| `stream_event` with `content_block_delta` type `text_delta` | `message.delta` |
| `stream_event` with `thinking_delta` | `thinking.delta` |
| `assistant` with `tool_use` block | `tool.started` |
| `user` with `tool_result` block | `tool.completed` |
| final `assistant` | `message.completed` |
| `canUseTool` call | `permission.requested`, promise resolved by UI HTTP response |
| `result` | `turn.completed` + `usage.updated` |
| `rate_limit_event` | `usage.updated` (`rateLimit` field) |
| `system/thinking_tokens` | `thinking.progress`, one step per hundred tokens |
| `system/notification`, `api_retry`, `model_refusal_*`, `permission_denied`, `informational` | `agent.notice` (see `signals.ts`): CLI notices, API retries, model refusals, automatic denials, hook messages |
| `prompt_suggestion` | `suggestion.updated`, predicted next message |
| `conversation_reset` | `agent.notice`; next `session_id` arrives in next turn's init |
| `system/session_state_changed` | ignored (exclusion list: progress noise) |

`system/init` arrives every turn, not only at launch (database count: as many inits
as turns). Runner journals `session.started` only on session/model changes,
precisely what the thread needs: typed `/model`, fallback, `/clear`. Commands are
requested only on the first init.

Subagents (nonnull `parent_tool_use_id`) are kept with that ID through to the
journal. `forwardSubagentText` is enabled: otherwise SDK sends only tool calls,
enough for a counter but not their reasoning/intermediate-message thread.

Disk transcripts store them separately in
`<sessionId>/subagents/agent-<agentId>.jsonl`, without repeating the origin call:
linkage uses `agentId` attached to the main transcript's `Task` result. Import
reads these files, recursively finding nested subagents from each thread, merging
events by timestamp. They carry no turn boundary or compaction: subagents work
*inside* the parent turn, not their own.

During resync, cutting at a common point does not fit their separate chronology,
nor does `uuid`: most entries leave no `raw` containing one, so they would appear
new each time. Import is all-or-nothing per subagent: once a call leaves any trace
in the journal, its thread is considered imported.

---

## 7. Codex adapter

### Launch

Through `codex app-server` (JSON-RPC over stdio). Types generated from installed
binary and committed:

```
codex app-server generate-ts -o packages/protocol/src/codex/
```

`pnpm codex:types` regenerates; CI fails when generated files differ from committed
content, flagging a Codex version bump to address.

### Methods used

Recorded from version 0.142.2 schema:

**Client to server:** `thread/start`, `thread/resume`, `thread/list`, `thread/read`,
`thread/fork`, `thread/archive`, `thread/name/set`, `turn/start`, `turn/interrupt`,
`turn/steer`, `thread/compact/start`, `model/list`, `config/read`, and
`collaborationMode/list` (see below).

### Collaboration mode

Codex has Claude Plan mode's equivalent, more than instructions: the **CLI tool
router** determines allowed model tools by mode. In `default`, `request_user_input`
is rejected, making choice requests fall back to prose lists. This explained
Codex saying “I need plan mode for that”.

Found by probing installed binary; no documentation described the path:

- `initialize` must declare **`experimentalApi`** capability. Otherwise `turn/start`
  returns `collaborationMode requires experimentalApi capability`;
- `collaborationMode/list` returns presets (`Plan`, `Default`) with display names.
  Thus the list comes from CLI, not hardcoded in Sillage;
- `turn/start.collaborationMode` carries mode per turn like model/sandbox.
  `thread/settings/updated` confirms it.

Tried and **not working**: `config.collaboration_mode` at `thread/start`,
`developerInstructions` with Plan-mode prompt, developer-message injection via
`thread/inject_items`. All leave router in `Default mode`.

`collaborationMode/list` and `turn/start` field are not exported by `generate-ts`:
they use explicitly named `callExperimental`, and the field type is intersected
from generated `CollaborationMode`. Nothing manually transcribed. Codex versions
without `collaborationMode/list` simply hide the selector instead of offering an
ineffective setting.

Verified end to end through Sillage in both modes: `plan` produces normalized
`question.requested` with choice buttons; `default` produces a text list. Sending
answers back closes requests (`question.resolved`), then the turn ends.

**Server to client (notifications):** `thread/started`, `thread/status/changed`,
`item/started`, `item/completed`, `item/agentMessage/delta`,
`item/reasoning/textDelta`, `item/reasoning/summaryTextDelta`,
`item/commandExecution/outputDelta`, `item/fileChange/patchUpdated`,
`item/mcpToolCall/progress`, `turn/started`, `turn/completed`, `turn/diff/updated`,
`turn/plan/updated`, `thread/tokenUsage/updated`, `account/rateLimits/updated`.

**Server to client (requests requiring answers):** `item/commandExecution/requestApproval`,
`item/fileChange/requestApproval`, `item/permissions/requestApproval`,
`item/tool/requestUserInput`.

All three approval requests map exactly to `permission.requested`, like Claude's
`canUseTool`. This gives both CLIs one permission UI.

### Exposed settings

| UI setting | Codex parameter | Values |
|---|---|---|
| Model | `model` | through `model/list` |
| Reasoning effort | `-c model_reasoning_effort` | `minimal`, `low`, `medium`, `high` |
| Approval | `askForApproval` | `untrusted`, `on-request`, `never` |
| Sandbox | `sandbox` | `read-only`, `workspace-write`, `danger-full-access` |
| Web search | `--search` | boolean |
| Directory | `cwd` | worktree or project |
| Profile | `-p/--profile` | list from `$CODEX_HOME` |

UI presents both CLIs in the same form, simply omitting irrelevant fields. It does
not pretend they share concepts: Claude permission mode and Codex approval/sandbox
pair appear with native vocabulary.

---

## 8. API

### REST

All routes live under `/api`, authenticated by session cookie (`HttpOnly`,
`SameSite=Lax`, `Secure` with HTTPS).

```
POST   /api/auth/login              { username, password } -> Set-Cookie
POST   /api/auth/logout
GET    /api/auth/me

GET    /api/projects
POST   /api/projects                { name, workspacePath, visibility }   existing directory
                                    { name, parentDir, directory, visibility }   created directory, remembered parent
POST   /api/projects/order          { ids[] }   manual sidebar order
PATCH  /api/projects/:id
DELETE /api/projects/:id
GET    /api/projects/:id/branches           git branch --list
GET    /api/projects/:id/files              ?q=&worktreeId=  mention autocomplete
GET    /api/projects/:id/worktrees
POST   /api/projects/:id/worktrees          { name, baseRef }
DELETE /api/worktrees/:id                   { force?: boolean }

GET    /api/conversations                   all visible conversations
GET    /api/projects/:id/conversations      ?archived=
POST   /api/projects/:id/conversations      { agent, config, worktreeId?, firstMessage? }
POST   /api/projects/:id/conversations/order { ids[] }
GET    /api/conversations/:id
PATCH  /api/conversations/:id               { title?, config?, pinned?, archived? }
DELETE /api/conversations/:id
GET    /api/conversations/:id/events        ?after=<seq>&limit=500

POST   /api/conversations/:id/messages      { clientMessageId, text,
                                              attachmentIds[], mentions[] }
POST   /api/conversations/:id/fork           { throughSeq, title? } -> branch
POST   /api/conversations/:id/steer          steers active turn
POST   /api/conversations/:id/interrupt
POST   /api/conversations/:id/compact
POST   /api/conversations/:id/permissions/:requestId  { decision, scope }
POST   /api/conversations/:id/questions/:requestId    { status, answers }
POST   /api/conversations/:id/elicitations/:requestId { action, content }
DELETE /api/conversations/:id/queue/:queueId          removes queued message
POST   /api/conversations/:id/queue/:queueId/steer    injects it into active turn
POST   /api/conversations/:id/plans/:requestId        { decision, followUpMode }

POST   /api/attachments                     multipart -> { id, filename, ... }
GET    /api/attachments/:id

GET    /api/push                            VAPID public key + subscription state
POST   /api/push/subscribe                  { endpoint, keys }
POST   /api/push/unsubscribe                { endpoint }

GET    /api/search?q=                       messages matching query, visibility enforced
GET    /api/palette/catalog                 tickets and skills from all visible projects
GET    /api/palette/files                   ?q=&conversationId=  files from all visible projects

Panel routes have two scopes: `/api/conversations/:id/...` uses thread directory,
including worktree, while `/api/projects/:id/...` uses project workspace for Board
and draft panels. Same paths and access checks, only resolved directory differs.

GET    .../tree?path=                       one workspace level, per-entry git status
GET    /api/conversations/:id/edits/:toolCallId?path=   what a call did to a file
POST   .../entries                          { parent, name, kind } -> creates a file or directory
POST   .../entries/move                     { from, to } -> renames or moves
DELETE .../entries                          { path }
GET    .../file?path=                       file text content with disk fingerprint
GET    .../file/raw                         raw content: images, PDF, audio/video (Range), 3D models
PUT    .../file                             { path, content, fingerprint } -> 409 if disk changed
GET    .../commits?limit=                   latest branch commits with references
GET    .../commits/:hash/diff               what a commit changed
GET    .../git/status                       index, working directory, conflicts, upstream, active operation
GET    .../git/file-diff?path=&area=        file diff in index or working directory
GET    .../git/branches                     local (ahead, worktree) and remote branches
GET    .../git/stashes                      repository stashes
POST   .../git/stage | unstage              { paths? } -> entire directory if no paths
POST   .../git/discard                      { paths } -> index version, or deletion if untracked
POST   .../git/commit                       { message, amend?, stageAll? } -> { hash, shortHash }
POST   .../git/branches                     { name, from?, checkout? }
DELETE .../git/branches                     { name, force? }
POST   .../git/checkout                     { ref } -> local branch, remote (tracking), commit (detached)
POST   .../git/merge                        { ref } -> { conflicts } ; conflict is not an error
POST   .../git/abort | continue             active operation (merge, rebase, cherry-pick, revert)
POST   .../git/fetch | pull | push          pull { rebase? }, push { force? } using --force-with-lease
POST   .../git/stash                        { message?, includeUntracked? }
POST   .../git/stash/apply | pop | drop     { index }
POST   .../git/revert                       { hash }
POST   .../git/reset                        { hash, mode: soft | mixed | hard }

GET    /api/agents                          per-CLI capabilities and available models
GET    /api/health                          daemon state, active sessions, RSS

WS     /api/ws                              multiplexed journal and statuses
GET    /api/projects/:id/terminals          open project terminals
POST   /api/projects/:id/terminals          { conversationId? | cwd? } -> opens shell; cwd comes from session
                                            (including worktree), a project worktree,
                                            or default workspace
PATCH  /api/projects/:id/terminals/:tid     { title }
DELETE /api/projects/:id/terminals/:tid

WS     /api/projects/:id/terminal?terminalId=   pty, dedicated socket (section 10)
```

`GET /api/conversations/:id/events` is the catch-up route. Paginated, used for
initial loading (`after=0`) and after long disconnections.

### WebSocket

One connection per tab at `/api/ws`, multiplexed so clients can follow several
conversations.

`status` bypasses subscriptions: sent for every conversation readable by the
account, subscribed or not. Sidebar shows unopened rows without journals to fold
for state; subscribing to every stream would replay that many journals for a dot.
Read access is rechecked on every push, and reconnection rereads the list instead
of waiting for the next transition.

Client to server:

```ts
{ t: 'subscribe',   conversationId: string, afterSeq: number }
{ t: 'unsubscribe', conversationId: string }
{ t: 'ping' }
```

Server to client:

```ts
{ t: 'event',   conversationId: string, seq: number, ts: number,
                type: string, payload: unknown }
{ t: 'status',  conversationId: string, status: ConversationStatus }
{ t: 'catchup', conversationId: string, fromSeq: number, toSeq: number }
{ t: 'pong' }
```

**Reconnection sequence.** Client keeps latest `seq` per conversation in memory
(and IndexedDB), then sends `subscribe` with that cursor on reconnect. Beyond
500 missed events, server returns `catchup`, switching client to paginated REST
rather than flooding the socket.

Application heartbeat every 25 seconds (`ping`/`pong`), automatic reconnect with
exponential backoff capped at 15 seconds, immediate reconnect on browser `online`
and `visibilitychange`. The latter matters on mobile, where screen-off kills sockets.

---

## 9. Worktrees

Three choices when creating a conversation:

1. **Project root.** Agent works directly in `workspace_path`.
2. **Existing worktree.** Known project worktrees with branches.
3. **New worktree.** Branch name and base ref. Sillage runs
   `git worktree add <path> -b <name> <baseRef>` with `<path>` under
   `<data>/worktrees/<project_id>/<name>`.

Do not delegate to `claude --worktree`: Codex lacks it, and Sillage must know
worktree locations to list/clean them. Management belongs to Sillage, identical
for both CLIs.

Deleting a worktree first displays its `git status --porcelain`. Uncommitted
changes require explicit confirmation. Attached conversations become read-only
instead of being deleted.

---

## 10. Terminal mode

Real terminal, not command emulation. `node-pty` server-side, `xterm.js` client-side
with `fit` addon.

**What this terminal is not.** It does not show the CLI interface. Agent processes
launch headless through SDK (`--input-format stream-json --output-format
stream-json`, piped stdio): nothing is drawn, no screen to mirror. A “CLI / Web”
switch would require launching real TUI in a pty and deriving structured data
through hooks, replacing I2/I3 with a screen buffer. Rejected.

**Status.** Pty, socket, and `xterm` component are written and checked, but view
is not mounted: its toggle below input misleadingly suggested this switch.
Terminal will return in the tools side panel with git-colored explorer,
tabbed editing, and agent change history.

- Terminals belong to the **project**, not conversation: pty is a process living
  in a directory; session indexing made servers in archived conversations' shells
  unfindable. Opened from session, shell uses its directory (including worktree);
  from project view, workspace. One list per project, tabs identify shell location,
  sidebar marks projects with live shells.
- PTYs survive client disconnection (I1) with the latest 128 KB buffered for replay:
  closing a tab does not interrupt commands.
- Automatic closure after `limits.ptyIdleTimeoutMin` inactivity (default 60 min),
  only at prompt: shells with running children (dev server, build) are not idle
  and reset the deadline.
- Processes do not survive daemon restart, an intentional choice against tmux
  complexity. Metadata and last screen do (`<data>/terminals/`): entries reappear
  marked “interrupted”, readable, restartable in same cwd.
- Dedicated socket (`/api/projects/:id/terminal`), separate from journal: shell
  output is not conversation content, never stored in database, and its throughput
  would put thread events behind kilobytes of build output.
- Mobile helper keys: `Escape`, `Tab`, `Ctrl+C`, `Ctrl+D`, arrows. Otherwise path
  completion and command interruption would be impossible.

### 10.1 Copy/paste

Most web terminals fail here for two combined reasons, both checked in a real
browser over local-network `http://`:

- `navigator.clipboard` is absent outside secure contexts. Copy must use
  `execCommand('copy')` fallback; clipboard **reading is impossible**.
- xterm sets `user-select: none` on rows and manages selection itself, making
  phone long-press ineffective.

Selected approach gives each gesture a path independent of `navigator.clipboard`:

- CSS makes xterm rows natively selectable (`.sg-terminal`), restoring system gestures;
- **selecting copies**, like PuTTY, with explicit `Ctrl+Shift+C`; insecure-context
  fallback uses an offscreen textarea and `execCommand('copy')`;
- **`Ctrl+V` pastes** through native browser paste received by xterm's textarea,
  the only universally working route; literal `Ctrl+V` (0x16) is sacrificed.
  Right-click pastes through `readText` when available, otherwise opens browser menu.

Terminal provides a full shell under your user account. Intentional and consistent
with the trusted-circle model, stated explicitly in README.

---

## 11. Remote control

**Rejected after verification.** Remote Control is unreachable from headless SDK
sessions; an ineffective switch would be worse than none.

Measured on installed CLI:

- `extraArgs: { 'remote-control': '<name>' }` is **accepted without error**:
  session starts/responds normally. But no process appears (272 before/after),
  local daemon (`~/.claude/daemon.log`) records nothing. Flag is ignored.
- `applyFlagSettings({ remoteControlAtStartup: true })` is accepted/observable:
  `initializationResult()` changes `remote_control_auto_enable` from `false` to
  `true`. But it does what the name says; no bridge starts for an existing session.

Consistent with the feature: Remote Control connects an **interactive** TUI session
to claude.ai for another application to drive. Headless sessions have no TUI to connect.

`remoteControl` was therefore removed from `ClaudeConfig`: ineffective configuration
is dead weight. Adding it back if SDK exposes a bridge costs three lines.

Codex `codex remote-control` manages an entire **app-server daemon**, not a session:
an alternative deployment mode, not per-conversation setting.

---

## 12. Frontend

### 12.1 Routes

```
/login
/                       redirect to last project or home
/p/:projectId           project conversation list
/p/:projectId/c/:convId conversation view (Chat | Terminal | Diff)
/settings               profile, theme, density
/settings/projects      project management
/settings/users         admin only
```

### 12.2 Screen structure

Desktop: collapsible sidebar and conversation area. Conversations list under
projects in manual rather than chronological order: both have a `position` column
rewritten in bulk by drag/drop. Rewriting all positions avoids gaps/ties eventually
caused by individual moves.

Sidebar collapse persists across sessions (`localStorage`), leaving a top-left
restore button. Initially it had a dedicated gutter, a column its width: a full-height
empty strip for a 40 px button. Views with headers now reserve space inside their
header, making it a toolbar control instead of floating object. Other views center
content and let it pass.

Collapse is published by a small store (`lib/sidebar.ts`) instead of context:
views needing it are not in the sidebar branch, and prop drilling would cross
the whole shell for a CSS class.

**Handle-adjustable width**, right edge, desktop only. Sidebar starts at window
left, so pointer x *is* desired width: no initial gesture state needed. Value
writes to CSS variable rather than React state, like visual viewport height:
drag emits an event per frame, and rerendering conversation list each time would
make the handle sluggish. `localStorage` writes only on release. Left/right arrows
do the same in 16 px steps, otherwise resizing would be mouse-only. Bounds:
200 px, below which titles cannot fit, and 480 px.

Mobile drawer keeps base width (`--sidebar-width`); handle changes only
`--sidebar-desktop-width`: keyboard-selected widths may exceed a phone, and
an overlay drawer has nothing to adjust anyway.

**Double-click names to rename**, alongside menu entry. Current name is preselected:
usually replacing an entire CLI-proposed title, while an end-of-line cursor forced
manual deletion. First click still navigates because target is a link; opening
what one renames is harmless.

**Two levels, two typographic treatments.** Projects are bold/full ink;
conversations smaller/muted. Same size/color left indentation as the only hierarchy
cue, making navigation look flat. Open conversation returns to full ink because
selection outranks hierarchy.

Mobile: no sidebar. Compact header with conversation name and a button opening
fullscreen list. Thread metadata (model, worktree, provenance, usage) collapses
behind chevron: four squeezed chips are unreadable at 390 px and consulted only
occasionally.

**Application is a fixed layer sized to visual viewport**, shifted upward by
`visualViewport.offsetTop`; document itself never scrolls (`overflow: hidden` on
`html`/`body`). Keyboard opening compresses/pushes everything upward rather than
covering input: `100dvh` remains full-screen height, and only `visualViewport`
follows keyboard. Each view therefore owns its scrolling.

**Device notches use variables** (`--sg-safe-top`, `--sg-safe-bottom`) fed by `env()`,
not direct calls. Two reasons from real defects: fixed-height bars must *add* notch
to height, impossible with a utility alone; values are zero in browser but nonzero
in installed PWA, so naming enables replaying iPhone geometry on dev machines
instead of discovering offsets after installation.

**Fixed-height bars extending under notches cannot use `pt-safe`.**
`h-[var(--header-height)]` and `pt-safe` on one element do not combine: box stays
52 px, content shifts 59 px, overflowing *below* bar where view covers it. This
broke installed-PWA header but remained invisible in browsers with zero notch.
`header-bar` adds notch to height instead of subtracting from content.

Reserve a notch **once, by the element actually touching the edge**: workspace
panel, even fullscreen, sits below shell header already reserving top notch,
so must not reserve it again. Double reservation created 59 px of blank space
mid-screen.

**Layer height is imposed only while keyboard is open.** It previously always
used `visualViewport.height`; installed PWAs report shorter visual viewport without
keyboard, leaving blank strip below input. Below 120 px difference, remove measure
and use `100dvh`; beyond it, keyboard shrinks the layer as before.

**No zoom on field focus.** iOS zooms input text below 16 px and never zooms back,
leaving shifted pages and unwanted horizontal scrolling. Two protections because
neither suffices: viewport `maximum-scale=1`, plus 16 px fields on coarse pointers.
Rule lives **outside all CSS layers**: Tailwind utilities set text sizes, overriding
rules placed in `@layer base`.

**Turn navigation.** Two arrows right of thread jump between user messages;
reached message gets a fading ring. Target derives from **scroll position**, not
visible turns: after jumping, previous turn stays visible because its region extends
to next message; starting from first visible always returned to same place.
Side ruler (section 12.2bis) appears only above 40rem and requires targeting a
two-pixel line, useless by touch. Each control reserves its gutter, otherwise
covering line endings.

**Translation transitions target `translate`, not `transform`.** Tailwind v4
translation utilities use distinct CSS `translate`; transitions on `transform`
do nothing, making drawers jump edge to edge. Verified by tracing positions frame
by frame, not reading classes.

### 12.3 Composer structure

Multiline input plus compact controls accessible to the thumb:

- Model selector
- Effort selector
- Permission-mode selector (Claude), or collaboration mode, approval, sandbox (Codex)
- Attachment button
- Context-window occupancy gauge
- Send button becoming Stop during execution

**Settings collapse when composer is narrow.** Below 34rem composer width, selectors
become one button opening a bottom sheet with named fields. Button shows **all**
setting states, not only model (“Sonnet · Medium · Ask”): collapse must not hide
state, forcing sheet opening to know work mode. Overflow text truncates, keeping
useful order first. Four Codex chips previously consumed phone bar, pushing Send
offscreen. Threshold uses composer (`@container`), not window: width also depends
on sidebar. One descriptor renders both forms to prevent drift. Settings removing
guardrails tint the button so they remain visible.

**Queue.** Typing during a turn does not block input: message queues **server-side**
and displays below activity indicator, its position explaining that agent has not
read it yet. Messages send automatically at turn end, one at a time, removable
before sending.

Queue lives server-side, not CLI: messages pushed mid-turn are consumed immediately
there. That is precisely steering below, not ordinary sending. Sillage therefore
provides determinism and identical defaults for both CLIs.

Queue is in memory: messages never reaching CLI need not survive restart. Journal
still records enough for clean recovery closure (`EventLog.openQueuedMessages`),
otherwise replay would show them queued forever.

**Steer active turn.** Message is taken **immediately** inside existing turn,
rather than waiting like queue. Both CLIs support it through unrelated mechanisms.

| | Mechanism | Guaranteed folding into turn |
| --- | --- | --- |
| Codex | `turn/steer` with `expectedTurnId` | yes |
| Claude Code | `priority: 'next'` on streamed message | no |

Codex `expectedTurnId` is a protocol precondition: if turn ended between button
display and click, request fails as intended. `review`/`compact` turns reject
steering (`activeTurnNotSteerable`).

Claude has no dedicated request: ordinary message stream carries it, `priority`
determines placement. `next` (also default) folds it into current turn at next
tool-batch boundary, prefixed to model with “The user sent a new message while you
were working”. `later` waits for next turn. Two limits: folding only at tool-batch
boundaries means final-answer drafting completes before a new turn opens; stream
never says which happened. SDK exports field without comment and documentation
still describes strictly sequential queue: `pnpm steer:probe` established behavior
and can recheck it at next bump.

The gestures differ, so user chooses: queue defaults, steering explicit, refusals
shown as `steer_unavailable` instead of secretly queuing. Offered in two places,
second primary: composer button while typing, and **Steer now** on each queued
message. First alone was insufficient because it depended on draft text and vanished
as sending cleared input. Steering dequeues with `message.dequeued` reason
`steered`, distinct from `sent`.

Dequeuing needs a CLI round trip; message must not remain exposed to turn-end
`flushQueue`: remove before call, restore exact position on rejection.

Verified end to end with real CLIs. Codex: turn about tides steered to volcanoes
produces **one** `turn.started`, two user messages, volcano response, **no**
`message.queued`; same turn ID, app-server echoes `userMessage` item, already
ignored by translator to avoid duplicates. Claude: turn planned for three slow
commands, steered during first, stops afterward and answers requested word,
with **one** `turn.started` and **one** `turn.completed`.

**Draft survives conversation changes.** Composer remounts by conversation key,
so text and uploaded attachments live outside React (`lib/composer-drafts.ts`),
indexed per conversation and restored on return. Uncreated threads use project
as only available key.

Drafts do not persist across sessions: attachments are uploaded-file IDs reclaimed
as orphans server-side, so post-restart drafts would reference missing files.

**Status strip below input.** Shows two facts absent from header: connection state,
and whether a CLI process remains running for this conversation (`warm`). Status
alone cannot reveal the latter: idle conversations may keep loaded sessions or
let them expire, making next message pay CLI restart/context reload costs.

Settings take effect next message and write to `conversations.config`. Mid-thread
model changes appear as discreet separators.

**`@` mentions.** Typing `@` opens working-directory files
(`GET /api/projects/:id/files`) with subsequence matching: `wsx` finds
`web/src/index.tsx`. Search uses `git ls-files --cached --others --exclude-standard`,
with nonrepository traversal fallback. Sillage performs it rather than CLI:
otherwise completion would need a process and offer nothing before conversations start.

Both CLIs inject mentions differently, hence an abstraction: paths travel beside
text, each runner applies them its way.

- **Claude Code** expands text `@path` itself. Installed-CLI check asked about
  mentioned file with all tools denied: response arrived without tools.
- **Codex** expects separate `mention` input (`UserInput`) and expands nothing itself.

Only list-selected paths are sent: manually typed `@something` need not be a file,
and Codex rejects nonexistent mentions. Server resolves paths, rejecting anything
outside working directory.

### 12.4 Content rendering

- Markdown through `markdown-it`, `html: false`: model raw HTML is escaped, not interpreted.
- Document splits into segments: code blocks/tables become React components owning
  toolbars; everything else remains markdown-it HTML. Recreating them manually
  afterward in DOM stops working once state is involved.
- Code blocks: on-demand `highlight.js`, **per-block** wrapping, copy, download
  with language-derived extension. No automatic language detection: short snippets
  often misclassify, and wrong highlighting is worse than none.
- Highlight palette uses theme tokens, not a premade stylesheet ignoring light,
  dark, and contrast themes.
- Tables: full width, wrapper horizontal scrolling keeps columns aligned,
  RFC 4180-compliant CSV export.
- Task lists `- [ ]` / `- [x]` render as real disabled checkboxes.
- Thread is not virtualized: each item memoized, fold renews only changed objects,
  sufficient without variable-height virtualization scroll jumps.
- Text deltas apply in 60 ms batches, not per-token `setState`, which drops phone framerate.

### 12.4bis Account usage

A header **Usage** button opens the equivalent of `/usage`: account quota gauges,
not conversation gauges.

| | Source | Nature |
| --- | --- | --- |
| Claude Code | `get_usage` control request | named and per-model windows |
| Codex | `account/rateLimits/read` | counters by `limit_id` |

**Normalized format is a list, never named fields.** Installed-CLI probe currently
returns `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`,
`seven_day_oauth_apps`, about ten still-null code-name keys (`tangelo`,
`iguana_necktie`, `cinder_cove`...), and `model_scoped`, where Fable's release added
its own gauge. Fixing a list would require rebuilds for every addition and silently
hide unforeseen ones.

Reading traverses everything, retains window-shaped values (rate, reset date),
ignores the rest without naming it, displays unknown keys with original names
instead of discarding them. Model-window labels come already written from server.

SDK API is `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`; documentation
warns shape may change without notice, so normalization presumes nothing and cannot
fail for missing fields. Probe failure removes only usage from UI.

Two display choices not from CLI: alert thresholds (75%/90%), and unknown rates
rendering no bar instead of empty bars falsely asserting zero. Credit amounts
appear only when payload supplies decimal scale: showing 4250 for €42.50 would
be worse than showing nothing.

Each read starts a CLI process, hence one-minute server cache and explicit refresh
button bypassing it.

### 12.5 Tool-call rendering

One collapsed strip per call: icon, name, one-line summary (`Read` path, `Bash`
command), state (running/succeeded/failed/duration). Expanded: readable call view,
native payload one click away.

**What collapsed rows say.** Call **description** takes precedence: it states intent,
while command/path only explain how. Claude includes descriptions on Bash/subagents;
“Read commands section context” beats truncated `sed -n '334,364p' CLAUDE.md` or
three-line subagent prompts. Not guaranteed: Codex produces none, so identifying
parameter (command/path/pattern) takes over. Sentences use text font, code fragments
monospace. Command is never lost: it stays below expanded call input.

**Thread separation.** Threads show only their author's work. Anything with
`parentToolCallId` leaves main thread: mixed with agent replies it appears to be
the parent's speech, and parallel subagents become inseparable. Main thread keeps
only spawn call, always its own row, never a collapsed group: only marker that a
whole part happened elsewhere. Instructions/report stay in its card, one click
away, with access to full thread (section 12.11).

**Running-subagent strip.** Between thread and input, outside scroll flow.
Subagents run for minutes while main thread stays still: in-flow indicators left
screen when scrolling upward, making conversation look idle. This defect motivated
the split: only remaining sign of life was collapsed-group tool count. Strip
expands to active subagents; each row opens its thread.

**Grouping.** Consecutive completed calls collapse into one row counting calls
and failures: collapsing must never hide errors. Active calls keep individual
chronological rows and join group on completion. Nonrendered items (agent messages
containing only `tool_use`) do not break sequences.

Groups do not dissolve while a later call runs. Previous rule expanding entire
sequence until all calls finished caused two defects with no benefit: expansion/
collapse on every call made thread jump with no readable rule; manually opened
groups closed because disappearing rows lost component open state. Users need
current call, not its ten predecessors.

**Open calls close at turn/session end** with “interrupted”, distinct from failure:
interrupted CLI sends no in-flight results, otherwise calls stay running forever,
even after reload. A `Task` once advertised an active subagent with timer days
later. Late `tool.completed` takes over unconditionally.

**Renderers.** `Map<toolName, ToolView>` gives tools views explaining what happened,
not CLI representation: highlighted shell command/output for `Bash`, content without
`cat -n` gutter for `Read`, replaced/replacement snippets for Claude `Edit`, real
line diff for Codex `Edit`, checked task list for `TodoWrite`, Markdown instructions/
report for subagents.

Three levels, precise to safe: dedicated view, generic payload formatting (short
fields in lists, long fields in blocks), raw. Views choose fallback at runtime,
not merely name presence: `Edit` is not guaranteed its usual fields, and CLI
versions may change them. Unrecognized input returns `null`, never guesses.
This supports “all tools” without maintained tables: unknown MCP server gets
generic view, never nothing.

**Raw is one click away.** *Readable / Raw* toggle on expanded calls shows stored
input/output. Not a degraded mode to hide: only way to verify views and retrieve
fields considered secondary. Views may choose what they show, never be the only
consultable representation.

**Payload highlighting.** Input is JSON and highlighted accordingly. Output may
be JSON or text; nothing guessed: strings highlight only if call declares source
file, whose extension supplies language (highlight.js resolves `ts`, `py`, `rs`...
aliases, no maintained table). Command output stays plain. Above 100 KB, skip
highlighting: parsing large read files would block thread execution.

No migration required: native payload stays in database (I3), so newly added views
apply to yesterday's conversations.

### 12.6 Design and themes

**Brand: L’écho.** Three solid parallel waves extend a movement: trace of work,
continuity of exchanges.

Interface symbol uses `currentColor`, following selected hue. Standalone icons
show white symbol on indigo #535CDA tile, default app accent.

Paths necessarily have several copies because favicons/README headers load as
images inheriting no tokens: `docs/brand/README.md` records copies and update rules.

Visual language: clean, very light gradients, hierarchy through spacing/typography
rather than borders/shadows.

Everything uses CSS variables, no hardcoded component colors:

```css
:root {
  --bg-base, --bg-raised, --bg-overlay
  --fg-primary, --fg-secondary, --fg-muted
  --accent, --accent-fg, --accent-subtle
  --border-subtle, --border-strong
  --success, --warning, --danger
  --gradient-canvas         /* application background */
  --gradient-surface        /* signature gradient on elevated surfaces */
  --radius-sm/md/lg, --shadow-sm/md
  --font-sans, --font-mono
}
```

Themes are JSON objects of these variables. Three supplied (light, dark,
high-contrast dark), plus custom theme in `user_settings`. `data-theme` on `<html>`
applies before hydration to prevent light-theme loading flash.

**App background.** Two diffuse halos over slightly graded base. Bottom halo hue
shifts 45°, like accent gradient, adding depth without becoming a color itself.
Three appearance controls still drive it: `hue` directs halos, `tint` controls
chroma, `lift` changes only base so halos do not brighten along with surfaces.

Contrast theme has none: readability comes from strictly flat surfaces;
`--sg-gradient-canvas` is `none`. Underlying `background-color` becomes actual background.

Accessibility: minimum AA text/background contrast in supplied themes, minimum
44 px touch targets, respect `prefers-reduced-motion`.

**Syntax palette selected in settings.** Ten palettes (Sillage, Océan, Nuit,
Agrume, Cerise, Forêt, Sable, Ardoise, Sobre, Encre), each light/dark, remembered
on device like theme. Each overrides only seven `--sg-syn-*` tokens: rest of UI
stays unchanged while code throughout thread, tools, diffs, editor follows together.

Choice uses `data-syntax` on `<html>`; default is obtained by **removing** attribute,
not duplicating values. Same pre-hydration script as theme avoids first code
block briefly using default before recoloring.

Selectors are not rooted at `:root`, ensuring honest preview: each button has
both attributes and actual palette colors without changing app. Preview snippet
contains all seven roles, strings/templates included, avoiding partial impressions.

Selector is a **grid**, not wrapping list; selection check reserves space even
when absent. Otherwise choosing palettes rearranged others at click time.
Checked positions relative to document after all ten selections.

Contrast theme always keeps its own palette and says so: contrast is its purpose,
and mood palettes would defeat it. Same reasoning as disabled hue/intensity.

### 12.7 Creation screen

CLI choice uses two cards, not dropdown: most consequential choice, only two,
each bearing a descriptive distinguishing sentence, not promotion. Both share
journal/interface; difference is elsewhere.

Working-directory options likewise remain expanded. Dropdowns hide possibilities
until opened and never show options side by side; a few explanatory options
(current branch, worktree status) cost a few lines and avoid opening. Beyond
half a dozen, dropdowns regain advantage, explaining their use elsewhere.

Both keep checkmark space permanently reserved: appearing on click would shift
labels while targeting.

### 12.8 Settings

Categories each have a route, shareable/bookmarkable and traversable by phone Back.
One page stacked unrelated cards, extending scroll with every setting.

Two layouts, one route tree. Desktop list is left column with section beside it;
`/settings` redirects to first section to avoid empty right column. Touch list
**is** the page; opening category replaces it with a Back link.

Redirect depends on actual width, not `hidden` class: CSS-hidden components stay
mounted, so mounted redirects execute, causing phone list to redirect itself.

**About.** Last category, visible to all: installed/latest versions and all releases'
notes since installation (unchanged from GitHub, in English). Discreet icon dot
indicates update without toast: waiting, not pressuring. Update action is admin-only,
only on `installer` channel; Docker shows equivalent `docker pull`. During updates,
progress polls `/api/system/update/status`, then client polls `/api/health` until
new version responds and reloads.

**Reading comfort.** Three controls affect message text only: size, line height,
ink softness. Enlarging conversation must not shift sidebar/input, so they live
on Markdown-render class, not document root.

Softness mixes ink toward muted tone (`color-mix`) rather than lowering opacity:
translucent text reveals background, making identical messages differ inside/
outside bubbles. Addresses harsh pure white on very dark background over long reading.

Same mechanism as hue/brightness: CSS variables on `<html>`, `localStorage`,
applied before hydration by `index.html` script kept aligned with
`APPEARANCE_SETTINGS`. Reset only affects visible sliders: typography reset must
not remove hue chosen elsewhere.

Preview is a fake conversation reusing real thread components, including bubble,
not a diverging imitation. No props needed: settings on `<html>` apply naturally.

**CLI defaults.** New-conversation settings: Claude model/effort/permission mode,
Codex collaboration/approval/sandbox, active MCP servers. Complete set per CLI,
never shared settings: safeguards are different concepts, not two names for one.

Account setting, not instance setting unlike archiving: permission modes concern
who reads replies, and project teammates need not share safeguards. Stored in
`user_settings`, read by `GET /api/me/settings`, replaced per CLI through `PATCH`.
No changes to existing conversations, each retaining configuration: changing defaults
must not alter open threads under users' hands.

Screen uses composer's categories and source (`useAgentSettings`): settings exactly
match what appears there, expanded as dropdowns instead of behind a single-line
trigger. Additional directories excluded because project-specific.

Server uses defaults wherever conversations lack explicit configuration: Claude
CLI session import, final `/api/v1` cascade tier (request, token, project preset,
then owning account defaults).

**Skills.** Global library (`/settings/skills`) delivered as native skills to all
conversations in both CLIs. Visible to all so users know what agents receive;
admin-editable like MCP registry. Project skills live on project page, editable
by owner, alongside read-only repository skills (`.claude/skills`, `.agents/skills`)
and CLI visibility.

Skills open full-width (`/skills/:id`), shared between scopes: settings column
is too narrow for instructions/supporting files. Edit name, description,
`SKILL.md` body, supporting files, read Claude/Codex compatibility differences.
Writes immediately affect open sessions. Behavior/rationale: `docs/skill-library.md`.

Below library, sources: git repositories (preconfigured anthropics/skills,
openai/skills; others admin-added or found on skills.sh). Browse catalog/review
raw `SKILL.md` and files before installation into a scope. Install is commit-pinned
copy; source advances announce updates, reviewable as diffs before applying.

### 12.9 PWA

- `manifest.webmanifest`: `display: standalone`, 192/512/maskable icons,
  `theme_color` matching active theme.
- Workbox service worker: app-shell precache, `NetworkOnly` for `/api`. Caching
  API responses would contradict journal consistency.
- **Updates announced in `prompt` mode.** `autoUpdate` lets new worker take control,
  but loaded page keeps old code: no notification/reload. Generated registration
  only called `navigator.serviceWorker.register('/sw.js')`. Installed PWA resumes
  memory rather than navigating, so fixes might appear only after full closure;
  “I do not see the fix” was accurate.

  Registration now comes from app, banner announces new version, reload offered
  rather than forced to avoid losing drafts. Periodic recheck (30 min) required
  because installed PWAs seldom navigate, the usual update-check trigger.

  Verified by serving two distinct builds: old page stays until checked, banner
  appears after check, reload brings new code, no banner without changes.
- **Installed version shown in settings.** Without it, “I do not see the fix” cannot
  be resolved because screen never identifies running version.
- Offline: shell loads explicit “offline” state with latest IndexedDB messages
  read-only.
- Web Push/VAPID for two events: waiting permission or completed conversation.
  Makes mobile practical: launch task, put phone away, get called when needed.
  Planned batch 5, not v1.

### 12.10 Search

Palette (Cmd+K, Ctrl+K, sidebar entry for touch) reaches projects, conversations,
message excerpts, files, tickets, scheduled tasks, skills, MCP servers, settings,
and commands (new conversation, board, theme).

**No filters to configure.** One input, results grouped by project then “General”.
Groups sort by best result, current project wins ties; named items precede files,
files precede message excerpts because every repository has a matching file.
Project names restrict (“nimbus cache”) or alone list conversations; types (“skill”,
“ticket”, “mcp”) list that type. Groups show five rows and expand; Tab advances
groups. Empty input is quick switcher: recent conversations, current project first.

**Same fuzzy matching on client/server** (`packages/protocol/src/fuzzy.ts`),
otherwise server might discard files palette would rank first. Each query word
matches independently in best field. Three modes: scattered letters for short
identifiers (`cmdpal` → `CommandPalette.tsx`), chunks/initials for phrases
(`aocf` → “Add offline caching for”), one chunk for descriptions. Jumps land inside
words only while staying in same word; required mean score per letter rises with
text length. Otherwise long camelCase always assembles any input, and “power”
matched `ApprovalsReviewer.ts`. Like VS Code, filenames use scattered letters,
directories contiguous matching; slash separates like space (`web/pal`).

**In-memory data responds immediately.** Projects, conversations, tasks, MCP servers
come from navigation lists; all-project tickets/skills from lightweight catalog
reread on open. Only files (2+ characters) and message content (3+) use server
after input settles. Server caches directory file lists 15 seconds: typing causes
several searches, and running `git ls-files` in every project per letter repeats
work. Worktree conversation searches its project in that worktree where files open.

**Files open in panel**: open conversation's panel if same project, otherwise
project's usual home (board/draft), preserving its view. Focus goes to editor,
not panel button.

**Index is derived, never a source** (I2). FTS5 `search_messages` feeds inside
journal write transaction, so cannot contain absent messages. Three shipped consequences:

- extraction written **once in SQL** for incoming messages, fork-copied threads
  (bypassing `append`, otherwise unfindable), full rebuild;
- explicit deletion because virtual FTS5 receives no `ON DELETE CASCADE`:
  deleted conversations/projects and cascaded threads;
- `pnpm --filter @sillage/server search:reindex` clears/replays, catching existing
  content when indexing changes.

Indexed content: main-thread `message.completed` text blocks only. No streaming
deltas duplicating unfinished content, reasoning, tools, or subagent writing,
which lives in panel without `?seq=` anchors for search results. This exclusion
is a measured volume decision, not convenience: even sparse databases average
3.4 KB per `tool.completed` versus 0.4 KB per message; indexing tool output indexes
read files' contents.

Three query safeguards:

- **Visibility enforced in SQL**, not afterward: private excerpts reaching HTTP
  layer would already leak if a future filter were forgotten. Joining
  `conversations` also hides orphan rows;
- input **quoted term by term** before FTS5 syntax, last term prefixed for ongoing
  typing. Otherwise `"`/`-` inside phrases fail whole query;
- excerpts bounded by two control characters, not markup. Database HTML would
  require trust; markers split into plain text.

Tokenizer: `unicode61 remove_diacritics 2`, so “reglage” finds “réglage”. Ranking: `bm25`.

**Results open messages, not threads.** URL carries `?seq=`, view scrolls to message
with existing turn-jump ring. Entire journal loads already, so no partial-loading
mechanism needed until genuinely long threads make full loading problematic.

Archived conversations are excluded, as elsewhere: search sees what navigation sees.

**Search open thread** (Cmd+F/Ctrl+F, conversation-menu entry also for shared-thread
readers). Entirely client-side: thread fully loaded, so server requests would
refetch visible data. Shortcut replaces browser search, which cannot count/jump
occurrences in independently scrolling containers; browser menu still reaches it.

Search uses **DOM**, not folded items, to find Markdown-rendered text and tool
content. Visible text is reconstructed with a table mapping positions to original
nodes/offsets, so terms split by `<strong>` still match. Accent folding is per
character: “é” decomposes into two, and global normalization would shift later
positions and misplace highlights.

Highlighting uses **Custom Highlight API**, coloring ranges without document
mutation. Injected tags would break Markdown/code rendering. Where unavailable,
scroll alone locates occurrence.

**A broader defect found along the way.** Ranges on user messages collapsed because
browsers reanchor ranges when text nodes leave document. Root cause: `fork` function
recreated each render and passed directly to user bubbles, breaking memoization
and redrawing entire thread per scroll event, precisely what `MessageBubble`'s
`memo` should prevent. Function is now stable; search rereads occurrences if one
collapses because active turns may still change thread.

### 12.11 Workspace panel

Expandable third column right, handle-resizable and remembered like sidebar.
Cannot coexist with thread in 390 px phones: becomes fullscreen from conversation header.

Follows open **conversation's** working directory including worktree, not project
root: that is where agent writes.

**Sliding open/close**, like navigation drawer: touch translation overlays thread;
desktop closes margin where it occupies a column. Panel stays mounted until offscreen,
then disappears: live terminals/tree requests should not remain behind closed panel.
Entry starts only on render after mount because elements born in place cannot transition.

**Tab bar never pushes out actions.** Tabs scroll; refresh/close sit in nonshrinking
block. Touch labels previously pushed cross offscreen, preventing closure. Labels
need more than phone/default panel width, so below threshold only active tab keeps
name, identifying location without scrolling. `aria-label`/`title` retain names
when unwritten. I2 does not apply: files/diffs are live disk state, not events;
panel reads disk, never writes journal.

Intentional effect: composer collapses by container width (`@container`), so opening
panel switches settings to sheet without more code. Measured 416 px composer on
1024 px window with sidebar/panel open.

**Explorer.** One level per request: expanding `node_modules` at once weighs
megabytes. All paths bounded to workspace like `@` mentions, otherwise `..` gives
shared-project users whole-machine browsing. `.git` hidden, other hidden files
visible: `.gitignore` is ordinary content.

Colors derive from one `git status --porcelain -z --untracked-files=all
--ignored=matching` for entire repository. Per-file calls would be ruinous across
hundreds of entries. **Folders carry most significant descendant status** so users
need not expand everything: changed files propagate status to all ancestors.
Letters (`M`, `A`, `D`, `?`) duplicate colors, difficult to distinguish and impossible
for some color perception.

**`ignored` alone does not propagate upward.** Previously `node_modules`/`dist`
anywhere grayed every ancestor to root, making genuinely changed folders appear
unversioned. Ignored children say nothing about versioned parents; only directories
git itself marks ignored are ignored.

**File icons**: VS Code `material-icon-theme` with official mapping (1,378 extensions,
2,131 exact names such as `package.json`/`Dockerfile`, 4,654 directory names including
open variants). No handwritten table. `pnpm icons:sync` copies 1,250 SVGs to static
`public/file-icons`: bundling would add 240 KB compressed for icons shown a handful
at once, and worker precache would download all per update (`globPatterns` omits
SVG). Only mapping enters bundle, ~50 KB compressed in panel chunk.

**File operations**: create, rename, move, delete files/directories. Rename/move
share **one route** differing only in destination; separate routes force UI to
choose from path. Drag/drop also moves; dropping files on parent directory is supported.

Four server-side rejections: paths through `.git` (hiding tree is no guardrail;
renaming git storage destroys history), occupied destinations, directories moved
inside descendants, root deletion. Workspace boundary reuses external-mention
rejection, colocated with protected resolution. Visibility checks were factored
out of three copied panel routes, three chances to forget them.

Refresh at **turn end**, when tree truly changed, plus button. No polling: mid-turn
files change per write, rereading per event would flicker without useful knowledge.

**Git tab.** Actual repository and everyday operations without terminals or asking
agents to commit. Header branch/upstream/ahead with fetch/pull/push, then four
remembered collapsible sections: changes (conflicts/index/unstaged/commit form),
branches, stashes, commits. Uses repository `git`, never reimplementation: hooks,
`pull.rebase`, signing, credentials helper behave like shell.

Index shown as two groups, not checkbox abstraction: workflow needs staging to
choose commit content, abstraction leaks on agent's first `git add`. Empty index
offers “stage all and commit”, common outside carefully curated commits.
Messages use git stdin, preserving multiparagraph body; draft survives tab changes
(`sessionStorage`, per scope).

Git rejections get codes when unambiguous; notices offer next-command remedies:
rejected push offers `--force-with-lease`, never `--force`; divergent pull offers
merge/rebase; unmerged branch offers forced deletion; local-change-blocked checkout
offers stash then retry. Conflict-stopped merge is not error: repository enters
“operation in progress” with abort/continue banner and mark-resolved file actions.

Repository actions serialize server-side to prevent `index.lock` from rapid clicks.
Reads use `GIT_OPTIONAL_LOCKS=0` to avoid interfering with agent commits. Destructive
operations (discard, `reset --hard`, drop stash, delete branch) require explanatory
confirmation. No graph: per-commit references say essentials; 390 px graph adds little.

**Permissions.** Every account seeing project can use panel, including writes when
editor/terminals arrive. Consistent with shared projects, but terminal commands run
under daemon Unix account across whole machine, not just workspace: reserve access
to accounts managed by instance owner.

**Explorer gestures.** Folders expand on single click as expected. Files single-click
select, double-click open. Opening immediately filled tabs during browsing and
prevented targeting rename without opening.

Right-click and overflow menus offer same actions. Distinct Radix modules cannot
share elements, so actions described once as data, rendered twice to avoid drift.
“Reference in prompt” inserts `@path` into composer and selected mentions like
completion selection.

**File search.** Separate from level-paginated tree: searching traverses, and
client traversal needs one request per directory. Case/accent-insensitive substring,
not fuzzy: project-tree fuzzy mostly returns noise; users usually type exact
name fragments. Name matches precede path matches, shorter before longer. Traversal
skips dependency/build directories and caps visited entries: working directories
can include network mounts. Truncation is reported, otherwise “no results” would lie.

Results replace tree, not filter it in place: clearing search restores expanded levels.

**Tabs and editor.** Clicking explorer files opens tabs and switches editor:
opening invisibly is pointless. Both views stay mounted so returning preserves
tree expansion and avoids rereading files.

CodeMirror 6 over Monaco: latter twenty times heavier, adding deliberately omitted
LSP/completion. Required features mounted explicitly rather than `basicSetup`,
which includes completion/lint. Languages load on demand like thread highlight.js;
unknown extensions get no highlighting instead of approximate mode.

Official Lezer grammars supplemented with CodeMirror 5 legacy modes
(`@codemirror/legacy-modes`), less precise but one package covers shell, TOML, INI,
Dockerfile, about twenty more. Approximate coloring beats plain white, previously
half a real repository.

Mode derives from **filename**, not Node extension: `extname('.env')` is empty
because dotfiles have names, not extensions. Hence `.env` was white including
comments. Prefix mapping covers `.env.local`, `Dockerfile.dev`, etc.

Theme is handwritten from same `--sg-syn-*` tokens as thread highlighting, using
`var()` not resolved colors, so theme/hue changes affect editor. Browser verified
keyword color exactly matches `--sg-syn-keyword`.

**Tricky part is agents writing same files.** Reads return fingerprint (size/mtime,
provided by system without rereading file); saves send it back; server returns 409
if changed. Otherwise save silently overwrites agent work noticed only later.
Conflict is decision, not failure: reload or knowingly overwrite (`fingerprint: null`).
Verified by real underlying file writes, both branches, disk unchanged until decision.

Binary files (NUL in first 8 KB) and files above 2 MB rejected with reason. Images
render through raw route restricted to closed extension list: arbitrary guessed
binary types invite browser interpretation. SVG receives inert CSP because SVG
documents can contain scripts.

Whole panel loads `lazy`: initial bundle formerly grew from 250 to 365 KB compressed,
paid on every conversation opening for an optional view. Now 110 KB chunk loads
on first click.

**Tabs reorder** by drag/drop, close by middle click; menu offers “Close others”/
“Close all”. Opening order does not reflect usage: related files should group.

CodeMirror search uses our tokens and native `phrases` translation facet: native
white fields/buttons were unreadable in dark. Anchored top instead of consuming
half a narrow panel's bottom. Panel `Ctrl+F` searches file, not thread; otherwise
both searches opened.

Only active tab mounts, avoiding as many live editors as tabs. Unsaved content
of a departed tab is therefore lost; active dirty dot indicates it.

**Changes**, two sections answering different questions.

Top: **repository state**: current branch, affected files/line totals, last commit,
then working-directory diff against HEAD across all authors via `readWorkingDiff`,
truly read-only (temporary index, repository untouched). Last commit distinguishes
empty-diff causes: untouched or just committed. Worktree omitted because header
already carries it.

**Diffs are highlighted**, same `--sg-syn-*` tokens and on-demand library as thread,
extension-derived language, never guessed. Line-by-line: deleted/added lines never
coexist as continuous code. Multiline comments may miscolor, harmless through
`ignoreIllegals` and acceptable for diffs. Red/green backgrounds remain beneath
highlighting to show changes. Written content without comparison (Claude whole
rewrite) is still code and highlighted.

Diff rereads at turn end, **each panel opening**, on request. Opening refresh was
missing: commits while closed left stale precommit diff cached on reopen.

**Two separate modified-file gestures**: row expands inline diff; “Open in editor”
switches Editor tab. Diff stays where diffs belong; editor shows current file.
Previously clicking opened tab without switching, appearing ineffective. Unified
patch splits client-side into sections with two-sided line numbers, no dependency:
git already produces diffs; libraries mainly *calculate* them. Line numbers are
unselectable so copying yields code, not numbered code.

Bottom: **what agent did**, per turn, derived solely from normalized journal
`file.edited { toolCallId, path, action }`. Client guesses from tool names would
violate I3 by teaching frontend each CLI. Group by user message, not `turn.started`:
request gives edits meaning, and event order differs by CLI. Accepted tradeoff:
older conversations lack history because event did not exist.

**Past-turn edits expand to diffs.** Cannot come from git because disk kept changing;
reconstruct from native tool payload kept in `raw`, read by relevant CLI adapter,
not frontend (I3). Repeated file edits in one turn show one file retaining every
call sequentially; keeping last would erase prior ones.

Payload capabilities vary and display says so:

| Call | What can be shown |
| --- | --- |
| `Edit` (Claude) | real diff of **replaced excerpt only**: excerpt-relative line numbers explicitly announced |
| `Write` (Claude), existing file | written content without comparison: previous state unavailable |
| `Write` (Claude), new file | complete diff, all added |
| `fileChange` (Codex) | complete CLI unified diff |

Claude excerpt diff uses longest common line subsequence, the only place Sillage
*calculates* diffs because git supplies all others. Above 2,000 lines, use truthful
cheap whole replacement. Creation/deletion have one side: both CLIs provide raw
content wrapped in git-like format so display knows one format.

**Incidental fix**: creation/rewrite distinction used **asynchronous** disk read
started at call beginning, possibly resolving after write and observing changed
disk; fallback could instead abandon edit if call finished first. Synchronous
`stat` takes microseconds and removes both races.

**What each CLI establishes differs**, visibly:

| | Source | Deletion | Shell writes |
| --- | --- | --- | --- |
| Claude Code | `Write`, `Edit`, `NotebookEdit` tools | no deletion tool | unseen |
| Codex | `fileChange` items and `kind` | yes | unseen (native patch only) |

Claude distinguishes creation/rewrite by checking existence **at call start**,
only time answer remains true. Parsing “File created successfully” would hardcode
English wording CLI may change.

Claude SDK declares ideal `FileChanged` hook (path + `add`/`change`/`unlink`), CLI-origin
and covering Bash writes. Probed on 0.3.220 with `SessionStart`-returned `watchPaths`:
**never fires**, even for files in CLI's announced cwd. Hence tool-based approach
and measured limit: Claude `rm` absent from history, present in current state.
Precisely why both sections coexist.

**Terminals.** Multiple shells per project, on-demand open/close, numbered from open
ones rather than counters: close first then reopen must not produce two “shell 2”.
Manager indexed per terminal so one runs dev server while another runs commands.
Cap 6/project shared in protocol so UI disables button instead of waiting for rejection.

Cwd follows opening session (including worktree), otherwise workspace. Project
deletion closes shells; worktree deletion closes matching cwd shells. REST manages
lifecycle and cap/ID, dedicated socket carries output: creating on socket attach
would add terminals every reconnect.

Terminal survives last-client departure, entry survives process with final screen:
accidental `exit`/crash must not erase readable output. Prolonged inactivity frees
pty. Nothing journaled: shell output is not conversation content; persisting would
grow database without supporting any render.

**Copy/paste decides web-shell usability**, precisely what fails elsewhere.
`Ctrl+C` stays SIGINT, only way to stop commands; copy uses `Ctrl+Shift+C`, paste
`Ctrl+Shift+V`/right-click, universally expected gesture. Browser checked including
mouse selection and important negative test: `Ctrl+C` on `sleep 60` returns prompt
immediately.

**Two defects found by testing**, invisible in code review:

- opening terminal did not show it because selection did not follow creation;
  “+” with no visible change appeared ineffective;
- terminal stayed initial 305 px despite 687 available. Neither layout nor font:
  effect closure captured `visible: false` at mount before tab selection.
  `FitAddon` proposed 87 columns but resize returned early. Value now uses ref
  read at call time.

Second found only by measurement: control observer on same element fired thirteen
times during drag, ruling out layout; probe then revealed frozen `visible: false`.
Code comment claimed opposite, hiding defect during review.

**Subagents.** Fifth tab, only one not reading disk: entirely journal-derived.
Subagents have no server entity, only tool calls whose IDs identify them:
`buildSubAgents` groups existing events by `parentToolCallId`, no parallel state/query.

List shows type, request, current activity, tool count, timer. Display maintains
timer while active: CLI publishes duration only at completion, and advancing
counter is most direct sign of continuing work.

Subagent threads use **same component** as main (`ChatThread`) and same `buildRows`
with author ID. Same events: another renderer would require keeping two views
aligned for one content. Only optional page-specific turn anchors/fork differ.
Interactive permission/plan/question items lack authors and remain in main thread,
the only answerable location.

Active-subagent count stays on tab even when label collapses, signaling otherwise
invisible work while tab is closed.

---

## 13. Authentication

- Argon2id passwords (`node-argon2`), library default parameters.
- Opaque 32-byte session cookie, only SHA-256 stored. 30-day lifetime renewed on use.
- No open registration. First account created by first-run tour
  (`POST /api/auth/setup`, available only with no accounts) or
  `pnpm sillage user:create`; subsequent accounts by admin through `/settings/users`.
- `/api/auth/login` rate limit: 5 attempts/minute/IP.
- No v1 2FA. Sillage belongs behind reverse proxy/VPN, documented in README.

**Authorization.** Users see projects they own or with `visibility: shared`.
They send only in own conversations but read others' on shared projects.
Permission decisions belong to conversation owner; `permission.resolved` records decider.

---

## 14. Attachments

- Multipart upload, 20 MB/file, 5 files/message. Attachment-only messages allowed,
  never messages with neither text nor files.
- Disk storage `<data>/attachments/<yyyy>/<mm>/<uuid><ext>`, never database:
  SQLite is not blob storage and journal must remain lightweight to reread.
- **Type from content**, never extension chosen by caller proving nothing.
  PNG renamed `.txt` is recognized as image.
- API-supported images (jpeg/png/gif/webp) sent inline: Claude base64, Codex
  `localImage` path, according to native protocols. Everything else uses absolute
  path opened with agent tools. Storage root added to runner-allowed directories,
  otherwise out-of-workspace reads denied.
- Upload happens **before** conversation creation because first message creates
  conversation: `conversation_id` stays null until sending, file meanwhile
  belongs to uploading user.
- Sent files cannot be deleted or resent: journal must replay identically (I2).
- Conversation deletion removes disk files too. Foreign-key cascade deletes only
  rows; files explicitly removed first.
- Abandoned uploads reclaimed after 24 hours.

## 15. Deployment

```
~/.local/share/sillage/
  sillage.db
  attachments/
  worktrees/
~/.config/sillage/config.toml
```

`config.toml`:

```toml
[server]
host = "127.0.0.1"
port = 7317

[limits]
max_concurrent_sessions = 3
session_idle_timeout_min = 30
pty_idle_timeout_min = 60

[retention]
archived_events_days = 90
# Inactive days before read, idle conversations are archived.
# Zero disables automatic archiving; manual action remains available.
auto_archive_days = 14
# Archiving cron pattern. Both settings above are also editable in
# Settings > Archiving; interface values take precedence over these.
auto_archive_schedule = "45 4 * * *"

[agents.claude]
binary = "claude"
enabled = true

[agents.codex]
binary = "codex"
enabled = true
```

Three installation modes:

1. **Installer (`install.sh`)**, reference mode. Downloads release tarball
   (server bundle + frontend + prebuilt native node_modules) to
   `~/.local/share/sillage/app/releases/vX.Y.Z`, atomically switches `current`
   link, renders systemd unit from `deploy/sillage.service.tmpl`, starts service.
   Unit sets `SILLAGE_INSTALL_DIR`, enabling integrated updates: About shows
   installed version/new releases, admin updates in one click (download, link
   switch, systemd restart through `Restart=always`).
2. **Docker** (`ghcr.io/marlburrow/sillage`), no bundled agent CLIs: installed
   through interface into data volume. Host-mounted credentials/projects.
   `SILLAGE_UPDATE_CHANNEL=docker` disables integrated updates; UI shows
   `docker pull` instead.
3. **From source**, for development (`pnpm dev`) or manual deployment.

Releases are `vX.Y.Z` git tags: CI builds Linux x64/arm64 tarballs, multi-arch Docker
image, GitHub release with generated notes. Version fixed at compile time in
bundles (`SILLAGE_VERSION`), exposed by `/api/health` and `/api/system/version`.

Recognized environment: `SILLAGE_HOST`/`SILLAGE_PORT` (override TOML),
`SILLAGE_CONFIG`, `SILLAGE_DATA_DIR`, `SILLAGE_WEB_ROOT`, `SILLAGE_MIGRATIONS`,
`SILLAGE_INSTALL_DIR`, `SILLAGE_UPDATE_CHANNEL`. TOML accepts snake_case/camelCase.

External exposure through Caddy/tunnel (Tailscale, Cloudflare Tunnel). Sillage
neither defaults to `0.0.0.0` outside Docker nor handles TLS itself.

---

## 16. Directory layout

```
sillage/
  apps/
    server/
      src/
        main.ts
        http/            Fastify routes
        ws/              WebSocket hub, subscriptions, fan-out
        agents/
          types.ts       AgentRunner interface
          claude/        Claude Code adapter
          codex/         Codex adapter
          registry.ts
        sessions/        SessionManager, lifecycle, queue
        events/          EventLog, compaction, retention
        pty/             PtyManager
        git/             worktrees, branches, diff
        auth/
    web/
      src/
        routes/
        components/
          chat/
          tools/         renderer registry
          terminal/
        theme/
        lib/             WS client, store, IndexedDB
      public/
  packages/
    protocol/            shared Zod schemas + generated Codex types
    db/                  Drizzle schema + migrations
  docs/
    SPEC.md
```

---

## 17. Delivery batches

**Batch 0: foundation.** pnpm monorepo, Fastify, Drizzle/migrations, authentication,
project CRUD, frontend shell, theme/tokens, build/systemd unit. Acceptance: sign in,
create project, see it in sidebar.

**Batch 1: Claude end to end.** Claude adapter, event journal, WS hub, Markdown
chat/collapsible tools, interactive permissions, interruption. Acceptance: disable
Wi-Fi 30 seconds during agent work, reconnect, recover entire stream without reload.

**Batch 2: Codex.** Shipped. app-server adapter, generated/committed bindings with
drift detection (`pnpm codex:types:check`), Codex composer settings. Acceptance met:
Codex conversation produces same normalized events as Claude, including permissions.

Observed differences, not Sillage gaps:

- Codex accepts model/effort/approval/sandbox **per turn**, so settings never require
  restart, unlike Claude's limited control requests.
- Codex does not autoname threads: conversation keeps first-message excerpt where
  Claude supplies summary.
- app-server reports no cost but quota percentage (`usedPercent`), which Claude
  does not send.

**Batch 3: worktrees and diff.** Shipped. Create/select worktrees at conversation
startup, manage from project page, Diff tab.

Two implementation decisions:

- Diff uses temporary index (`GIT_INDEX_FILE`). Real-index `git add --intent-to-add`
  would show untracked files but modify user repository merely for display.
- Already checked-out branches cannot be checked out again: git rule. Message
  states this explicitly rather than forwarding raw output.

**Batch 4: mobile and PWA.** Shipped with one caveat. Manifest, icons/maskable,
Workbox worker, virtual keyboard through `visualViewport`.

Two points to remember:

- **Installation requires HTTPS.** On `http://<local-ip>` worker does not register
  and manifest installation is unavailable: browser requires secure contexts.
  Dev instance now uses HTTPS ingress, enabling installation/push.
- **Session cookie `Secure` is per request**, not environment: same instance serves
  plain local-network HTTP and ingress HTTPS. Global Secure breaks HTTP;
  absence removes encrypted-access protection. `trustProxy` makes
  `request.protocol` follow `X-Forwarded-Proto`.
- **Thread not virtualized.** Rows memoized; fold replaces only modified item,
  limiting each delta batch to one redraw. Main benefit without dynamic-height
  sliding-window risks; add if real long conversations show need.

**Batch 5: comfort and integrations.** Remaining:

- **Specialized tool renderers.** Deferred: payload syntax highlighting (12.5)
  currently covers the need.

Shipped outside original breakdown: user prompts (questions/plan approval/MCP
elicitations), `@` mentions, attachments, appearance, manual project/conversation
ordering, thread navigation ruler.

**Compaction.** Shipped for both CLIs in conversation action menu.

Initially lived on clickable context gauge, where constraint is visible. But
clickable gauges do not explain actions, requiring experiments on active threads.
Gauge is again purely informational; named action lives in menu.

| | Mechanism | Returned signals |
| --- | --- | --- |
| Claude Code | `/compact` command in message | `system/status` (`compacting`, then `compact_result`), `system/compact_boundary` with `trigger`, `pre_tokens`, `post_tokens` |
| Codex | `thread/compact/start` | `contextCompaction` item without counter |

**Name compaction instead of disguising it as thinking.** Previously ordinary turn
showed “Thinking” throughout, measured 27 seconds on filled thread while waiting
for nonexistent reply. `context.compaction_started` opens state,
`context.compacted` closes; indicator names compaction with context size being summarized.

Neither CLI reports numeric progress, so no invented progress bar. Final measured
sizes appear for Claude (“Context summarized, 28k to 2k tokens”, observed
27,580 → 2,224). Failed compaction emits no boundary: `compact_result: failed`
becomes recoverable error, otherwise full context would remain unreported.

Claude has no control request: `/compact` is a slash command recognized in ordinary
user messages. Verified through CLI response: short thread says “Not enough
messages to compact”, filled thread emits `compact_boundary`. Command is not
journaled as user content: addressed to CLI, not agent speech.

`context.compacted` is journaled because nothing else reveals changed agent memory
while displayed messages stay intact. Without marker, ignoring earlier detail
seems inexplicable. `preTokens`/`postTokens` nullable because Codex omits them;
inventing figures would be worse.

Mid-turn compaction rejected (409): context still changes. Menu entry disabled,
not hidden, to show existence/availability later.

End-to-end verified both CLIs: context decreases (Claude 23,926 → 21,588,
Codex 13,463 → 12,569), previously memorized word still recalled. Compaction
summarizes, does not erase.

**Incidental defect.** Codex context gauge used `tokenUsage.total.totalTokens`,
**thread cumulative usage**, not occupancy: four turns measured 12,570, 25,497,
38,794, 52,475 while real context went 12,228 → 13,313. Dividing by window exceeds
100%, never drops even after compaction. Correct field: `last.inputTokens`,
already including cache. Turns without user input, such as compaction, report
zero: leave gauge unchanged rather than claiming empty context.

**Push notifications.** Shipped. Web Push/VAPID: server authenticates directly with
browser push service, no third-party account. Per-instance key pair generated
at first start in `<data>/vapid.json`.

Three decisions distinguish useful notifications from noise:

- **Notify only user-needed moments** (permission/question/elicitation/plan) plus
  turn completion, unknowable remotely. Named list in code, not inferred.
- **Do not notify users already watching conversation.** Socket signals presence:
  subscribed tabs receive event live; another alert repeats what they read.
- **One displayed notification per conversation** (`tag` = thread ID): five “agent
  finished” alerts say nothing beyond latest.

Subscription belongs to account/device pair. Dead endpoints (404/410) removed,
otherwise table accumulates entries retried every send. Send failures never
interrupt agents (I1), but causes are logged: unreachable endpoints and rejected
content need different diagnoses.

Listeners live in `public/push-sw.js`, loaded by `importScripts` into Workbox worker:
tool manages precache without handwritten entire worker.

Verified end to end against fake push service: VAPID-header send when unwatched,
**none** while socket follows thread, resumes after closure, subscription removed
on 410. Learned detail: web-push enforces TLS, correct for real push services.

**Conversation fork.** Shipped. Forking at thread point creates new conversation
inheriting history through that point without touching original.

| | Mechanism | Granularity |
| --- | --- | --- |
| Claude Code | `forkSession(id, { upToMessageId })` | transcript message |
| Codex | `thread/fork { lastTurnId }`, inclusive last retained turn | turn |

Verified through Sillage both sides: fork just before second message answers
“POMME”, original “POMME, BANANE”. Branch journal stops exactly at cut.

**Gesture.** Fork from user message cuts **before** it: branch inherits preceding
history, cut message returns to input for rewording. Keeping it in branch history
would defeat purpose. Header provenance links original; otherwise near-identical
sidebar threads are indistinguishable.

`conversations.forked_from_id` does not cascade: deleting original must not delete
independent branches. Reference becomes orphan; UI stops displaying provenance.

Fork requires no live runner: uses persisted CLI state, working long after session
stops. Never-started conversations have nothing to fork (`no_agent_session`).

Two constraints from trials:

- Claude `upToMessageId` refers to transcript entry, not API ID. Only `user`,
  `attachment`, `assistant` have one; `result` absent from transcript, so targeting
  it fails. Usable `uuid` is SDK assistant-message ID, already in `events.raw` (I3).
- Codex cuts only at complete turn end (`lastTurnId`, inclusive;
  `thread/rollback { numTurns }` removed in 0.156.0), not messages. Common
  granularity therefore **turn**, matching navigation ruler.

New conversation journal copies original through cut; otherwise forked thread
would be empty while agent remembers (I2). Codex fork does not roll back disk
changes; explain this limit to users instead of making them guess.

**Batch 6: tools side panel.** Unspecified work. Git-colored explorer, tabbed editing,
terminals, agent change history. Batch 5 terminal already ready (section 10).

---

## 18. Remaining open points

Few, none blocking batch 0 or 1.

0. **Codex subagents.** Runner sets `parentToolCallId` to `null`, so subagents are
   invisible, strip/tab empty. app-server has unused linkage (`thread_spawn`
   with `parent_thread_id`, `subAgentActivity` item).

2. **Steering.** Shipped for Codex, see 12.3. Claude has no equivalent, so button
   appears only on Codex conversations.
