---
name: integrate-cli
description: Method, coverage checklist and code map for integrating a new coding-agent CLI into Sillage, next to Claude Code, Codex, OpenCode, Grok and Antigravity. Covers installation and updates, models, efforts, permission modes and CLI-specific options, accounts, usage gauges, Sillage MCP and skill injection, slash commands, the event stream (thinking, tokens, errors, warnings, subagents, workflows, background work), tool rendering and its metadata, forks and handoffs, Server and Desktop editions, tests and docs. Use when adding a CLI (a new AgentKind), when finishing or auditing an existing integration's coverage, or when a CLI version bump brings native features Sillage should expose.
---

# Integrating a CLI into Sillage

The goal is a CLI that feels native in Sillage. Every feature the CLI really offers can be
reached from the interface, nothing it lacks is offered, and outside
`apps/server/src/agents/<kind>/` the rest of the code only needs a few table entries to know
the CLI exists.

Integrations take many sessions and touch around a hundred files (Antigravity's
`git show --stat e67c41628` lists 99). The main risk is forgetting something: a composer chip
that never renders, an account that silently uses another payer's login, a native signal
swallowed. This skill exists to prevent that.

## Principles

1. **Contract, not branches.** Server code outside adapters talks to `AgentAdapter`
   (`apps/server/src/agents/registry.ts`) and `AgentRunner` (`apps/server/src/agents/types.ts`).
   The UI reads `AGENT_CAPABILITIES` (`packages/protocol/src/capabilities.ts`). This is
   invariant I3 in `docs/SPEC.md`. To add behavior, fill a row or implement a method rather
   than writing `if (agent === 'x')`. The code still has per-kind chains that typecheck does
   not catch, and some of them fall through to another CLI. Add an explicit case to each one
   (see [touchpoints](references/touchpoints.md)).
2. **Probe the installed binary and record the version.** Docs and source leave things out.
   A call that returns `{}` does not prove the feature exists: Antigravity's `session/fork`
   is a stub. Some parameters are accepted and then ignored, like ACP `systemPrompt` in Grok
   and `additionalDirectories` in Antigravity. Every claim in the coverage doc names the
   version it was observed on.
3. **Native vocabulary.** Configs keep the CLI's own terms for permission modes, efforts and
   options (see the header of `packages/protocol/src/agent-config.ts`). Map them onto shared
   concepts only in the composer groups (`model`, `effort`, `mode`/`permission`).
4. **Expose what exists, hide what doesn't, say why.** A capability flag hides the control,
   and the runner method still returns `false` as a safety net. Each limit goes in the
   coverage doc. If users can notice it, it also gets a translated notice
   (`additional_directories_unsupported`, `antigravity_sandbox_unavailable`).
5. **Never leak, never pick the wrong payer silently.** Credentials stay in private files.
   They never appear in API responses or in a journal's `raw`. Turn off the CLI's automatic
   import of other CLIs' configs: Grok re-published MCP tokens read from `~/.claude.json`. A
   missing or disconnected account must produce a visible error, never a quiet switch to
   another login.
6. **Both editions, every OS.** On Server, many users connect from a remote browser, so a
   login that calls back to `localhost` cannot work. Desktop has a single account and runs
   locally. On Windows, check npm `.cmd` shims, junctions instead of symlinks, and the slow
   first launch while Defender scans the binary. Tell the user how each change behaves in
   each edition.
7. **Production safety.** Work in a Sillage worktree (`create_worktree`). Never restart
   `sillage.service`. Run real trials on a disposable server. Prefix installs, tests and
   typecheck with `NODE_ENV=development`. Use `TMPDIR=/var/tmp`, because `/tmp` is a tmpfs
   with a quota.

## Workflow

Copy this progress list into the conversation's plan and keep it updated:

```
- [ ] 0. Study & probe       → references/study-and-probe.md   (draft docs/<CLI>.md first)
- [ ] 1. Declare the kind    → references/touchpoints.md §1    (typecheck lists forced tables)
- [ ] 2. Adapter & runner    → references/events-and-tools.md
- [ ] 3. Platform services   → references/platform.md
- [ ] 3b. Continuity         → references/continuity.md        (resume, import, fork, handoff)
- [ ] 4. Interface           → references/touchpoints.md §3
- [ ] 5. Verify & document   → references/verification.md
```

- **Phase 0 comes before any code.** Choose the distribution and the protocol, list
  everything the CLI can say and accept, then fill the "native" column of the coverage table.
  Before building, show the user the choices with real trade-offs (a risky workaround, a
  feature to drop). Never give a time estimate.
- **Start from the closest existing integration** and copy its structure:

  | Native protocol | Integrations to copy |
  |---|---|
  | ACP over stdio | `grok/`, `antigravity/`, with `acp/` shared |
  | JSON-RPC app server | `codex/` |
  | HTTP server and SSE | `opencode/` |
  | Vendor SDK | `claude/` |
- **Commits stay small and in English**, with an imperative title and a body that explains
  why. Commit only when the user asks.

## Coverage checklist

The coverage doc gives every line one status, and silence is not a status:

- **covered**, with how it was verified;
- **not offered by the CLI**, with the version and the proof;
- **deferred**, with the reason.

**A. Distribution**
- Install from Sillage into the managed prefix, with progress, on every OS and architecture.
- Version pinned in `PREFERRED_CLI_RELEASES`.
- Update through Settings › CLI versions: it waits for sessions, re-verifies the version and
  invalidates catalogs.
- A guard for incompatible major versions.
- The CLI's own auto-updater disabled.
- `enabled=false` and hidden CLIs respected.

**B. Configuration**
- Model catalog read from the CLI for each account, and efforts for each model.
- `CLI_DEFAULT` kept with `resolveDefaults`.
- Native permission modes, including plan mode if it exists.
- CLI-specific options (web search, sandbox, variants, primary agent…).
- For each setting, applied live or by restart (`applyConfig`), with the applied config shown.
- User, project and preset defaults.
- API token execution policy and v1 fields.

**C. Conversation**
- Start, streamed text and thinking, title.
- Interrupt with a watchdog, and resume after the process restarts.
- Steer, or the message queue when steering isn't possible. Compact, or the native automatic
  compaction.
- Images, audio, documents and `@` mentions.
- Additional directories, worktrees, attachments and memory are readable.

**D. Interactions**
- Permissions with the native options (once, session, always, reject) and the CLI's
  rejection semantics. In Grok, a rejection ends the whole turn.
- Questions, MCP elicitations, plan review or a plan command, cancellation, replay of pending
  requests.

**E. Delegated work**
- Subagents nested under an `Agent`/`Task` row through `parentToolCallId`.
- Workflows and tasks (`task.*`, with progress).
- Background jobs (`background.updated`, and stopping them).
- Todo and plan progress (`plan.updated`), loops.

**F. Signals**
- Live thinking progress, such as a token count while reasoning is hidden.
- Per-turn tokens and cost, the context meter, rate limits.
- Errors with stable codes and translations, recoverable or fatal.
- Notices and warnings: retries, model adjusted, sandbox, deprecations.
- Model changes, compaction start and end.

**G. Tools**
- Every native tool maps to a canonical name with Claude-style input keys, or gets a
  deliberate specific view.
- The human metadata (Bash `description`, ACP `title`) is the label. A resource's
  description is never used as the action's title.
- MCP tools are named `server/tool`.
- Incremental output, diffs through `describeEdit`, `file.edited` only when the edit
  succeeded, images.
- No duplicate rows, and late or broadcast closings are handled.

**H. MCP**
- The Sillage built-in server is injected, with a decision on strict mode.
- Registry servers over stdio, HTTP and SSE, with secrets and headers.
- `mcp.updated` health. Without a native health stream, go from `configured` to `connected`
  on the first successful call.
- Reconnect, a restart on live changes, no collision with the user's own config names.

**I. Skills, instructions, memory**
- The library roots are delivered through the native mechanism, or copied, and reloaded
  after a write.
- `skills.updated` is emitted if the CLI doesn't emit it.
- SILLAGE.md goes through the system-prompt channel. Check whether the CLI re-reads it on
  resume.
- Repository `AGENTS.md`/`CLAUDE.md` are masked.
- Memory is reachable through the native file tools, or through `read_memory`.
- The project overview and the handoff context are delivered.

**J. Slash commands**
- Native commands live (`commands.updated`) and in drafts (`commands()`).
- `usableSlashCommands` hides the commands that change state Sillage tracks.
- Command arguments, and skills listed as commands where the CLI does that.

**K. Accounts**
- CLI login status.
- Extra accounts in isolated homes, where auth and identity-keyed caches are private.
- Logins that work remotely: device code, API key or a relayed OAuth.
- Sign-out, including a native `/logout`, plus reconnect and delete, which stop the sessions.
- Model catalog and usage for each account, and the account choice in the composer and
  drafts.

**L. Usage**
- A gauge (windows, credits) for the CLI login and each account (`usage()`,
  `usageForAccount()`), cached.
- `limitsAvailable: false` when it doesn't apply.
- Live `rateLimit` in `usage.updated`.

**M. Continuity** (see [continuity](references/continuity.md))
- Resume after a crash, an update or a settings restart, with the instruction channel
  re-injected.
- Import native sessions (`cliSessions`), and resync them.
- Native or portable fork, with the native ids `forkCut` needs kept in `raw`.
- Handoff in both directions:
  - **CLI → Sillage**: a journal the handoff can read (main-thread text, subagents behind
    `parentToolCallId`, real tool arguments at `tool.started`, normalized `stopReason`);
  - **Sillage → CLI**: `projectOverview()` delivered on every start through the
    instruction channel.

  There is no per-CLI handoff interface to write.
- Checkpoints closed on turn end and fed by `file.edited`.
- `rawFormat` versioned.

**N. Reach**
- v1 API and the Sillage MCP tools (`start_session`, `list_models`).
- Schedules, automations, board, onboarding.
- Desktop profile, and Windows and macOS launches.

**O. Docs**
- `docs/<CLI>.md`, `docs/accounts.md`, `docs/skill-library.md`, `docs/sillage-md.md`,
  `docs/cli-handoff.md`, `docs/features.md`, `README.md`, `deploy/config.example.toml`.
- `site/` too. Warn the user before any push that touches `site/**`, because it publishes
  the site.

## Done means

- `NODE_ENV=development pnpm typecheck`, `pnpm test` and `pnpm lint` pass, and the production
  web build passes.
- A fixture agent and `test:<kind>-ui` cover the Server and Desktop profiles at 1440×900 and
  390×844.
- The UI checks that count CLIs are updated.
- A real-binary trial ran on a disposable server, with the version written down.
- `docs/<CLI>.md` holds the coverage table. It states plainly what was **not** verified, for
  example real OAuth, a paid model turn, or Windows and macOS.

Details are in [verification](references/verification.md).

## Later bumps of the same CLI

The user only uses the CLIs through Sillage and wants to know what new versions bring. On each
bump:

- re-probe the binary and regenerate the bindings (`pnpm codex:types` and `pnpm opencode:types`
  follow that pattern);
- diff the native schema for new messages, settings and commands, and read the changelog;
- update the coverage doc. Report new native features, not only what broke.

## Keep this skill current

When an integration teaches you a non-obvious pitfall, add it to the right reference file in
the same change. Facts about one task belong in project memory instead.
