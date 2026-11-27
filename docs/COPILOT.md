# GitHub Copilot CLI integration

Sillage starts one `copilot --acp` per conversation and speaks plain **ACP** (Agent Client
Protocol) over stdio, through the same handwritten client as Grok and Antigravity
(`apps/server/src/agents/acp/client.ts`). The code lives in `apps/server/src/agents/copilot/`.
Everything below was probed on **GitHub Copilot CLI 1.0.116** (`@github/copilot` on npm), signed
in with a Copilot Free account, unless stated otherwise.

## Models and Auto

Copilot advertises its models only inside a session, as the ACP `model` config option; `initialize`
carries none. The catalog (`catalog.ts`) opens a disposable session in an empty folder: a session
that never receives a prompt is not listed by `session/list`, so it leaves no trace in the user's
history.

- **Auto** (`auto`) lets Copilot pick the model for each request. It leads the list, as it does in
  OpenCode's GitHub Copilot section, because it is a way of choosing rather than one model.
  Copilot lists it twice (a description entry, then one carrying the premium multiplier in
  `_meta.copilotUsage`); Sillage shows one row with the multiplier in its hint.
- The models follow the plan: a Free plan lists only Auto. `copilot help config` names many more
  (`claude-sonnet-5.5`, `gpt-6.2-sol`…), but `session/set_config_option` rejects any model the
  session did not list (`Invalid modelId … not one of this session's models`), so Sillage offers
  only the listed ones.
- **Auto profile** (`autoTier`): `efficiency`, `balance` or `intelligence`, or a profile the server
  advertises. ACP has no option for it (`Unknown config option 'auto_tier'`), so it goes through
  `--auto-tier` at launch, only when the model is Auto, and changing it restarts the process. Empty
  keeps the CLI's own setting (`autoTier` in Copilot's config, `balance` otherwise).
- **Effort**: no effort option is advertised on Auto. For other models the catalog reads an option
  of ACP category `thought_level` after selecting each model. **Not verified**: a plan that lists
  models other than Auto was not available.

## Launch and isolation

| Choice | Why |
|---|---|
| `--no-auto-update`, `COPILOT_AUTO_UPDATE=false` | Sillage chooses the version (Settings › CLI versions). The flag alone still lets plugin updates run and a previously downloaded build start. |
| `--disable-client-telemetry` | Copilot-owned telemetry off; server-side telemetry is GitHub's. |
| `COPILOT_PLUGIN_DIR_ONLY=true` | The user's installed plugins would bring MCP servers and hooks Sillage does not show. |
| `--plugin-dir <skill>` per library skill | `--plugin-dir` accepts a folder holding a `SKILL.md` and names the command after the skill. A library root would need a `plugin.json` and prefix every command. |
| `--add-dir` for additional directories, worktrees, memory and attachments | Copilot asks for every path outside cwd otherwise. |
| `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` | Instruction channel, see below. |

## Configuration

| Sillage setting | In Copilot | Live |
|---|---|---|
| Model | `session/set_config_option` `model` | yes |
| Effort | the `thought_level` option, when the model has one | yes |
| Auto profile | `--auto-tier` | restart |
| Mode: Agent, Plan, Autopilot | `mode` option (`https://agentclientprotocol.com/protocol/session-modes#agent`…) | yes |
| Permissions: Manual, Assisted, Allow all | `allow_all` option `off`, `auto`, `on` | yes |
| Skills, MCP servers, directories | launch | restart |

Copilot's own names are kept. Changes Copilot makes itself (`config_option_update`,
`current_mode_update`) are written back to the conversation config. Autopilot and anything other
than Manual count as permissive for API tokens (`tasks:autonomous`).

## Conversation

| Feature | Status |
|---|---|
| Streamed text and thinking (`agent_message_chunk`, `agent_thought_chunk`) | covered, fixture and real turn |
| Title (`session_info_update`) | covered |
| Turn tokens (`session/prompt` usage), context meter (`usage_update`) | covered, real turn |
| Interrupt (`session/cancel`, 15 s watchdog) | covered, fixture |
| Resume (`session/load`) | covered, real turn. Copilot replays the whole history before answering; Sillage drops the replay, already journaled. |
| Steer, manual compact | not offered over ACP; `/compact` stays a slash command |
| Images, mentions, attachments, skills | sent as ACP `image`, `resource_link` and `resource` blocks. Images not verified on a real turn. |
| Fork | portable history fork: no native fork RPC |
| Native session import | deferred: `session/list` exists, `session/load` replays history |

## Tools

Copilot sends no native tool name, only the ACP `kind`, a prose `title` and `rawInput`
(`tools.ts`):

| Copilot | Sillage | Recognized by |
|---|---|---|
| view | `Read` | `kind: read`, `rawInput.path` |
| shell | `Bash`, labelled with its `description` | `kind: execute` |
| `apply_patch` | `Edit`, or `Write` for `*** Add File` / Create file | `kind: edit`; the path comes from the patch header, then `fileName` in the permission request |
| grep | `Grep` | `pattern` with `output_mode` or a "Searching" title |
| glob | `Glob` | `pattern` otherwise |
| web fetch | `WebFetch` | `kind: fetch` |

Edits close with ACP `diff` blocks: `file.edited` and the diff view come from them. The full tool
output is `rawOutput.content`.

## Permissions

`session/request_permission` offers `allow_once`, `allow_always` and `reject_once`; Sillage maps
them onto once, session and deny. Questions through Copilot's `ask_user` tool and plan review were
not observed over ACP: **not verified**.

## Instructions, memory, skills, MCP

- **SILLAGE.md and the project overview** go to
  `$TMPDIR/sillage-copilot/<conversation>/.github/instructions/sillage.instructions.md`
  (`applyTo: "**"`), named by `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`. Copilot reads it on every launch,
  so a resumed session gets the current version. Verified on a real turn.
- **Repository AGENTS.md / CLAUDE.md are not masked**: `--no-custom-instructions` is ignored under
  `--acp` in 1.0.116 (a real turn still read the repository's AGENTS.md).
- **Memory** is reachable through Copilot's file tools (`--add-dir`).
- **Skills** are listed as slash commands and sent as resources when picked in the composer.
- **MCP**: servers go in `session/new`/`session/load` (stdio, HTTP, SSE). Without a health
  notification, a server turns `connected` on its first successful call.

## Slash commands

Live from `available_commands_update`, and for drafts from the catalog session. `/model` and
`/clear` are hidden like for the other CLIs; `/cwd` and `/add-dir` are hidden because they would
move the session outside the conversation's settings.

## Not covered yet

- Extra Sillage accounts (`COPILOT_HOME` per account, device-code login): Copilot uses the
  machine's `copilot login`, or `COPILOT_GITHUB_TOKEN`/`GH_TOKEN` from the server environment.
- Usage gauge: ACP exposes no quota call; `limitsAvailable: false`.
- Native session import, subagents (`/fleet`) nested under their parent, background shells.
- Windows and macOS Desktop launches were not tried; the npm `copilot` shim follows the generic
  npm path.

## Checking

- `apps/server/test/copilot.test.ts` with `test/fixtures/copilot-agent.mjs` (wire shapes from 1.0.116).
- `npx tsx src/cli/copilot-probe.ts` in `apps/server`: two real turns (edit behind a permission,
  instructions, usage, resume). It spends requests from the signed-in account.
