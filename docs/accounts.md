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
so in the thread.

On the new-session screen, an **Account** choice sits right under the CLI choice as
soon as an extra account exists. Each option shows where its account stands: the two
most loaded usage windows for the CLI's own sign-in and for Codex subscriptions, or a
sentence for the accounts that have no gauge (a subscription token, an API key). It
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
