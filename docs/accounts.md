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

A subscription token cannot read plan limits: `setup-token` only asks for the
`user:inference` scope (read in its authorization URL, 2.1.296), and without
`user:profile` the CLI does not read them. Each subscription can therefore get a
**gauge**: a second, full sign-in (`claude auth login`), run by Sillage the same guided
way, and kept in `<data>/claude-accounts/<id>` (`.credentials.json` and `.claude.json`
only, mode `0600`). Sessions never use it; usage reads run the CLI with
`CLAUDE_CONFIG_DIR` pointing there, and the CLI renews that sign-in by itself.

Sillage offers the gauge right after a subscription is added, and on every
subscription card (**Enable the gauge**, **Sign in again**, **Remove the gauge**). The
card shows the e-mail the gauge is signed in as: it should be the same account as the
token. A refused code makes `auth login` exit (« Login failed: … »), unlike
`setup-token` which waits for another; Sillage then starts a fresh one under the same
sign-in and shows its new link. An API key has no plan, so no gauge.

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
