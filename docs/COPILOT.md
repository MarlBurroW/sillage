# GitHub Copilot CLI integration

Sillage installs `@github/copilot` from npm (pinned to **1.0.116**), starts one
`copilot --acp` per conversation and speaks **ACP** (Agent Client Protocol) over stdio,
through the same handwritten client as Grok and Antigravity
(`apps/server/src/agents/acp/client.ts`). Plain ACP is completed by Copilot's own
**session events**, subscribed at `initialize`. The code lives in
`apps/server/src/agents/copilot/`.

Everything below was observed on the real **1.0.116** binary, in two ways that do not
cover the same ground:

- **A scripted model provider.** Copilot accepts a model provider of your own
  (`COPILOT_PROVIDER_BASE_URL`), which needs no GitHub sign-in. A local server that
  answers with the tool calls a script names drove the real binary through every tool,
  permission, question, sub-agent, background shell, error and resume, without an
  account and without spending anything. This is what the tables call **scripted**.
- **Signed-in accounts**, model Auto, on two plans that only list Auto. A handful of
  real turns: an edit behind a permission, the instruction channel, a question, tokens
  per turn, the quota, Auto's routing, a resume, and one turn through a disposable
  Sillage server and its interface. This is what the tables call **signed in**.

What only a larger plan shows (a catalog with several models, efforts, premium
requests) is listed under [Not yet verified](#not-yet-verified).

## Coverage inventory

| Area | Implementation | Limits / verification |
| --- | --- | --- |
| Installation | npm package `@github/copilot`, a loader that pulls the binary of the platform as an optional dependency (about 220 MB). The version probe reads `copilot --version`. | Installed through npm on Linux x64. On first run the binary unpacks itself into `~/.cache/copilot` (about 320 MB more); `COPILOT_CACHE_HOME` moves it. Windows and macOS not tried. |
| Updates | Sillage chooses the version (Settings › CLI versions): `--no-auto-update` and `COPILOT_AUTO_UPDATE=false` stop both the download and the launch of a newer cached build. | Read from `copilot help environment`. |
| Sign-in | The machine's own: `copilot login` (device code on a server), or `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` in the server's environment, which win over a stored login. | Signed in. Without a sign-in, `session/new` answers `Authentication required` and the conversation says how to sign in. Classic tokens (`ghp_…`) are refused by Copilot, a GitHub CLI login made with one included. A server without a keychain needs `storeTokenPlaintext`; see [Sign-in](#sign-in-accounts-and-usage). |
| Conversation | Streamed text and thinking, title, context meter, per-turn tokens. | Scripted and signed in. |
| Interrupt | `session/cancel`, then a 15 s watchdog. Calls left open are closed as interrupted. | Scripted. |
| Resume | `session/load`. Copilot replays the whole history before answering; the runner drops it, already journaled. | Scripted and signed in. |
| Native history | Sessions started in a terminal are listed for the project folder (`session/list`, no sign-in needed) and adopted from the history `session/load` replays: prompts, calls, replies, a sub-agent's included. | Scripted. Thoughts and to-do lists are not replayed by Copilot. Turns made in a terminal after the adoption are not resynced. |
| Tools | Named after the native tool and mapped to canonical names and arguments; see [Tools](#tools). A command that exits non-zero shows as failed, a failed call shows its reason. | Scripted, every tool of the table. `apply_patch` (GPT models) signed in. |
| MCP tools | Named `server/tool` from the call's own metadata. | Scripted with a stdio server. |
| Sub-agents | `task` is an `Agent` row; its calls, thoughts and replies nest under it, in the foreground and in the background. | Scripted. On the signed-in plan the call itself failed (`400 The requested model is not supported.`), shown as a failed row with that reason. `/fleet` and `/delegate` not tried. |
| Background work | A shell left running (`mode: async`) is listed as background work until Copilot reads its exit. When it finishes after the turn, Copilot reads it by itself: that is journaled as a turn of its own. | Scripted, attached and detached shells. Copilot has no client call to stop a shell: only the model can (`stop_bash`). |
| To-do list | Copilot keeps it in a session database; changes arrive as an ACP `plan` and show as the plan card. | Scripted. |
| Permissions | Allow once, allow for the session, deny, from `session/request_permission`: tools, paths outside the allowed folders, URLs. A refusal ends Copilot's whole turn, which closes as `permission_denied`. | Scripted. |
| Questions | `ask_user` arrives as an `elicitation/create` form. A form made only of choices is a question card (a free answer is allowed); anything else is a form. The call itself is not shown as a tool row. | Scripted and signed in. Copilot only offers `ask_user` to a client that announces forms, which Sillage does. |
| Plan review | Not offered over ACP: plan mode exposes no `exit_plan_mode` tool to an ACP client. Plan mode itself works. | Scripted (tool list of plan mode). |
| Composer | Model, effort when the model has one, Auto profile, mode (Agent, Plan, Autopilot), permissions (Manual, Assisted, Allow all), skill library, MCP servers. With Auto, a notice names the model that answered. | Scripted and signed in. Efforts and a multi-model catalog only with the fixture. |
| Attachments | Images inline, other files and `@` mentions as resource links, picked skills as embedded Markdown. | Scripted: the image reaches the model, the linked file is named in the prompt, the embedded resource is attached. |
| Commands | Published live and for drafts. `/model` and `/clear` are hidden like for the other CLIs; `/cwd`, `/add-dir` and `/session` too, which would move the session out of what Sillage tracks. | Scripted: `/usage`, `/context`, `/env`, `/compact` and a skill's own command answer as replies. |
| Compaction | The compact action sends `/compact`; Copilot's events say when it starts and what it saved. Automatic compaction is reported the same way. | Scripted (manual). |
| Skills | One `--plugin-dir` per library skill; each is also a slash command. Reload is a restart before the next turn. | Scripted: listed in the model's skills, command expands the skill. |
| MCP | Servers go in `session/new` and `session/load` (stdio, HTTP, SSE). Health follows Copilot's events: pending, connected, failed with its reason. Servers from Copilot's own files and its built-in GitHub server show as external. | Scripted with one working and one broken stdio server. No per-server reconnect call. |
| Instructions | SILLAGE.md and the overview go to an instruction file in a private folder named by `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`, reread on every launch. | Scripted (the text reaches the system prompt) and signed in. Repository `AGENTS.md`, `CLAUDE.md` and `.github/copilot-instructions.md` are **not masked**. |
| Memory | Reachable through Copilot's file tools (`--add-dir`). | Not tried on a real turn. |
| Errors | Copilot's errors, warnings and retries are journaled as such, with shared codes for rejected sign-in, rate limit, exhausted quota and context overflow. A refused request for quota or rate limit also marks the account as stopped, which is what lets Sillage offer to resume later. | Scripted: provider 401 and 429. Real quota and rate-limit refusals not seen. |
| Accounts | None beyond the machine's sign-in. | See [Sign-in, accounts and usage](#sign-in-accounts-and-usage). |
| Usage | Per-turn tokens. The plan gauge shows the quota the last model call reported: the monthly budget in AI credits, or premium requests. | Tokens and the AI-credit budget signed in. Premium requests read from Copilot's schema only. |
| Forks / transfers | No fork call: a fork starts a new Copilot session with the conversation up to the chosen turn as portable context. Transfers to and from the other CLIs go through the instruction channel. | UI check, both directions. |
| Editions | Server and Desktop behave alike: one sign-in for the machine, nothing to configure. | UI check on both profiles, 1440×900 and 390×844, with the fixture; one signed-in turn through a Server on Linux. Windows and macOS launches not tried. |

## Launch and isolation

| Choice | Why |
|---|---|
| `--acp` | The protocol. Naming the client at `initialize` marks the session as driven by a person. |
| `--no-auto-update`, `COPILOT_AUTO_UPDATE=false` | Sillage chooses the version. The flag alone still lets plugin updates run and a previously downloaded build start. |
| `--disable-client-telemetry` | Copilot-owned telemetry off; server-side telemetry is GitHub's. |
| `COPILOT_PLUGIN_DIR_ONLY=true` | The user's installed plugins would bring MCP servers and hooks Sillage does not show. |
| `COPILOT_DISABLE_DESKTOP_NOTIFICATIONS=1` | Nobody sits at the server. |
| `--plugin-dir <skill>` per library skill | It accepts a folder holding a `SKILL.md` and names the command after the skill. A library root would need a `plugin.json` and prefix every command. |
| `--add-dir` for additional directories, worktrees, memory and attachments | Copilot asks for every path outside the working directory otherwise. |
| `--auto-tier` | The Auto profile, only when the model is Auto. |
| `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` | The instruction channel, see below. |
| Announced at `initialize`: `elicitation.form`, and the session events of `COPILOT_SESSION_EVENTS` | See [Session events](#session-events). |

What Sillage writes for Copilot lives under `<data>/copilot`: one instruction folder
per conversation, removed when its session stops, and the empty folder the catalog
probe runs in. Not in the system temporary directory, which other local accounts can
write to first.

The catalog probe opens a session to read the models, and Copilot keeps a folder for
it in its own home (`session-state/<id>`) even though it never receives a prompt and
is not listed. The probe removes that folder, and only a folder without an event log.

## Launch settings and live settings

| Sillage setting | In Copilot | Live |
|---|---|---|
| Model | `session/set_config_option` `model` | yes |
| Effort | the option of category `thought_level`, when the model has one | yes |
| Permissions: Manual, Assisted, Allow all | `allow_all` option `off`, `auto`, `on` | yes |
| Mode: Agent, Plan, Autopilot | `mode` option (`https://agentclientprotocol.com/protocol/session-modes#agent`…) | yes |
| Auto profile | `--auto-tier` (ACP answers `Unknown config option 'auto_tier'`) | restart |
| Skills, MCP servers, directories, instructions | launch | restart |

Copilot's own names are kept. What Copilot changes itself (`config_option_update`,
`current_mode_update`) is written back to the conversation's settings. Autopilot and
anything other than Manual count as permissive for API tokens (`tasks:autonomous`).

## Session events

`copilot help acp` documents three events a client can subscribe to through
`clientCapabilities._meta["github.com/copilot"].events`. The same subscription accepts
the other event types of the CLI's `session-events.schema.json`; they arrive as
`github.com/copilot/sessionEvent` notifications. Sillage subscribes to the ones that
say what plain ACP leaves out:

| Event | Used for |
|---|---|
| `assistant.message` | `toolRequests`: the native name of each call, and the server and tool of an MCP call. The ACP frame only has a kind and a prose title. |
| `assistant.turn_start` | With an `agentId`: `parentToolCallId`, the only link between a sub-agent and the call that spawned it. |
| `assistant.usage` | Tokens of each model call, the account's quota, the model Auto routed to (`isAuto`, `modelDisplayName`). |
| `assistant.turn_retry` | A retry notice. |
| `session.idle` | The end of a turn Copilot started by itself. |
| `session.info`, `session.warning`, `session.error` | Notices and errors as data. |
| `session.compaction_start`, `session.compaction_complete` | Compaction, with tokens before and after. |
| `session.mcp_server_status_changed`, `session.mcp_servers_loaded` | MCP server health. |

`tool.execution_*`, `subagent.*`, `session.skills_loaded` and
`session.todos_changed` are not relayed even when asked for.
`session.auto_mode_resolved` is relayed and says why Auto chose a model; the notice
only needs the name, which every model call carries.

## Tools

| Copilot | Sillage | Notes |
|---|---|---|
| `view` | `Read` | `view_range` becomes `offset` and `limit`. |
| `create` | `Write` | |
| `edit` | `Edit` | `old_str` / `new_str` become `old_string` / `new_string`. |
| `apply_patch` (GPT models) | `Edit`, or `Write` for `*** Add File` | The path comes from the patch header. |
| `bash` | `Bash`, labelled with its `description` | `mode: async` is a background command. |
| `grep`, `glob` | `Grep`, `Glob` | |
| `web_fetch` | `WebFetch` | |
| `task` | `Agent` | Sub-agent; `mode: background` runs it in the background. |
| `skill` | `Skill` | |
| `ask_user` | a question card, no tool row | |
| `sql`, `read_bash`, `stop_bash`, `read_agent`, `write_agent`, `session_artifacts`… | their own name, with Copilot's title | |
| MCP tools | `server/tool` | |

Edits close with ACP `diff` blocks: `file.edited` and the diff view come from them.
The full output of a call is `rawOutput.content`; Copilot's own status line at the end
of a shell's output (`<shellId: 0 completed with exit code 0>`) is removed, the exit
code decides whether the row failed.

## Observed behavior

Quirks of 1.0.116 the next maintainer must know.

- **The prompt response counts tokens since the process started**, sub-agents
  included, not the turn's. The counter restarts with the process. A turn's tokens are
  the model calls reported as `assistant.usage` during it, or the difference with the
  previous response when no event arrived. Copilot's input includes cache reads and
  writes, and its output includes reasoning (`copilot help billing`).
- **Copilot writes its own lines into the reply**: "Info: …" (a created file, a
  cancellation, a retry), "Warning: …" and "Error: …" arrive as message chunks. Only
  the model's chunks carry a `messageId`. The runner drops a line that repeats an
  event it received, and keeps the rest: the output of `/usage` or `/context` has no
  message ID either, and is the reply.
- **Most `session.info` events are never shown by Copilot itself**: every signed-in
  session starts with one about its search guidance. An information event becomes a
  notice only when Copilot also writes its line into the reply.
- **A failing command closes as `completed`.** Its exit code is in
  `rawOutput.contents`.
- **A second `session/prompt` cancels the turn in progress** rather than steering it.
- **A refused permission ends the whole turn**, with `stopReason: "end_turn"`.
- **A model error ends the turn with `end_turn` and no usage**, after an "Error: …"
  line.
- **The prompt response waits for attached background work.** A detached shell
  outlives it; when it finishes, Copilot reads its output and answers without a
  prompt, and nothing but `session.idle` says that turn is over.
- **Entering Autopilot turns `allow_all` on, leaving it turns it back to Manual**,
  whatever it was before. The mode is therefore applied after the permissions.
- **`config_option_update` follows every model change, a sub-agent's included.**
- **`session/load` replays without session events**: a sub-agent of the history is
  attached to the spawning call still open, or to the last one started.
- **The command list is announced three times at startup.**
- Not found: `session/fork`, `session/resume`, `account.getQuota`, `models.list`.
  `session/close` and `logout` exist. `session/close` keeps the session's folder.
- **A quota snapshot describes the account before the call that carries it**, and its
  `usedRequests` is a whole number: on a budget of 200 AI credits a turn only shows in
  `remainingPercentage`.
- `/usage` over ACP prints the session's spend ("0.28 AI Credits") and nothing of the
  plan; a prompt answered by a slash command carries no `usage`.
- Unknown slash commands go to the model as text.

## Deliberate differences

- **No account choice.** See below.
- **Steering is off**: a message sent during a turn waits in Sillage's queue.
- **`/cwd`, `/add-dir`, `/session`** are not offered.
- **Repository instructions are not masked**: `--no-custom-instructions` is ignored
  under `--acp`, so a repository that holds `AGENTS.md` or `CLAUDE.md` reaches the
  model twice when SILLAGE.md repeats it.
- **The instruction file keeps its frontmatter in the prompt.** Only a
  `*.instructions.md` file with `applyTo: "**"` is read from the extra folder; an
  `AGENTS.md` or a `copilot-instructions.md` placed there is ignored.
- **Information lines Copilot repeats** (created file, cancellation, retry) are not
  shown: the journal already says it.

## Sign-in, accounts and usage

Copilot uses the sign-in of the machine: `copilot login`, or a token in the server's
environment. On a Server every account of the instance therefore works on the same
GitHub Copilot plan, like OpenCode's providers; Desktop has a single account anyway.
A token in `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` or `GITHUB_TOKEN` wins over a stored
login without saying so: a `GH_TOKEN` exported for the GitHub CLI also decides which
plan pays.

Extra Sillage accounts are **deferred**. The pieces exist in Copilot
(`COPILOT_HOME` moves its state, `copilot login --device-code` prints a link and a
code a remote browser can use), but an account needs its own table, a login that was
tried against GitHub, and a way to keep the machine's token and the GitHub CLI login
from answering in its place.

`copilot login` stores its token in the system keychain. A server usually has none:
Copilot then only writes the token to `config.json` in its home when
`"storeTokenPlaintext": true` is set in its `settings.json`, or when the prompt it
shows in a terminal is accepted. Run without a terminal and without that setting, the
login succeeds on GitHub and then fails with "the token was not saved".

Copilot's ACP has no quota call. Each model call reports the account's quota
(`quotaSnapshots`): the gauge shows the last reading, dated by its turn, and nothing
before the first turn after a server start. Three snapshots arrive:

- `chat` is the plan's monthly budget. On an account billed in AI credits it counts
  those credits (200 a month on the plan observed) and goes down with every model
  call of a turn; the gauge labels it **AI credits**.
- `premium_interactions` is what a prompt spends on a plan billed in premium
  requests. The observed plans had none.
- `completions` counts the editor's inline completions. CLI turns do not move it, and
  it is left out.

A full quota is a warning, because Copilot may go on with included models or paid
overage; only a refused request marks the account as stopped.

## Verification

- `apps/server/test/copilot.test.ts`, 18 tests on
  `test/fixtures/copilot-agent.mjs`, which speaks the wire shapes captured from the
  real binary: catalog, launch, tool mapping, events, tokens per turn, options,
  sub-agents, questions, MCP, errors, shells and the turn Copilot opens itself,
  compaction, resume, adoption, listing, interrupt, quota.
- `pnpm test:copilot-ui` (`scripts/copilot-ui-check.mjs`): both editions, 1440×900
  and 390×844, with the fixture: defaults, adoption of a native session, a turn with
  tools and a sub-agent, a question, a permission, compaction, fork, transfers both
  ways, the consumption color.
- The real binary against a scripted provider: the same journeys through
  `CopilotRunner`, plus MCP servers, errors, interrupt, Autopilot and adoption.
- Signed in: the runner on two real turns (a question answered through the card, the
  instruction channel, Auto's notice, tokens per turn, the built-in GitHub MCP
  server), and one turn through a disposable server and the interface (model list, a
  file created behind the permission card, the gauge before and after).
- `npx tsx src/cli/copilot-probe.ts` in `apps/server`: two real turns on the
  signed-in account. It spends requests.

### Not yet verified

- A plan that lists models other than Auto: the catalog, efforts per model, the
  context-size option.
- A plan billed in premium requests: the `premium_interactions` gauge.
- A real quota or rate-limit refusal.
- A sub-agent on a plan whose models allow it.
- A sign-in made from Sillage: none is offered.
- Images and documents on a signed-in turn (the scripted provider received the image).
- The Sillage MCP server and a registry server over HTTP in a real conversation;
  whether a server Sillage passes can collide with one of the same name in
  `~/.copilot/mcp-config.json`.
- Windows and macOS, Desktop included: the npm `copilot` shim follows the generic
  npm launch path.
- `/fleet`, `/delegate`, workflows (`run_dynamic_workflow`), `/remote`.

## Sources

- `copilot --help` and `copilot help acp | environment | billing | sessions |
  skills | mcp | limits` of 1.0.116.
- `schemas/session-events.schema.json` in the package the binary unpacks.
- Wire captures of the real binary.
