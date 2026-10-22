# Install Sillage Server

[Back to the overview](../README.md) · [Looking for the desktop app?](desktop.md)

Choose the setup that fits the machine where your agents will run:

- [Docker](#docker)
- [Linux with systemd](#one-line-script-linux-no-docker)
- [macOS with Apple Silicon](#macos-apple-silicon)
- [Windows with WSL2](#windows-wsl2)
- [Kubernetes with Helm](#kubernetes-helm)
- [From source](#from-source-development)

For access from another device, follow the [remote access guide](remote-access.md).
The server listens on the host’s loopback interface by default; use a VPN or a
protected HTTPS reverse proxy to reach it remotely.

## Docker

The agent CLIs are not in the image: install the ones you use from the UI and
they land in the data volume. Mount your credential directories to reuse the
authentication done on the host, and your projects:

```bash
curl -fsSLO https://raw.githubusercontent.com/MarlBurroW/sillage/main/deploy/docker-compose.example.yml
mv docker-compose.example.yml docker-compose.yml   # then adjust the mounted paths
docker compose up -d
```

Then open Sillage in your browser: with no account yet, it starts on the first-run
tour, which creates the first account (admin) and walks you through agents,
permissions, where instructions and memory live, your general instructions and
remote access, then leads to your first project. Without a browser at hand,
the command line does the same:

```bash
docker compose exec -it sillage node /app/server/cli/user-create.js   # first account, admin
```

Update by pulling a newer image tag. The UI tells you when a release is available
and what changed.

## Kubernetes (Helm)

A chart lives in [`deploy/helm/sillage`](../deploy/helm/sillage), built on the same
image and the same volumes as the Compose setup.

```bash
helm install sillage ./deploy/helm/sillage \
  --namespace sillage --create-namespace \
  --set storage.data.storageClass=<a-block-storage-class> \
  --set ingress.enabled=true --set ingress.host=sillage.example.com
```

Open the ingress host: the first-run tour creates the first account. Or from a
terminal:

```bash
kubectl -n sillage exec -it deploy/sillage -- node /app/server/cli/user-create.js
```

Sillage runs as a single replica with a `Recreate` strategy: the state is a SQLite
database in WAL mode on a `ReadWriteOnce` volume, and two pods writing to it means
corruption. Give the data volume a block storage class rather than NFS, whose file
locks SQLite cannot rely on. Leaving the class empty is not neutral either: when a
cluster has several default StorageClasses, Kubernetes picks the most recent one
without a word.

The [chart README](../deploy/helm/sillage/README.md) covers the rest: ingress and
WebSocket timeouts, egress the pod needs, and what to back up.

## One-line script (Linux, no Docker)

Requires Linux x64/arm64 with systemd. The agent CLIs are optional here too:
Sillage installs the ones you want from the UI, you authenticate them yourself.

```bash
curl -fsSL https://raw.githubusercontent.com/MarlBurroW/sillage/main/install.sh | bash
```

This installs under `~/.local/share/sillage`, sets up a systemd user service and
enables lingering (so the service survives logout). It then checks that the server
actually answers before reporting success. Open Sillage in your browser: the
first-run tour creates the first account and sets the instance up. Later
updates happen from the web UI (Settings > About) or by re-running the script.

Logs go to the journal: `journalctl --user -u sillage -f`.

The service, agents and the dev servers they start included, may use up to 75% of
the RAM before systemd slows it down. To change that, run `systemctl --user edit
sillage` and set `MemoryHigh=` under `[Service]`: the override survives reinstalls.

The service uses the system's Node when it is 22.14 or newer. Otherwise the
installer downloads the current Node LTS under `~/.local/share/sillage/node`, for
Sillage alone, and refreshes it on each run. Any Node from 22.14 up works: every
native module ships as an N-API prebuild, which does not depend on the Node ABI, and
22.14 brings N-API 10, which better-sqlite3 needs.
The installer checks they load and rebuilds them if they do not, which then needs
a compiler (`build-essential` and `python3` on Debian/Ubuntu).

## macOS (Apple Silicon)

The same script installs Sillage Server on Macs with Apple Silicon, as a background
service your other devices can reach. For an app in its own window, see
[the desktop app](../README.md#install-the-desktop-app). Run it from Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/MarlBurroW/sillage/main/install.sh | bash
```

It needs git: if the Command Line Tools are missing, run `xcode-select --install`
first. As on Linux it installs under `~/.local/share/sillage`, fetches Node if the
system has none recent enough, then opens Sillage on port 7317 on the first-run
tour, which creates the first account. The service is a launchd agent: it starts with your session
and keeps running with Terminal closed, but nothing runs while the Mac sleeps.

- Logs: `tail -f ~/.local/share/sillage/logs/sillage.log`. The file is not rotated.
- Stop: `launchctl bootout gui/$(id -u)/io.github.marlburrow.sillage`. Re-running
  the script starts it again.
- Uninstall: stop it, then delete
  `~/Library/LaunchAgents/io.github.marlburrow.sillage.plist` and
  `~/.local/share/sillage`, which holds the database.

The process view (Services) is Linux only.

## Windows (WSL2)

Sillage runs inside WSL2, the Linux built into Windows 10 and 11, and you use it
from your Windows browser. Nothing to install beforehand but WSL itself, not even
Node.

1. In PowerShell, as administrator, install WSL and Ubuntu, then restart Windows
   when asked. Ubuntu opens and asks for a Linux user name and password:

   ```powershell
   wsl --install
   ```

2. In the Ubuntu terminal, run the same installer as on Linux:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/MarlBurroW/sillage/main/install.sh | bash
   ```

   Under WSL it also enables systemd when the distribution lacks it, asks whether
   Sillage should start with Windows, and adds a **Sillage** entry to the Start
   menu. That entry keeps WSL running once the terminal is closed, starts
   Sillage if WSL was stopped, and opens Sillage on port 7317 in the Windows
   browser.

3. Install and sign in to the agents inside Ubuntu: Sillage drives the Linux
   `claude`, `codex`, `opencode` and `grok`, not the Windows ones.

   ```bash
   curl -fsSL https://claude.ai/install.sh | bash && claude
   ```

Keep your projects in the Linux file system (`~/projects`), not under `/mnt/c`:
Windows drives are several times slower for git and the agents. The
[WSL2 guide](windows.md) covers Codex sign-in, how Sillage stays up, everyday
commands, troubleshooting and uninstalling. Tested on Windows 11 with WSL 3.0.1,
Ubuntu 26.04 and 24.04.

## From source (development)

Clone the repository and run these commands from its root.

Requires Node 22.14+ and pnpm 9, plus at least one agent CLI, from the host or
installed from the UI:

```bash
NODE_ENV=development pnpm install
pnpm db:generate          # only after changing packages/db/src/schema.ts
NODE_ENV=development pnpm dev  # API on :7317, Vite UI on :5317 with /api proxy
pnpm user:create          # optional: the first account from a terminal rather than the tour
```

