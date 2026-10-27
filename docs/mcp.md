# Using Sillage's MCP server from a local CLI

Sillage mounts a `sillage` MCP server in every conversation, giving the CLI access
to what the platform knows: history, board, active sessions, memory, and actions
that go through the daemon (starting a session, creating a card, scheduling).
The same server, `apps/server/src/mcp/sillage-mcp.mjs`, can be started manually
from a CLI outside Sillage: Codex or Claude Code in a terminal on the machine or
from a workstation connecting over SSH.

It speaks stdio and reads the SQLite database directly. Started manually, it has
neither port nor token: it trusts whoever can launch it. Over HTTP, the API token
authenticates (see below). Its environment determines the scope it serves.

## Project and external global scopes

| Variable | Conversation mode | Global mode |
|---|---|---|
| `SILLAGE_MCP_DB` | path to `sillage.db` | same |
| `SILLAGE_MCP_PROJECT` | ID of the project served | **absent** |
| `SILLAGE_MCP_USER` | — | account name to write as; optional if the database has only one account |
| `SILLAGE_MCP_MEMORY` | project's memory directory | memory root (`memory/` next to the database by default) |
| `SILLAGE_MCP_PROJECTS` | — | comma-separated allowlist of IDs; set by the HTTP bridge from the token |
| `SILLAGE_MCP_CONVERSATION` | current conversation, excluded from results | — |

**Conversation mode.** This is what Sillage uses for project sessions. Tools are scoped to the project,
and writes are attributed to the conversation: a card note links to the session;
a started session receives the wrapped task, identifying who assigned it.

Agents can name their own conversation with `rename_session({ title })`. The
shared startup context asks for a concrete title of three to six words in the
user's language, at most 60 characters, once the request is understood. This runs
within the existing turn; there is no separate title-generation model call.
The daemon broadcasts the change immediately. An agent's title takes precedence
over native CLI summaries, while a title set by the user is always preserved.
The tool has no target-session parameter and is unavailable in global mode.
Existing unnamed sessions receive the instruction when their runner next starts;
disabling Sillage MCP keeps the native CLI naming behavior.

**Global mode.** Without `SILLAGE_MCP_PROJECT`, the server serves the entire instance:

- an extra tool, `list_projects`, returns projects with their directory, working
  sessions, and latest activity;
- every other tool takes a `project` parameter: ID, exact name, or a name fragment
  if it identifies only one project (guessing between two would write to the wrong
  one); `count_active_sessions` does not need it, nor do SILLAGE.md tools with
  `scope: global`;
- `add_card_note` and `update_issue` take `card`, the card number, instead of using
  the conversation's card;
- writes are attributed to the account: the created card and note have that author;
  a started session belongs to that account and receives the unwrapped task as if
  typed in Sillage; without `agent`, it runs Claude;
- tools for inter-session communication are not offered (`send_session_message`,
  `broadcast_session_message`, `notify_when_done`, `read_session_messages`,
  decisions): an out-of-session client has neither an identity to sign with nor
  a turn to receive messages;
- instead, six tools act on an existing account session as the user would in the
  interface: `read_session` (state, activity, last message, open prompt),
  `wait_for_session` (waits for turn completion, up to 100 seconds),
  `message_session` (ordinary message, delivered at turn completion if working),
  `steer_session` (steers an active turn, otherwise an ordinary message),
  `interrupt_session`, and `reply_session` (responds to a permission, question,
  plan, or input according to the shape described by `read_session`). The last
  four go through the daemon (`agent_requests`, no migration).

Actions going through the daemon remain subject to its guards: at most six
launches per hour, counted together for everything coming from outside sessions;
the daemon must be running, otherwise the request expires.

## Personal discussions

Discussions opened from **Discussions** in the sidebar have no project. Sillage
mounts the same MCP server with `SILLAGE_MCP_PERSONAL=1`, no
`SILLAGE_MCP_PROJECT`, and the current `SILLAGE_MCP_CONVERSATION`. The account is
resolved from that conversation; `SILLAGE_MCP_USER` cannot override it.

The assistant can use `list_projects`, project tools with an explicit target,
and `create_project`, `continue_in_project`, `delete_project` and `find_files`.
Project deletion removes Sillage data and preserves the project's disk folder.
File discovery covers accessible project folders; native CLI tools can search
elsewhere within the user's request and CLI permissions. Global instruction
edits still require an administrator.

Use the discussion's own directory for new work. If an idea needs a project or
delegated project sessions, create a dedicated project with `continue_in_project`;
do not borrow an unrelated catch-all project merely to satisfy a tool argument.
`list_models` works without a project and then uses the account's defaults.
Personal assistants can inspect, interrupt, steer and resume this account's
project sessions with `read_session`, `interrupt_session`, `steer_session` and
`message_session`. Sessions owned by other accounts remain inaccessible.

Without a `project` argument, `search_history`, `read_conversation` and
`list_sessions` cover the account's personal discussions and accessible projects.
Memory tools default to the account's personal memory, shared across its personal
discussions. Durable preferences and decisions are retained automatically.
**Personal memory** allows reading, editing and deleting notes, and reviewing
recent changes. Native memory file edits are captured when observed as well.
Project memory stays separate.

Each discussion receives a managed directory. Forks and CLI continuations reuse
it so native sessions keep their working directory. Deleting a discussion leaves
the directory in **Discussion folders**; deletion of an unused folder is a
separate, explicit operation. Server stores these files on its host, Desktop on
the local machine.

`continue_in_project` creates a project and a linked session from an explicit
brief and selected files, including large media. It copies only those files,
without overwriting and subject to available disk space; the
original discussion, its files and personal memory remain in place. The new
session shows its transferred context immediately. Supply `prompt` to start the
requested next action after the files and brief are ready; omit it to prepare
the session without starting a turn. Resume that same session with
`message_session` instead of creating another continuation.
The UI offers the same operation under
**Create a project** in the conversation menu. The source discussion remains
private even when the new project is shared.

These capabilities belong to personal sessions. External global MCP clients and
project-scoped API tokens do not gain access to personal discussions.

## Referencing sessions

Use `session:<conversation UUID>` to cite a Sillage conversation. `list_sessions`,
`search_history`, and `read_conversation` return this stable reference; the latter
also accepts it as its `id` argument. Search includes archived conversations.
The reference survives renames and archiving, and does not depend on a Server
hostname or a Desktop port. It identifies a session within the current instance;
it does not transfer conversations between installations.

In messages, Sillage renders the reference with the current title, CLI logo, and
the same details as the sidebar preview. Known bare UUIDs and same-origin
conversation URLs are recognized too. Fenced code is left intact. Users can insert
references with `@@` completion or copy one from a session's ellipsis/context menu.
The composer’s **Insert** button explains the available prefixes and opens their
suggestions: `@` files, `@@` sessions, `#` cards, plus `/` commands and `$` skills
when the agent publishes them. Choosing a prefix preserves the draft and does not
send a message. Project sessions resolve references within their project; personal
discussions resolve across sessions accessible to their account.

Outgoing references add only bounded identity metadata to the model input. The
journal keeps the original user text. Agents can read the relevant history with
`read_conversation`; mentioning a session does not contact or wake its agent.
When Sillage MCP is disabled, the metadata explicitly says that history tools
are unavailable. Deleted or inaccessible references expose no session details.

## Over HTTP, with an API token

For clients off the machine without SSH, the same server is available over HTTP:
`POST /api/v1/mcp`, MCP's “streamable HTTP” transport, behind an API token
(Settings → API and MCP). Any valid token can connect. Its scopes determine the
actions listed and accepted, exactly as with `GET /api/v1/tools` and
`POST /api/v1/tools/:name` in REST. See [the shared catalog and execution policy](api.md).

The **`mcp`** scope grants the project tools (history, board, memory, instructions,
worktrees, scheduling and session tools) through either transport. Structured task
tools (`create_task`, `read_task`, replies, events, etc.) use `tasks:*` scopes;
`list_agents` and `list_task_projects` use `projects:read`. `inspect_access` explains
the token's rights and defaults without an extra scope.

The bridge (`apps/server/src/http/v1/mcp.ts`) executes project tools in a global-mode
process under the token owner, restricted to the token's projects. Task tools reuse
the native REST handlers. The same dispatcher serves the REST tool endpoint.
Allowed CLIs, models, reasoning efforts and Claude spending caps apply to both
paths, including `start_session`, schedules, automations and session resumption.
Omitted launch choices use the key defaults for its default CLI, then project and
account defaults for other CLIs; defaults never grant additional permissions.

Editing a key's execution permissions affects the next call of connected clients.
Local stdio clients inside Sillage retain their existing session/project defaults;
API token restrictions apply only to authenticated external clients.

- `initialize` opens the session and returns a `Mcp-Session-Id` header to send on
  subsequent requests; without it, or after thirty minutes without requests, `404`:
  the client starts again with `initialize`. `DELETE` closes the session.
- Always a JSON response, never an SSE stream; `GET` returns `405`.
- At most four sessions per token; beyond that, the oldest is closed.

Codex, from any workstation:

```toml
[mcp_servers.sillage]
url = "https://sillage.marlburrow.dev/api/v1/mcp"
bearer_token_env_var = "SILLAGE_TOKEN"   # exported in the shell launching codex
```

Claude Code:

```bash
claude mcp add --transport http sillage https://sillage.marlburrow.dev/api/v1/mcp \
  --header "Authorization: Bearer sillage_pat_…"
```

The token is the boundary: it writes instructions and memory, starts sessions, and
creates cards. Restricting it to selected projects limits its reach if leaked;
revoking it closes its sessions on the next message.

## Over stdio, on the machine or through SSH

The paths below are for a Linux script installation, where the current release is
under `~/.local/share/sillage/app/current`; the `.mjs` depends on `better-sqlite3`
compiled for the daemon's Node and must run with the same `node`.

Codex, in `~/.codex/config.toml` on the Sillage machine:

```toml
# Sillage MCP server, entire instance, acting as the database's only account
[mcp_servers.sillage]
command = "node"
args = ["/home/USER/.local/share/sillage/app/current/server/mcp/sillage-mcp.mjs"]
env = { SILLAGE_MCP_DB = "/home/USER/.local/share/sillage/sillage.db" }
```

From another workstation over SSH (the noninteractive `PATH` must find `node`):

```toml
[mcp_servers.sillage]
command = "ssh"
args = ["marldev", "SILLAGE_MCP_DB=/home/USER/.local/share/sillage/sillage.db SILLAGE_MCP_USER=USER node /home/USER/.local/share/sillage/app/current/server/mcp/sillage-mcp.mjs"]
```

Claude Code, same command and environment:

```bash
claude mcp add --scope user sillage -e SILLAGE_MCP_DB=/home/USER/.local/share/sillage/sillage.db -- node /home/USER/.local/share/sillage/app/current/server/mcp/sillage-mcp.mjs
```

To restrict scope to one project, add `SILLAGE_MCP_PROJECT` with the project ID
(from its Sillage URL): the tool list becomes a conversation's list again, without
`list_projects` or `project` parameters, but also without a session, so no
inter-session messages.

## In the code

- `GLOBAL`, `selectProject`, and `globalTools` in `sillage-mcp.mjs`: the project is
  process state set at the beginning of each call, and calls run sequentially to
  prevent overlap.
- `http/v1/mcp.ts`: the HTTP bridge, one process per session, shared REST/MCP catalog and token checks.
- `agent_requests.user_id` (migration 0041): a request without a conversation carries
  the account to act for; `AgentRequests.principal` makes it a requester without a
  session, and each handler skips what only makes sense for a session.
- Tests: `apps/server/test/mcp-global.test.ts`, `mcp-http.test.ts`, and the global
  case in `agent-requests.test.ts`.

### Editing project cards

Any session can edit a card in its project, even without being attached to it:
`update_card` takes its `number` and new `title` or `description`. The description
replaces the entire text; read the card before editing it. `add_card_note` and
`update_issue` also accept `number`; without one, they target the conversation's
attached card. In global mode, their `card` parameter is retained.
Changes to GitHub-linked cards synchronize to their issues.

### Linking tickets

`link_cards` adds an explicit relationship; `unlink_cards` removes it. Both take
`number` (source ticket), `target` (target ticket), and `kind`:

| `kind` | From the source ticket | Reverse direction |
| --- | --- | --- |
| `blocks` | Blocks | `blocked_by`: is blocked by |
| `related` | Is related to | Same |
| `duplicates` | Duplicates | `duplicated_by`: is duplicated by |
| `parent` | Contains sub-ticket | `child`: is a sub-ticket of |
| `replaces` | Replaces | `replaced_by`: is replaced by |

The reverse direction is also accepted when creating and removing links. For
example, `link_cards(number: 12, target: 4, kind: "child")` makes #12 a sub-ticket
of #4. `read_card` shows relationships with linked tickets' titles and columns.
Any project session can manage them; in global mode, also specify `project`.

Both tickets must belong to the same project. A ticket cannot link to itself,
duplicate links are ignored, cycles are rejected, and a sub-ticket has at most
one parent. Relationships stay local to Sillage: they are not published on GitHub,
close no duplicates, and move no tickets. `#12` mentions in text remain simple references.
