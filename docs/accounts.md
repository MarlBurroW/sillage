# Extra accounts

Each CLI keeps a single sign-in: Claude Code in its configuration directory, Codex in
the `auth.json` of its home. Sillage lets a user register **extra accounts** for each
of them, then pick one per conversation. Accounts belong to the Sillage user who
created them, like git access tokens: another member of a shared project cannot run
a session on your subscription.

The choice lives in the conversation's configuration, under **Account** in the
composer, in **Settings › CLI defaults**, and in a project's presets. Changing it on a
running conversation restarts the session, as the permission mode does. When the
chosen account no longer exists, the session starts on the CLI's own sign-in and says
so in the thread. Antigravity requires choosing another connected account explicitly,
so an unavailable Google account never silently changes who pays for the request.

OpenCode has no extra accounts: it signs in to each provider itself.

On the new-session screen, an **Account** choice sits right under the CLI choice as
soon as an extra account exists. Each option shows where its account stands: the two
most loaded usage windows for the CLI's own sign-in, Codex subscriptions and extra
Claude subscriptions with their usage gauge enabled, or a sentence for accounts
without a gauge (a subscription token without the extra sign-in, an API key). It
sets the same field as the composer's **Account** setting.

## Claude Code

Settings › **Claude accounts**. An account is one of two things:

- **A subscription** (Pro, Max, Team), reached through the long-lived token that
  `claude setup-token` prints. Sillage hands it to the session in
  `CLAUDE_CODE_OAUTH_TOKEN`, which Claude Code takes ahead of its stored `/login`
  (probed on 2.1.296: a bogus token fails with 401, a valid one answers). The token
  lasts a year; replace it from the account's card when it expires.
- **A Console API key** (`sk-ant-api03-…`), billed per use on the key's organization.
  Handed to the session in `ANTHROPIC_API_KEY`; in non-interactive mode the CLI takes
  it without asking. The conversation header then shows the computed cost, which has
  a meaning here that it lacks on a subscription.

The kind is read from the secret's prefix. Secrets are encrypted at rest with the
same key as git access tokens and never returned by the API.

### Adding a subscription without a terminal

Choose **Sign in with a subscription**. Sillage runs `claude setup-token` in a
pseudo-terminal, inside a throwaway configuration directory so the host's own
sign-in is neither read nor touched, and follows the dialogue the command expects:

1. it shows the authorization page the CLI printed; open it, signed in to the Claude
   account you want, and authorize Claude Code;
2. the page then shows a code; paste it back in Sillage;
3. the CLI prints the token, Sillage encrypts it, and the account appears.

A refused code can be retried without starting over. The CLI waits fifteen minutes
for the code, then the attempt is dropped. This is the same flow as
`claude setup-token` in SSH, where the browser cannot reach the CLI's local callback:
the page shows the code instead.

### Adding a token or a key by hand

Choose **Paste a token or an API key**. To mint a subscription token yourself, from a
terminal signed in to that subscription:

```bash
# keep the host's sign-in untouched: a separate configuration directory
CLAUDE_CONFIG_DIR=~/.claude-work claude auth login
CLAUDE_CONFIG_DIR=~/.claude-work claude setup-token
```

### Usage gauge

The same token reads the subscription's usage: there is nothing more to sign in to.
A `setup-token` token only carries the `user:inference` scope, so `/api/oauth/usage`
answers 403 and the CLI's usage request reports nothing (probed on 2.1.301). Every
model response, however, carries the plan's limit headers, which the CLI forwards as a
`rate_limit_event` with the 5-hour and 7-day windows. Sillage reads the gauge by
running one tiny Haiku turn under the token (about 2.5k cached input tokens), with no
settings, tools, MCP servers or saved transcript, and keeps the answer five minutes
like every other usage read. The plan name and per-model weekly windows are not in
those headers, so they do not show for extra subscriptions. An API key has no plan,
so no gauge.

Sillage keeps the CLI from opening a browser of its own during the sign-in
(`BROWSER=true`): that tab would complete the flow through the localhost callback and
make the code from Sillage's link useless. Where that cannot be prevented (Windows),
a token obtained through the callback still creates the account.

### Host sign-in expiry

Administrators see the host CLI's sign-in state and estimated expiry in **Claude
accounts**. Sillage reads `claude auth status` in the existing home, without copying
credentials or spending a model turn (probed on 2.1.318). It caches the result for
five minutes and checks hourly even with no conversation running. The refresh action
reads it immediately.

At ten days before expiry, then three days, then the reported expiry, administrators
receive a notification once per threshold. Activity retains a link to the account
settings while attention is needed. Server can deliver push notifications; Desktop
keeps the in-app warning. Notification preferences include CLI sign-in expiry. The
date can be an estimate, with actual expiry up to three days earlier; it does not
prove the current token is still accepted by Anthropic.

The warning links to the existing guided personal-account flow. Selecting that
account in conversations and schedules avoids relying on the host login; adding it
alone does not change their account. Renewing the shared host login itself still
requires `claude auth login` on the machine running Sillage, described in the
settings details. API keys, environment tokens, and extra accounts do not report
this date. Older CLIs and failed status reads show that the date is unavailable.

### Limits

- A token cannot open Remote Control sessions nor fetch claude.ai connectors. Local
  MCP servers work.
- Nothing checks a secret when it is saved beyond its prefix: checking would cost a
  model request. A wrong one shows up on the first message, as a 401 in the thread.

## Codex

Settings › **Codex accounts**. Codex keeps its sign-in in `$CODEX_HOME/auth.json`, so
each extra account gets its own home under Sillage's data directory
(`codex-accounts/<id>`), where only `auth.json` is real: every other entry is a
symbolic link to the user's `~/.codex` (or `$CODEX_HOME`). Settings, skills, memories
and threads are therefore shared, and a thread resumes or forks from any home
(probed on codex-cli 0.162.1). Links are refreshed at every launch, so an entry Codex
adds later to the user's home is seen by the accounts too.

The session gets `CODEX_HOME` pointing at the account's home. Sillage stores no
secret: Codex writes and refreshes `auth.json` itself. The account's card only keeps
what `account/read` said, the e-mail and plan of a ChatGPT sign-in.

### Signing in

An account is created with a name, then signed in from its card:

- **Device code**, for a ChatGPT subscription. Sillage starts `codex app-server` in
  the account's home, asks for `account/login/start` with `chatgptDeviceCode`, and
  shows the verification URL and the one-time code. Open the page with the ChatGPT
  account you want and enter the code; Codex reports completion and the card turns to
  *Signed in*. Device-code sign-in is a beta at OpenAI and must be allowed in the
  ChatGPT security settings of that account.
- **API key**, handed to Codex, which stores it in that home.

The classic browser flow is deliberately absent: its callback lands on
`localhost:1455` *of the server*, which the user's browser cannot reach.

**Sign out of this account** removes the home's `auth.json`; deleting the account
removes the home. Only signed-in accounts appear in the composer's selector: a home
without `auth.json` would refuse the turn.

### Limits

- The symbolic-link home is a bet on Codex's layout. Links are refreshed on each
  launch, but a future version that refused a home made of links would break it.
- Usage is read per account through the same `account/rateLimits/read`, in the
  account's home.

## OpenCode

Not covered: OpenCode has no account notion in Sillage.

## Grok Build

Same design as Codex: Grok Build keeps one sign-in per `GROK_HOME`, in its `auth.json`.

- Each extra account gets its own home under `<data>/grok-accounts/<id>`. Every entry
  of the user's `~/.grok` is linked into it except `auth.json`, `models_cache.json` and
  `settings_cache.json`, which depend on the subscription. Sessions are shared, so a
  conversation resumes whichever account opened it.
- Sign-in is run by Grok in that home: `grok login --device-auth` for a SuperGrok or
  X Premium subscription (Sillage reads the URL and code it prints), or the ACP
  `xai.api_key` method with `XAI_API_KEY` for an xAI API key, which Grok stores in the
  home's `auth.json`. Sillage keeps no secret.
- Sign-out runs `grok logout` in the home, then removes its `auth.json`.
- The session receives `GROK_HOME`. Changing the account restarts the process.
- Usage is read per account through Grok's `_x.ai/billing` extension: the share of the
  weekly or monthly credit allowance, the on-demand cap and the prepaid balance.
- Probed on Grok Build 1.0.62.

## Google Antigravity

Settings › **Google accounts** supports personal Google OAuth, enterprise OAuth
(with a Google Cloud project), a Gemini API key, and Agent Platform (API key or
project/location with Application Default Credentials on the host).

Open the Google authorization link from the account card. On a remote Server, the
browser's final loopback callback cannot reach the CLI: copy that failed page's
address into the card. Sillage forwards it only to the pending login's exact
loopback endpoint and checks its OAuth state. Desktop can complete the local
callback directly. Google owns OAuth and refreshes its own credentials.

Each account has a private `GEMINI_HOME` under `<data>/antigravity-accounts/<id>`.
File credential storage is forced to keep accounts separate on macOS too. API keys
are stored with mode `0600`, passed only to their native process and never returned
to the browser. The native API-key authentication step records configuration; Google
validates it on the first model request, so these cards say **Configured**.

Model catalogs, thinking choices and usage probes use the selected account.
Changing accounts restarts the process and resumes the same history; unavailable
model names are replaced by the new account's native default with a notice.
Histories are shared only within one Sillage user's accounts. Artifacts survive
account deletion; credentials do not travel with a conversation.

Signing out, reconnecting or deleting an account stops its running sessions first.
Native `/logout` also updates the Sillage account and stops its other sessions.
Quota gauges use the native `/usage` report when available; unsupported gauges
remain unavailable instead of showing an invented balance.

See [the integration inventory and validation limits](antigravity-integration.md).

## GitHub Copilot CLI

Settings › **Copilot accounts**. Same design as Grok: Copilot keeps one sign-in per
`COPILOT_HOME`, in its `config.json` (or the system keychain, under the login
`config.json` names).

- Each extra account gets its own home under `<data>/copilot-accounts/<id>`. Every
  entry of the user's `~/.copilot` is linked into it except `config.json`,
  `settings.json` and `logs/`. Sessions are shared, so a conversation resumes
  whichever account opened it. On Windows without the right to create symbolic
  links, the session index `session-store.db` is not linked (a hard link would give
  SQLite two journals for one database): sessions still resume, but Copilot's own
  session list in that home only shows the account's sessions.
- `settings.json` is the user's, rewritten at each launch with
  `"storeTokenPlaintext": true`: a server without a keychain can then keep the
  token, in the home's `config.json`, readable by the server's user only.
- Sign-in runs `copilot login --device-code` in that home. Open
  `github.com/login/device` signed in to the GitHub account you want and enter the
  code Sillage shows; the card then shows that account's login. The browser flow is
  absent for the same reason as Codex's: its callback lands on the server.
- Signing out removes the home's `config.json`; Copilot has no logout command to
  call. Deleting the account removes the home.
- The session receives `COPILOT_HOME`, and none of `COPILOT_GITHUB_TOKEN`,
  `GH_TOKEN` or `GITHUB_TOKEN`: any of them would answer in the account's place.
  Commands the agent runs in that session do not see them either. An account whose
  home is no longer signed in falls back to the machine's sign-in and says so.
  Changing the account restarts the process.
- Models and the usage gauge are per account. The gauge is the plan budget the
  account's last turn reported, so it stays empty until its first turn.
- Probed on GitHub Copilot CLI 1.0.116, with a scripted model provider for the
  shared sessions. A real second GitHub account has not been signed in yet.

### The machine's sign-in

Without an extra account, Copilot uses the sign-in of the machine Sillage runs on:

- `copilot login` in a terminal on that machine. On a server it prints a link and a
  code to enter on GitHub from any browser. Copilot keeps the token in the system
  keychain; a server without one must allow the plain-text fallback first, by
  accepting the prompt Copilot shows in a terminal or by setting
  `"storeTokenPlaintext": true` in `~/.copilot/settings.json`. The token then lives
  in `~/.copilot/config.json`, readable by that user only.
- Or a token in the server's environment: `COPILOT_GITHUB_TOKEN`, then `GH_TOKEN`,
  then `GITHUB_TOKEN`. One of these wins over a stored login without saying so, so
  a `GH_TOKEN` set for the GitHub CLI also decides which Copilot plan pays. Classic
  tokens (`ghp_…`) are refused; a fine-grained token needs the "Copilot Requests"
  permission.

Without a sign-in, a conversation fails at its first message and says how to sign
in. The usage gauge shows the plan budget the last turn reported (AI credits, or
premium requests), since Copilot has no call to read it between turns. Probed on GitHub Copilot CLI 1.0.116; see
[the integration inventory](COPILOT.md).
