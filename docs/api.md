# Public API

The `/api/v1` API authenticates with `Authorization: Bearer <key>`.
Keys are created in Sillage's API settings.

The `mcp` scope opens `POST /api/v1/mcp`, Sillage's MCP server over HTTP: see
[mcp.md](mcp.md).

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
