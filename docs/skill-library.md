# Skill library: implementation plan

A skill library managed by Sillage and delivered to Claude Code, Codex, and OpenCode
as native skills: invocable with `/name` and `$name`, triggered by their description,
without writing to `~/.claude`, `~/.codex`, or `~/.config/opencode`. The same principle
as the MCP registry: declared once, supplied at every launch, and absent when a
conversation is resumed in a native CLI.

Decisions approved on 2026-10-04:

- two scopes, **global** (admins) and **project** (project owner);
- one toggle per conversation, not one per skill;
- no hiding a global skill in a single project (see “Limitations”);
- for Claude, plugins named `sillage` (global) and `projet` (project).

**Batches 1, 2, and 3 shipped** on 2026-10-04, merged into `main` after other sessions'
waiting work. Batch 1 acceptance checks ran on a disposable server with real Claude
and Codex sessions: 13 out of 13 passed, plus the `bypassPermissions` case.
Batch 2 and 3 interfaces were exercised in a browser on the same server, batch 3
against real GitHub repositories and skills.sh (see “Batches” below).

## What the probes established

Probed on 2026-10-04 with Claude Code 2.1.286 (SDK 0.3.273) and codex-cli 0.157.1.
Scripts in `/tmp/skill-probe`, to rerun if a CLI version changes behavior.

**Claude, SDK `plugins` option.**

- A plugin skill is named `sillage:name`, with alias `name`: `/name` works.
  Description-based invocation and `$ARGUMENTS` substitution work.
- Reading a skill's supporting file (`references/`, `scripts/`) triggers `canUseTool`
  if the directory is outside `additionalDirectories`. Through a symbolic link,
  **both sides** must be included: the library therefore uses no links.
- A skill added during a session is not detected automatically. `reloadSkills()`
  picks it up, the CLI pushes `commands_changed` (already handled,
  `claude/runner.ts:533`), and the prompt cache is preserved.
- A plugin launched with an **empty** `skills/` directory can be populated with
  `reloadSkills()`. One launched **without** a `skills/` directory never sees later
  additions: both roots must exist at launch.
- `deny` rules for `Edit(//root/**)` and `Write(//root/**)` supplied through settings
  flags block writes in both `acceptEdits` and `bypassPermissions`, while allowing
  reads. They survive a live `applyFlagSettings` that does not specify `permissions`.
- The `.claude-plugin/plugin.json` manifest is optional: without it, the plugin takes
  its directory's name.

**Codex, `skills/extraRoots/set`.**

- Accepts a skill directory, a single skill, or a link. Reported scope: `user`.
- Process-scoped, not thread-scoped: roots disappear with app-server. Set them on
  every launch, before both `thread/start` and `thread/resume`.
- Codex watches its roots: additions or changes are detected within 5 seconds with
  `skills/changed`. A directory **leaving** the root (rename, disable, delete) is
  not detected: reset the roots to force a complete reread.
- When a `.claude-plugin/plugin.json` exists above a root, Codex prefixes each skill
  with the plugin name (`projet:name`), like its own plugins. The composer searches
  by prefix: `$name` would no longer find it. Hence the absence of a manifest.
- Reads supporting files through `cat` in the `read-only` sandbox without approval.
- Does not substitute `$ARGUMENTS`: the model interprets the marker.
- `~/.codex/config.toml` stays untouched.

**OpenCode, injected configuration's `skills.paths` key.** Probed on 2026-10-05
with opencode 1.18.25, added after the batches shipped.

- Each root's `skills/` directory goes into `skills.paths` through
  `OPENCODE_CONFIG_CONTENT`: nothing is written to `~/.config/opencode`.
- Skills appear among slash commands (`source: skill`) and in the model's `skill`
  tool, which invokes them by description.
- Skills added after launch are invisible. The instance must be disposed
  (`POST /instance/dispose`), which the runner does while idle; the open event
  stream then goes silent and must be reconnected.
- OpenCode also reads `~/.claude/skills`, `~/.agents/skills`, and repository
  `.claude/skills` and `.agents/skills` while walking up from the working directory.

**Grok Build, `--plugin-dir` per root.** Probed on 2026-10-17 with Grok Build 1.0.62.

- Grok reads Claude Code-format plugins, with optional manifests: each library
  root is passed through `--plugin-dir` when launching `grok agent`.
- `_x.ai/plugins/reload` rereads them after a write without restarting the session.
- `GROK_CLAUDE_SKILLS_ENABLED=0` prevents additionally reading `~/.claude/skills`.
  Repository `.grok/skills` and `.agents/skills` directories remain readable.

**Google Antigravity, native skill directories.** Implemented against ACP 1.4.3.

- Global and project library skills are copied into each session's private
  `GEMINI_HOME/config/skills`, including supporting files. Symlinks to the shared
  library would resolve outside the native allowed home and fail file-tool reads.
- Native `config/skills`, project `.gemini/skills`, `antigravity-cli/skills` and
  project `.agents/skills` remain available in their native precedence order.
- The composer uses the skill inventory and passes an explicitly selected skill as
  embedded Markdown context. Description-based discovery remains native.
- Changes restart the ACP process before the next turn, resuming its history.
  There is no native live skill-reload RPC.

## Model

### On disk

The library takes the shape of two Claude plugins whose `skills/` directories are
used unchanged as Codex roots. One set of files for both CLIs.

```
<data>/skill-library/
  global/sillage/skills/<nom>/SKILL.md …              “sillage” plugin
  projects/<projectId>/projet/skills/<nom>/SKILL.md …  “projet” plugin
  disabled/<skillId>/                                  outside every delivered root
  .staging/                                            atomic-write staging
$XDG_CACHE_HOME/sillage/skill-sources/<sourceId>/      regenerable clones (batch 3)
```

- No manifest: Claude names the plugin after its directory, and Codex keeps bare
  names (see probes).
- The directory name is the frontmatter `name`. Renaming moves the directory and
  rewrites frontmatter in the same operation.
- Disabling moves the directory to `disabled/`. Neither Claude nor Codex offers a
  filter that would not also hide the user's personal skills.
- A project's roots are created when its first conversation launches, including
  `skills/` even when empty (see probes).
- Source clones go in the cache, not `<data>`: they are regenerable and need not
  be carried by hourly backups.
- Every write uses a temporary file followed by `rename`, so a CLI never reads a
  half-written `SKILL.md`. Updates replace the entire directory the same way.

### In the database

The name `skills` is already taken by `packages/protocol/src/skills.ts`, which
describes skills published by Codex. Everything below uses a `library` or
`skillSource` prefix.

```ts
// packages/db/src/schema.ts
library_skills
  id               text pk
  scope            'global' | 'project'
  project_id       → projects.id, on delete cascade, null for global scope
  name             text       directory name, uniqueness key
  enabled          bool
  source_id        → skill_sources.id, on delete set null
  source_path      text null  skill path within the source
  source_commit    text null  installed commit
  source_hash      text null  skill fingerprint in the source, before renaming
  installed_hash   text null  content fingerprint at installation
  created_by       → users.id
  created_at, updated_at

skill_sources
  id, name, url, ref (null = default branch), subpath (null = root)
  builtin bool, enabled bool
  last_commit, last_fetched_at, last_error
  created_at, updated_at
```

- Descriptions are not in the database: `SKILL.md` is authoritative and the list
  rereads it.
- **Uniqueness.** A name can occur only once across “global + a given project”.
  SQLite treats `NULL` values as distinct, so an index is insufficient: the service
  checks and returns a translatable error code, like `requireFreeName` in
  `routes/mcp.ts`.
- **Fingerprint.** sha256 of the sorted list of `path\0sha256(content)`. A local
  fingerprint differing from `installed_hash` means “locally modified”. A source
  fingerprint differing from `installed_hash` means “update available”.
- The two preconfigured sources are inserted by the migration itself, not on
  startup, so deleted sources do not return:
  - `anthropics/skills`, subdirectory `skills`;
  - `openai/skills`, subdirectory `skills/.curated`. Not `.system`, which would
    duplicate Codex's built-in skills.

### Configuration

- `AgentConfig`: `skillLibrary: z.boolean().default(true)` for Claude and Codex,
  following `sillageMcp` (`packages/protocol/src/agent-config.ts:33`).
- `config.toml`: `[skills] library = true`, an instance toggle like `mcp.sillage_server`.
- `Paths` (`apps/server/src/config.ts:81`): `skillLibrary` and `skillSourcesCache`.

## Delivery to CLIs

`RunnerContext` receives `skillRoots(config): string[]`, the plugin roots (global,
then project), or an empty array when the library is disabled for the instance or
conversation. It is a function for the same reason as `resolveMcpServers`: the toggle
changes live. It is built in `SessionManager.buildContext`, which also creates roots.

**Claude** (`claude/runner.ts`, `query()` options, built by `claude/skill-library.ts`):

- `plugins: roots.map((path) => ({ type: 'local', path, skipMcpDiscovery: true }))`;
- roots added to `additionalDirectories`, alongside `attachmentsRoot`;
- in `flagSettings`, `permissions.deny` for `Edit(//<root>/**)` and
  `Write(//<root>/**)`. This guards against an agent in one project accidentally
  editing a global skill; it is not a boundary: Bash can still write;
- different roots make `applyConfig` return `false`, triggering the existing
  turn-end restart mechanism: plugins are launch options.

**Codex** (`codex/runner.ts`, `start()`):

- `skills/extraRoots/set` with `roots.map((root) => join(root, 'skills'))`, right
  after `initialize` and before `thread/start` or `thread/resume`;
- changing `skillLibrary` replays `extraRoots/set` live, with an empty list if needed;
- a method failure does not terminate the session, which runs without the library;
- the composer's inventory updates automatically through the already wired `skills/changed`.

**Reload after a write.** `AgentRunner` gains `reloadSkillLibrary()`. For Claude it
calls `session.reloadSkills()`. For Codex it resets the same roots: its watcher
does not detect departing directories. `SessionManager.reloadSkillLibrary(projectId |
null)` calls it on affected runners: all for a global write, project runners otherwise.
The library service calls it after each successful write.

## Server

New directory `apps/server/src/skill-library/`:

| File | Role |
|---|---|
| `layout.ts` | root paths, idempotent creation of both plugins |
| `frontmatter.ts` | frontmatter reading and writing (`yaml` dependency) |
| `validate.ts` | relative file paths without empty, `.`, or `..` segments; `SKILL.md` reserved outside imports. Name and description validated by `packages/protocol/src/skill-library.ts` schemas |
| `compat.ts` | warnings: `$ARGUMENTS`/`argument-hint` (Codex does not substitute), `allowed-tools`, `disable-model-invocation`, `context: fork` (ignored by Codex), presence of scripts |
| `store.ts` | creation, editing, renaming, scope changes, enabling, deletion, fingerprints, atomic writes |
| `archive.ts` | zip/`.skill` import and export (`fflate` dependency, already present transitively) |
| `local-scan.ts` | skills already on the machine and in the project repository |
| `sources.ts` | cloning, refreshing, catalog, installation, updates |
| `skills-sh.ts` | skills.sh search, isolated because the API is undocumented |

Routes registered in `http/app.ts` like `registerMcpRoutes`:

```
GET    /api/skill-library?projectId=           global + project + repository skills (read)
POST   /api/skill-library                      create {scope, projectId?, name, description, body}
GET    /api/skill-library/:id                  detail: frontmatter, body, tree, compatibility, state
PATCH  /api/skill-library/:id                  name, description, body, frontmatter, enabled, scope
DELETE /api/skill-library/:id
GET    /api/skill-library/:id/files/*          read a supporting file
PUT    /api/skill-library/:id/files/*          write a text file
POST   /api/skill-library/:id/files            multipart upload (@fastify/multipart)
DELETE /api/skill-library/:id/files/*
GET    /api/skill-library/:id/export           zip
POST   /api/skill-library/import               zip, .skill, or directory (multipart)
GET    /api/skill-library/local?projectId=     skills found on the machine and in the repository
POST   /api/skill-library/adopt                copy a local skill into the library

GET    /api/skill-sources
POST   /api/skill-sources                      {name, url, ref?, subpath?}
PATCH  /api/skill-sources/:id
DELETE /api/skill-sources/:id
POST   /api/skill-sources/:id/refresh
GET    /api/skill-sources/:id/catalog
POST   /api/skill-sources/:id/install          {path, scope, projectId?}
GET    /api/skill-library/:id/update           diff between installed version and source
POST   /api/skill-library/:id/update           apply
GET    /api/skill-sources/search?q=            skills.sh
```

**Permissions.**

- Read: every user for global scope, project members for project scope.
- Global writes and sources: `requireAdmin`. A global skill enters the context of
  every instance conversation, and its scripts run as the system user, like MCP servers.
- Project writes: the owner, same check as `projects.ts:360`.
- `local` and `adopt` on `~`: admin only because these routes expose the system
  account's home directory. The “project repository” part stays visible to project members.

**Details.**

- Deleting a project (`projects.ts:395`) also deletes `skill-library/projects/<id>/`.
  Database cascade does not touch disk.
- `local-scan` reads `~/.claude/skills`, `~/.agents/skills`, and `$CODEX_HOME/skills`,
  excluding `.system` and `~/.claude/skills/synced`, managed by Claude account sync.
  It also reads workspace `.claude/skills` and `.agents/skills`. It flags name
  collisions too: a native skill `x` would hide Claude's `/x` alias, while Codex
  would show both.
- Archive import rejects absolute paths and paths containing `..`. It caps size
  at `limits.maxAttachmentBytes` and file count at 500. It accepts `SKILL.md` at
  the root or in a single top-level directory.
- Cloning reuses `cloneRepository` (`git.ts:167`) with `--depth 1` and the triggering
  admin's git credentials, covering a team's private repositories. Refresh runs
  `fetch --depth 1` followed by `reset --hard` on the ref, only in the cache.
- The catalog lists directories containing `SKILL.md`, at most four levels deep,
  excluding `.git` and `node_modules`. Results are cached next to the clone.
  A source's `.claude-plugin/marketplace.json`, if present, groups skills.
- Installation is a **copy** pinned to a commit, never a live link: nothing should
  change in agents' context without admin review. No automatic updates.
- Update diffs use `git diff --no-index` between installed content and source,
  reusing the format the interface already displays (`DiffHunks`).
- `skills-sh.ts` calls `GET https://skills.sh/api/search?q=`, returning
  `{source: "owner/repo", skillId, installs}`. Installing a result adds the
  corresponding GitHub source. If the API fails, search is hidden and the rest works.

## Interface

**Settings > Skills** (`/settings/skills`):

- `SECTIONS` entry in `routes/SettingsPage.tsx`, `workspace` group, after `mcp`;
- `routes/SkillLibrarySettingsPage.tsx`, following `McpSettingsPage`: visible to
  everyone, editable by admins;
- list: name, description, origin badges (“created here”, `anthropics/skills @ abc123`)
  and state badges (“locally modified”, “update available”, “disabled”, “scripts”);
- “Add” button: New, Import archive, From a catalog, From this machine;
- “Sources” section on the same page: repository list, add by URL, refresh, last error.

**Project page** (`/p/:projectId`):

- `ProjectSkills` section in `routes/ProjectPage.tsx`, after worktrees, outside the
  owner-only block because members can read it;
- visible to members, editable by the owner;
- content: project skills, a read-only reminder of global skills, and read-only
  repository skills with the CLI that sees them (`.claude/skills` for Claude,
  `.agents/skills` for Codex).

**Editor** (`/skills/:skillId`, full-width page):

- one route for both scopes, outside settings: the settings column is too narrow
  for instructions and files. The back link leads to the library or project;
- name and description fields with live validation. Description hints “say when
  to use it”: this is what triggers the skill;
- `SKILL.md` body in `panel/CodeEditor.tsx`, gaining a read-only mode for users
  without write access; one Save button and Ctrl+S;
- files: a simple list rather than workspace-bound `panel/FileTree.tsx`; creation,
  upload, deletion, each text file opened in a `CodeEditor`. No renaming: delete
  and recreate is enough for now. Advanced YAML frontmatter is not editable
  either; CLI-specific fields stay intact on rewrite;
- compatibility panel powered by `compat.ts`;
- actions: export, duplicate, move between global and project, disable, delete
  (`ConfirmDialog`).

**Catalog and updates**:

- catalog dialog: source choice, list, preview (rendered `SKILL.md`, tree, scripts
  badge, commit), then “Install” with scope choice;
- skills.sh search at the top of the dialog when available;
- update dialog: diff through `DiffHunks`. If the skill is locally modified, the
  dialog warns before overwriting.

**Conversation**:

- “Skill library” toggle added in `components/chat/agent-settings.tsx` for both
  CLIs, next to Sillage MCP. The same hook supplies the composer, account defaults,
  and project defaults;
- nothing else needed in the composer: skills arrive in `/` through Claude's
  command catalog and in `$` through `skills/list`.

Web files: `lib/skill-library.ts` (hooks, following `lib/mcp.ts`),
`components/skills/*`, routes in `App.tsx`, labels in `lib/i18n/catalog-fr.ts` and
`catalog-en.ts`.

## Batches

### Migration

`0028_skill_library.sql`, after project images' `0027`. Both preconfigured sources
are inserted manually at the end of the generated file: regeneration through
`pnpm db:generate` must restore them.

### Batch 1: library and delivery (implemented)

1. Schema (`library_skills`, `skill_sources`, seeds) and migration.
2. `skillLibrary` in `AgentConfig`, `[skills] library` in `config.toml`, `Paths`.
3. `skill-library/layout.ts`, `frontmatter.ts`, `compat.ts`, `store.ts`.
4. `skillRoots` in `RunnerContext`, both runners wired up, `reloadSkillLibrary`.
5. Create, read, edit, and delete routes without supporting files.
6. Deletion of removed projects' directories, including disabled skills.

Tests (`apps/server/test/`, `tsx --test`):

- `skill-library.test.ts`: layout, global/project uniqueness, foreign directory,
  renaming, disabling, scope changes, rejection without partial writes, disk-read
  problems, fingerprint, project deletion, symbolic links, frontmatter,
  compatibility, Claude options, route permissions;
- `codex-runner.test.ts`: `extraRoots/set` sent before `thread/start`, replayed on
  reload and toggle changes, and not sent when the library is disabled.

Acceptance checks on a disposable server with real Claude (Haiku 4.5) and Codex
sessions. Thirteen out of thirteen passed:

- a project skill created through the API appears in an open Claude session within
  one second (`projet:e2e-probe`, alias `/e2e-probe`), and in an open Codex session;
- a global skill appears in both;
- `/e2e-probe` and `$e2e-probe` execute, and Claude triggers the global skill by description;
- library writes are rejected in `acceptEdits`, after a live setting change;
- Codex reads a skill's modified version;
- a deleted skill disappears from both inventories;
- turning the toggle off removes the library, live in Codex, through restart in Claude.

The same write is also rejected in `bypassPermissions`.

### Batch 2: management interface (implemented)

What was done, and what differs from the breakdown below:

- server: supporting files (read, write, upload, delete), archive export/import,
  adoption of machine skills, duplication. A browser-selected directory is zipped
  client-side (`fflate`): one import path. Adoption copies only a path just offered
  to the caller by the scan, and repository skills are adopted into their project;
- interface: settings section, project section, editor, add menu (new, archive,
  directory, from this machine), per-conversation toggle, French and English labels,
  translated error codes;
- tests: `skill-library-import.test.ts` (archives and `..` traversal, supporting
  files, export then import, duplication, scan and adoption with permissions);
- Chromium walkthrough on a disposable server: creation, supporting file, Ctrl+S,
  project page, adoption of a repository skill, composer setting for both CLIs,
  export, duplication, move, disable, delete, touch display. No console errors.

Planned breakdown:

1. Supporting-file routes, archive import/export, `local-scan`, adoption.
2. Settings section, project section, editor, files, compatibility.
3. Per-conversation toggle in `agent-settings.tsx`.
4. French/English labels.

Tests: `skill-archive.test.ts` (reject paths outside archive, single top-level
folder, caps). Visual checks with Playwright on a disposable server, not the daemon.

Acceptance: create, edit, add a script, rename, move to a project, export,
reimport, delete. All through the interface and visible in an open session at every step.

### Batch 3: sources (implemented)

What was done, and what differs from the breakdown below:

- `source_hash` joins `library_skills`: updates are detected by comparing the
  catalog with the installed source version, not written content. Otherwise, a
  skill renamed at installation (rewritten frontmatter) would have a phantom
  update. The migration was regenerated instead of duplicated because the branch
  was not yet merged anywhere;
- depth-1 clones under `$XDG_CACHE_HOME/sillage/<data-directory fingerprint>/skill-sources`:
  two instances on one machine (test server alongside daemon) have the same
  preconfigured source IDs and must not refresh the same clone;
- clones use the refreshing admin's git credentials, through the environment,
  without writing anything in the cloned repository;
- a repository can itself be a skill (empty path); `.git` is never copied;
- updates keep the library name, replace the directory atomically, and compute
  diffs with `git diff --no-index` between installed content and source, with
  paths normalized to the skill;
- skills.sh search is admin-only because only admins can add a result's source;
  browsing catalogs and installing into one's projects is open to everyone;
- the editor remounts when server text changes without an active draft
  (`use-editor-revision.ts`): after an applied update it showed the old version,
  which Ctrl+S would have written over the new one. Found during acceptance checks.

Verified: `skill-sources.test.ts` with local git repositories (catalog, preview,
installation and permissions, update detected then applied, rename, overwritten
local changes, skill repository, fetch failure, directory change). In the browser
against GitHub: fetched anthropics/skills (19 skills) and openai/skills (39),
reviewed and installed `pdf`, simulated an update in the database, reviewed its
diff with overwrite warning then applied it, skills.sh search (20 results),
touch catalog. Not verified: a real private repository because none was available;
credentials follow the already operational project-clone path.

Planned breakdown:

1. `sources.ts`: clone, refresh, catalog, installation with provenance, update
   detection, diff, application.
2. `skills-sh.ts` and search route.
3. Sources section, catalog dialog, update dialog.

Tests: `skill-sources.test.ts` with a git repository created in a temporary directory.
Covers installation, then a source commit showing “update available”, a local change
showing “locally modified”, and applying the update.

Acceptance: install `pdf` from `anthropics/skills` and invoke it in Claude and Codex.
Install a skill from a private repository with an admin's git credentials.

### Later

- Bridge repository skills across CLIs: supply `.claude/skills` as an extra Codex
  root and `.agents/skills` to Claude. Requires a Claude probe because `.agents/`
  has no plugin manifest.
- Git-versioned library for history, undo, and sharing a team library through a
  common repository.
- Agent-assisted creation in a conversation opened in the skill directory.
- MCP dependencies declared by a skill and enabled from the registry.
- Personal scope per account.

## Accepted limitations

- **No hiding a global skill in one project.** Both CLIs read entire roots.
  Excluding a skill for one project would require a generated per-project view
  or the SDK's `skills` filter, which would also hide personal skills.
- **Library skills do not exist outside Sillage**: conversations resumed in the
  native CLI lack them, as with MCP servers.
- **Write protection is only a guardrail**: `deny` rules stop `Edit` and `Write`,
  not Bash redirection.
- **A third-party skill is executed content.** Its instructions enter context and
  its scripts run with the agent's permissions. Hence admin-only installation,
  full preview before installation, pinned copies, and no automatic updates.

## Documentation

The data model was added to section 4 of `SPEC.md`, and the screen to section 12.8.
This file remains the reference for probes and design rationale: reread it before
changing delivery, and rerun probes (`/tmp/skill-probe`) when a CLI version changes
any observed behavior.
