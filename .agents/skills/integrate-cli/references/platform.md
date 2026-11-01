# Platform services around a CLI

## Installation and updates

- **Binary resolution** (`apps/server/src/agents/cli-binary.ts`):
  - `CliBinary` looks in the managed prefix (`~/.local/share/sillage/agents`), then in
    `PATH`;
  - systemd and launchd have a minimal `PATH`, so never hardcode a directory;
  - Windows: it tries the `PATHEXT` extensions, matches `Path` case-insensitively, and finds
    npm launchers at the prefix root rather than in `bin/`;
  - the version probe waits 20 s on Windows, because Defender scans a new binary first
    (`30e7d1a80`);
  - for a vendor installer, add a fallback path for an install that only changed an
    interactive shell's `PATH`, like Grok's `~/.grok/bin` in `grok/adapter.ts`.
- **Disabled CLIs.** Every probe (catalog, commands, usage, version) goes through
  `this.cli.executable()`. It throws `503 cli_disabled` when `enabled=false` (`126deb326`).
  `SessionManager` also checks `assertCliEnabled`.
- **Installation** (`agents/cli-install.ts`):
  - npm packages use `npm install -g --prefix <agents>`, with progress parsed from
    `--loglevel=http`;
  - jobs are serialized because every CLI shares the prefix;
  - a non-npm distribution gets its own branch, modeled on `antigravity/install.ts` and
    `distribution.ts`:
    - a SHA-256 for each os-arch;
    - download and extraction streamed, because the Desktop heap is small;
    - path traversal checked and size capped;
    - a versioned install directory, so running sessions keep their binary;
    - rollback on failure.
- **Updates** (`2eface80f`):
  - `http/app.ts` calls `sessions.prepareCliUpdate(kind)`, which waits for turns, questions,
    background tasks, loops and queues, then stops idle runners. They resume through their
    native id.
  - After installing it calls `cli.invalidate()` and **`adapter.invalidateCatalogs?.()`**.
    Implement that method, or the old binary's catalogs stay cached. Then it checks
    `managed && version === preferred`.
  - `CachedProbe` has a revision counter so a probe still running cannot restore a stale
    catalog after invalidation.
  - `http/routes/agents.ts` returns a cached description while an install runs, so the
    binary npm is replacing is never executed. Windows locks those files.
- **Version guard.** `opencode/version-guard.ts` refuses a major version the adapter cannot
  speak (`opencode_unsupported_version`) instead of running a silent conversation. Copy it if
  the CLI has protocol generations.
- **The CLI's own auto-updater is disabled at launch**, for example with
  `GROK_DISABLE_AUTOUPDATER=1`. Sillage chooses the version.
- **Web:**
  - `apps/web/src/lib/agents.ts` invalidates queries when the version or path changes;
  - `routes/CliVersionsSettingsPage.tsx`;
  - onboarding `AgentInstallProgress`.

## Launch, environment, isolation

- **`agentProcessEnv()`** (`agents/process-env.ts`) on every spawn: runner, catalog, billing
  and login. It drops `NODE_ENV`, which the daemon sets to production and which would make
  npm skip devDependencies.
- **`launchOf(binary)`** (`agents/launch.ts`) on every spawn:
  - on Windows it reads npm `.cmd` shims instead of starting a shell (CVE-2024-27980);
  - `runsThroughNode` handles extensionless Node scripts, such as Grok's `bin/grok`
    (`fcc09ae03`);
  - pass `windowsHide: true`;
  - use `comparablePath` (`agents/paths.ts`) for Windows and macOS case and separators.
- **Isolation environment.** Disable everything the CLI reads by default outside Sillage,
  and record each variable with its reason (`grok/launch.ts`):
  - imported Claude, Cursor or other CLI configs. They bring duplicate instructions,
    duplicate MCP servers and **leaked tokens**;
  - telemetry and trace upload;
  - the auto-updater;
  - folder trust: in ACP, an untrusted folder silently ignores repository MCP servers,
    instructions and skills;
  - shared keychains: `AGY_ACP_FORCE_FILE_STORAGE=1` gives each macOS account its own
    storage.
- **Restarts.** `sameLaunch` decides whether a change of launch arguments needs a restart.
- **Readable directories.** `attachmentsRoot`, `memoryDir()`, `workTrees()` and
  `additionalDirectories` must be readable by the native tools. Each CLI does it its own
  way:
  - Claude: `additionalDirectories`;
  - Codex: `writableRoots`, re-read each turn;
  - OpenCode: `permission.external_directory`;
  - Antigravity: copies attachments into the session home, because its realpath checks
    refuse symlinks.

  If the CLI ignores extra roots, emit the `additional_directories_unsupported` notice.

## Accounts

The model is Codex, Grok and Antigravity: one private home per account. Read
`docs/accounts.md` first.

**Server side**
- Code lives in `apps/server/src/<kind>-accounts/{homes,store,login}.ts`.
- Contracts in `packages/protocol/src/<kind>-accounts.ts`, a table in
  `packages/db/src/schema.ts`, and a migration.
- **Homes.** `grok-accounts/homes.ts` keeps auth **and every cache keyed by identity** as
  private real files, and links everything else from the user's home.
  - Codex's `models_cache.json` was linked, and two accounts kept overwriting each other's
    model list (`3ad0c719b`).
  - On Windows, links go through `platform/links.ts`: junctions for directories, a hardlink
    fallback for files.
  - Antigravity is stricter. It gives each session a private view, copies credential
    snapshots (`.auth-revision`), and removes ambient API keys.
- **Logins must work from a remote browser:**
  - Device code: Grok's `grok login --device-auth` prints the URL and code on stdout; Codex
    uses `account/login/start`.
  - API key: through ACP `authenticate`, or stored in the home.
  - Claude: `setup-token` in a node-pty, with a throwaway config dir and `BROWSER=true`.
  - OAuth with a loopback callback: relayed after strict checks of origin, path and state
    (Antigravity `POST /api/antigravity-accounts/:id/callback`). Desktop uses its local
    callback.

  A successful API-key `authenticate` may only record the key. Label it **Configured**,
  not Connected.
- **Sign-out:** run the native logout, then delete the home's auth.
  - Reconnect, logout and delete **stop that account's sessions** before changing
    credentials (`stopAntigravityAccount`).
  - A native `/logout` inside a conversation calls `ctx.accountSignedOut()` and emits a
    notice. The web invalidates its queries when it sees that notice.
- **Wiring.** Routes copy `http/routes/grok-accounts.ts`: owner checks, and secrets never
  returned. Register them in `http/app.ts` and `main.ts`. Also add:
  - the `accountEnv` branch, with a visible error when the account is missing or not ready;
  - `<kind>Home()` and `modelsFor`;
  - `accountCredential`.

**Web side**
- `routes/<Kind>AccountsSettingsPage.tsx`, which exports `LoginControls`.
- `lib/<kind>-accounts.ts`, `lib/extra-accounts.ts`, `AccountChoice.tsx`.
- The onboarding step.
- The account choice in drafts.

**No accounts at all.** OpenCode delegates authentication to its providers. Write that down
in the coverage doc, and keep the kind out of `ExtraAccountAgent`.

## Usage, quotas, cost

- **Shape** (`packages/protocol/src/usage.ts`): `AgentUsage {agent, plan, limitsAvailable,
  windows[{id, label, utilization 0–1, resetsAt ms}], credits, fetchedAt}`. `windows` is a
  list, so windows the CLI adds later still show.
- **Implement** `usage(force)` for the CLI login, and
  `usageForAccount(accountId, credential, force)` for each account. Examples:
  - `grok/billing.ts`: a disposable ACP process calling `_x.ai/billing`;
  - `antigravity/catalog.ts`: parses the Markdown of `/usage`. Dates without a time give no
    exact reset, so don't invent one;
  - `codex/usage.ts` and `codex/quota.ts`: seconds converted to ms, shared window labels;
  - `claude/usage.ts`.
- **When the gauge doesn't apply.** No plan, API key or not logged in is not an error: return
  `limitsAvailable: false` (Grok's `NO_LIMITS`, OpenCode).
- **Caching** with `CachedProbe`/`CachedProbeMap`: 5 min by default (`usage-cache.ts`), 60 s
  for Grok and Codex.
- **Live data.** Emit `usage.updated` with `rateLimit` when the stream carries it.
- **Per turn.** Tokens and cost go on `turn.completed`. Never invent a cost, a balance or a
  reset time.
- **Where gauges show** (web): `UsagePanel.tsx`, `AccountChoice.tsx`, the draft page,
  onboarding, the account pages. `lib/usage.ts` `usageAccountOf` picks the account.

## Models, efforts, options

- **`models(credential?, force?)`** returns an `AgentModelsDto` (`packages/protocol/src/api.ts`):
  - `models[]`, each with `value`, `displayName`, `description`, `hint`, `isDefault`,
    `efforts[{value, label, hint}]`, `defaultEffort`, `supportsFastMode`;
  - `modes[]`, `account`, `outputStyles`, `fastMode`, `agents`;
  - fields that don't apply get empty values.
- **Read the catalog from the CLI** for the selected account. The plan decides the list
  (`3ad0c719b`).
  - Key the cache by home or credential, and by the credential file's mtime, so a new
    login shows before the TTL expires (Antigravity).
  - Catalogs are cached for 1 h. `?refresh=1` bypasses the cache and the composer shows a
    reload button.
- **Efforts are per model** when the CLI says so. Never offer an effort the selected model
  rejects. If the CLI adjusts the model or effort itself, emit a notice
  (`antigravity_model_adjusted`).
- **`resolveDefaults`** fills `CLI_DEFAULT` from the catalog, and leaves it as is if the
  catalog can't be read.
- **Live versus restart.**
  - Apply model, effort and permission mode through native calls when they exist.
  - Return `false` from `applyConfig` when any of these changed: account, MCP set (compare
    `JSON.stringify(resolveMcpServers(config).servers)`), skill-library toggle, launch
    arguments, directories. See Grok's and Antigravity's `applyConfig`.

## Sillage MCP and registry servers

- **Built-in server.** `agents/mcp-builtin.ts` runs `process.execPath` with
  `apps/server/src/mcp/sillage-mcp.mjs`, scoped through environment variables. It always
  goes last (`session-manager.ts`) so user-declared names win. Decide whether the CLI gets a
  strict mode, like Claude's `strictMcp`.
- **Registry** (`agents/mcp-registry.ts`): secrets are substituted just before launch, and
  servers with missing secrets are reported through `failedStatuses`.
- **Per-CLI translation:**
  - `claude/mcp.ts`;
  - `codex/mcp.ts`: the built-in server is renamed `sillage_builtin`, because Codex merges
    thread overrides field by field into the user's tables. A user HTTP server named
    `sillage` broke startup (`9f0e2a702`). Reserved names are in `protocol/mcp.ts`;
  - `acp/mcp.ts`: env and headers as lists of pairs;
  - opencode `mcp.<name>`, through `OPENCODE_CONFIG_CONTENT`.

  **Check whether the CLI's config merge can collide with the user's names.**
- **Health.** Emit `mcp.updated`. Without a native health stream, report `configured` and
  switch to `connected` after the first successful call (Antigravity).
- **Reconnect.** Implement `reconnectMcpServer(name)` if the CLI has a per-server reconnect,
  otherwise return `false`.
- **Live changes.** `reloadMcpServer` relies on `applyConfig` returning `false` when the
  server set changed. Codex used to return `true` and silently kept the old tools
  (`93c6f270e`).
- **Hardcoded kinds.** `sillage-mcp.mjs` lists the kinds by hand (see touchpoints). Global
  `start_session` without `agent` defaults to Claude.

## Skills, instructions, memory

- **Skill library** (`docs/skill-library.md` has a section per CLI). `ctx.skillRoots(config)`
  gives global, then project, plugin roots. Their `skills/` directories exist even when
  empty, because some CLIs only watch directories that existed at launch. Delivery per CLI:
  - Claude: `plugins` plus `additionalDirectories`, with writes denied;
  - Codex: `skills/extraRoots/set` before `thread/start`/resume, set once per process;
  - OpenCode: `skills.paths`;
  - Grok: `--plugin-dir`;
  - Antigravity: copied into the session home, because realpath checks refuse symlinks.

  Probe whether a `.claude-plugin/plugin.json` above a root changes the names: Codex then
  prefixes them.
- **`reloadSkillLibrary()`**: a native reload (Claude `reloadSkills()`, Grok
  `_x.ai/plugins/reload`, Codex resets the same roots), or a restart-and-resume before the
  next turn. Emit `skills.updated` if the CLI doesn't.
- **SILLAGE.md and overview.** `projectOverview(config)` goes through the CLI's
  system-prompt channel:
  - Claude: `systemPrompt.append`;
  - Codex: `developerInstructions`;
  - OpenCode: `system` on each message;
  - Grok: `_meta.rules`, on creation only;
  - Antigravity: `_meta.antigravity.systemPrompt.append`.

  Note whether resume keeps it.
- **Masking.** `maskedInstructionRoots()` lists the repositories whose `AGENTS.md` and
  `CLAUDE.md` must be hidden:
  - Claude: `claudeMdExcludes`;
  - Codex: `project_doc_max_bytes: 0`;
  - OpenCode: `OPENCODE_DISABLE_PROJECT_CONFIG=1`, which also disables `opencode.json`;
  - Grok: `_meta.agentProfile.agentsMd: false`;
  - Antigravity can't mask them, so the instructions arrive twice. This is documented.

  Record the probe in `docs/sillage-md.md`.
- **Memory.** `memoryDir()` must be readable by the native file tools. If the CLI refuses
  paths outside the workspace, point it to the `read_memory` MCP tool through the memory
  appendix (`memoryAppendixForCodex(…, nativeFileAccess)`). Antigravity's viewer refused
  the path and failed the whole parallel batch.

## Slash commands

- **Draft commands.** `commands(cwd, force, credential?)` serves drafts (`draftCommands`).
  - Failures return 502, never an empty list (`routes/agents.ts`).
  - ACP CLIs use `acp/commands.ts` `toSlashCommands`; Claude uses `claude/command-catalog.ts`,
    a control session cached per directory.
- **Live commands.** Emit `commands.updated` as the CLI publishes them. Buffer the ones that
  arrive before the session response.
- **Filtering.** Always pass the list through `usableSlashCommands`
  (`packages/protocol/src/commands.ts`). It hides commands that change state Sillage tracks
  (`/clear`, `/model`…). Add the CLI's own: an account switch, an in-TUI settings screen.
- **Don't invent.** Never add commands the CLI doesn't publish, such as `/compact` or
  `/help`.
- Arguments are passed through. Skills listed as commands need `combinedCommands` and
  `listsSkillsAsCommands` (touchpoints).
- Web: `lib/commands.ts`, whose query key includes the account.

## Attachments and mentions

`send(text, attachments, mentions, skills)`:

- `OutgoingAttachment.inlineImage` says when an image can go inline. Otherwise send the path
  or a resource block.
- Claude expands `@path` itself. Codex needs separate `mention` inputs. Grok gets `file://`
  links. Antigravity gets resources and session-scoped copies.
- Skills arrive by name. Unknown names are ignored.
- Probe images, audio and documents on the real binary. Native capability flags can be
  wrong: Grok reports `image: false` and reads images anyway.

## Desktop and Windows

- Desktop installs CLIs through its bundled npm and reads the login-shell environment
  (`apps/desktop/src/shell-env.ts`, `docs/desktop.md`).
- The `desktop` profile has no password, one account, no push, no PWA, and listens on
  127.0.0.1 only. Simulate it without Electron with `SILLAGE_PROFILE=desktop` and
  `SILLAGE_HANDSHAKE_FD=3` (`scripts/onboarding-ui-check.mjs`).
- Windows: `.cmd` shims, junctions, the slow first launch under Defender, file locks during
  updates. `docs/windows.md` covers only the first three CLIs and is out of date, so extend
  it.
- CI installs CLIs through the bundled npm (`.github/workflows/desktop.yml`,
  `scripts/desktop-ui-check.mjs`, `SILLAGE_CHECK_INSTALL`).
