<img src="docs/brand/wordmark.svg" alt="Sillage" width="340" height="72">

**A home for your coding agents.**

Use **Claude Code, Codex, OpenCode and Grok Build** in one interface, with your
conversations, code and Git changes side by side. Work on your computer, or host
Sillage on a server and pick up where you left off from your phone.

Sillage runs the native agent CLIs on your machine, using your own accounts.
You get their tools and capabilities in a visual workspace, without having to
manage a terminal for every conversation.

[**Get the desktop app**](#install-the-desktop-app) ·
[**Host your own server**](#install-the-server) ·
[**Watch the 54-second demo**](https://marlburrow.github.io/sillage/#film)

[![Latest release](https://img.shields.io/github/v/release/MarlBurroW/sillage)](https://github.com/MarlBurroW/sillage/releases/latest)
[![CI](https://github.com/MarlBurroW/sillage/actions/workflows/ci.yml/badge.svg)](https://github.com/MarlBurroW/sillage/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<picture>
  <source srcset="site/screenshots/hero-dark.png" media="(prefers-color-scheme: dark)">
  <img src="site/screenshots/hero-light.png" alt="Sillage: a coding conversation with grouped tool calls and a reply in progress">
</picture>

## What you can do

- **Keep the conversation going.** Queue your next request or steer an agent while
  it works. On Server, close your browser and come back from another device: work
  continues while the host stays awake and Sillage is running.
- **See what changed.** Browse files, review diffs and manage Git beside the
  conversation. Enable checkpoints to inspect or undo the changes from a turn.
- **Work on several ideas at once.** Give each conversation its own branch and
  working folder with Git worktrees. See what is in progress, ready to merge or
  ready to clean up.
- **Use the right agent for the next step.** Choose your CLI, model and account,
  or continue a conversation in another CLI with context from the original thread.
- **Turn ideas into tracked work.** Keep a project board with local cards and
  linked GitHub issues. Connect conversations to tasks and save common commands
  as buttons.
- **Let routine work come to you.** Schedule prompts, or use Server to start
  sessions from GitHub and other webhooks. Review questions and decisions when
  an agent needs your input.

There is more when you need it: full-text search, voice dictation, shared skills,
MCP connections, a task API, and phone notifications with Server.
[Explore the full feature guide →](docs/features.md)

## Server or desktop

Both editions share the same interface and agent integrations. Pick the one that
matches where you want to work.

| | Desktop | Server |
|---|---|---|
| Best for | Working on your own computer | Following your agents from any device |
| Runs as | An app on Windows, macOS or Linux | A background service or container |
| Keeps working | While the app runs and the computer is awake | While the host is awake and Sillage is running |
| Access | This computer, without a Sillage password | Browser or phone, with sign-in and configured remote access |

Each edition keeps its own data. You can try Desktop first; setting up Server
later starts a separate workspace.

### Install the desktop app

**The easiest way to try Sillage.** Download the app, open it and follow the setup
tour. It helps you choose your agents, permissions and first project.

| Your computer | Download |
|---|---|
| Windows · x64 | [Windows installer](https://github.com/MarlBurroW/sillage/releases/latest/download/Sillage-win-x64.exe) |
| macOS · Apple Silicon | [macOS app](https://github.com/MarlBurroW/sillage/releases/latest/download/Sillage-mac-arm64.dmg) |
| Debian / Ubuntu | [x64 .deb](https://github.com/MarlBurroW/sillage/releases/latest/download/Sillage-linux-amd64.deb) · [arm64 .deb](https://github.com/MarlBurroW/sillage/releases/latest/download/Sillage-linux-arm64.deb) |
| Other Linux | [x64 AppImage](https://github.com/MarlBurroW/sillage/releases/latest/download/Sillage-linux-x86_64.AppImage) · [arm64 AppImage](https://github.com/MarlBurroW/sillage/releases/latest/download/Sillage-linux-arm64.AppImage) |

**First launch:** the app is not yet signed on Windows or notarized on macOS, so
your system may ask you to allow it. Windows also needs Git for Windows; on macOS,
install the Command Line Tools if Git is missing. On Ubuntu, use the `.deb`.
The [desktop guide](docs/desktop.md) walks through these steps and troubleshooting.

### Install the server

**For your phone, tablet and computers.** Install Sillage on a machine that stays
on, then connect through your browser. The first-run tour creates your account
and guides you through setup.

On **Linux with systemd** or **macOS with Apple Silicon**:

```bash
curl -fsSL https://raw.githubusercontent.com/MarlBurroW/sillage/main/install.sh | bash
```

The installer sets up a background service. Use the
[remote access guide](docs/remote-access.md) to connect from other devices through
a private connection or protected HTTPS address.

Prefer another setup? Follow the guides for [Docker](docs/install.md#docker),
[Windows / WSL2](docs/windows.md) or [Kubernetes](deploy/helm/sillage/README.md).
The [server installation guide](docs/install.md) also covers prerequisites,
updates, logs and running from source.

## Your first project

1. **Connect an agent.** Install the CLIs you want from Settings, then sign in with
   your own agent accounts. Existing sign-ins on the host can be reused.
2. **Choose a project folder.** Open an existing repository or create a project,
   then start a conversation with the agent of your choice.
3. **Ask for a useful first step.** Try “Explain how this project is organized” or
   “Help me fix this bug.” Review the files and changes alongside the reply.

Sillage is free and open source. You still need the account, subscription or API
credentials required by each agent you use. [Account setup →](docs/accounts.md)

## Instructions and memory

Set your conventions once and let your agents share what they learn.
**Instructions** hold your rules and preferences; **memory** keeps project
decisions, useful facts and pitfalls across conversations and worktrees.

Manage both in Sillage, or keep project instructions in your existing `AGENTS.md`
or `CLAUDE.md`. [How shared context works →](docs/features.md#instructions-and-memory)

## Go further

| I want to… | Guide |
|---|---|
| Explore all the features | [Feature reference](docs/features.md) |
| Use Sillage and agent preview links from my phone | [Remote access](docs/remote-access.md) |
| Switch between agent accounts | [Accounts](docs/accounts.md) |
| Continue a conversation with another agent | [CLI handoff](docs/cli-handoff.md) |
| Share skills between agents | [Skill library](docs/skill-library.md) |
| Connect my own tools | [MCP](docs/mcp.md) · [Task API](docs/api.md) |
| See and stop processes started by agents on Linux | [Services](docs/services.md) |

## Security model

Sillage is designed for you and people you trust. Agents and terminals run under
the host's system account and can access its files; Sillage accounts do not isolate
users at the operating-system level. Extra agent accounts are selectable only by
the Sillage user who added them, but their files share that same host account.

Desktop stays on your computer, listens on the loopback interface and needs no
Sillage password. Server also listens on loopback by default: use a VPN or a
protected HTTPS reverse proxy for remote access, rather than exposing its port
directly. [Set up remote access →](docs/remote-access.md)

## Built with Sillage

Much of Sillage was built with Claude Code and Codex, from inside Sillage itself.
The project uses TypeScript, React, Fastify, SQLite and Electron.

Want to explore the code? Start with the [development setup](docs/install.md#from-source-development)
and the [specification](docs/SPEC.md) (in French).

<details>
<summary>Repository layout</summary>

```text
apps/web           React interface and PWA
apps/server        API, conversations and agent supervision
apps/desktop       Electron desktop app
packages/protocol  Shared schemas and types
packages/db        Database schema and migrations
deploy/            Docker, Helm and service templates
docs/              Guides and technical references
site/              Public website and screenshots
```

</details>

## Releases

Get the latest apps, server archives and release notes on
[GitHub Releases](https://github.com/MarlBurroW/sillage/releases/latest).
Sillage checks for updates in Settings. Installer-based Server setups can update
from the interface; Docker users pull a newer image, and Desktop users download
the new app.

## License

[MIT](LICENSE). Free to use, modify and self-host.
