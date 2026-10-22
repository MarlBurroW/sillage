# Grok Build integration

Sillage starts one `grok agent --no-leader stdio` per conversation and speaks **ACP**
(Agent Client Protocol): JSON-RPC over stdio, one line per message, like the Zed
editor. Grok Build adds `_x.ai/…` extensions to standard ACP in both directions.
Everything below was probed on **Grok Build 1.0.62** and read in its public source
(`xai-org/grok-build`, Apache-2.0, whose public repository contained 1.0.45 at
integration time).

The ACP client (`apps/server/src/agents/acp/client.ts`) is handwritten; only the
types come from the official `@agentclientprotocol/sdk` SDK. The SDK's
`ClientSideConnection` validates every incoming message with its zod schema and
would reject Grok-specific variants instead of passing them through.

## Launch and isolation

The process receives an environment that disables what Grok reads by default
outside Sillage (`apps/server/src/agents/grok/launch.ts`):

| Variable | Why |
|---|---|
| `GROK_{CLAUDE,CURSOR}_{RULES,SKILLS,MCPS,HOOKS,AGENTS,SESSIONS}_ENABLED=0` | Grok rereads Claude Code and Cursor configuration. Otherwise, SILLAGE.md and the `sillage` server arrive twice. More critically, Grok republishes the environment of MCP servers from `~/.claude.json`, including tokens, in `_x.ai/mcp/servers_updated`. |
| `GROK_TELEMETRY_ENABLED`, `GROK_TELEMETRY_TRACE_UPLOAD`, `GROK_ERROR_REPORTING` = `false`, `GROK_STORAGE_MODE=local` | Disabled by default, but xAI remote settings can enable them, including uploading session traces (prompts, images). |
| `GROK_FOLDER_TRUST=0` | In ACP, instruction files, MCP servers, and skills in an untrusted folder are silently ignored because no prompt is available. |
| `GROK_DISABLE_AUTOUPDATER=1` | Sillage chooses the version, as with other CLIs. |

`--no-leader` provides a dedicated process without the shared server `grok` starts
for its clients, which would ignore `--plugin-dir`. `--disable-web-search` disables
web tools; it is a `grok` option, not a `grok agent` option, so it goes before
the subcommand.

## Launch settings and live settings

| Sillage setting | In Grok | Live |
|---|---|---|
| Model, effort | `session/new`'s `_meta.modelId` and `_meta.reasoningEffort`, then `session/set_config_option` (`model`, `reasoning_effort`) | yes |
| Ask (`default`) | `yoloMode` and `autoMode` false | yes |
| Automatic (`auto`) | `autoMode`: a classifier decides | yes |
| Allow everything (`bypassPermissions`) | `yoloMode` | yes |
| Plan (`plan`) | `session/set_mode` `plan`; Grok submits the plan through `_x.ai/exit_plan_mode` and returns to `default` | yes |
| Web search | `--disable-web-search` | restart |
| Skill library | `--plugin-dir` per root; `_x.ai/plugins/reload` after a write | restart for the toggle |
| Registry MCP servers, Sillage server | `session/new`'s `mcpServers` (stdio, http, sse) | restart |
| SILLAGE.md, memory, CLI handoff | `session/new`'s `_meta.rules`, appended to the system prompt in `<human_rules>` | creation only |
| Instructions managed in SILLAGE.md | `_meta.agentProfile` with `agentsMd: false`: otherwise repository `AGENTS.md`/`CLAUDE.md` are always read | creation and resume |

Live permissions use the `_x.ai/yolo_mode_changed` notification (`yolo_mode`,
`auto_mode`), which targets every session in the process: there is only one.

## Observed behavior

- **ACP `systemPrompt` field and `--rules` option**: ignored by `grok agent`. Only
  `_meta.rules` works, and only at creation: resume keeps the system prompt saved
  with the session (`system_prompt.txt`).
- **Resume**: `session/resume`, without history replay. `session/load` would replay
  everything through `session/update`. `session/resume` rejects
  `additionalDirectories`, and `session/new` does not read it: files outside the
  working directory require permission.
- **Early notifications**: slash commands and MCP server state arrive before the
  `session/new` response. The runner keeps and replays them.
- **Text and reasoning**: chunked, without a message ID.
- **Tools**: the reliable name is `_meta["x.ai/tool"].name` (`read_file`,
  `search_replace`, `write`, `run_terminal_command`, `grep`, `list_dir`, `todo_write`,
  `spawn_subagent`…), normalized to journal names (`Read`, `Edit`, `Write`, `Bash`…).
  ACP's `title` is a sentence that changes between updates. MCP tools are not
  exposed individually: the model searches for them (`search_tool`), then calls
  them through `use_tool`, with `server__tool` as the name.
- **Command output**: accumulated in `rawOutput.output`, in bytes.
- **Edits**: `diff` blocks (`path`, `oldText`, `newText`). For `search_replace`, these
  are replaced excerpts, not entire files: the displayed diff is partial.
- **Permission**: `session/request_permission` offers `allow-once`,
  `allow-edits-session`, `always-allow`, `reject-once`… Grok reads the response by
  kind (`allow_once`, `allow_always`, `reject_once`). **Rejection ends the entire
  turn** (`cancelled`, category `PermissionRejected`), journaled as `permission_denied`.
- **Questions**: `_x.ai/ask_user_question` request, answers keyed by question title.
  The tool is enabled by default.
- **MCP elicitations**: `_x.ai/mcp/elicit` request (form or URL), closed by
  `_x.ai/mcp/elicit_complete`.
- **Steering**: `_x.ai/interject`, applied at the turn's next safe point. A second
  `session/prompt` during a turn waits in Grok's queue.
- **Interruption**: `session/cancel`. The active `session/prompt` responds `cancelled`.
- **Compaction**: `_x.ai/compact_conversation`, completion announced by
  `auto_compact_completed` (before and after sizes) under `_x.ai/session_notification`.
- **Fork**: `_x.ai/session/fork` with `targetPromptIndex`, the index of the last prompt
  to keep (zero-based). Each Sillage turn is one prompt.
- **Usage**: in the `session/prompt` response's `_meta.usage`. `inputTokens` includes
  cache; `costUsdTicks` is one ten-billionth of a dollar. Context size travels in
  each `session/update`'s `_meta.totalTokens`.
- **Images**: Grok reports `image: false` but reads image blocks sent by its TUI.
  Mentioned files are sent as `file://` links, expanded like an `@path`.
- **Catalog**: the `initialize` response contains the signed-in account's models
  (`_meta.modelState`) and built-in commands without opening a session.

## Sign-in, accounts, and usage

CLI sign-in: `grok login --device-auth` on the machine running Sillage (SuperGrok
or X Premium subscription), or `XAI_API_KEY`. Credentials go in `~/.grok/auth.json`.

Extra accounts are registered in **Settings › Grok accounts**, following the Codex
account design: one `GROK_HOME` per account under `<data>/grok-accounts/<id>`, linked
to the user's home except `auth.json`, `models_cache.json`, and `settings_cache.json`.
Sign-in uses `grok login --device-auth` in that home (Sillage reads the URL and code
from its output), or the ACP `xai.api_key` method, which Grok stores in the home's
`auth.json`. Sign-out runs `grok logout`, then removes that `auth.json`.

The gauge comes from the `_x.ai/billing` extension (`creditUsagePercent`,
`currentPeriod`, `onDemandCap`/`onDemandUsed`, `prepaidBalance`, `subscription_tier`),
read in a disposable process for both the CLI sign-in and every account.

## Out of scope

Subagent threads (their `session/update` events arrive under their own session ID),
background jobs, importing sessions started in the TUI.

## Verification

```sh
pnpm typecheck
pnpm test                 # includes test/grok-*.test.ts, using a fake Grok (test/fixtures/grok-agent.mjs)
pnpm test:grok-ui         # Grok thread rendering: tools, MCP, permission, question, plan
pnpm test:grok-accounts-ui # Grok accounts: sign-in, account choice, gauge, sign-out
```

For a real trial: use a disposable Sillage server (`SILLAGE_DATA_DIR`, a free
`SILLAGE_PORT`, `SILLAGE_CONFIG` pointing `[agents.grok] binary` to the desired
binary), then open a Grok conversation from the interface.
