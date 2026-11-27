# OpenCode integration

Sillage starts one `opencode serve` per conversation and communicates over HTTP,
with an SSE stream. It speaks both OpenCode majors, which ship different servers:

| | OpenCode 1 | OpenCode 2 |
|---|---|---|
| Distribution | npm `opencode-ai` | npm `@opencode/cli` |
| API | `/session/...`, stream `GET /event` | `/api/...`, stream `GET /api/event` |
| Bindings | `@sillage/opencode-bindings` (`GET /doc`, **1.19.5**) | `@sillage/opencode-bindings/v2` (`GET /openapi.json`, **2.4.2**) |
| Runner | `agents/opencode/runner.ts` | `agents/opencode/v2/runner.ts` |
| Journal `rawFormat` | `opencode-server@v1` | `opencode-server@v2` |

Both install to `~/.opencode/bin`, so a machine has one at a time. The runner
reads `opencode --version` when a conversation starts
(`version-guard.ts`, cached on the binary's size and mtime) and picks the
matching runner (`runner-switch.ts`): upgrading in place switches the next
session without restarting Sillage. Majors above 2 are rejected with
`opencode_unsupported_version` rather than running a silent conversation.
Catalog, command and fork probes follow the same detection.

Sillage installs and recommends OpenCode 2 (`PREFERRED_CLI_RELEASES`:
`@opencode/cli` 2.4.2). 1.x stays supported (`alsoSupported`: no version
warning), and Settings › CLI versions offers the update, with a note on the
history migration below. Both packages claim the `opencode` command, so npm
refuses to install one over the other (EEXIST): the installer first removes the
packages listed in `replaces` (`opencode-ai`) from Sillage's prefix. Removing an
absent package succeeds. Both packages ship every platform build as optional
dependencies, about 1 GB installed on Linux x64 either way.

**Moving a machine to OpenCode 2** (`opencode upgrade --major`, or
`curl -fsSL https://opencode.ai/v2/install | bash`) migrates its session
database in place on the first 2.x start. Sessions keep their IDs and history,
so Sillage conversations begun on 1.x resume on 2.x. The 1.x binary still opens
the migrated database (probed on 1.19.3 after 2.4.1). A conversation crossing
the upgrade journals both raw formats; readers (`describeEdit`, `forkCut`)
accept either.

Changes in the 1.x line that matter to Sillage:

- **1.19.1**: session sharing is gone (links, commands, URL import).
  `/session/{id}/share` routes remain in the OpenAPI but no longer work;
  Sillage never used them and keeps `share: 'disabled'` at launch, still accepted.
- **1.19.2**: 1.x no longer offers 2.x as a normal update (neither the update check
  nor the installer). Moving to OpenCode 2 remains an explicit action: `/update`
  or `opencode upgrade --major`.

## Launch settings and session settings

opencode reads permissions, MCP servers, and skill directories from its
configuration. Sillage injects them through `OPENCODE_CONFIG_CONTENT`, merged
over the machine's configuration without writing to it. Changing them therefore
restarts the conversation's server, which resumes its session (stored in
opencode's database). Each major gets its own document format; 2.x would also
translate the 1.x document, but Sillage writes the native one (`v2/config.ts`).

| Sillage setting | OpenCode 1 | OpenCode 2 |
|---|---|---|
| Edits, commands, web access | `permission.edit`, `.bash`, `.webfetch` | `permissions` rules `{action, resource: '*', effect}`, actions `edit`, `shell`, `webfetch` |
| Additional directories, attachments, memory, skills | `permission.external_directory`, `directory/**` → `allow` | `external_directory` rules, `directory/**` → `allow` |
| Registry MCP servers, Sillage server | `mcp.<name>`, `local` or `remote` | `mcp.servers.<name>`, with `codemode: false` |
| Skill library | `skills.paths` | `skills` |
| Self-update | `autoupdate: false` | `update: 'disable'` |
| Instructions managed in SILLAGE.md | each message's `system` | instruction entry `sillage` of the session |

`OPENCODE_DISABLE_PROJECT_CONFIG=1` hides the repository's `AGENTS.md` and
`CLAUDE.md` in both majors when SILLAGE.md carries the instructions. It also
disables the project's opencode configuration: opencode has no finer switch.

Model (`provider/model`), variant, and primary agent change without a restart. 1.x
receives them with every message. 2.x keeps them as durable session state, set
through `POST /api/session/{id}/model` and `/agent` before a message when they
changed; Sillage's instructions likewise go through
`PUT /api/experimental/session/{id}/instructions/entries/sillage`.

## Observed behavior, OpenCode 1

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

## Observed behavior, OpenCode 2

Probed on 2.4.1, data directories isolated.

- **Password**: `OPENCODE_PASSWORD` (the 1.x name is ignored). Without one, every
  route answers 401, the OpenAPI document included. Sillage sets both names.
- **Startup**: same announcement (`server listening on http://…`).
- **Lazy lists**: the first request for a directory's commands, skills or agents
  returns an empty list and starts loading it; later requests, seconds after,
  are filled, and no stream event announces it. The model list behaves the same
  for about a second on a first run. Each of these lists has built-in entries, so
  Sillage reads until non-empty within a bound (`v2/catalog.ts`).
- **`opencode run`** (not used by Sillage) records the session under `$PWD`, not
  the process working directory; `serve` uses the real working directory.
- **Sessions**: `POST /api/session {location: {directory}}`; one server can serve
  several directories, Sillage still runs one per conversation.
- **Stream**: flat typed events with a durable `seq` per session:
  `session.execution.started|succeeded|failed|interrupted` bracket a turn,
  `session.text.*` and `session.reasoning.*` stream blocks per assistant message
  and ordinal, `session.tool.input.started → called → success|failed` follow a
  call (results no longer repeat their input: Sillage journals the call with the
  result), `session.step.ended` carries tokens and cost.
- **Skills** are no longer slash commands: `GET /api/skill` lists them, and a
  prompt attaches them by ID (`skills: [{id}]`). Sillage publishes them like
  Codex's `$` skills (`skills.updated`); `/api/command` keeps only commands.
- **Shell output**: a shell call names its shell in `session.tool.progress`
  (`metadata.shellID`); the output pages by byte cursor
  (`GET /api/shell/{id}/output?cursor=`). Sillage reads it every 400 ms while the
  call runs (`tool.output_delta`).
- **Background shells** (`shell` with `background: true`) are jobs too (job ID =
  shell ID), reported to the parent's inbox as
  `<background-result kind="shell" id="sh_…">`. The Agents pane can stop them
  (`POST /api/experimental/job/{id}/cancel`) and read their last 8 KiB.
- **Tools**: renamed: `shell` (was `bash`), `subagent` (was `task`), file tools take
  `path`. Direct tools: `read`, `write`, `edit`, `glob`, `grep`, `webfetch`,
  `websearch`, `skill`, `question`, `generate_image`, `generate_video`, plus
  `execute` (Code Mode). No todo tool.
- **Code Mode**: by default MCP tools are reachable only through `execute`, which runs
  model-written JavaScript. Sillage sets `codemode: false` on its MCP servers so
  their tools are called directly (`<server>_<tool>`).
- **Permissions**: `permission.asked {action, resources, metadata}`, edits carrying
  `metadata.files[]` with a unified patch; answered by
  `POST /api/session/{id}/permission/{req}/reply {decision: once|always|reject}`.
  Unlike 1.x, where `always` lasts for the instance, 2.x `always` saves a rule in
  opencode's database for the whole project, under the widened `save` pattern of the
  request (`echo *` for `echo one`), and it then applies to later conversations and to
  the TUI (probed on 2.4.2). Sillage never sends it: "Allow for the session" replies
  `once` and remembers the `save` patterns, then answers matching requests of the same
  conversation itself (`v2/permissions.ts`, opencode's wildcard). Rules saved by
  Sillage before this fix stay until removed: `GET /api/permission/saved`, then
  `DELETE /api/permission/saved/{id}`.
- **Forms** replace 1.x questions. The question tool opens a form with
  `metadata.kind: "question"`: one field per question, a `string` with options for
  a single choice, a `multiselect` for several, `custom` allowing free text.
  Answer with `POST …/form/{id}/reply {answer}` (option values), dismiss with
  `DELETE …/form/{id}`, which fails the tool and interrupts the turn. Other kinds
  (`mcp-elicitation`, `auth-required`) carry typed fields and become Sillage
  elicitations; a lone `external` field is a link to open.
- **Subagents always run in the background**. The parent's turn ends right after
  `subagent` returns "working in the background"; the child session (`parentID`)
  streams on the same connection, `experimental.job.updated` tracks it, and its
  report reaches the parent's inbox as a synthetic
  `<background-result kind="subagent" sessionID="…">` item, which starts a new
  parent execution without any message from Sillage. Sillage maps jobs to
  `background.updated` / `task.*` (like Claude's background tasks), opens a turn on
  that unprompted execution, counts a child's tokens in the next parent turn, and
  keeps a child's pending permission open when a parent turn ends.
- **Sessions begun outside Sillage**: `GET /api/session?directory=&parentID=null`
  lists them (untitled until their first answer; Sillage names those by their
  first prompt). `GET /api/session/{id}/message` keeps the history: the first
  page takes `order=asc`, later ones only the `cursor` (2.x rejects both together).
  The draft page offers them ("resume an OpenCode session"); importing replays
  the history (`v2/history.ts`) without any model request, then the
  conversation continues the same session.
- **Fork**: `POST /api/session/{id}/fork {before}`, same exclusive cut as 1.x.
  Message IDs sort chronologically and survive the 1.x migration. The message list
  answers 50 messages newest first by default, so the cut is looked up page by page,
  oldest first, like the import (probed 2.4.2).
- **Steering**: a prompt sent during an execution steers it by default.
- **Compaction**: `POST /api/session/{id}/compact` answers at once; the stream
  reports `session.compaction.*`.
- **Usage**: steps report their tokens (`session.step.ended`), and
  `session.usage.updated` carries each session's running total, children excluded
  (probed 2.4.2). Compactions and titles spend without a step: Sillage adds the part
  of the total no step explains, to the turn while it is open, otherwise as
  `usage.consumed` (a title generated just after the execution ends). A resumed
  session starts from the total `GET /api/session/{id}` gives.
- **Skills added during a session**: `POST /api/location/reload`. It cancels
  pending permissions and forms, so Sillage waits for idle like on 1.x.
- **Sub-agent mentions**: `@explore` in the text names a sub-agent, as in the TUI.
  The composer offers the catalog's sub-agents under `@`, before files, for
  OpenCode only; the 2.x runner reads the directory's agents (`GET /api/agent`,
  project agents included) and records the mentions in `agents: [{name, mention}]`.
  Only the text reaches the model, as a hint to delegate (2.4.2). A file mentioned
  under the same name stays a file. 1.x receives the text alone.
- **Images and mentioned files**, directories included: `files: [{uri, name}]` with
  `file://` URIs, read and inlined by opencode.

## Outside the scope so far

Signing in to providers from the interface (use `opencode auth login`) and
cumulative cost, on both majors. On 1.x: MCP elicitations, background tasks and
importing native sessions. On 2.x: tool titles (the stream carries none), the plan
panel (2.x has no todo tool), and calls made inside Code Mode's `execute`, shown as
one call.

## Verification

On November 27, 2026, OpenCode **2.4.2** (Linux x64, data directories isolated)
passed `opencode:types:check` (additions only: `experimental.push.*`, skill files,
agent `instructions`, two experimental flags; nothing Sillage reads changed), the
manual probe, and real turns through the runner: text, reasoning, a background
`explore` subagent with its report, shells and compaction. A 2.4.1 database reopens
as is. The only new event, `experimental.push.updated` (phone pairing), is ignored.

On November 24, 2026, OpenCode **2.4.1** (Linux x64, data directories isolated)
passed the manual probe below (Read, Edit, permission, injected instructions,
token reporting), a runner probe of skills, live shell output, interruption,
manual compaction and MCP reconnection, and two disposable end-to-end runs on a
fresh Sillage server driven from the interface: a background subagent whose report
woke the parent with an edit approved in the thread; and a managed 1.19.5 updated
to 2.4.1 from Settings › CLI versions, then a session begun with `opencode run`
adopted from the draft page and continued. The manual probe passed again on the
installed 1.19.3. Server and Desktop share this adapter and the versions page
(`pnpm test:cli-updates-ui` covers both profiles); Windows and macOS runtime were
not tested in this pass.

On November 14, 2026, the downloaded **1.19.5** Linux executable passed the
OpenAPI comparison and a real `opencode/big-pickle` turn. `/session`, `/config`
and `/doc` returned 401 without authentication and JSON 200 with the per-process
password.

```sh
pnpm typecheck
pnpm test
pnpm opencode:types:check # compare bindings with the installed binary
pnpm test:opencode-ui     # real components, mocked API, desktop and mobile
```

The manual `pnpm --filter @sillage/server opencode:probe` probe runs a real turn
on the installed opencode (or `OPENCODE_BIN`) with the free `opencode/big-pickle`
model. It leaves a session in opencode's database and prints its ID; delete it
with `opencode session delete <id>`. Run a 2.x binary under a scratch `HOME` and
`XDG_*` directories unless the machine already moved to 2.x: its first start
migrates the 1.x database.

To update an API: point `OPENCODE_BIN` at a binary of that major, run
`pnpm opencode:types`, review the diff, adjust the matching `index.ts` if a schema
changed, then rerun the probe.
