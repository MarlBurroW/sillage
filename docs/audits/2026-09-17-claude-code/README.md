# Claude Code feature coverage — September 17, 2026

Review of what Sillage exposes from the Claude Code CLI against what the CLI and
SDK currently offer. Based on commit `74e3391`, including uncommitted working-tree changes.

**Diagnosis.** The foundation is complete: everything making up a conversation
(model, effort, permissions, plan, questions, MCP, subagents, background tasks,
loops, compaction, steering, fork, import) is covered and current. Gaps fall into
three families: newer **session settings** (Fast mode, output style, advisor),
about ten **signals emitted by the CLI but swallowed by Sillage** (notifications,
API reconnection attempts, model refusals, automatic permission denials), and two
larger optional features (file rewind, user dialogs). None is blocking; Fast mode
is most visible, and forwarding signals offers the greatest return by explaining
currently unexplained silences.

**Scope and method.** Read the adapter (`apps/server/src/agents/claude/`),
`ClaudeConfig` schema, and composer. Compared installed SDK types (0.3.220) with
latest published (0.3.273), and CLI changelog from 2.1.224 to 2.1.273. Three probes
on installed CLI (2.1.263), using control requests without model messages and
therefore no tokens: Fast mode state, live Fast/output-style changes, subagent
list. Read instance database to count `session.started` per turn. No application
code modified.

## Versions

| | Installed on this machine | Latest published | Declared target (`cli-versions.ts`) |
|---|---|---|---|
| CLI `@anthropic-ai/claude-code` | 2.1.263 | 2.1.273 | 2.1.220 |
| SDK `@anthropic-ai/claude-agent-sdk` | 0.3.220 | 0.3.273 | — |

The SDK type diff spans 2,700 lines. Nothing Sillage depends on changed: message
`priority` (steering), Stop-hook `session_crons` (loops), `forwardSubagentText`,
`usage_EXPERIMENTAL…`, `supportsFastMode`. Two control requests disappear,
`get_plan` and `get_workspace_diff`, neither used by Sillage. The bump therefore
has no known risk and brings useful additions listed below
(`PreModelSwitch`/`PostModelSwitch` hooks, `context_usage` and `usage_report` on
`result`, `capabilities` and effective `effort` on `init`,
`permissionPrompts: 'none'`, `reloadOutputStyles()`).

CLI fixes between 2.1.263 and 2.1.273 directly affecting Sillage:

- 2.1.265: no spurious “Continue from where you left off.” turn when resuming after
  `/compact` or another local command. Sillage takes this path when settings
  require restarting.
- 2.1.265: Bash `cd` persists across turns in SDK sessions.
- 2.1.269: headless sessions no longer report “waiting” while a background subagent
  is still running.
- 2.1.273: SDK streams no longer lose final messages from a subagent moved into
  the background mid-run.

## What is covered

Verified in runner, adapter, and composer. Nothing to do here.

| Area | Coverage |
|---|---|
| Settings | model (catalog read from CLI), per-model effort `low`…`max`, six permission modes, additional directories, registry MCP servers + Sillage server + strict isolation; all apply live except `strictMcp` and entering/leaving `bypassPermissions`, which restart with resume |
| Interactions | permissions with CLI-proposed rules (`once` / session / always), choice questions (`AskUserQuestion`), plan approval with next-mode choice, MCP elicitation (form and URL) |
| Stream | text and reasoning deltas, reasoning counter, tool calls/results, subagents with full threads, `file.edited` for `Write`/`Edit`/`NotebookEdit` |
| Turn | steering through `priority: 'next'`, interruption with closure fallback, manual/automatic compaction (start, boundary, failure), turn errors, exhausted quota |
| Background | background tasks and stopping them, subagent tasks (start, progress, completion), `/loop` and `CronCreate` loops through the Stop hook |
| Account | quota windows (`/usage`), live rate limits, context occupancy after each turn, per-turn cost/tokens including cache |
| Session | native-ID resume, fork at a thread point, CLI session import/resync, CLI-derived title, project slash commands before the first turn, `@file` mentions, inline images |

## What is missing

Ranked by the cost of lacking it, not implementation cost.

### A. CLI signals Sillage ignores

The runner's `switch` has a `default` discarding unknown messages. This is
intentional and documented, but its catch-all list has grown. All following
messages have stable shapes in the installed SDK and could feed `agent.notice`
or `error`, already in the schema, without new event types.

| Native message | What users currently lose |
|---|---|
| `system/notification` | CLI notices: “Fast mode disabled · usage credits exhausted” (one per turn), “MCP server disconnected, reconnection abandoned” (2.1.273), “an MCP server requires authentication”. All discarded. |
| `system/api_retry` | Attempt n/max, delay, HTTP status. An overloaded API retrying for two minutes looks like a frozen turn. |
| `system/model_refusal_fallback`, `model_refusal_no_fallback` | Model refused and CLI fell back (or not): category, fallback model, retracted messages. Sillage says nothing; the thread stops or restarts unexplained. |
| `system/permission_denied` | Automatic denial by `auto` classifier, `dontAsk`, or a rule, with reason. Only an error tool result remains. |
| `system/informational` | Hook messages and `notice` / `suggestion` / `warning` notices, including a Stop hook blocking continuation. |
| `tool_use_summary` | CLI-written summary of a tool batch. Well suited to a collapsed mobile group header. |
| `prompt_suggestion` (with `promptSuggestions` option) | Likely next message, one per turn, nearly free (parent cache). A “suggested” phone button. |
| `conversation_reset` | `/clear` is hidden from the palette but can still be typed: CLI changes conversations without the journal knowing. |
| `tool_progress`, `task_updated`, `memory_recall`, `auth_status` | Tool duration and subagent retries; task-state patches (pause/background); recalled automatic memories; ongoing authentication. Secondary. |

One case needs verification rather than assertion: the runner ignores `user`
messages whose content is a block list without `tool_result`. This is the likely
shape of messages from another session (`SendMessage` between sessions on the
same machine, precisely what Sillage hosts) and MCP channels. If they take that
path, they do not appear in the journal.

### B. CLI session settings Sillage does not offer

**Fast mode.** Same model, responses up to 2.5× faster, $10/$50 per MTok, only
Opus 5 and Opus 4.8. On subscriptions this uses usage credits outside plan quota.
The first Fast turn pays again for the entire context at Fast rates, once per
conversation: best set initially rather than toggled. On Fast rate limits, the CLI
falls back to normal speed (`cooldown`), then reactivates.

Probe results on this machine, Claude Max account:

| Step | Result |
|---|---|
| `initializationResult()` at launch | `fast_mode_state: off`, `fast_mode_disabled_reason: sdk_opt_in_required` |
| `applyFlagSettings({ fastMode: true })` then `reinitialize()` | `fast_mode_state: on`, without restarting CLI |
| `applyFlagSettings({ fastMode: null })` | back to `off` |
| models with `supportsFastMode` | `default` (Opus) and `opus[1m]`; not Fable, Sonnet, or Haiku |

Thus the SDK must opt in: `/fast` typed in Sillage says “unavailable” (already
hidden from the palette for another reason). Live switching uses the same request
as effort; state is readable on `init` and each `result` (`fast_mode_state`,
including `cooldown`). The probe does not establish whether the API actually accepts
Fast requests for this account (usage credits enabled or not). That becomes visible
only on the first turn, and failure arrives through section A's `system/notification`.
Enabling Fast on an unsupported model switches the CLI to Opus; SDK 0.3.273's
`PostModelSwitch` hook would reveal it.

Natural shape: a `fastMode` boolean in `ClaudeConfig`, offered only when the
selected model has `supportsFastMode` (to expose in `AgentModelDto`), passed at
launch and live through `applyFlagSettings`, with state (`on` / `cooldown`) and
cost notice in the composer signal row.

**Output style.** Five styles on this machine: `default`, `Proactive`, `Concise`,
`Explanatory`, `Learning`. `Concise`, added in CLI 2.1.236, puts results first
without preamble. Probed: `applyFlagSettings({ outputStyle: 'Concise' })` changes
`output_style` live; `null` returns to default. The list comes from
`initializationResult().available_output_styles`. A simple setting like effort.

**Advisor.** `/advisor <model>` and `advisorModel`: a stronger model consulted on
demand by the main model. Available headless since 2.1.260. Extra cost per
consultation. Expose as an option, not a default.

**Budget guards.** `maxTurns`, `maxBudgetUsd` (turn closes with
`error_max_budget_usd`), alpha `taskBudget`. None is exposed. Particularly relevant
for `/api/v1` tasks, where machines start tasks without watching them.

**Named subagents.** `supportedAgents()` lists five here (`claude`, `Explore`,
`general-purpose`, `Plan`, `statusline-setup`) plus project `.claude/agents/` entries.
CLI accepts `@agent` in text and suggests while typing; Sillage does not know them.
Same mechanism as slash commands.

**Thinking.** `thinking` option (adaptive, fixed budget, disabled) and
`setMaxThinkingTokens`. Recent models use adaptive thinking controlled by effort,
already exposed: redundant for normal use.

**Sandbox, tools, fallback.** `sandbox` (Linux bubblewrap), `tools` / `allowedTools`
/ `disallowedTools`, `fallbackModel`, `planModeInstructions`. Sandbox/tool rules
come from machine `settings.json`, loaded by default by SDK (omitted
`settingSources` = all), so already apply without per-conversation settings.
Codex has a Sillage sandbox selector, Claude does not; acceptable asymmetry until
requested.

### C. Two larger features to decide

**File rewind.** CLI `/rewind`: `enableFileCheckpointing` at launch, then
`rewindFiles(userMessageId)` returns files to their state at a selected message.
Sillage can fork a thread at a point but cannot restore disk state there. This is
the most requested missing CLI feature; it affects the journal (needs user-message
`uuid`), file panel, and worktrees.

**User dialogs.** `onUserDialog` + `supportedDialogKinds`: blocking dialogs the
CLI asks the host to render (`request_user_dialog`), for example a fallback offer
after model refusal. Without a callback, CLI applies each dialog's default.
`dialogKind` is open-ended, not enumerated in types: probe before wiring anything.

### D. Out of scope or already rejected

Remote Control (rejected after measurement, SPEC §11), Teleport, cloud sessions,
self-hosted runner, terminal-specific features (fullscreen, `/diff` panel, `/focus`,
`/recap`, spellcheck, shortcuts, themes), `claude agents`, CLI dictation (Sillage
has its own), `/desktop`, `/ide`. Plugins and skills install on the CLI's disk and
load by default: Sillage handles them without dedicated UI and could at most offer
“reload” (`reloadPlugins()`, `reloadSkills()`). Ultracode, Workflow, and Monitor
are model tools visible through background tasks: nothing to do.

## Incidental findings

- **`init` arrives every turn**, not only at launch. Database count in a recent
  conversation: 13 `session.started` and 13 `commands.updated` for 13 turns. Runner
  therefore reemits `session.started` and calls `supportedCommands()` every turn.
  Not a bug, but journal noise and an unnecessary control request per turn.
  Emitting only on `session_id` or `model` changes would suffice; these `init`
  messages' `model` reveals CLI-decided model changes.
- **`file.edited` sees only file tools.** `bashEditDiffEnabled` (2.1.269) attaches
  diffs of command-modified files to Bash results, covering the `sed -i` and `rm`
  blind spots identified in SPEC.
- **`PREFERRED_CLI_RELEASES.claude` targets 2.1.220**, two months behind the machine.
  The caret does not complain, but bump it with the SDK.

## Recommendations, in order

| Priority | Work | Benefit | Scope |
|---|---|---|---|
| P1 | Bump SDK 0.3.273 and CLI target 2.1.273 | Prerequisite for model-switch hooks and `context_usage` on `result`; no used type breaks | Small |
| P1 | Forward `notification`, `api_retry`, `model_refusal_*`, `permission_denied`, `informational` to `agent.notice` / `error` | Silences become explanations; also reports “Fast disabled, credits exhausted” | Small |
| P1 | Per-conversation live Fast mode, only on supported models, with state and cost | Most visible CLI addition, probed and live switch verified | Medium |
| P2 | Output style | Verified live setting, five styles, `Concise` first | Small |
| P2 | Optional `prompt_suggestion` | One tap for the next phone message | Small |
| P2 | `session.started` only on change | Lighter journal, one fewer control request per turn | Small |
| P3 | Typed `@` subagents, `/api/v1` budget guards, advisor | Input parity, machine-task safeguards | Small to medium |
| P3 | File rewind, user dialogs | Entire features, probe before deciding | Large |

Sizes estimate scope, not delivery commitments.

## Follow-up the same day

Everything above is done except file rewind, rejected by the user, and user dialogs,
whose kinds cannot be enumerated without probing.

- SDK 0.3.273 and CLI target 2.1.273. Nothing Sillage uses changed.
- CLI signals translate to `agent.notice` in pure, tested `signals.ts`:
  notifications, API retries, model refusals, automatic denials, hook messages,
  conversation reset.
- Fast mode, output style, and advisor are conversation settings applied at launch
  through `settings` and live through `applyFlagSettings`. Fast is offered only
  on supported models and eligible accounts; its state returns in the thread as
  one replaceable notice.
- `maxBudgetUsd` and `maxTurns` are configuration fields overridable by the task
  API, without composer settings.
- Next-message suggestions are requested from CLI and offered below the thread;
  one tap places them in input. Machine setting `promptSuggestionEnabled: false`
  disables them.
- `session.started` is journaled only on session/model changes, and commands are
  requested only on first init.
- Named subagents arrive in the catalog (`agents`), without typing suggestions
  yet: another session was redesigning the composer.

Verified end to end with `pnpm --filter @sillage/server claude:probe`, three tiny
turns on CLI 2.1.263 with SDK 0.3.273: one `session.started` for three turns,
`Concise` accepted at launch, live `applyConfig({ fastMode: true })` accepted,
“Fast mode enabled” notice next turn, then message suggestion after `result`.
This account's API rejected Fast requests for lack of usage credits: CLI reported
it through `notification` (“Fast mode disabled · usage credits exhausted”),
forwarded to the thread, and the turn ran at normal speed. This is documented
behavior and why the setting is offered even when the first request may fail:
Sillage cannot know in advance; the availability check passes.

## Probes

Disposable scripts run from `apps/server` with installed SDK and binary resolved
through `readlink -f "$(which claude)"`. They open sessions with an empty input
queue, send control requests, and close: no model messages.

```js
// Fast mode: launch state, live switch, supported models.
const init = await q.initializationResult()
init.fast_mode_state              // 'off'
init.fast_mode_disabled_reason    // 'sdk_opt_in_required'
init.models.map((m) => [m.value, m.supportsFastMode])
await q.applyFlagSettings({ fastMode: true })
;(await q.reinitialize()).fast_mode_state   // 'on'

// Output style: same mechanism.
init.available_output_styles      // ['default', 'Proactive', 'Concise', 'Explanatory', 'Learning']
await q.applyFlagSettings({ outputStyle: 'Concise' })
;(await q.reinitialize()).output_style      // 'Concise'
```

Rerun at the next SDK bump: none of this is documented beyond types, and
`applyFlagSettings` is described as “streaming input only”.

## October 6, 2026 addendum: target 2.1.291

Reviewed changelog from 2.1.274 to 2.1.291 (≈1,500 lines, mostly fixes) and SDK
0.3.273 → 0.3.291 type diff, with control-request probes on machine CLI 2.1.286
and a separately downloaded 2.1.291, without touching the system binary.

| | Installed on this machine | Latest published | Declared target |
|---|---|---|---|
| CLI `@anthropic-ai/claude-code` | 2.1.286 | 2.1.291 (`stable`: 2.1.285, `next`: 2.1.292) | 2.1.273 → **2.1.291** |
| SDK `@anthropic-ai/claude-agent-sdk` | 0.3.273 | 0.3.291 | 0.3.273 → **0.3.291** |

Nothing Sillage uses changed in SDK: typecheck passes without edits. `TaskOutput`
(removed in 2.1.276) and `REPL` leave tool schemas; Sillage did not treat them separately.

### What affected Sillage, and what was done

- **Ultracode is no longer an effort level (2.1.284).** It no longer forces
  `xhigh` and works at every level; however, `effortLevel` changes without
  `ultracode` disable it. Sillage sent effort alone: changing effort in an
  Ultracode conversation disabled it in CLI while composer showed it enabled.
  Probed on 2.1.286/2.1.291 through `getSettings().applied` (present at runtime,
  absent from public types). Fixed: `liveFlagSettings` sends `ultracode: true`
  with effort changes, and composer no longer aligns effort to `xhigh` when
  enabling it. CLI still rejects models without `xhigh` (`ultracodeAvailable:
  false` on Haiku 4.5 and Sonnet 4.6), so the setting stays limited accordingly.
- **Model names leaving the catalog.** `opus[1m]` is unlisted since 2.1.282 (Opus
  has a million tokens by default), and 2.1.291 lists Fable 5.1 as `fable` instead
  of `claude-fable-5-1`. CLI still accepts old names, but exact-match composer
  lookup lost effort, speed, and Ultracode for these conversations: 94 active
  `opus[1m]` entries and about ten `claude-fable-5-1` in the database.
  `catalogModel` now finds entries without `[1m]`, then by resolved ID.
- **Two more signals.** `conversation_reset` carries `trigger` (`clear`,
  `plan_mode_exit`, `fresh_session`, `onboarding`), translated into a sentence;
  `init` carries `plugin_errors`, forwarded in a notice repeated only on change.
  Sillage loads its skill library as plugins: failures were silent.

### What affects Sillage without code

- **Background command limits (2.1.285, 2.1.288).** Commands launched with
  `run_in_background` stop after 30 minutes by default, 2 hours maximum, in
  “unattended” sessions. CLI classifies all SDK sessions not identifying as
  Desktop/VS Code this way, including Sillage. Decision pending: card #12.
- **Claude reads AGENTS.md (2.1.277)**: covered already; `claudeMdExcludes` hides
  both files in SILLAGE.md mode (probed October 5, `docs/sillage-md.md`).
- **Default permission mode is `auto`** when none supplied: Sillage always supplies one.
- **Opus 5.5 and Sonnet 5.5**: catalog is read from CLI; they appeared automatically.
- Beneficial SDK fixes: priority messages no longer interrupt active WebFetch;
  tool heartbeats arrive during blocked streams; model fallback no longer repeats
  every message after an in-flight model change; `set_model` adopts new model
  output limits; turns no longer stay open when their stream cuts off.

### Deferred and recorded

- `get_task_output`, final background-command output without a model turn: card
  #13. Present at SDK runtime but not in public types.
- Advisor consultations (`advisor_tool_result`) not rendered in thread: card #14.
- `prewarm()` / `claim()` (alpha): CLI started ahead of time, then bound to a session.
  Could improve conversation startup but requires fixing all launch inputs
  (MCP, plugins, hooks) in advance.
- MCP Apps (`readMcpResource`, `_meta.ui`, alpha): render sandboxed MCP HTML widgets.
- Permission-request `mcpServer` (server and provenance of `mcp__*` tools),
  `verbatimPrompts`, `pasted_content`, `/focus`'s `view_mode`: no identified use today.

Verified: typecheck, tests (including `claude-flag-settings.test.ts` and new
`claude-signals.test.ts` cases), lint, disposable Playwright pass on real composer
(mocked API), desktop and phone: `opus[1m]` shows “Opus 5.5” with effort,
`claude-fable-5-1` shows “Fable 5.1”, Ultracode enables without changing effort.

## October 12, 2026 addendum: target 2.1.296

Reviewed 2.1.292 → 2.1.296 changelog (≈390 lines, two-thirds fixes, much unrelated
Claude Tag/cloud/gateway content) and SDK 0.3.291 → 0.3.296 type diff. Control-request
probes used separately downloaded 2.1.296
(`npm pack @anthropic-ai/claude-code-linux-x64@2.1.296`) without touching system
binary, then a real session on a disposable server configured for that binary
(`agents.claude.binary`), driven through API v1.

| | Installed on this machine | Latest published | Declared target |
|---|---|---|---|
| CLI `@anthropic-ai/claude-code` | 2.1.292 | 2.1.296 (October 9) | 2.1.291 → **2.1.296** |
| SDK `@anthropic-ai/claude-agent-sdk` | 0.3.291 | 0.3.296 | 0.3.291 → **0.3.296** |

SDK only adds optional fields, removes none: typecheck, tests, lint pass without
code changes. Only two probe-related comments were updated.

### What changes for Sillage

- **`haiku` now means Haiku 5.5 (2.1.293).** Probed: `haiku` → `claude-haiku-5-5`,
  “Haiku 5.5”, million-token context, `low` → `max` efforts, and Ultracode available
  (`ultracodeAvailable: true` through `getSettings().applied`). Haiku 4.5 is available
  only as `claude-haiku-4-5-20251001`, without effort levels or Ultracode. Catalog
  comes from CLI, nothing hardcoded: conversations/scheduled tasks using `haiku`
  silently move to 5.5 next turn. Trial confirmed it (`session.started` announces
  `claude-haiku-5-5` for a task created as `haiku`). Composer offers Ultracode only
  on `xhigh` models, so now offers it on `haiku`: intentional. Notify about model
  changes: card #26.
- **`claude_code_version` in initialization response**: session process version,
  absent in older CLIs. Sillage does not read it yet; it would show what version
  an active conversation actually uses, while Agents knows only the current
  binary. Card #27.
- **Subagent/task attribution**: message `agent_id`, then `parent_task_id`,
  `subagent_type`, `run_id` on `background_tasks_changed` and `task_*`.
  `background.updated` keeps only ID, type, description. Card #22, opened by monitoring.
- **`overageEnabled` on `rate_limit_event` (2.1.295)**: quota warnings indicate
  whether extra usage is enabled. `usage.updated` does not forward it. Card #28.
- **New tool parameters**: Agent `effort` (2.1.292), Read `allow_large` (2.1.296).
  Tool views do not show them. Card #29.
- **529 retry delays**: `CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS` (2.1.292),
  `…_MAX_DELAY_MS` (2.1.296), `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS` (2.1.295).
  Useful for unattended scheduled sessions. Card #30.
- **MCP tool-description and server-instruction limits raised from 2,048 to
  4,096 characters (2.1.296)**: `sillage` server instructions have headroom;
  no `sillage-mcp.mjs` change needed.
- `SDKStartupFailureReason` adds `org_config_required_unavailable` and
  `org_config_refused`; Sillage does not read `startup_failure_reason`.
- Agent-definition `autoCompactWindow` (2.1.296), hook `onFailure: "block"`
  (2.1.295): Sillage writes neither custom agents nor hooks of this kind.

### SDK-session fixes requiring no code

- 2.1.292: background commands no longer stop 5 seconds after an SDK run's final
  result (see #12 for remaining 30-minute limit); first turn no longer waits for
  HTTP/SSE MCP `resources/list`.
- 2.1.293: HTTP MCP connection memory leak; incorrect post-compaction resume.
- 2.1.295: remote MCP servers staying disconnected after outages above 15 seconds;
  rejected return to auto after removing `disableAutoMode`; messages sent during
  active turns no longer lost.
- 2.1.296: interruption during `UserPromptSubmit` hook no longer ends headless
  sessions; `/code-review` returns a numbered list instead of raw JSON array;
  Sonnet 5.5 cache cost becomes $0.10/MTok in SDK figures.

### Today's probes

```js
// Separately downloaded 2.1.296 binary, empty input queue, no model message.
const init = await q.initializationResult()
init.claude_code_version                       // '2.1.296'
await q.applyFlagSettings({ ultracode: true, effortLevel: 'high' })
;(await q.getSettings()).applied
// { model: 'claude-haiku-5-5', effort: 'high', ultracode: true, ultracodeAvailable: true }
await q.setModel('claude-haiku-4-5-20251001')
;(await q.getSettings()).applied
// { model: 'claude-haiku-4-5-20251001', effort: null, ultracode: false, ultracodeAvailable: false }
```

Verified: typecheck, tests, lint; real session (`haiku`, effort `low`, auto mode)
on disposable server using 2.1.296: `GET /api/agents` reads 2.1.296 without version
mismatch, Read runs, turn completes with `success`, context reports one million
tokens. At deployment, run `claude install 2.1.296` on marldev: machine CLI does
not self-update.

## October 17, 2026 addendum: target 2.1.301

Card #42, including monitoring cards #37/#38. CLI target **2.1.301**, SDK dependency
**^0.3.301**, lockfile resolution **0.3.301**. 2.1.302 already exists during this
work but is outside this validation. A fresh install without a lockfile may resolve
the caret to a later version.

### Compatibility and scope

The [official changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
mentions fixes for duplicate SDK resume execution, mid-turn attachments,
post-compaction resume, and message-interrupted permissions. These fixes come
from CLI and require no adapter changes. Not all are reproduced here.

SDK 0.3.296 → 0.3.301 declarations remove no contract used by Sillage. New
parameters remain optional. Decisions for additions:

- `reloadPlugins({ addPlugins })` supports live addition, not removal: retain
  current restart when skill roots change for this bump.
- `BUILTIN_TOOL_NAMES` and `LEGACY_TOOL_NAME_ALIASES` alone do not justify a new
  screen. Available tool list still comes from the session.
- SDK MCP per-tool policies do not concern our current stdio/HTTP MCP transport.
- `CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS` adds to #30: watchdog
  enablement and delays must be configured together. This bump enables no
  automatic retries.
- Idle compaction remains a possibility: this probe established no SDK benefit.
  Do not present it as available in Sillage.

### Transcripts: protecting import and synchronization

The real 2.1.301 trial transcript contains `api-request-shape`, `api-request-blob`,
and `api-request`, with `type` as first property. Even quota-rejected calls write
these lines. `readJsonl` now reads line by line, skipping these three types before
parsing in that format; a post-parse filter also covers different property order.
Anchoring the first filter avoids false positives inside message content. Subagents
use the same reader.

No dependency on internal `CLAUDE_CODE_ELEGANT_MEADOW`: CLI continues writing its
replay, so disk growth remains. This protection does not replace all of #17:
useful entries still accumulate in memory, and synchronization does not read only
the missing suffix.

### Verification and limits

Separately downloaded binary: `@anthropic-ai/claude-code-linux-x64@2.1.301`.
System CLI remains **2.1.296**; no deployment or production restart.

- `initializationResult().claude_code_version`: `2.1.301`.
- Catalog: Opus 5.5, Fable 5.1, Sonnet 5.5, Haiku 5.5, same aliases as before.
- `applyFlagSettings({ ultracode: true, effortLevel: 'high' })`, then
  `getSettings().applied`: Haiku 5.5, high effort, Ultracode active/available.
  After `setModel('claude-haiku-4-5-20251001')`: null effort, Ultracode
  inactive/unavailable. These checks need no model call.
- Probe returns `capabilities: ['mcp_call_result_not_for_model_v1']`; do not assume
  this matches the previous list. Adapter does not depend on it.
- Disposable server, new database, port 7501, binary 2.1.301: project/task creation
  through API v1, Haiku 5.5 initialization, and Sillage MCP connection succeed.
  **Real trial blocked by account quota** before Read and AskUserQuestion.
  Journal correctly receives `error: turn_failed` with quota refusal; SDK also
  sends a final result translated to `stopReason: success`, which alone therefore
  does not prove success. Rerun Read + AskUserQuestion response after quota
  recovery before declaring this path validated.
- `NODE_ENV=development pnpm typecheck`, `pnpm test` (241 tests), `pnpm lint`: OK.
  Added test: 2 MB replay, different property order, content resembling replay
  type, CRLF, truncated line, final line without newline, subagent, missing file.
- Separate memory probe: 200 MB of replay lines followed by one useful message,
  read with Node 24 `--max-old-space-size=96`; only the message retained, no OOM
  (RSS ≈180 MiB; heap limit is not an RSS limit).
- pnpm flags SDK's expected Zod 4 peer against project Zod 3; warning already
  present with 0.3.296. No SDK MCP server is created.

No interface change: no Playwright path added for this bump. During a future
authorized deployment, also install `claude install 2.1.301` through the supervised
procedure; do not install the system CLI during preparation.
