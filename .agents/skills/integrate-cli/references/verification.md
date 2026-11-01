# Verification and documentation

## Automated checks

Run from the worktree:

```sh
export TMPDIR=/var/tmp                      # /tmp is a quota tmpfs; UI checks use tmpdir()
NODE_ENV=development pnpm install
NODE_ENV=development pnpm typecheck
NODE_ENV=development pnpm test              # apps/server: tsx --test test/*.test.ts
NODE_ENV=development pnpm lint
NODE_ENV=production pnpm --filter @sillage/web build   # UI checks serve apps/web/dist
NODE_ENV=development pnpm test:<kind>-ui
```

**Fixture agent** (`apps/server/test/fixtures/<kind>-agent.mjs`). Copy
`antigravity-agent.mjs`, `grok-agent.mjs`, `codex-app-server.mjs` or `opencode-server.mjs`,
whichever matches the protocol. Requirements:

- it speaks the real wire format, deterministically;
- it answers the version probe and login/logout;
- it plays scripted steps from the prompt (`fixture:{"steps":[…]}`): tools, diffs, streaming,
  permissions, questions, background completion, errors, usage;
- it writes its traces next to itself, never in the cwd or HOME (`be72d3c2b`).

**Unit tests.**
- Add `apps/server/test/<kind>.test.ts`, plus `<kind>-accounts.test.ts` and
  `<kind>-install.test.ts` where they apply.
- Extend the shared suites: `cli-updates`, `cli-binary`, `windows-launch`, `mcp-naming`,
  `handoff`, `tool-presentation`, `replay`, `thread-projection`.

**UI check** (`scripts/<kind>-ui-check.mjs`, registered as `test:<kind>-ui` in the root
`package.json`). Copy `scripts/antigravity-ui-check.mjs`. It:

- starts disposable servers with `tsx src/main.ts` and sets `SILLAGE_DATA_DIR`,
  `SILLAGE_PORT`, `SILLAGE_CONFIG` (`[agents.<kind>] binary = "<fixture>"`),
  `SILLAGE_WEB_ROOT` and `SILLAGE_PROFILE`;
- runs both the `server` and `desktop` profiles. Desktop uses `SILLAGE_HANDSHAKE_FD=3`;
- tests 1440×900 and 390×844, in French, failing on browser errors and horizontal overflow;
- covers:
  - accounts;
  - model and effort selection;
  - tool rendering, permission, question and plan;
  - import;
  - fork and its cutoff;
  - handoff in both directions;
  - logout.

Two pitfalls from earlier checks:

- **Keep Claude enabled.** Handoffs to a disabled CLI are refused (`1e2aaa025`).
- **Wait for the fork's native session** after the optimistic send (`bf12bac85`).

Also update and run the checks that count CLIs: `test:windows-feedback-ui`,
`test:onboarding-ui` and `test:disabled-cli-ui`. Run `test:cli-updates-ui`,
`test:composer-ui`, `test:tool-styles-ui` and `test:mcp-auth-ui` when the change touches
those areas. `test:composer-ui` can fail once on a cold Vite cache; run it again before
investigating.

## Trial with the real binary

Fixtures prove the integration matches what you believe the CLI does. Only the real binary
proves the CLI does it.

- **Use a disposable server.** Never use production, and never restart `sillage.service`.
  - Start `tsx src/main.ts` from `apps/server` with its own `SILLAGE_DATA_DIR`, a free
    `SILLAGE_PORT`, `SILLAGE_HOST=127.0.0.1` and `SILLAGE_CONFIG` pointing at the real
    binary.
  - Run it through `systemd-run --user`, so it is not counted against `sillage.service`'s
    memory budget.
  - Create a user with `pnpm user:create` against that data dir.
- **Make it reachable for the user** with `sudo tailscale serve --bg --yes --http=<port>
  <port>`, then share `http://marldev.tail710c78.ts.net:<port>`. Never share a `localhost`
  URL. Check it with `curl` before sharing it, say when it will stop, and remove the route
  afterwards.
- **Run a real turn** that uses tools, MCP (the Sillage server and one registry server),
  skills, a permission, a question, a subagent, a background command and an image if the CLI
  supports them. Use the user's account only after telling them, and prefer an invalid key
  when you only need to check the protocol.
- **Write probe scripts to `/var/tmp`**, and save their path and the probed version in
  project memory.
- **Clean up afterwards:** units, tailscale routes, scratch homes that hold credentials.

## Coverage document

Create `docs/<CLI>.md` (English), modeled on `docs/antigravity-integration.md`,
`docs/GROK.md` and `docs/OPENCODE.md`:

```markdown
# <CLI> integration

One paragraph: distribution and version pinned, protocol, how Sillage launches it.
Everything below was probed on **<version>** (and read in <source>, if available).

## Coverage inventory

| Area | Implementation | Limits / verification |
| --- | --- | --- |
| Installation | … | … |
| Identity/settings | … | … |
| Conversation | … | … |
| Native history | … | … |
| Tools | … | … |
| Background work / subagents / workflows | … | … |
| Permissions/questions/plans | … | … |
| Composer (models, efforts, modes, options) | … | … |
| Attachments | … | … |
| Commands | … | … |
| Skills | … | … |
| MCP | … | … |
| Instructions/memory | … | … |
| Accounts | … | … |
| Usage | … | … |
| Forks / transfers | … | … |
| Editions (Server/Desktop, OS) | … | … |

## Launch and isolation
Table: variable or flag → why.

## Launch settings and live settings
Table: Sillage setting → native mechanism → live or restart.

## Observed behavior
Quirks the next maintainer must know, each tied to a version.

## Deliberate differences
What is hidden or replaced and why (no RPC, ignored parameter…).

## Sign-in, accounts, and usage

## Verification
Commands run, fixture coverage, real-binary trials, and an explicit
**Not yet verified** list.

## Sources
```

Also update:
- `docs/accounts.md` (section for the CLI), `docs/skill-library.md` (delivery section),
  `docs/sillage-md.md` (masking probe), `docs/cli-handoff.md`;
- `docs/features.md`, `docs/api.md` if API fields change, `docs/windows.md`,
  `docs/desktop.md`;
- `README.md` and `deploy/config.example.toml`;
- `site/index.html`. Several sections list the CLIs by hand, and Antigravity is missing from
  some of them. Pushing `site/**` to `main` publishes the site, so warn the user before that
  push.

## Reporting to the user

- **What works:** verified, and how.
- **What the CLI doesn't offer:** with the version.
- **What is deferred or unverified:** for example real OAuth, a paid turn, Windows or macOS
  runtime.
- **Each edition:** how Server and Desktop each behave.
- **Running services:** any demo still up, its URL, and how to stop it.

Say plainly when a check failed, and include its output. Commit and push only when the user
asks. To deploy, follow the "Prod deploy procedure" project memory.
