<img src="docs/brand/wordmark.svg" alt="Sillage" width="340" height="72">

[![Latest release](https://img.shields.io/github/v/release/MarlBurroW/sillage)](https://github.com/MarlBurroW/sillage/releases/latest)
[![CI](https://github.com/MarlBurroW/sillage/actions/workflows/ci.yml/badge.svg)](https://github.com/MarlBurroW/sillage/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A self-hosted, mobile-first web UI that drives the native Claude Code and Codex
CLIs on your own machine. Vibe-code from anywhere: the official agent harnesses,
without the terminal.

Website: [marlburrow.github.io/sillage](https://marlburrow.github.io/sillage)

## Why

Coding agents work best inside their official harness: the prompts, tools and
permission flows their vendors ship with the CLI. But a terminal is a poor fit for
a phone. Sillage keeps the CLIs and replaces the terminal with a web UI: streaming
chat, tool calls, interactive permissions, full-text search, an IDE panel (file
explorer, editor, diffs, terminals) and an installable PWA with push notifications.

The full specification lives in [docs/SPEC.md](docs/SPEC.md) (French).

## Install

### Docker

The agent CLIs are not in the image: install the ones you use from the UI and
they land in the data volume. Mount your credential directories to reuse the
authentication done on the host, and your projects:

```bash
curl -fsSLO https://raw.githubusercontent.com/MarlBurroW/sillage/main/deploy/docker-compose.example.yml
mv docker-compose.example.yml docker-compose.yml   # then adjust the mounted paths
docker compose up -d
docker compose exec -it sillage node /app/server/cli/user-create.js   # first account, admin
```

Update by pulling a newer image tag. The UI tells you when a release is available
and what changed.

### One-line script (Linux, no Docker)

Requires Linux x64/arm64, systemd and Node.js 22+, with `claude` and `codex`
installed and authenticated on the host:

```bash
curl -fsSL https://raw.githubusercontent.com/MarlBurroW/sillage/main/install.sh | bash
```

This installs under `~/.local/share/sillage`, sets up a systemd user service and
creates the first account. Later updates happen from the web UI (Settings > About)
or by re-running the script. Remember `loginctl enable-linger $USER` so the
service survives logout.

### From source (development)

Requires Node 22+, pnpm 9, and the `claude` / `codex` CLIs on the host:

```bash
pnpm install
pnpm db:generate          # only after changing packages/db/src/schema.ts
pnpm user:create          # first account, admin
pnpm dev                  # API on :7317, Vite UI on :5317 with /api proxy
```

## Security model

Sillage is built for a trusted circle, not for public exposure:

- Agents run under your system account, with your Claude and Codex credentials.
  Every account on the instance shares your subscriptions.
- Terminal mode gives a full shell under that same account.
- There is no system-level isolation between users: a shared project is readable
  by every account.

The server listens on `127.0.0.1` by default and does not terminate TLS. To reach
it remotely, go through a reverse proxy (Caddy) or a tunnel (Tailscale, Cloudflare
Tunnel). Never expose it directly to the Internet.

## Releases

Releases are git tags (`vX.Y.Z`). Each tag builds Linux tarballs (x64 and arm64,
prebuilt native modules included), a multi-arch Docker image on
`ghcr.io/marlburrow/sillage`, and a GitHub release with generated notes. The app
shows the installed version, checks for newer releases, and on installer-based
setups can update itself from the UI.

## Repository layout

```
apps/server       Fastify daemon: API, WebSocket, CLI supervision
apps/web          React UI, PWA
packages/protocol shared event schema and types
packages/db       Drizzle schema and migrations
deploy/           systemd unit template, config example, docker-compose example
site/             one-page website (GitHub Pages)
docs/brand/       the brand and the files derived from it
```

## License

MIT, see [LICENSE](LICENSE).
