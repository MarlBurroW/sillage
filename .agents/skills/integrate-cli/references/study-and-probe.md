# Phase 0: study and probe

Write no adapter code until this phase has produced a draft `docs/<CLI>.md`. Its coverage
table should have the native column filled in. Use the template in
[verification.md](verification.md).

## Choose the distribution and the protocol

- **Use the vendor's official, scriptable surface.** Existing integrations each use one of
  these:

  | Surface | CLI | Notes |
  |---|---|---|
  | SDK | Claude Agent SDK | |
  | JSON-RPC app server | `codex app-server` | |
  | HTTP server with OpenAPI and SSE | `opencode serve` | |
  | ACP over stdio | `grok agent --no-leader stdio`, Google's Antigravity ACP distribution | Google's distribution is used instead of the `agy` terminal UI or a community bridge |

  Never drive a terminal UI through a pty for conversations. A pty is acceptable only for a
  login flow such as `claude setup-token`.
- **ACP registry.** <https://github.com/agentclientprotocol/registry> lists official ACP
  distributions with their archives and checksums.
- **Prefer a surface with a schema.** Generate bindings from it and add a `:check` script so
  a bump shows drift. `pnpm codex:types` / `codex:types:check` (`packages/codex-bindings`) and
  `pnpm opencode:types` follow this pattern; opencode's comes from `GET /doc`.
- **ACP needs a handwritten client.** Take only the types from `@agentclientprotocol/sdk`.
  The client in `apps/server/src/agents/acp/client.ts` is written by hand because the SDK's
  zod validation rejects vendor extensions (`_x.ai/…`, `_meta`).
- **Note the distribution format:**
  - npm package (default path in `cli-install.ts`);
  - archive pinned by SHA-256 for each os-arch (`antigravity/distribution.ts`, `install.ts`);
  - vendor installer (Grok's falls back to `~/.grok/bin`).

  List the operating systems and architectures it covers, and any companion binaries.
  Antigravity needs `localharness_external` next to its `.par`.
- **Record the facts:**
  - package name and version to pin;
  - license, and whether source is readable. Grok has a public repository. Antigravity ships
    its Python source inside the archive. Reading the source often settles questions that
    probes can't.

## List the native surface

Before writing a runner, list everything the protocol can say and accept. Sources:

- the generated schema or bindings;
- the `initialize` response (capabilities, `_meta`, auth methods; it can carry models and
  commands);
- `--help` for every subcommand;
- vendor docs and changelog;
- source code.

Build a table where each row is one native message, notification or method. The second
column holds one of:

- the Sillage event or runner method it maps to;
- **ignored on purpose**, with the reason;
- **unknown**: probe it.

This table is how no signal gets swallowed. The September 2026 Claude audit found ten
signals Sillage was dropping (`docs/audits/2026-09-17-claude-code/README.md`).

Answer these questions for each area.

**Sessions**
- How are a new session, resume, load with replay, fork and list done?
- Does resume re-read the system prompt? Grok keeps the prompt saved at creation.
- Are message ids and timestamps stable?
- Do notifications arrive before the `session/new` response? Buffer them, as Grok and
  Antigravity do.

**Streaming**
- Do text and thinking arrive as chunks with ids?
- Is reasoning visible, or only a token count?

**Tools**
- Which field reliably carries the tool name? In Grok it is `_meta["x.ai/tool"].name`, not
  `title`.
- How do arguments, incremental output and final output arrive?
- Are diffs whole files or excerpts?
- Which file locations are sent?
- Is there human metadata (title, description), and is it the action or a description of a
  resource?
- How are MCP tools exposed? Grok uses `search_tool` then `use_tool`.
- Who closes a tool frame, and when? Late, broadcast and missing closings all happen.

**Interactions**
- What permission options exist, and what do they mean? Does a reject end the turn?
- What shape do questions take: single or multiple choice, free text?
- Are there MCP elicitations, plan approval, cancellation of pending requests?

**Configuration**
- Do the models depend on the account or plan?
- Which efforts exist for each model?
- What permission modes and options exist?
- Which of these can change live, and which only at launch?

**Delegated work**
- Do subagents have their own session id, and a link to their parent?
- Are there background jobs, todos, plans, workflows?
- Does stopping a background job have its own call?

**Usage**
- Are per-turn tokens cumulative or deltas, and do they include cache?
- What unit is cost in? Grok's `costUsdTicks` are 1e-10 USD.
- How is the context size reported?
- Is there an endpoint for rate limits, quota or billing?

**Errors**
- What do errors look like, and which codes exist?
- Are retries and backoff notified?
- What does an authentication error look like?
- Are there deprecation warnings?

**Injection points**
- How is the system prompt appended?
- How are MCP servers passed at launch?
- How are skill directories or plugins passed?
- How are repository instructions masked?
- What config overlay works without writing user files? opencode reads
  `OPENCODE_CONFIG_CONTENT`.
- Which environment variables apply?

**Isolation**
- What does the CLI read by default? Look for other CLIs' configs, telemetry, its
  auto-updater, folder trust and the macOS keychain.
- Which flag or variable disables each one? `apps/server/src/agents/grok/launch.ts`
  documents Grok's.

**Authentication**
- Which methods exist, and where are credentials stored?
- Which variable overrides the home: `CODEX_HOME`, `GROK_HOME`, `GEMINI_HOME`? Check whether
  it points at the directory itself or at its parent. `GEMINI_HOME` is the `.gemini`
  directory itself.
- Is login by device code or by browser callback?
- How does logout work?

## Probe safely

- **Work under `/var/tmp`.** `/tmp` is a tmpfs with a quota, and writes there fail with
  `EDQUOT`.
- **Treat downloaded binaries and archives as untrusted.** Put each one in its own empty
  directory. Keep your scripts elsewhere and pass paths as arguments, so you never start an
  interpreter from inside that directory.
- **Give each probe an isolated home** (the CLI's home variable). Copy in only the auth files
  it needs, and delete them afterwards.
- **Avoid billing.** A deliberately invalid API key still exercises `initialize`, session
  creation, configuration, commands and `/usage` without running inference. Before a real,
  paid turn on the user's account, tell the user.
- **Write probes as `.mts` scripts run with `tsx` from `apps/server`**, so they reuse the
  repository's clients. Keep them out of the repository, and save their path in project
  memory. `/var/tmp/sillage-antigravity-probe-tools/probe-tools.mts` follows this pattern.
- **Leave production alone.** Never point a probe at the production daemon or its data
  directory, and never restart `sillage.service`.
- **Count expensive launches.** Sillage launched Antigravity's 1 GB `.par` more than a
  hundred times in one day for version, catalog and session probes. Cache each probe, and
  probe the version in the cheapest way available. Antigravity has no `--version`; read
  `initialize.agentInfo.version`.
- **Confirm by observation.** An `{}` response, or a parameter that is accepted and then
  ignored, proves nothing.

## Output of phase 0

- `docs/<CLI>.md` drafted, with versions and the native column filled.
- A plan stating, for each checklist area, what will be covered, hidden or deferred.
- A short message to the user on the real trade-offs. Examples: Antigravity's portable fork
  in place of a missing native fork, or an option that would need a fragile workaround. No
  time estimates.
