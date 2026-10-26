# Public API

The `/api/v1` API authenticates with `Authorization: Bearer <key>`.
Keys are created in Sillage's API settings.

REST and [MCP](mcp.md) share keys, permissions and an action catalog. Any valid key
can connect to either transport; scopes decide which actions it can perform.

## Discover and call actions

- `GET /api/v1/access`: this key's scopes, project restrictions, execution policy
  and session defaults. Always available to the authenticated key.
- `GET /api/v1/tools`: exactly the tool catalog returned by MCP `tools/list`, with
  names, descriptions and JSON input schemas, filtered by scopes.
- `POST /api/v1/tools/:name`: the same action as MCP `tools/call`; send the tool's
  arguments directly as the JSON body. The result contains `content`, optional
  `structuredContent` and `isError` for tool failures. Check `isError` even on HTTP 200.

The existing project/task endpoints remain available. Their tool counterparts
call those same handlers, including authorization, validation and idempotency:

| REST endpoint | Shared tool |
| --- | --- |
| `GET /access` | `inspect_access` |
| `GET /projects` | `list_task_projects` |
| `GET /agents` | `list_agents` |
| `POST /projects` | `create_project` |
| `POST /projects/:id/tasks` | `create_task` |
| `GET /tasks` or `GET /projects/:id/tasks` | `list_tasks` (optional `projectId`) |
| `GET /tasks/:id` | `read_task` |
| `GET /tasks/:id/events` | `read_task_events` |
| `POST /tasks/:id/messages` | `message_task` |
| `POST /tasks/:id/steer` | `steer_task` |
| `POST /tasks/:id/interrupt` | `interrupt_task` |
| `POST /tasks/:id/replies/:requestId` | `reply_task` |

Paths above are relative to `/api/v1`. Project tools such as `start_session`,
`list_models`, board, memory, instructions, worktrees and scheduling are also
available at `/tools/:name` with the `mcp` scope. The scope name is retained for
compatibility; it grants those actions through **both** transports. It includes
session launches, even without `tasks:write`. `tasks:*` scopes cover the structured
task endpoints/tools; `projects:read` covers project and CLI discovery.

## Session choices and key permissions

In **Settings → API and MCP**, each key defines:

- allowed CLIs;
- allowed model identifiers per CLI, or all models;
- allowed reasoning effort values per CLI, or all levels;
- an optional Claude budget cap in USD per session (not a monthly quota);
- separate default CLI/model/effort settings, used when a caller omits them.

Changing the default model does not lock clients to it. For example:

```json
{
  "prompt": "Review the changes",
  "agent": "codex",
  "model": "<an allowed model from list_agents>",
  "effort": "high"
}
```

Send this to `POST /api/v1/projects/:id/tasks`, or add `projectId` and call
`create_task` through either tool transport. Existing `config` overrides remain
supported (`effort` for Claude, `reasoningEffort` for Codex/Grok/Antigravity,
`variant` for OpenCode). Top-level `model`/`effort` take precedence. Exact model IDs
and unambiguous display names are accepted. `effort: "max"` selects the model's
highest supported level, then checks that level against the key's permissions.

Defaults resolve in order: request, key (for its default CLI), project, account.
Restrictions apply **after** resolution, including to inherited defaults. A client
may need to select an allowed value explicitly if a project's default is denied.
`GET /agents` and `list_models` filter their catalogs to the key's permissions.
If a CLI's catalog is unavailable, configured restrictions still apply.

Policy representation (`null` lists allow all values; empty lists are invalid):

```json
{
  "agents": [
    { "agent": "claude", "models": ["sonnet", "opus"], "efforts": ["low", "medium"], "maxBudgetUsd": 2 },
    { "agent": "codex", "models": null, "efforts": ["high"], "maxBudgetUsd": null }
  ]
}
```

Owners can edit execution permissions and defaults without replacing the secret.
Changes apply to subsequent requests, including established MCP connections and
session resumption; already running sessions are not interrupted. Previously
issued keys have a null policy and retain their unrestricted CLI/model/effort
access until the owner edits them. This migration does not expand their scopes.

Failures use `token_agent_denied`, `token_model_denied`, `token_effort_denied` or
`token_budget_denied`. Permission/sandbox settings remain fixed; model choice
cannot enable unattended execution without `tasks:autonomous`. Claude budget and
turn caps may be lowered by a request but cannot be raised or erased.

Server and Desktop use the same checks. Desktop still listens only on loopback;
its keys connect clients on that computer and do not expose the app remotely.

## Create a project

`POST /api/v1/projects` requires the `projects:write` permission and a key with no
project restriction. Existing keys do not receive this permission automatically:
create a new key with the permission selected.

To attach an existing directory on the server:

```json
{
  "name": "Mon projet",
  "workspacePath": "/home/marlburrow/projects/mon-projet"
}
```

To create a directory in an existing parent:

```json
{
  "name": "Mon projet",
  "parentDir": "/home/marlburrow/projects",
  "directory": "mon-projet"
}
```

Paths are absolute and refer to the server's file system.
`directory` must be a simple directory name; an existing destination must be
empty. This route does not clone a Git repository.

Common options: `visibility` (`private` by default or `shared`), `color`
(`#RRGGBB` or `null`), and `instructionsMode` (`repo` or `sillage`). Without an
explicit mode, the presence of an instruction file in the directory determines
the mode, as in the interface. The key's user owns the project.

The `201` response has the same format as an entry in `GET /api/v1/projects`:
`id`, `name`, `workspacePath`, `git` (boolean), `worktrees`, and `defaults`.
The ID can immediately be used with `POST /api/v1/projects/:id/tasks`
with the `tasks:write` permission. Discovery requires `projects:read`.

Errors: `401` for a missing or invalid key, `403` for a missing permission
(`scope_missing`) or restricted key (`project_creation_restricted`), `400`
for an invalid body or path, `409` for a nonempty destination directory.
Creation is not idempotent: repeating a successful request creates another
project entry.
