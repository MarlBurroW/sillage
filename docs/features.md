# Feature reference

[Back to the overview](../README.md) · [Get started](../README.md#server-or-desktop)

This guide covers the details behind the [main features](../README.md#what-you-can-do).
Features that need remote access, push notifications or incoming webhooks use
Sillage Server. The [desktop guide](desktop.md#what-differs-from-sillage-server)
explains the differences.

## Working with your agents

- **Sessions that outlive the client.** The event journal on the server is the
  source of truth, not the browser: close the browser mid-turn and reopen on a
  phone through your configured remote connection. While the host stays awake and
  Sillage is running, the agent keeps working and the thread replays as it happened.
- **A queue, and steering.** Write while a turn runs. The message waits on the
  server and can be withdrawn, or goes straight into the turn already in flight.
- **One grammar for every CLI.** Claude Code, Codex, OpenCode, Grok Build and Google Antigravity are translated
  into a single event schema, so history, search, the board and the panel behave the
  same way whichever one ran the conversation.
- **The repository, one panel away.** File explorer, editor, diffs, a branch graph
  and terminals, beside the conversation that changed them. Stage changes, commit,
  manage branches and remotes, or copy and move several files at once. The commit
  history draws its branches and merges as a graph, over the current branch or all
  of them, with a diff inspector for each commit. Images that agents read or
  produce open in a viewer with zoom, rotation, copy and download. Markdown images
  also resolve in worktrees linked after the conversation started.
- **What each turn changed, and a way back.** With turn checkpoints enabled on a
  project, Sillage captures the workspace before and after every turn in hidden git
  refs. Each turn lists the files it changed, opens them as a diff, and can be
  reverted: the files go back to their state before the turn, commits made during
  it stay as uncommitted changes, and you can fork the conversation from before
  that turn at the same time.
- **Project actions.** Save a test command, a dev server or a debug script as a
  button, available from the project header, the workspace panel and the command
  palette. Tasks keep their output and exit code; services run as persistent user
  units on Linux with systemd, with a terminal fallback elsewhere. Agents can
  propose actions for you to review before their first launch from the interface.
  Definitions stay in Sillage, without adding files to your repository.
- **Worktrees, followed to the end.** Start a conversation on the project root, on
  an existing worktree, or on a branch Sillage creates for it. The project page lists
  every tree git knows, including those created from a shell, compared with the
  default branch: uncommitted work, commits to merge, merged, or folder missing, with
  the sessions working there. The sidebar shows each conversation's branch and state.
  Cleaning up a tree is one action that first says what would be lost; once a tree
  is merged and clean, Sillage proposes the cleanup as a decision. Agents create and
  list worktrees through `create_worktree` and `list_worktrees`, so the interface
  sees them.
- **References between conversations.** Type `@@` to find a session and insert a
  reference, or copy one from the session menu. References in messages and agent
  replies show a preview and open the original conversation. The composer's
  **Insert** menu explains the shortcuts for files (`@`), sessions (`@@`), cards
  (`#`), commands (`/`) and skills (`$`, where supported by the CLI).
- **Your choice of tool presentation.** Appearance settings offer discreet lines,
  a timeline, groups by purpose, useful previews, a compact console and the classic
  view. Completed sequences fold when the agent speaks again. Open details to read
  inputs, outputs and file changes; failures remain visible in folded groups.
  Long histories load progressively and full tool outputs load on demand.
- **Concentration mode.** Hide navigation and secondary controls while keeping the
  conversation, composer and temporary file panels available. Restore the previous
  layout without losing a draft or your reading position. Conversation actions
  remain directly accessible as icons outside this mode, including on phones.
- **Reading preferences.** Adjust the conversation width and activity indicator in
  Appearance settings. Optionally add RSS or Atom feeds in News to read headlines
  while an agent works; the feed is off until you enable it.
- **Full-text search** across every conversation in every project.
- **Processes launched by Sillage.** On Linux, see what each agent and terminal has
  started, each command with its process tree, ports and originating conversation,
  plus the permanent apps agents run as `sillage-app-*` systemd units; stop them from
  the same page. Other systemd services and tmux sessions are excluded.
  [Detection and limits](services.md).
- **A board connected to GitHub.** Keep local cards alongside issues from a linked
  repository, with descriptions, comments, attachments and sessions. Choose whether
  new cards stay local or become issues; labels and issue state map to board columns.
  Any session in a project can edit its cards and leave notes through the built-in
  MCP server, as well as create cards and close or reopen linked issues. Link tickets
  as blockers, related work, duplicates, parent/sub-tickets or replacements from the
  interface or an agent. Relations appear in both directions and stay local to Sillage. Optional maintenance starts a session for a new
  issue and brings subsequent comments into that issue's session, using your
  instructions, CLI and worktree choice.
- **Sessions that coordinate.** Through the same server, a session can message
  another, ask to be notified when it finishes, or start a new one when you ask:
  "start a Codex session at max effort to fix this" opens a conversation that you
  can follow like any other, with its own CLI, model, effort and worktree. The new
  session starts with the project's default permissions.
- **Scheduled tasks.** A prompt replayed on a schedule, by interval, cron
  expression or at a single date, each run in a fresh session of the CLI you chose,
  with the model, effort and permissions fixed on the task. The daemon fires it with
  nobody at the keyboard: the agent is told so, gets the date, link and last reply of
  the previous run, and is cut off after a maximum duration. Runs stay out of the
  session list and sit under their task in the sidebar. An optional check script
  runs first, in any language: exit 0 wakes the agent with the script's output,
  exit 10 skips the run without opening a session, so a daily watch only costs
  tokens when something changed. Agents can schedule too, through `schedule_task`,
  the durable equivalent of Claude's session-bound cron; a check script an agent
  writes waits for your approval before it runs.
- **Webhook automations.** Start a session when an issue gets a label, a pull
  request opens, CI fails, or another service sends an event. Inspect payloads,
  build conditions and prompts from their fields, and simulate a delivery without
  starting an agent. GitHub templates, an optional sandboxed JavaScript filter,
  delivery deduplication and hourly limits help keep triggers under control.
- **Decisions for autonomous work.** Enable decision requests on a schedule,
  webhook automation or GitHub maintenance rule. The agent can leave a question in
  **Decisions** and receive your answer back in its session, with an expiry and an
  optional fallback choice. This is separate from the CLI's permission requests
  and is off by default for each source.
- **Shared instructions and memory.** One `SILLAGE.md` and one project memory for
  all five CLIs, editable from the interface, which agents can read and rewrite.
  [How it works](#instructions-and-memory).
- **Installable PWA with notifications.** In-app toasts for questions and decisions,
  push notifications on other devices, and silence while you already have the
  conversation open. Manage subscribed devices and send a test from Settings.
- **Dictation** biased with a lexicon read from the project itself plus the
  current branch, then an optional cleanup pass. Any OpenAI-format endpoint.
- **Continue a conversation in another CLI.** From Claude Code to Codex, OpenCode or
  Grok Build or Google Antigravity and back: the new agent receives a budgeted selection of the thread, full messages rather
  than a summary, with references it can read back through the Sillage MCP server.
  [How the handoff is built](cli-handoff.md).
- **MCP servers** declared once and handed to the agents that should get them.
- **A shared skill library** for Claude Code, Codex, OpenCode, Grok Build and Google Antigravity, with global and
  project skills managed from the interface. [Skill library](skill-library.md).
- **Extra accounts.** Register other Claude subscriptions or API keys, other Codex
  subscriptions or API keys, and other Grok subscriptions or xAI API keys from the
  interface, then pick one when creating
  a conversation or from its composer. Compare subscription usage before choosing;
  extra Claude subscriptions need a separate guided sign-in to enable their gauge.
  Added accounts belong to the Sillage user who registered them.
  [Extra accounts](accounts.md).
- **Google Gemini through Antigravity.** Native commands, model-specific thinking levels,
  permissions, skills, MCP, account selection and history import. Google ACP has no
  native fork: Sillage starts a new session with portable context through the selected
  turn. Manual compaction and live steering are unavailable in this protocol.
  [Coverage and limitations](antigravity-integration.md).
- **A composer you can arrange.** Model and effort sit in one chip under the
  message box, with a slider for supported effort levels; pin the other settings you use next to it: permissions, speed,
  account, advisor or other controls supported by that CLI, and order them. Each
  CLI keeps its own layout; on a phone the chip stays and the rest lives in the
  settings panel.
- **A task API for machines.** `/api/v1` speaks tasks rather than screens: open
  one in a project, follow its events, answer what it asks, steer or interrupt
  it, and take a webhook when it lands. Bearer tokens carry their own scopes and
  an optional list of allowed projects, separate from the browser session.
  Create projects with `POST /api/v1/projects` and the explicit `projects:write`
  scope on an unrestricted token. [Project creation API](api.md).
- **Sillage's MCP from your own tools.** Connect an external CLI to project history,
  boards, instructions and memory, and launch work across projects. Use stdio on
  the host or over SSH, or Streamable HTTP at `/api/v1/mcp` with an API token carrying
  the `mcp` scope and optional project restrictions. Session-to-session messaging
  stays inside Sillage. [MCP setup and scope](mcp.md).

The CLI versions this tree targets are kept in
[`packages/protocol/src/cli-versions.ts`](../packages/protocol/src/cli-versions.ts).
Sillage can install them from Settings and flags incompatible installed versions.

## Instructions and memory

Each CLI keeps its own context files: Claude Code reads `CLAUDE.md` and its auto
memory under `~/.claude`, Codex reads `AGENTS.md`, OpenCode and Grok Build read
`AGENTS.md` or `CLAUDE.md`. Sillage gives all four the same two things instead.

|  | Instructions (`SILLAGE.md`) | Memory |
| --- | --- | --- |
| What it holds | Rules you set: conventions, preferences, things to avoid | What agents learned while working: decisions, pitfalls, facts |
| Scope | One global part, one part per project | One per project, shared by all its worktrees |
| Who writes | You, in the interface; agents when you ask them | Agents, on their own; you can fix or delete notes |
| Claude Code | Appended to its system prompt | Its native auto memory, pointed at Sillage's folder (`autoMemoryDirectory`) |
| Codex | Added to its developer instructions | The index is given at startup; it reads notes from the folder and writes through MCP tools |
| OpenCode | Sent as the system prompt of each message | The index comes with each message; it reads notes from the folder and writes through MCP tools |
| Grok Build | Appended to its system prompt when the session is created (`rules`) | The index is given at creation; it reads notes from the folder and writes through MCP tools |
| Agent tools | `read_instructions` · `edit_instructions` · `write_instructions` | `read_memory` · `write_memory` · `delete_memory` |
| Edited from | Settings › Instructions (global), the project page, the conversation header | The project page |

**Where a project's instructions live** is chosen when the project is created, and
can be changed later:

- *In Sillage*: kept in Sillage and given to every CLI. The repository's `CLAUDE.md`
  and `AGENTS.md` are hidden from agents (`claudeMdExcludes` for Claude Code,
  `project_doc_max_bytes = 0` for Codex, `OPENCODE_DISABLE_PROJECT_CONFIG` for
  OpenCode, an agent profile without `agentsMd` for Grok Build) so nothing arrives twice. The files themselves are not touched.
  OpenCode has no finer switch: its project `opencode.json` and `.opencode/` folder
  are skipped too.
- *In the repository*: the project part is the workspace's `AGENTS.md` (or
  `CLAUDE.md`), which the CLIs read on their own; the interface edits that file.
  Only the global part comes from Sillage.

By default, a project whose folder already has one of those files stays on the
repository; existing projects keep working as before. Their instructions panel offers
to move the files' content into Sillage in one step.

**Memory** is the format Claude Code already uses: a `MEMORY.md` index and one note per
file, under `<data>/memory/projects/<id>`. On first launch, the memory Claude kept for
the project root is copied there; the original stays in place.

**When changes apply.** Claude Code and Codex read both when a session starts. A
session already running keeps what it received: Claude Code records its system
prompt on the first turn and replays it on resume, until the next compaction.
OpenCode receives them with every message, so an edit reaches it on the next one.
Grok Build receives them when a session is created, and keeps them for its whole life.

Details and the probes behind them: [docs/sillage-md.md](sillage-md.md).

