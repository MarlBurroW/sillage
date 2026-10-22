# OpenCode integration

Sillage starts one `opencode serve` per conversation and communicates over HTTP,
with an SSE stream (`GET /event`). Bindings are generated from the OpenAPI the
binary publishes at `GET /doc`, with **opencode 1.19.3**. Everything below was
probed on that version (originally 1.18.25, rechecked on 1.19.0 then 1.19.3: the
v1 API is unchanged; 1.19.3 only adds `reasoning_options` to `ProviderConfig`
models, from which opencode derives variants the adapter already reads).

Changes in the 1.x line that matter to Sillage:

- **1.19.1**: session sharing is gone (links, commands, URL import).
  `/session/{id}/share` routes remain in the OpenAPI but no longer work;
  Sillage never used them and keeps `share: 'disabled'` at launch, still accepted.
- **1.19.2**: 1.x no longer offers 2.x as a normal update (neither the update check
  nor the installer). Moving to OpenCode 2 remains an explicit action: `/update`
  or `opencode upgrade --major`.

**Do not run `opencode upgrade --major`** (or accept `/update`'s 2.0 offer) on a
machine running Sillage while the adapter uses the v1 API: OpenCode 2
(`@opencode/cli` 2.x) removed that API in favor of `/api/...`, and `--major`
uninstalls 1.x. A guard (`apps/server/src/agents/opencode/version-guard.ts`)
reads `opencode --version` before every `opencode serve` and rejects major
versions ≥ 2 with `opencode_unsupported_version` rather than running a silent
conversation. Checked on `@opencode/cli` 2.0.32, whose `--version` returns
`opencode v2.0.32`: `serve` does announce `server listening on ...`, but
`/session`, `/event`, and `/doc` return its web app's HTML page (200), and only
`/api/...` is the API.

## API generations

Two generations coexist in the opencode server. The adapter uses only the first
(`/session/...`, `GET /event` stream), pinned in `rawFormat` as `opencode-server@v1`:

- the second (`/api/session/...`, `GET /api/event`, `session.next.*` events) has
  neither forks nor MCP server management;
- its stream says nothing about sessions created by the first: the two do not mix;
- the first is what opencode's TUI and SDK use.

## Launch settings and per-message settings

opencode reads permissions, MCP servers, and skill directories from its
configuration. Sillage injects them through `OPENCODE_CONFIG_CONTENT`, merged
over the machine's `opencode.json` without writing to it. Changing them therefore
restarts the conversation's server, which resumes its session (stored in
opencode's database).

Model (`provider/model`), variant, and primary agent are sent with every message
and can change without a restart.

| Sillage setting | In opencode |
|---|---|
| Edits, commands, web access | `permission.edit`, `.bash`, `.webfetch`: `ask`, `allow`, `deny`, or unset (the machine's rule) |
| Additional directories, attachments, memory, skills | `permission.external_directory`, one `directory/**` pattern with `allow` for each |
| Registry MCP servers, Sillage server | `mcp.<name>`, `local` or `remote` |
| Skill library | `skills.paths`; they appear among slash commands |
| Instructions managed in SILLAGE.md | Each message's `system`; `OPENCODE_DISABLE_PROJECT_CONFIG=1` hides the repository's `AGENTS.md` and `CLAUDE.md` |

`OPENCODE_DISABLE_PROJECT_CONFIG` also disables the project's `opencode.json`
and `.opencode/` directory: opencode has no finer switch. Projects keeping their
instructions in their repository are unaffected.

## Observed behavior

- **Port**: chosen by Sillage. With `--port 0`, opencode reuses 4096 while the
  previous server is still shutting down, cutting off the new one's first connection.
- **Password**: one per process (`OPENCODE_SERVER_PASSWORD`, user `opencode`).
- **Steering**: a `prompt_async` received during a turn is taken at the next model
  step, without passing through `idle`.
- **Turn completion**: `session.idle`, sent twice. On interruption it precedes
  closure of active tools, and permission requests stay in opencode's list without
  `permission.replied`: the runner closes everything itself.
- **Fork**: `POST /session/{id}/fork` copies messages before `messageID`, exclusive.
  Without `messageID`, everything is copied.
- **Slash commands**: `POST /session/{id}/command`, which responds only at turn completion.
- **Skills added during a session**: invisible until the instance is disposed
  (`POST /instance/dispose`). The open stream then goes silent without closing
  and must be reconnected. Done only while idle: an active turn would be lost
  with the instance.
- **Subagents**: one child session per `task` call, identified in the call's
  metadata (`metadata.sessionId`). Its events arrive on the same stream.
- **Command output**: accumulated in the active call's `metadata.output`.
- **Images and mentioned files**: `file` parts with a `file://` URL, read by opencode itself.

## Outside the first version's scope

Signing in to providers from the interface (use `opencode auth login`), cumulative
cost, importing sessions started in opencode, MCP elicitations.

## Verification

```sh
pnpm typecheck
pnpm test
pnpm opencode:types:check # compare bindings with the installed binary
pnpm test:opencode-ui     # real components, mocked API, desktop and mobile
```

The manual `pnpm --filter @sillage/server opencode:probe` probe runs a real turn
on the installed opencode with the free `opencode/big-pickle` model. It leaves a
session in opencode's database and prints its ID; delete it with
`opencode session delete <id>`.

To update the API: run `pnpm opencode:types`, review the diff, adjust
`packages/opencode-bindings/src/index.ts` if a schema changed, then rerun the probe.
