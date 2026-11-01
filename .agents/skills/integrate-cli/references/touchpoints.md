# Touchpoints: every place that names a CLI

Lists like this go out of date. Treat the greps below as the source of truth, and use the
lists as a map of what each place does. Last checked against `main` at 572a0391b
(November 2026).

```sh
# Every place a kind is named. Antigravity was the last CLI added, so it shows the full surface.
git grep -n -i antigravity -- apps packages scripts deploy ':!*.lock'
# Comparisons outside adapters. These are the branches typecheck will not catch.
git grep -n -E "(===|!==) '(claude|codex|opencode|grok|antigravity)'" -- apps packages ':!apps/server/src/agents/*/**'
# Past integrations, file by file
git show --stat e67c41628   # Antigravity (99 files)
git show --stat 00c16ad12   # Grok merge; follow-ups: be72d3c2b (accounts and gauge),
                            # fcc09ae03 (Windows launch), 37ea9fa92 (login in onboarding)
git show --stat 3ad0c719b   # per-account model catalogs for every CLI
git show --stat f97f29f97   # MCP reconnect (runner contract method)
git show --stat 2eface80f   # managed CLI updates
```

## 1. Declare the kind

First add the kind to `agentKindSchema` in `packages/protocol/src/events.ts`. Then run
`NODE_ENV=development pnpm typecheck`. Every `Record<AgentKind, …>` and every exhaustive
`switch` then reports an error until it has an entry.

**Forced by typecheck** (as of this writing):

| File | Symbol | What to decide |
|---|---|---|
| `packages/protocol/src/capabilities.ts` | `AGENT_CAPABILITIES` | Seven flags: `steer`, `compact`, `resyncSessions`, `planReview`, `cliSessions`, `stopBackgroundTask`, `draftCommands`. Each flag says what was probed, and the existing rows comment on why. |
| `packages/protocol/src/cli-versions.ts` | `PREFERRED_CLI_RELEASES` | `{package, version}`. Compatibility uses caret rules, and a newer install is never downgraded. |
| `packages/protocol/src/agent-config.ts` | `DEFAULT_CONFIGS` | Default config (see §2). |
| `packages/protocol/src/user-settings.ts` | `ComposerLayout`, `AgentDefaults` interfaces | Composer layout and the user's defaults. |
| `packages/protocol/src/v1.ts` | `EFFORT_FIELD`, `OVERRIDABLE_CONFIG_FIELDS`, `isPermissiveConfig` | The effort field name, which fields API callers may override, and which modes count as permissive for `tasks:autonomous`. |
| `apps/server/src/agents/cli-binary.ts` | `names` in `installable` | Default executable name. |
| `apps/server/src/conversations/handoff.ts` | `AGENT_NAMES` | Display name used in handoff context. |
| `apps/server/src/exports/render.ts` | `agents` | Name in HTML exports. |
| `apps/server/src/sessions/agent-requests.ts` | `effortOf` | How to read the effort. |
| `apps/web/src/components/AgentIcon.tsx` | `BRAND`, `AGENT_META` | Brand color, label, vendor, blurb key and SVG mark. Put new entries after an entry's doc comment, not inside it. |
| `apps/web/src/lib/onboarding.ts` | `withPermissionChoice` | Mapping of the onboarding permission choice. |
| `apps/web/src/components/onboarding/AgentsStep.tsx` | `CLI_LOGIN`, `EXTRA_LABEL` (+ `ExtraAccountAgent`) | Login hint, and the extra-accounts label. |

**Silent: no type error.** Each item below compiles even if you forget it.

Protocol:
- `agent-config.ts`:
  - a `<kind>ConfigSchema` in the `agentConfigSchema` union, and `DEFAULT_<KIND>_CONFIG`;
  - every field needs `.default()`, because stored rows from older versions must still parse
    (`parseAgentConfig`).
- `project-defaults.ts`:
  - the interface, `NO_PROJECT_DEFAULTS`, and a schema with `.nullable().default(null).catch(null)`;
  - the `!defaults.x && …` chain in `serializeProjectDefaults`. If you miss it, a preset set
    only for the new CLI serializes to `null`.
- `user-settings.ts` schemas: use `.default(DEFAULT).catch(DEFAULT)`, not `.catch` alone,
  because stored settings don't have the key.
- `index.ts`: export `<kind>-accounts.ts` if the CLI has accounts.

Server:
- `agents/registry.ts`: the `createAgentRegistry` array. A missing entry fails only at
  runtime ("Aucun adaptateur inscrit").
- `config.ts`:
  - `agents.<kind>{binary, enabled}`, and `Paths.<kind>Accounts` if the CLI has accounts;
  - add the same block to `deploy/config.example.toml`.
- `sessions/session-manager.ts`:
  - `accountEnv`. Anything it doesn't match **falls through to the Codex account store**.
  - a `<kind>Home()` helper, `modelsFor`, the memory appendix branches, and constructor
    wiring.
- `http/routes/agents.ts`, `accountCredential`. Without a branch the route returns
  `404 agent_account_not_found`.
- `http/routes/conversations.ts`: the portable fork is chosen by
  `source.agent === 'antigravity'`. Add your kind if the CLI has no native fork, then fix
  this properly with a capability.
- `sessions/agent-requests.ts`:
  - `withEffort`, which falls back to `variant`;
  - `describePermissions`, which has no Antigravity case yet.
- `instructions/store.ts`: the string that lists the CLIs.
- `memory/store.ts`: `memoryAppendixForCodex(…, nativeFileAccess)` and how the runner gets
  the appendix.
- `agents/mcp-builtin.ts`: `builtinMcpEnabled` applies `strictMcp` to Claude only.
- `agents/cli-install.ts`: npm is the default, so add a branch for anything else.
- `mcp/sillage-mcp.mjs` lists the kinds by hand in four places: the `start_session`
  description, two enums, and the `list_models` enum.
  - It is plain JS outside the module graph, so neither typecheck nor lint checks it.
  - The constants it duplicates from `packages/protocol` must stay in agreement, as its
    comments say.
- `http/app.ts`, `main.ts`: register the account routes, wire them in, and add them to
  `closeAll`.
- `http/v1/config.ts`, `discovery.ts`, `tasks.ts`, `execution-policy.ts`,
  `routes/api-tokens.ts`: mostly generic through `EFFORT_FIELD`, but read them. Budget
  handling is Claude only.
- `cli/demo-seed.ts`: demo conversations used for screenshots. Optional.

Web:
- `components/chat/agent-settings.tsx`, `useAgentSettings`: see §3. **Without a branch for
  the kind, the composer chip simply does not render.**
- `components/onboarding/WelcomeStep.tsx` and `WorkStep.tsx`: the literal `ALL_AGENTS`
  arrays. Also check the per-kind exclusions in `AgentsStep.tsx`, for example opencode has
  no extra accounts.
- `lib/usage.ts` `usageAccountOf`, `lib/extra-accounts.ts`, `components/chat/AccountChoice.tsx`.
- `components/chat/Composer.tsx` `combinedCommands` and `SkillsControl.tsx`
  `listsSkillsAsCommands`: both are `claude || grok` today. This matters if the CLI lists
  skills as slash commands.
- `routes/DraftConversationPage.tsx`: the account argument to `useProjectCommands`, set for
  Antigravity only today.
- `routes/ApiTokensSettingsPage.tsx`, `components/ApiTokenPermissionsEditor.tsx`,
  `ApiExecutionPolicyEditor.tsx`: the permission select for each CLI, and the
  `tasks:autonomous` auto-scope.
- `routes/SettingsPage.tsx` sections and `App.tsx` routes, for the accounts page.
- `lib/chat-fold.ts` `noticeText`: notice codes that need a translation.
- `lib/use-chat-stream.ts`: query invalidation on notices, for example
  `antigravity_account_signed_out`.

Tests and scripts that count CLIs:
- `scripts/windows-feedback-ui-check.mjs` counts the `draft-agent` options.
- `scripts/onboarding-ui-check.mjs`.
- `scripts/disabled-cli-ui-check.mjs`.

## 2. Configuration schema

- **Common fields.** Every config has:
  - `agent` (a literal), `model`, an effort field, and the native permission vocabulary;
  - `additionalDirectories`, `mcpServers`, `sillageMcp`, `skillLibrary`;
  - `account` when the CLI has extra accounts.
- **CLI-specific fields** use the CLI's own names, in the CLI's own terms. Examples:
  - Codex `sandbox`, `askForApproval`, `collaborationMode`, `webSearch`, `profile`;
  - opencode `variant`, `primaryAgent`, `permissions{edit,bash,webfetch}`;
  - Grok `permissionMode` (`default|auto|plan|bypassPermissions`), `webSearch`;
  - Antigravity `permissionMode` (`default|auto_edit|yolo`).

  When generated bindings exist, check the types against them (`agent-config.ts`, Codex
  assertions).
- **`CLI_DEFAULT = ''`.** Model and effort are free strings because the catalog decides
  them.
  - Never put a guessed model id in the defaults.
  - `resolveDefaults` (registry contract) replaces the sentinel with what the CLI reports.
    If the catalog can't be reached, it must leave the sentinel so the CLI applies its own
    defaults.
- **No database migration for the kind itself.** The `agent` columns are `text` typed as
  `AgentKind`. Only an accounts table needs a migration:
  - edit `packages/db/src/schema.ts`, then run `pnpm db:generate`;
  - commit the `.sql`, the snapshot and `_journal.json`;
  - renumber on a rebase collision (`f2e4bc7d7`);
  - never edit a published migration.

## 3. Interface

**`useAgentSettings` in `agent-settings.tsx`** is an if/else chain. The new CLI needs:

- its `const <kind> = config.agent === '<kind>' ? config : null` line;
- an entry in `effortSetting` if it uses `reasoningEffort`;
- its `accountOptions`, and the matching `useMemo` dependencies;
- its permission options, labeled in the native vocabulary;
- a branch that builds `groups`, `summary` and `mcp`.

**Group keys are a contract.** They are stored in `composerLayout`, so keep them stable.

- `model` and `effort` make the chip that is always visible (`ComposerSettings.tsx`).
  `effort` renders `EffortSlider`.
- A `mode` or `permission` group with the value `plan` shows the Plan status.
- A summary segment with `tone: 'caution'` raises the warning style, for permissive modes.
- When catalogs differ per account, clear `model` and effort on an account change. See
  Antigravity's branch and `AccountChoice.tsx`.
- `appliedLabel`/`notice()` show "pending until restart" from `appliedConfig`.

**Generic, nothing to add:**
- draft agent cards (`agentKindSchema.options`);
- CLI defaults and project default pages;
- the handoff dialog;
- schedule, automation and board pickers;
- hidden agents (`hiddenAgent` in `lib/agents.ts`);
- the disabled-CLI handling (`reason: 'disabled'`).

**Per-CLI pages and components:**
- `routes/<Kind>AccountsSettingsPage.tsx`. It exports `LoginControls` so onboarding can reuse
  it.
- `lib/<kind>-accounts.ts`.
- The onboarding login step.

**i18n**, in `apps/web/src/lib/i18n`. `catalog-en.ts` is the reference for types, and
`catalog-fr.ts` needs the same keys. Antigravity added about 52 keys:
- `agent.blurb.<kind>` and `onboarding.agents.<kind>Label`;
- permission labels, account flows, notices;
- `error.<code>` for every error code the runner emits.

Repository comments and docs are in English. User-facing text is written in both languages.

UI conventions from SILLAGE.md:
- icon-only actions with tooltips;
- forms in a dialog, not under the button that opens them;
- tabs instead of stacked lists;
- the CLI logo visible on every session row.
