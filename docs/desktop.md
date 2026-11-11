# Sillage Desktop

Sillage Desktop is the edition for your workstation: an app for macOS (Apple Silicon),
Windows (x64) and Linux (x64 and arm64). It bundles the server of the release and its own Node,
starts them when you open it, and shows the interface in its own window: the window
opens at once on a startup page while the server boots. There is no server to set up,
no account to create and no password.

It is the simplest way to try Sillage, or to use it on the machine where you code.
To follow your agents from a phone or another computer and leave them working,
[Sillage Server](../README.md#install-the-server) is the edition to install
([compare the two](../README.md#server-or-desktop)).

## Window controls

The draggable window header follows the application's theme. Windows and Linux keep
their native minimize, maximize and close buttons; the menu button opens application
commands, and keyboard shortcuts remain available. On macOS, the traffic lights sit
at the left of the header and the application menu stays in the system menu bar.

## Download

Every release ships the app next to the server archives. Each link downloads the
package of the [latest release](https://github.com/MarlBurroW/sillage/releases/latest)
directly:

| System | Package |
|---|---|
| macOS, Apple Silicon | [Sillage-mac-arm64.dmg](https://github.com/MarlBurroW/sillage/releases/latest/download/Sillage-mac-arm64.dmg) (or the [`.zip`](https://github.com/MarlBurroW/sillage/releases/latest/download/Sillage-mac-arm64.zip)) |
| Windows | [Sillage-win-x64.exe](https://github.com/MarlBurroW/sillage/releases/latest/download/Sillage-win-x64.exe) |
| Debian, Ubuntu | [x64 `.deb`](https://github.com/MarlBurroW/sillage/releases/latest/download/Sillage-linux-amd64.deb) or [arm64 `.deb`](https://github.com/MarlBurroW/sillage/releases/latest/download/Sillage-linux-arm64.deb) |
| Other Linux | [x64 AppImage](https://github.com/MarlBurroW/sillage/releases/latest/download/Sillage-linux-x86_64.AppImage) or [arm64 AppImage](https://github.com/MarlBurroW/sillage/releases/latest/download/Sillage-linux-arm64.AppImage) |

### macOS

Open the `.dmg` and drag Sillage into Applications, and keep it there: that is where
it can update itself. The app is not notarized by Apple yet, so the first launch is
refused: open **System Settings > Privacy &
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
sudo apt install ./Sillage-linux-amd64.deb
```

It pulls in git, and installs an AppArmor profile that Ubuntu 24.04 and later
require before Chromium, which draws the window, may start its sandbox. The AppImage
suits other distributions; on Ubuntu 24.04 and later it does not start without such a
profile.

## Agents

Install Claude Code, Codex, OpenCode, Grok Build or Google Antigravity from the app,
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
  quits. Quitting ends the sessions and stops the server first, which can take a few
  seconds with nothing on screen: opening Sillage again meanwhile brings it back.
  Nothing runs while the computer sleeps, and a scheduled task that came due
  during sleep runs once on wake.
- **Updates** are downloaded by the app itself: see [below](#updates).
- **Other devices reach it through Tailscale only**: see [Remote access](#remote-access).
- **Not available:** push notifications, and webhook automations triggered from the
  Internet, which need a public address (the test bench still works). Settings hide
  the password, logout, push notifications and user accounts. The process view
  (Services) stays Linux only.

## Remote access

Sillage Desktop can open itself to your phone and your other computers through
[Tailscale](https://tailscale.com), the private network between your own devices that
the [remote access guide](remote-access.md) recommends for the server edition. Nothing
is opened on your router and nobody outside your tailnet can see the instance.

Install Tailscale on this machine and on the devices, sign them into the same
tailnet, then turn on **Settings › Remote access**. Sillage keeps listening on
`127.0.0.1` and asks Tailscale Serve to forward the machine's HTTPS address
(`https://<machine>.<tailnet>.ts.net`) to it. The page shows that address and a QR
code to scan.

There is nothing to approve afterwards. Serve tells Sillage which Tailscale account
each connection comes from, and Sillage accepts only the account that owns the
machine: a device signed into that account is signed into Sillage at once, with no
password. Anyone else on the tailnet, and any visitor through Funnel (which would
publish the address to the Internet), is refused.

While remote access is on, the app keeps the machine from sleeping; the screen may
still turn off. Quitting Sillage ends the access, and the next launch restores the
Serve mapping if the port changed.

When Tailscale will not let Sillage configure Serve itself (on Linux, Serve needs
`sudo` unless your account is Tailscale's
[operator](https://tailscale.com/kb/1080/cli#tailscale-set)), the page prints the
command to run once; access is enabled all the same. HTTPS certificates must be
enabled on the tailnet, and a machine shared as a tagged node has no owner account
to recognise.

## Updates

The app updates itself from the GitHub releases. It checks when it starts, then every
four hours, and downloads a new version in the background; Settings > About shows the
download, then the version that is ready. Click **Restart and update** there to install
it: Sillage closes, installs the new version and reopens. On macOS and with the
AppImage, a version that is ready is also installed when you quit Sillage. Running
conversations are interrupted and resume with the next message. Your data stays where
it is.

- **Windows:** a version that is ready is installed from About only, never when you
  quit: the installer works for a while, and behind a closed app it showed nothing,
  while a Sillage reopened meanwhile found itself half replaced. From About, the
  installer window shows the progress as Sillage closes, then Sillage reopens.
  Before handing over, the app stops anything still running from its own folder, such
  as a CLI or MCP server its server started under the bundled Node: the installer
  cannot replace files they hold. If something cannot be stopped, About names it and
  the update waits for another try.

  The installer you run yourself over an installation frees the folder the same way: it
  asks before closing an open Sillage, waits for one that is quitting, and stops what
  a closed one left running, instead of asking you to close an application you cannot
  see. It notes what it had to stop in `logs/installer.log`.

  Should Sillage fail to start, it tries once more by itself, then says why and offers
  to try again or to download the installer: running it replaces the installation and
  keeps your data.
- **macOS:** Sillage replaces its own app in the Applications folder. Run from the disk
  image, or from a folder where macOS isolates it, it cannot, and About says so. Should
  macOS refuse the replacement, About tells you to allow Sillage under System Settings >
  Privacy & Security > App Management.
- **Linux:** the AppImage is replaced in place. The `.deb` is installed only when you
  click **Restart and update**, since it asks for your administrator password.

Versions through 0.24.2 do not include the updater: install the first release that
includes it manually once. The updater keeps its log in `logs/updater.log`, next to the server's.

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

`scripts/desktop-update-check.mjs` checks the update end to end: an installed version
finds a newer one in a folder served over HTTP (`SILLAGE_DESKTOP_UPDATE_FEED`), downloads
it, then replaces and relaunches itself. On Windows it then runs the new installer by
hand, over the open app and over a process left running from its folder. The workflow
runs it with `update-check`, on two versions it packages for the purpose; the CI does so
on Linux and Windows.

The Windows installer is electron-builder's, with our own check for what still runs from
the installation folder (`apps/desktop/resources/installer.nsh`, which says why).

`pnpm test:desktop-updates-ui` checks About in both editions at desktop and phone
widths with deterministic update states (build the web app first).
`pnpm test:desktop-mac-install` checks bundle replacement and rollback with injected
rename failures on a Unix host; it also runs shellcheck on the installer script.
