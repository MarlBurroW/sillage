# Sillage Desktop

Sillage Desktop is the edition for your workstation: an app for macOS (Apple Silicon),
Windows (x64) and Linux (x64 and arm64). It bundles the server of the release and its own Node,
starts them when you open it, and shows the interface in its own window. There is no
server to set up, no account to create and no password.

It is the simplest way to try Sillage, or to use it on the machine where you code.
To follow your agents from a phone or another computer and leave them working,
[Sillage Server](../README.md#install-the-server) is the edition to install
([compare the two](../README.md#server-or-desktop)).

## Download

Every release ships the app next to the server archives:
[latest release](https://github.com/MarlBurroW/sillage/releases/latest).

| System | File |
|---|---|
| macOS, Apple Silicon | `Sillage-<version>-mac-arm64.dmg` (or the `.zip`) |
| Windows | `Sillage-<version>-win-x64.exe` |
| Debian, Ubuntu | `Sillage-<version>-linux-amd64.deb` or `-linux-arm64.deb` |
| Other Linux | `Sillage-<version>-linux-x86_64.AppImage` or `-linux-arm64.AppImage` |

### macOS

Open the `.dmg` and drag Sillage into Applications. The app is not notarized by
Apple yet, so the first launch is refused: open **System Settings > Privacy &
Security** and click **Open Anyway**. From Terminal, this does the same:

```bash
xattr -dr com.apple.quarantine /Applications/Sillage.app
```

Sillage needs git: run `xcode-select --install` first if the Command Line Tools are
missing.

### Windows

Run the `.exe`: it installs Sillage for your user, without administrator rights. The
app is not signed yet, so SmartScreen warns on the first run: click **More info**, then
**Run anyway**.

Sillage needs [Git for Windows](https://git-scm.com/download/win): for git itself, and
for its bash, which runs project actions and the check scripts of scheduled tasks,
written in `sh` syntax. Claude Code needs it on Windows too. Terminals open in
PowerShell (PowerShell 7 when it is installed).

### Linux

On Debian and Ubuntu, prefer the `.deb`:

```bash
sudo apt install ./Sillage-<version>-linux-amd64.deb
```

It pulls in git, and installs an AppArmor profile that Ubuntu 24.04 and later
require before Chromium, which draws the window, may start its sandbox. The AppImage
suits other distributions; on Ubuntu 24.04 and later it does not start without such a
profile.

## Agents

Install Claude Code, Codex, OpenCode or Grok Build the usual way, or from the app,
which brings its own npm. At launch, the app reads the environment of your login
shell (on Windows, your user environment): CLIs installed with Homebrew, npm, nvm or
their own installers are found as they are in your terminal.

The agents use your own sign-ins and settings (`~/.claude`, `~/.codex`, …). A session
started in Sillage can be resumed in the terminal and the other way round; do not
drive the same session from both at once. Claude's automatic memory is the
exception: in Sillage it lives in the project memory that every CLI shares, separate
from the one Claude keeps when used alone.

## What differs from Sillage Server

- **No sign-in.** The app opens your session when it starts. Its server listens on
  `127.0.0.1` and serves only the app's window: no other page on the machine, opened
  in your browser or served by another program, can use your session.
- **A shorter first-run tour.** The first launch opens the same guided setup as the
  server edition, minus what has no meaning here: no account to create, no team or
  phone question, no public address, no push notifications. It starts at Welcome and
  runs through appearance, agents, permissions and instructions, then leads to
  your first project.
  Replay it from Settings › About.
- **Your data stays with the app**, in `~/Library/Application Support/Sillage` on
  macOS, `%LOCALAPPDATA%\Sillage` on Windows and `~/.config/Sillage` on Linux:
  projects, conversations and settings in `data/`, the server log in
  `logs/server.log`. A server install on the same machine keeps its own data and port.
- **Agents run while the app runs.** On macOS, closing the window leaves the app and
  its sessions running; quit with ⌘Q. On Windows and Linux, closing the last window
  quits. Nothing runs while the computer sleeps, and a scheduled task that came due
  during sleep runs once on wake.
- **Updates.** The app tells you when a release is out (Settings > About). Download
  the new version and replace the app; there is no automatic update yet.
- **Not available:** access from other devices, push notifications, and webhook
  automations triggered from the Internet, which need a public address (the test
  bench still works). Settings hide the password, logout, push notifications and
  user accounts. The process view (Services) stays Linux only.

## Uninstall

- **macOS:** quit Sillage, then delete `/Applications/Sillage.app` and
  `~/Library/Application Support/Sillage`.
- **Windows:** uninstall Sillage from Settings > Apps, then delete
  `%LOCALAPPDATA%\Sillage`.
- **Linux:** `sudo apt remove sillage`, or delete the AppImage, then delete
  `~/.config/Sillage`.

## Building it

The [`Desktop` workflow](../.github/workflows/desktop.yml) is the reference recipe:
it assembles the release runtime (`.github/actions/runtime-archive`), adds the Node
that built it (`scripts/desktop-stage.mjs`), then packages with electron-builder in
`apps/desktop`. `pnpm test:desktop-ui` launches the packaged app and checks it: the
server answers, the window opens without sign-in, other origins are refused, and
quitting stops the server. On Linux it needs a display, for example `xvfb-run`.
