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

## Two scopes

| Variable | Conversation mode | Global mode |
|---|---|---|
| `SILLAGE_MCP_DB` | path to `sillage.db` | same |
| `SILLAGE_MCP_PROJECT` | ID of the project served | **absent** |
| `SILLAGE_MCP_USER` | — | account name to write as; optional if the database has only one account |
| `SILLAGE_MCP_MEMORY` | project's memory directory | memory root (`memory/` next to the database by default) |
| `SILLAGE_MCP_PROJECTS` | — | comma-separated allowlist of IDs; set by the HTTP bridge from the token |
| `SILLAGE_MCP_CONVERSATION` | current conversation, excluded from results | — |

**Conversation mode.** This is what Sillage uses. Tools are scoped to the project,
and writes are attributed to the conversation: a card note links to the session;
a started session receives the wrapped task, identifying who assigned it.

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

## Over HTTP, with an API token

For clients off the machine without SSH, the same server is available over HTTP:
`POST /api/v1/mcp`, MCP's “streamable HTTP” transport, behind an API token with the
**`mcp`** scope (Sillage settings → API). The bridge
(`apps/server/src/http/v1/mcp.ts`) reimplements no tools: each HTTP session is a
server process in global mode, acting as the token's account and restricted to
the token's project list if present, with every JSON-RPC message forwarded to it.

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
- `http/v1/mcp.ts`: the HTTP bridge, one process per session, token `mcp` scope.
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
