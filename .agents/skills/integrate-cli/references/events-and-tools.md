# Adapter, runner, events and tool rendering

The runner turns the native stream into `SillageEvent`s (`packages/protocol/src/events.ts`)
through `ctx.emit(event, raw)`. The UI is a fold over those events: `applyEvent` in
`packages/protocol/src/chat-state.ts`, rendered by `apps/web/src/components/chat/*`. If the
events are right, the thread, tool rows, subagents, background work, the context meter,
checkpoints, the edits panel and the activity line all work without UI changes.

## Adapter contract (`apps/server/src/agents/registry.ts`)

| Member | Duty |
|---|---|
| `kind`, `label`, `binary`, `cli` | `cli` is a `CliBinary`: presence, version and path. Absence is a normal state that the UI shows. |
| `capabilities` | The row from `AGENT_CAPABILITIES`. |
| `rawFormat` | Provenance stamped on every `raw`, such as `'grok-acp@v1'`. **Bump it when native shapes change**, so old journals are read with the right reader. The journal is replayed indefinitely, so any field added later to a schema must be optional or defaulted. |
| `createRunner(ctx)` | See below. |
| `forkCut`, `fork` | Native fork from the journal (see History). |
| `models`, `invalidateCatalogs`, `usage`, `usageForAccount`, `commands`, `resolveDefaults` | Covered in [platform.md](platform.md). |
| `describeEdit` | Rebuilds a diff from `log.rawOfTool(...).completed`, which is the raw of the **latest** `tool.completed`. That raw must contain everything the diff needs. Grok and Antigravity store `{update, diffs}`. |

## Runner contract (`apps/server/src/agents/types.ts`)

**Calls the runner must answer.** Each method may return `false` when the CLI cannot do it.
Keep each answer consistent with the capability row.

- `start`, `send`, `interrupt`, `stop`.
- `applyConfig`: return `false` for anything that needs a restart.
  `SessionManager.reloadConfig` then restarts and resumes, deferring until the end of the
  turn if one is running (`config_restart_deferred`).
- `steer`, `compact`, `reviewPlan`, `stopBackgroundTask`.
- `reconnectMcpServer`: must work mid-turn.
- `reloadSkillLibrary`, `suggestedTitle`.
- `resolvePermission`, `answerQuestion`, `resolveElicitation`.
- `importHistory`: optional.

**Context the runner receives** (`RunnerContext`):

- `binary` is already resolved, including the managed prefix. Never resolve it again or
  hardcode a name.
- `resolveMcpServers(config)` and `skillRoots(config)` are functions, because toggles change
  while the session runs.
- `projectOverview(config)` carries SILLAGE.md, memory, the overview and the handoff context.
  The runner injects it into the CLI's system-prompt channel.
- `maskedInstructionRoots()` and `memoryDir()`.
- `workTrees()` and `attachmentsRoot`: directories outside the cwd that must be readable.
- `processEnv`: the origin inherited by services the conversation launches.
- `setAgentSessionId`: store the native id **as soon as the CLI announces it**, so a crash
  can still resume.
- `updateConfig`: persist changes the session made itself, for example a mode change after
  plan approval.
- `accountSignedOut`: call it when a native `/logout` succeeds.

**Interactions.** Create one `PendingInteractions(ctx)` (`agents/interactions.ts`) and go
through it. Never emit `*.requested` or `*.resolved` by hand.

- `requestPermission({toolName, input, title, description, suggestions?}, respond)`: map the
  native options (once, session, always, reject), as Antigravity does.
- `requestQuestion(questions, respond, blocking)`; `requestElicitation`; `requestPlanReview`.
- `respond(null)` means the request expired.
- Call `expireAll()` on exit, interrupt, stop and end of turn. Call `expire(id)` when the CLI
  cancels a request itself.
- Questions the CLI sends as tool calls (Grok `ask_user_question`, OpenCode `question`) must
  not also produce a tool row.

**Process death.** Close with `journalDeath()` (`agents/session-close.ts`). An `error`
event alone leaves the turn open after a reload.

**Interrupt.** Send the native cancel, then start a watchdog that forces the turn closed if
the CLI never answers. Antigravity waits 15 s, and Claude's `TURN_CLOSE_GRACE_MS` is also
15 s.

## Event catalog

Legend: C Claude, X Codex, O OpenCode, G Grok, A Antigravity. "Required" means the UI breaks
or lies without it.

**Lifecycle (required)**
- `session.started`: emitted at launch and on every model change. The model-change notice
  comes from this event.
- `turn.started`, `turn.completed`:
  - `turn.completed` carries **per-turn** tokens and cost. Codex turns cumulative totals
    into deltas in `codex/turn-usage.ts`.
  - It closes running tools as `interrupted`, closes the checkpoint, refreshes the turn count
    and adopts the suggested title.
- `session.ended`: emitted through `journalDeath`.

**Messages (required)**
- `message.delta`, `message.completed`: blocks are appended under the same `messageId` and
  never replaced.
- `thinking.delta`: streamed thinking text.
- `thinking.progress` (C only, throttled every 100 tokens): shown as "Thinking · N tokens".
  **Emit it if the CLI hides its reasoning but reports a count**, otherwise the turn looks
  stuck.

**Tools (required)**
- `tool.started`, `tool.completed`.
- `tool.output_delta`, `tool.input_updated` (X/O/G/A):
  - `tool.input_updated` with `title: null` **erases** the title, and leaving `title` out
    keeps it;
  - send the final arguments with `tool.input_updated` before `tool.completed`, as Codex
    does.
- `file.edited`: emit it **only for a successful edit**. It feeds the edits panel and the
  checkpoint's edited set.

**Interactions**: permission, question, elicitation and plan review, all through
`PendingInteractions`.

**Plans and diffs**
- `plan.updated` (X/O/G/A): todo and plan progress, rendered by `PlanProgress.tsx`.
- `diff.updated` (X): the turn's aggregate diff.

**Delegated work**
- **Subagents** are a tool call named `Agent` or `Task` (`isSpawnTool`). Every child event
  carries `parentToolCallId`.
  - Mappings today: Grok `spawn_subagent`, Antigravity `start_subagent`, OpenCode `task`.
    Codex builds `Agent` rows for collab child threads.
  - Only main-thread `message.delta` and `tool.started` reopen a turn (`b383a4223`), so a
    child event without its parent link reopens finished turns.
  - Antigravity exposes no parent link, so its subagent output is not nested. Say so in the
    coverage doc rather than guessing.
- **Workflows and tasks**: `task.started`, `task.completed` (C/X), and `task.progress` (C)
  with a `workflow` of phases and agents.
  - Parse it defensively, as `claude/workflow-progress.ts` does.
  - `WorkflowStrip.tsx` renders it inside the Workflow tool card.
- **`background.updated`** (C/X/A): a snapshot that sets `activity.background`.
  - Publish it with `id === toolCallId` **before** `turn.completed`, otherwise the closing
    turn marks the still-running command as interrupted. Antigravity's `endTurn` does this.
  - Stopping needs `stopBackgroundTask` (C only today).

**Snapshots.** Each one carries the full list and replaces the previous one.
- `mcp.updated`: all five CLIs.
- `commands.updated`: C/O/G/A.
- `skills.updated`: X/A. Emit it yourself if the CLI publishes no inventory.
- `loops.updated`: C.

**Usage**
- `usage.updated`: `context` drives the context meter, and `rateLimit` (C/X) the quota shown
  in `UsageSummary.tsx`.
- ACP CLIs send `costUsd: 0` when cost is unknown. Never invent a cost.

**Errors and notices**
- `error` renders as a banner, titled through `translateError(code)`:
  - use **snake_case codes** and add `error.<code>` to both i18n catalogs;
  - rename vague native codes, for example `unauthorized` becomes `provider_unauthorized`
    (`codexErrorCode`, `opencodeErrorCode`);
  - `recoverable: false` closes the turn, background work, loops and tasks.
- `agent.notice`: a banner when `level` is set.
  - A stable `id` makes a repeat replace the earlier notice: Claude `api-retry`,
    `notification:<key>`.
  - A code is translated only once added to `noticeText` in `apps/web/src/lib/chat-fold.ts`.
  - Deduplicate one-off notices: Antigravity emits each code once per session.
- `context.compaction_started`, `context.compacted`: the second adds a notice and resets the
  context meter.
- `suggestion.updated` and `prompt.injected` are CLI-specific. Emit them only if the CLI has
  the concept.

**Emitted by the platform**, never by a runner: `message.queued`, `message.dequeued`,
`session_message.*`, `checkpoint.*`.

**When bindings exist, make the coverage compile-time.**
- `codex/notification-policy.ts` classifies every native notification as `handled`, `notice`
  or `ignore`, with `satisfies Record<ServerNotification['method'], …>`. A bump that adds a
  notification then fails typecheck.
- `futureItem` in `codex/item-events.ts` does the same for item types, and falls back at
  runtime to `Codex/<type>`.

## Tool rendering

The aim: every tool row reads as an action a human would describe, with its real arguments
one click away. Reference: `docs/tool-presentation.md`.

**Canonical names** (`CANONICAL_TOOLS` in `packages/protocol/src/tools.ts`): `Bash`, `Read`,
`Write`, `Edit`, `NotebookEdit`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `TodoWrite`,
`Task`/`Agent`, `ExitPlanMode`. The web registry adds `ViewImage` and `ApplyPatch`
(`components/tools/views.tsx`).

- Map each native tool to one of them **with Claude-style input keys**: `file_path`,
  `old_string`/`new_string`, `command`, `pattern`, `path`, `description`.
- Long bodies are trimmed in history (`events/event-bodies.ts`) down to whitelisted keys.
  Non-canonical keys therefore lose their summary after a reload.
- Mapping tables to copy:
  - `grok/tools.ts`: renames, and unwrapping `use_tool` into `server/tool`;
  - `antigravity/tools.ts`: `NAMES`, a fallback on the ACP `kind` (`execute`→`Bash`,
    `read`→`Read`, `edit`→`Edit`, `search`→`Grep`, `fetch`→`WebFetch`), and `KEYS` for
    PascalCase arguments;
  - `opencode/tools.ts`;
  - `codex/item-events.ts`.
- **MCP tools are named `server/tool`.** Take the identity from structured metadata, never
  from a title. Antigravity has `_meta.mcp`. OpenCode splits `server_tool` only for known
  servers.
- A tool specific to the CLI gets its own view only if a generic one would mislead.
  Otherwise the fallback is `genericView`, then raw JSON (`components/tools/registry.tsx`).
  Keep the native name in `raw`.

**Label** (`toolSummary` in `apps/web/src/lib/tool-presentation.ts`). It tries, in order:

1. the top-level `title`;
2. `input.description`, for `Bash`, `Agent` and `Task` only (Claude's human description of
   the command);
3. `presentation.title`;
4. Codex `commandActions`;
5. edit paths;
6. a list of input keys;
7. `presentation.paths` (ACP locations).

Rules for the label:

- **Build `presentation` with `toolPresentation(title, [nativeName, canonicalName],
  locations)`.** It drops titles that only repeat the tool name and keeps up to 20 paths.
- **Use the metadata for what it is.** Antigravity reuses a resource's description as
  `_meta.prompt`. A `create_card` row must not be titled with the card's body.
- **Check that the title is stable.** Grok's ACP `title` is a sentence that changes between
  updates.
- **`presentation.label`** is a fixed action label from a connector. It must not hide the
  query.

**Content**
- Command output: send `tool.output_delta` while it runs, then the full output on
  completion. Grok accumulates `rawOutput.output` as bytes.
- Diffs: reuse `acp/content.ts` (`diffsOf`, `describeEdit`, `contentText`, `commandOutput`)
  for ACP. Mark excerpt-only diffs as partial; Grok's `search_replace` sends excerpts.
- Images in tool results go through the shared image handling.
- Durations come from `ToolDurations` (`agents/tool-durations.ts`).

**Lifecycle pitfalls**
1. `tool.started` always appends a row, so a repeated id means a duplicate row.
   - Track the ids you have already closed (Grok `closedTools`).
   - Turn a re-announced id into `tool.input_updated` (Antigravity, `ddf059296`).
2. A CLI may send `failed` to every open frame when one step of a parallel batch is denied,
   then re-announce the frames that are still running. Ignore bare terminal updates for
   frames you already settled (`recloseTool`).
3. A re-closing that sends an empty raw (`{diffs: []}`) can hide the diff, because
   `rawOfTool` takes the latest raw. Keep the earlier content.
4. Some frames close late or carry no content. Antigravity's `view_file` closes only with
   the next planner step. Mirror the file from disk after a short delay (`readSettleMs`,
   `settleRead`) rather than leaving the row spinning.
5. Notifications can arrive before the session id is known. Buffer them, then replay them.

## History: import, fork, handoff, checkpoints

- **Import** (`cliSessions`):
  - `importHistory` replays a native session into a new journal without a model request;
  - Antigravity sets `replaying`, emits `session.started`, then turns each user chunk into
    `endTurn`, a user `message.completed` and `turn.started`;
  - permission requests are cancelled while replaying;
  - Claude also resyncs turns made outside Sillage (`resyncSessions`,
    `claude/transcript-sync.ts`).
- **Fork.** `forkCut` reads native ids from `raw`, so keep them:
  - Claude: the `uuid` of the top-level `message.completed`;
  - Codex: `turn.id` on `turn.completed`;
  - Grok: counts `turn.completed`, so an extra `turn.completed` shifts the cut;
  - without a native fork, throw `ForkError` and use the portable fork. Its condition is
    hardcoded in `http/routes/conversations.ts`; see touchpoints.
- **Handoff** (`conversations/handoff.ts`, `docs/cli-handoff.md`):
  - it reads only main-thread `message.completed`, `tool.started` and `tool.completed`;
  - a turn counts as interrupted only if `stopReason` is exactly `'interrupted'` or
    `'failed'`, so normalize native reasons (Antigravity `end_turn`→`completed`,
    `cancelled`→`interrupted`);
  - the handoff block arrives through `projectOverview()`;
  - test both directions.
- **Checkpoints** are server-side git snapshots and work for every CLI. They need
  `turn.completed` or `session.ended` to close, and `file.edited` to attribute files.

## Tests to extend

- `apps/server/test/<kind>.test.ts`, driven by a fixture agent in
  `test/fixtures/<kind>-agent.mjs`.
- `tool-presentation.test.ts`, `handoff.test.ts`, `replay.test.ts`,
  `thread-projection.test.ts`.
- `scripts/tool-styles-ui-check.mjs` for rendering.
