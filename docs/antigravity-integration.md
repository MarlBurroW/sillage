# Google Antigravity integration

Sillage uses Google's official Antigravity ACP distribution, pinned to **1.4.3**,
to run Gemini. It is a native Google agent process, with its own tools, permissions,
configuration and authentication.

This inventory records implemented coverage and limits observed in the actual
1.4.3 binary and bundled source. An RPC returning `{}` does not establish that a
feature exists: Google's unimplemented fork endpoint does exactly that.

## Coverage inventory

| Area | Implementation | Limits / verification |
| --- | --- | --- |
| Installation | Official archives pinned by SHA-256, streamed download/extraction, progress, version/availability checks; Linux/macOS/Windows x64/arm64 mappings | Real Linux archive installed and initialized; macOS/Windows execution remains untested |
| Identity/settings | Fifth CLI throughout protocol, defaults, presets, onboarding, visibility, sidebar icon, schedules, automations, MCP tools and task API | Existing authorization applies; only native `yolo` qualifies for autonomous Antigravity work |
| Conversation | New session, text/thinking streaming, interruption, reconnect, resume, title updates, context usage and native errors | No live steering RPC; use the message queue |
| Native history | Discover sessions in the selected project/account and import user/assistant/tool history without inference | Sparse native metadata; no external-history resynchronization after import |
| Tools | Human action metadata, native arguments, normalized file/shell/search/MCP categories, incremental output, images, file changes and diffs | Raw events retained; resource descriptions are not action titles; edit excerpts remain marked partial |
| Background work | Keep native running commands visible after a turn and consume later completion/output | No stop-background-task RPC or exposed subagent parent relationships |
| Permissions/questions | Once/always/reject choices, native warnings, native question choices, cancellation and pending-decision replay | Single-choice native questions; planning uses commands/questions, not the structured plan-review sheet |
| Composer | Account-scoped models/thinking, `default`/`auto_edit`/`yolo`, account, skills and MCP; persist effective native options | Model/thinking update live while idle; account/MCP/library changes restart/resume; extra workspace roots ignored upstream |
| Attachments | Images/audio inline, documents/file mentions as resources, session-scoped copies of uploads | Native model capabilities still govern usable media |
| Commands | Discover/invoke native commands with arguments, including draft discovery | 1.4.3 publishes `/plan`, `/usage`, `/logout`; no invented `/compact`, `/help` or terminal-only commands |
| Skills | Sillage global/project library, all four native roots, explicit insertion, supporting files and native description-based discovery | No live reload RPC: restart/resume before next turn; copied files remain inside Google's allowed home |
| MCP | Sillage MCP and configured stdio/HTTP/SSE servers/secrets, native configuration and tool metadata | Health is not published: configured initially, connected only after an observed successful call |
| Instructions | SILLAGE.md, memory, overview, references and transferred history through the native system-prompt extension | Native project configuration and hooks remain in effect |
| Accounts | Personal/enterprise OAuth, Gemini API key, Agent Platform; private owned homes, model/usage isolation, rename/reconnect/logout/delete | Real Google OAuth/inference still need user validation; API-key authentication only records configuration |
| Remote OAuth | Google authorization URL and callback relay checking owner, exact loopback origin/path and OAuth state | Requires user authorization; relay tested with a protocol fixture |
| Forks | Fresh native session with portable history through the selected turn, visible notice, provenance and checkpoints | No native fork: reasoning, attachments and native internal state are not copied; omitted older content is referenced |
| Transfers | Existing handoff in both directions, target account/settings and inherited-context references | Existing budget applies; original request cannot be silently truncated |
| Editions | Server ownership/remote callback; Desktop native handshake/local callback | Both profiles tested on Linux at wide/phone viewports; other OS runtime validation outstanding |

## Native storage and account boundaries

`GEMINI_HOME` is the actual `.gemini` directory, not its parent. Each managed
account has its own home. `AGY_ACP_FORCE_FILE_STORAGE=1` avoids sharing the macOS
keychain identity. Ambient API keys and Google project variables are removed from
explicit account environments; only that account's values are restored.
Credentials are private files and never returned through the account API.

Each conversation runs in a private view of its account home:

- Only native SQLite history directories are linked to owner-scoped storage.
  Switching between host/default and managed accounts uses SQLite backup,
  including committed WAL data, after the old native process exits.
- OAuth credentials are private snapshots the CLI can refresh atomically.
  Reconnecting invalidates them; they are never linked across accounts.
- Skills, uploads and native `brain/<session>` artifacts live physically inside the
  session home. A symlink to shared artifacts passes initialization but fails
  native file-tool access after realpath checks.
- Artifacts are saved outside the disposable account directory on session stop,
  so deleting an account retains the conversation's work. Reconnect/logout/delete
  stop that account's sessions before changing credentials/storage.

Native settings, hooks and MCP configuration are retained. Native skill precedence
is `config/skills`, project `.gemini/skills`, `antigravity-cli/skills`, then project
`.agents/skills`. Sillage's supplied library is copied into the first root.

## Deliberate differences from Claude

Shared services provide accounts, MCP, skills, events, tool presentation, handoff,
settings and instructions. Controls reflect Google's actual protocol capabilities:

- Manual compaction, live steering and stopping background tasks have no RPC.
  Their controls are hidden; native automatic context management remains.
- `additionalDirectories` is accepted but ignored upstream. Existing configurations
  produce a notice; file tools retain the project's native access boundary.
- Native fork is absent. Portable forks retain a bounded journal selection with
  references to omitted history, rather than duplicating native internal state.
- Native import is an initial replay, without Claude-style external history sync.
  The wire has no stable per-message IDs or timestamps.
- No structured MCP health or subagent ancestry is available. Sillage reports
  observed facts. Native `/usage` supplies quota percentages when available;
  costs, balances and precise reset times are not invented.
- API-key login does not validate the key. Its card says **Configured**; Google
  validates it on the first model request, whose errors appear in the thread.

## Tool stream quirks observed in 1.4.3

Verified on marldev on 30 October 2026 with a real Google account (see the probe
recipe in project memory, `antigravity-tools-diagnosis`):

- `view_file` frames (ids `call_N`) are closed late and without content: with the
  next planner step for the main agent, only at the end of the turn for subagents,
  never after a cancellation (the sweep marks them failed). Sillage mirrors the file
  from disk after `AntigravityRunner.readSettleMs` and when a bare `completed`
  arrives, and ignores later bare closings of a frame it already settled.
- When one step of a parallel batch is denied by Google's pre-tool hook (for example
  a read outside the workspace), every open frame receives a `failed` update with
  that error, then the SDK re-announces the frames still running under the same ids.
  Sillage reuses the existing row instead of appending a duplicate.
- Google's file viewer refuses paths outside the workspace, the session home,
  skills and `/tmp`. The memory appendix therefore points Antigravity sessions to
  `read_memory` rather than to the memory directory.

## Linux host: user namespaces

Antigravity's Go harness (`localharness_external`) sandboxes commands by creating an
unprivileged user namespace. Ubuntu 23.10+ confines such processes in the
`unprivileged_userns` AppArmor profile, which denies `net_admin`; the sandbox server
dies and every command and file read fails with
`connecting to sandbox server: connection reset by peer`. Sillage shows the notice
`antigravity_sandbox_unavailable` once per session. The fix mirrors the Playwright
profile, in `/etc/apparmor.d/sillage-antigravity`:

```
abi <abi/4.0>,
include <tunables/global>

profile sillage-antigravity-harness /home/*/.local/share/sillage/agents/antigravity/*/localharness_external flags=(unconfined) {
  userns,
  include if exists <local/sillage-antigravity-harness>
}
```

Load it with `sudo apparmor_parser -r /etc/apparmor.d/sillage-antigravity`. Running
sessions keep their old harness process until their next restart. What makes the
harness start its sandbox is not known: a single background command or subagent
does not; the incident involved four subagents and a background task.

## Verification

On Linux with Google's checksum-verified **Antigravity ACP 1.4.3**:

- Downloaded and installed the real archive including its companion harness;
  initialization returned the expected version.
- Real runner probes covered session creation/resume, system-prompt append,
  model/thinking/mode configuration, commands and `/usage`. An intentionally
  invalid test key avoided model inference and billing.
- Fixtures cover tools/diffs/streaming, background completion, approvals/questions,
  cancellation, import, media, OAuth relay, key redaction, ownership, WAL history
  handoff, artifact retention, private credential refresh, model fallback and
  installer rollback.
- `NODE_ENV=development pnpm typecheck`, `pnpm test` (**415 tests**) and `pnpm lint`
  passed; the production web build passed.
- `NODE_ENV=development pnpm test:antigravity-ui` checks accounts, model/effort
  selection, import, portable forks, selected-turn cutoff, transfers in both
  directions and logout. It runs real disposable Sillage servers with a protocol
  fixture in Server and Desktop profiles, at 1440×900 and 390×844, checking browser
  errors and overflow.
- The existing `test:windows-feedback-ui` regression also passed after updating
  its five-CLI expectations and selecting the current all-projects navigation.
  It covers installation progress, hidden agents, context menus, text selection,
  mobile layout and Desktop's single-account project settings.

**Not yet verified:** personal/enterprise authorization against Google's service,
a real model turn using tools/MCP/skills, and execution on Windows/macOS.
These require user credentials or the corresponding OS. Fixture success does not
establish Google's access grant for a particular subscription.

## Implementation map

- `apps/server/src/agents/antigravity/`: distribution/install, catalog, tools,
  history discovery and runner.
- `apps/server/src/antigravity-accounts/`: homes, login, storage and identity.
- `apps/server/src/http/routes/antigravity-*.ts`: owned accounts/history import.
- `packages/protocol/src/antigravity-accounts.ts`, shared config/capabilities and
  migration `0054_perpetual_black_panther.sql`: contracts/storage.
- `apps/web/src/routes/AntigravityAccountsSettingsPage.tsx` and shared composer:
  account flow and native options, in English/French.
- `apps/server/test/antigravity*.test.ts` and
  `scripts/antigravity-ui-check.mjs`: checks without Google credentials.

## Sources

- [Official ACP registry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json)
- [Google editor/ACP integration](https://antigravity.google/docs/ide/extensions/zed/)
- Python source inside Google's verified 1.4.3 archive.
