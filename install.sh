#!/usr/bin/env bash
#
# Sillage installer for Linux (x64 / arm64) with systemd, WSL2 on Windows included, and
# for macOS on Apple Silicon with launchd.
#
#   curl -fsSL https://raw.githubusercontent.com/MarlBurroW/sillage/main/install.sh | bash
#
# Idempotent: run it again to update to the latest release. Pin a version with
# SILLAGE_VERSION=1.2.3, or install an archive already on disk (a CI build) with
# SILLAGE_ARCHIVE=path/to/sillage-*.tar.gz. Everything lives under ~/.local/share/sillage;
# the application itself under app/releases/<version> with an atomic `current` symlink,
# which is also what the in-app updater manages.
#
# Without Node.js 22+ on the PATH, a private Node LTS goes to ~/.local/share/sillage/node,
# used by the service alone. Under WSL2 the script also enables systemd if needed and
# adds a "Sillage" Start menu entry plus a sign-in entry that keeps WSL running
# (SILLAGE_WSL_AUTOSTART=yes|no answers that question in advance). On macOS the service
# is a launchd agent rather than a systemd unit, and logs to a file under logs/.

# One block, so that bash reads the whole script before running any of it. Under
# `curl | bash` it would otherwise read as it goes: a command reading stdin (a Windows
# program started through WSL interop does) would swallow the rest of the script, and a
# truncated download would run half an installer.
{

set -euo pipefail

REPO="MarlBurroW/sillage"
DATA_DIR="${SILLAGE_DATA_DIR:-$HOME/.local/share/sillage}"
APP_DIR="$DATA_DIR/app"
NODE_DIR="$DATA_DIR/node"
UNIT_DIR="$HOME/.config/systemd/user"
# Major version of the private Node, the active LTS line.
NODE_LINE=24

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Prompts read the terminal, not stdin: under `curl | bash`, stdin is the script itself.
# `-e /dev/tty` is not enough: the node exists even when no terminal is attached.
has_tty() { ( : </dev/tty ) 2>/dev/null; }

# ask QUESTION DEFAULT — DEFAULT (yes|no) also answers when there is no terminal.
ask() {
  local reply=""
  has_tty || { [ "$2" = "yes" ]; return; }
  printf '\033[1;36m==>\033[0m %s ' "$1" >/dev/tty
  read -r reply </dev/tty || true
  case "${reply:-$2}" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- preflight ---------------------------------------------------------------

case "$(uname -s)" in
  Linux)  PLATFORM="linux" ;;
  Darwin) PLATFORM="darwin" ;;
  *) fail "unsupported system: $(uname -s) (Linux, WSL2 and macOS only)." ;;
esac

case "$PLATFORM-$(uname -m)" in
  linux-x86_64)  ARCH="x64" ;;
  linux-aarch64) ARCH="arm64" ;;
  darwin-arm64)  ARCH="arm64" ;;
  # A terminal running under Rosetta reports x86_64 on Apple Silicon too: ask the hardware.
  darwin-x86_64)
    [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ] \
      || fail "Intel Macs are not supported: Sillage for macOS needs Apple Silicon."
    ARCH="arm64" ;;
  *) fail "unsupported architecture: $(uname -m) (x86_64 and aarch64 on Linux, Apple Silicon on macOS)" ;;
esac

# WSL sets WSL_DISTRO_NAME in every shell it starts; the kernel name tells WSL 1, which
# translates system calls and has no systemd, from WSL 2, which runs a real kernel.
IS_WSL="no"
if [ "$PLATFORM" = "linux" ] && { [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; }; then
  IS_WSL="yes"
  case "$(cat /proc/sys/kernel/osrelease)" in
    *WSL2*|*microsoft-standard*) ;;
    *) fail "WSL 1 is not supported. Convert the distribution from PowerShell, then run this again:
  wsl --set-version ${WSL_DISTRO_NAME:-<distribution>} 2" ;;
  esac
fi

# Under WSL the Windows PATH is appended to the Linux one: a `claude` or `node` found on
# a Windows drive is a Windows program, unusable by a Linux service.
host_command() {
  local found
  found="$(command -v "$1" 2>/dev/null)" || return 1
  [ "$IS_WSL" = "yes" ] && case "$found" in /mnt/*) return 1 ;; esac
  printf '%s\n' "$found"
}

apt_hint() { command -v apt-get >/dev/null && printf ' (sudo apt install %s)' "$1"; }

command -v curl >/dev/null || fail "curl is required$(apt_hint curl)."
command -v tar  >/dev/null || fail "tar is required$(apt_hint tar)."
if [ "$PLATFORM" = "darwin" ]; then
  # /usr/bin/git exists on every Mac, but only as a stub until the Command Line Tools are
  # installed: run it rather than look for it.
  git --version >/dev/null 2>&1 || fail "git is required, Sillage drives git repositories.
  Install the Command Line Tools (xcode-select --install) and run this script again."
else
  command -v git >/dev/null || fail "git is required, Sillage drives git repositories$(apt_hint git)."
fi

# sha256_check — checks the `<sum>  <file>` lines on stdin. macOS has shasum only.
sha256_check() {
  if command -v sha256sum >/dev/null; then sha256sum -c --status -; else shasum -a 256 -c --status -; fi
}

# swap_link TARGET LINK — points LINK at TARGET atomically, by a rename over the old link,
# never a bare `ln` in place. GNU mv needs -T and BSD mv -h: without them, both move the
# new link *into* the directory the old one points to, and leave the old one as it was.
swap_link() {
  ln -sfn "$1" "$2.tmp"
  if [ "$PLATFORM" = "darwin" ]; then mv -fh "$2.tmp" "$2"; else mv -T "$2.tmp" "$2"; fi
}

# WSL distributions installed before 2023, or imported from a tarball, may still boot
# without systemd. Enabling it is one line in /etc/wsl.conf and a WSL restart, which
# cannot happen from inside the distribution being restarted.
if [ "$IS_WSL" = "yes" ] && [ "$(cat /proc/1/comm 2>/dev/null)" != "systemd" ]; then
  RESTART_HINT="restart WSL (in PowerShell: wsl --shutdown), reopen your distribution
  and run this installer again."
  ask "systemd is off in this WSL distribution and Sillage runs as a systemd service. Enable it in /etc/wsl.conf (uses sudo)? [Y/n]" yes \
    || fail "add these two lines to /etc/wsl.conf:
  [boot]
  systemd=true
  then $RESTART_HINT"
  # Only the systemd key changes: the rest of wsl.conf stays as it was.
  if [ -f /etc/wsl.conf ] && grep -qE '^[[:space:]]*systemd[[:space:]]*=' /etc/wsl.conf; then
    sudo sed -i -E 's/^[[:space:]]*systemd[[:space:]]*=.*/systemd=true/' /etc/wsl.conf
  elif [ -f /etc/wsl.conf ] && grep -qE '^[[:space:]]*\[boot\]' /etc/wsl.conf; then
    sudo sed -i -E '/^[[:space:]]*\[boot\]/a systemd=true' /etc/wsl.conf
  else
    printf '\n[boot]\nsystemd=true\n' | sudo tee -a /etc/wsl.conf >/dev/null
  fi
  say "systemd enabled in /etc/wsl.conf. Now $RESTART_HINT"
  exit 1
fi

if [ "$PLATFORM" = "linux" ]; then
  systemctl --user show-environment >/dev/null 2>&1 \
    || fail "systemd user session unreachable. Log in as a regular user (not su/sudo) and retry."
fi

# --- Node.js -----------------------------------------------------------------

# usable_node NODE — Node 22+ with N-API 10, built for this machine. better-sqlite3 needs
# N-API 10, which came with Node 22.14: an older 22 loads it, then crashes on the first
# query. On a Mac migrated from Intel, an x64 Node left in /usr/local runs under Rosetta
# and cannot load arm64 native modules.
usable_node() {
  "$1" -e 'const v = process.versions
    process.exit(v.node.split(".")[0] >= 22 && v.napi >= 10 && process.arch === process.argv[1] ? 0 : 1)' \
    "$ARCH" 2>/dev/null
}

# The latest release of NODE_LINE, unpacked under NODE_DIR/<version> behind a `current`
# symlink, so that the service keeps one path across Node updates. Checked against the
# SHASUMS256 file published next to the archives.
install_private_node() {
  local base="https://nodejs.org/dist/latest-v$NODE_LINE.x" sums file version
  sums="$(curl -fsSL "$base/SHASUMS256.txt")" || return 1
  file="$(printf '%s\n' "$sums" | grep -oE "node-v[0-9.]+-$PLATFORM-$ARCH\.tar\.gz" | head -1)"
  [ -n "$file" ] || return 1
  version="${file#node-}"
  version="${version%%-"$PLATFORM"-*}"

  if [ ! -x "$NODE_DIR/$version/bin/node" ]; then
    say "Downloading Node.js $version, for Sillage only (nothing changes system-wide)…"
    curl -fL --progress-bar -o "$TMP/$file" "$base/$file" || return 1
    printf '%s\n' "$sums" | grep "  $file\$" | (cd "$TMP" && sha256_check) \
      || fail "Node.js archive checksum mismatch: $base/$file"
    rm -rf "$NODE_DIR/.staging"
    mkdir -p "$NODE_DIR/.staging"
    tar -xzf "$TMP/$file" --strip-components=1 -C "$NODE_DIR/.staging"
    mv "$NODE_DIR/.staging" "$NODE_DIR/$version"
  fi
  swap_link "$version" "$NODE_DIR/current"
  # The running service keeps its binary open; once restarted, older versions are unused.
  find "$NODE_DIR" -mindepth 1 -maxdepth 1 -name 'v*' ! -name "$version" -exec rm -rf {} +
}

# A Node 22+ already on the PATH wins: it is what the user maintains. Otherwise the
# private copy, refreshed to the latest patch of its line on every run.
NODE_BIN=""
if SYSTEM_NODE="$(host_command node)" && usable_node "$SYSTEM_NODE"; then
  NODE_BIN="$SYSTEM_NODE"
else
  if [ -n "$SYSTEM_NODE" ]; then
    say "note: $SYSTEM_NODE ($("$SYSTEM_NODE" -v 2>/dev/null || echo '?')) is older than 22.14 or not built for $ARCH. Sillage gets its own Node."
  fi
  if ! install_private_node; then
    [ -x "$NODE_DIR/current/bin/node" ] \
      || fail "Node.js >= 22.14 is required and could not be downloaded from nodejs.org.
  Install it yourself (https://nodejs.org, or fnm/nvm) and run this script again."
    say "warning: could not check nodejs.org for a newer Node.js; keeping $("$NODE_DIR/current/bin/node" -v)."
  fi
  NODE_BIN="$NODE_DIR/current/bin/node"
  # node, npm and npx of the private copy for the rest of this script.
  export PATH="$NODE_DIR/current/bin:$PATH"
fi

host_command claude >/dev/null || say "note: 'claude' CLI not found on PATH. Sillage can install it for you from the web interface; you will still need to authenticate it."
host_command codex  >/dev/null || say "note: 'codex' CLI not found on PATH. Sillage can install it for you from the web interface; you will still need to authenticate it."
host_command opencode >/dev/null || [ -x "$HOME/.opencode/bin/opencode" ] || say "note: 'opencode' CLI not found. Sillage can install it for you from the web interface; its free models need no account."

# --- resolve version ---------------------------------------------------------

if [ -n "${SILLAGE_ARCHIVE:-}" ]; then
  [ -f "$SILLAGE_ARCHIVE" ] || fail "archive not found: $SILLAGE_ARCHIVE"
  # The version the archive was built as, a CI build included: it names the release
  # directory, and tells the in-app updater whether a release is newer.
  VERSION="$(tar -xzOf "$SILLAGE_ARCHIVE" sillage/VERSION 2>/dev/null)" && [ -n "$VERSION" ] \
    || fail "not a Sillage archive (no sillage/VERSION inside): $SILLAGE_ARCHIVE"
elif [ -n "${SILLAGE_VERSION:-}" ]; then
  VERSION="${SILLAGE_VERSION#v}"
else
  say "Resolving latest release…"
  VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | grep -m1 '"tag_name"' | sed -E 's/.*"v?([^"]+)".*/\1/')"
  [ -n "$VERSION" ] || fail "could not resolve the latest release from GitHub."
fi

RELEASE_DIR="$APP_DIR/releases/v$VERSION"

if [ -f "$APP_DIR/current/VERSION" ] && [ "$(cat "$APP_DIR/current/VERSION")" = "$VERSION" ]; then
  say "Sillage $VERSION is already installed."
else
  # --- download & unpack -----------------------------------------------------

  if [ -n "${SILLAGE_ARCHIVE:-}" ]; then
    cp "$SILLAGE_ARCHIVE" "$TMP/sillage.tar.gz"
  else
    TARBALL_URL="https://github.com/$REPO/releases/download/v$VERSION/sillage-v$VERSION-$PLATFORM-$ARCH.tar.gz"

    say "Downloading Sillage $VERSION ($PLATFORM-$ARCH)…"
    # A 404 is worth its own message: releases older than macOS support have no archive
    # for it, and "download failed" would send the user looking for a network problem.
    HTTP_CODE="$(curl -L --progress-bar -o "$TMP/sillage.tar.gz" -w '%{http_code}' "$TARBALL_URL")" || HTTP_CODE=""
    case "$HTTP_CODE" in
      200) ;;
      404) fail "release v$VERSION has no $PLATFORM-$ARCH archive: $TARBALL_URL" ;;
      *)   fail "download failed: $TARBALL_URL" ;;
    esac
  fi

  say "Unpacking…"
  mkdir -p "$APP_DIR/releases"
  rm -rf "$RELEASE_DIR" "$APP_DIR/releases/.staging"
  mkdir -p "$APP_DIR/releases/.staging"
  tar -xzf "$TMP/sillage.tar.gz" --strip-components=1 -C "$APP_DIR/releases/.staging"
  mv "$APP_DIR/releases/.staging" "$RELEASE_DIR"

  swap_link "releases/v$VERSION" "$APP_DIR/current"
  say "Version $VERSION activated."

  # Keep the three most recent releases, the active one always: a pinned SILLAGE_VERSION
  # may be older than the rest. Numeric sort on each field rather than GNU `sort -V`, and
  # `tail -n +4` rather than `head -n -3`, which BSD head lacks. Like the in-app updater,
  # only vX.Y.Z directories are counted: a CI build stays until removed by hand. grep
  # finding none must not end the script under `set -e -o pipefail`.
  (cd "$APP_DIR/releases" && printf '%s\n' v*) | { grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true; } \
    | sort -t. -k1.2,1nr -k2,2nr -k3,3nr | tail -n +4 \
    | while read -r OLD; do
        [ "$OLD" = "v$VERSION" ] || rm -rf "${APP_DIR:?}/releases/$OLD"
      done
fi

# --- native modules ----------------------------------------------------------

# Every native module in the tree is N-API — stable across Node versions — so the
# shipped binaries should load anywhere. Should: a truncated download or a platform the
# prebuild does not cover still yields a module that will not load, and the failure mode
# is a service that starts, dies, and gets restarted forever. Catching it here costs a
# second; discovering it afterwards costs a debugging session. A query, not just a
# require: a Node short of the N-API version the module needs loads it, then crashes on
# the first call.
sqlite_loads() {
  (cd "$APP_DIR/current" && node -e 'require("better-sqlite3")(":memory:").prepare("select 1").get()') 2>&1
}

if ! ERR="$(sqlite_loads)"; then
  say "better-sqlite3 does not load under $(node -v); rebuilding from source…"
  command -v npm >/dev/null || fail "npm is required to rebuild better-sqlite3. Detail: $ERR"
  # Sources travel inside the archive (binding.gyp, deps/, src/): the rebuild downloads
  # nothing, but it does need a toolchain.
  if ! (cd "$APP_DIR/current" && npm rebuild better-sqlite3 >/dev/null 2>&1); then
    if [ "$PLATFORM" = "darwin" ]; then TOOLCHAIN_HINT="macOS: xcode-select --install"
    else TOOLCHAIN_HINT="Debian/Ubuntu: sudo apt install build-essential python3"; fi
    fail "could not rebuild better-sqlite3.
  Install a toolchain ($TOOLCHAIN_HINT) and run this script again.
  Original error: $ERR"
  fi
  ERR="$(sqlite_loads)" || fail "better-sqlite3 still unusable after the rebuild: $ERR"
  say "better-sqlite3 rebuilt."
fi

# --- service -----------------------------------------------------------------

render_service() {
  sed -e "s|__NODE__|$NODE_BIN|g" \
      -e "s|__NODE_DIR__|$(dirname "$NODE_BIN")|g" \
      -e "s|__INSTALL_DIR__|$APP_DIR|g" \
      -e "s|__DATA_DIR__|$DATA_DIR|g" \
      -e "s|__HOME__|$HOME|g" \
      -e "s|__SHELL__|${SERVICE_SHELL:-}|g" \
      -e "s|__LANG__|${SERVICE_LANG:-}|g" \
      "$APP_DIR/current/deploy/$1"
}

if [ "$PLATFORM" = "darwin" ]; then
  # A launchd agent of the login session: it starts when the user logs in and keeps
  # running with every Terminal window closed. No lingering to enable, but nothing runs
  # while the Mac sleeps.
  LABEL="io.github.marlburrow.sillage"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  DOMAIN="gui/$(id -u)"
  LOG_FILE="$DATA_DIR/logs/sillage.log"
  # launchd sets neither a shell nor a locale for the terminals Sillage opens: those of
  # the installer's session, the locale if UTF-8, are the user's choice.
  SERVICE_SHELL="${SHELL:-/bin/zsh}"
  case "${LANG:-}" in *UTF-8*|*utf8*) SERVICE_LANG="$LANG" ;; *) SERVICE_LANG="en_US.UTF-8" ;; esac

  mkdir -p "$HOME/Library/LaunchAgents" "$DATA_DIR/logs"
  render_service sillage.plist.tmpl > "$PLIST"

  say "Starting the service…"
  # bootout then bootstrap, for launchd to reread the plist: kickstart would restart the
  # job as first loaded. bootout can return before the old process is gone, and a
  # bootstrap that comes too soon fails with "Input/output error": retry for a while.
  # `enable` lifts a `launchctl disable` that would otherwise refuse the bootstrap.
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
  LOADED="no"
  for _ in $(seq 20); do
    if launchctl bootstrap "$DOMAIN" "$PLIST" 2>"$TMP/launchctl.err"; then
      LOADED="yes"
      break
    fi
    sleep 1
  done
  [ "$LOADED" = "yes" ] || fail "launchd refused the Sillage agent: $(cat "$TMP/launchctl.err")
  Over SSH, someone must be logged in to the Mac's desktop: the agent runs in that session."
else
  mkdir -p "$UNIT_DIR"
  render_service sillage.service.tmpl > "$UNIT_DIR/sillage.service"

  say "Starting the service…"
  systemctl --user daemon-reload
  systemctl --user enable --now sillage.service
  # enable --now is a no-op when already running: restart to pick up the new version.
  systemctl --user restart sillage.service
fi

# Without lingering, systemd stops user services when the last session closes: on a
# remote box Sillage would go down on every SSH logout. Enable it rather than suggest
# it — one more line in the installer output protects nobody. Recent systemd lets a user
# enable it for their own account without root.
#
# Under WSL it also starts Sillage as soon as the distribution boots, whoever boots it,
# and a WSL user has a sudo password but no reason to have it cached: ask for it there.
SUDO_LINGER=(sudo -n)
if [ "$IS_WSL" = "yes" ] && has_tty; then SUDO_LINGER=(sudo); fi
if [ "$PLATFORM" = "linux" ] && ! loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes'; then
  say "Enabling lingering so Sillage survives logout…"
  loginctl enable-linger "$USER" 2>/dev/null \
    || "${SUDO_LINGER[@]}" loginctl enable-linger "$USER" 2>/dev/null \
    || say "warning: could not enable lingering. Sillage will stop when you log out.
    Run it yourself:  sudo loginctl enable-linger $USER"
fi

# --- final checks ------------------------------------------------------------

# `Done.` only means something once checked. The installer used to announce success
# while the service was crash-looping and no account existed: two failures, no signal.

# Follow the configured port when there is one; 7317 otherwise.
PORT=7317
CONFIG_FILE="${SILLAGE_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/sillage/config.toml}"
if [ -f "$CONFIG_FILE" ]; then
  CONFIGURED_PORT="$(sed -nE 's/^[[:space:]]*port[[:space:]]*=[[:space:]]*([0-9]+).*/\1/p' "$CONFIG_FILE" | head -1)"
  if [ -n "$CONFIGURED_PORT" ]; then PORT="$CONFIGURED_PORT"; fi
fi

# Startup opens the database and replays migrations: give it a few seconds before
# calling it a failure, or a slow machine reports a false negative.
# Braces before a non-ASCII character: in a UTF-8 locale, macOS's bash 3.2 takes the "…"
# for the end of the variable name, and stops on an unbound variable.
say "Checking that Sillage answers on port ${PORT}…"
HEALTHY="no"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fs -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/health"; then
    HEALTHY="yes"
    break
  fi
  sleep 1
done

if [ "$HEALTHY" != "yes" ]; then
  printf '\033[1;31merror:\033[0m %s\n' "Sillage does not answer on http://127.0.0.1:$PORT." >&2
  say "Service state:"
  if [ "$PLATFORM" = "darwin" ]; then
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null \
      | grep -E '^[[:space:]]*(state|pid|runs|last exit code) =' || true
    say "Application log:  tail -n 50 $LOG_FILE"
  else
    systemctl --user --no-pager --lines=0 status sillage.service || true
    say "Application log:  journalctl --user -u sillage -n 50 --no-pager"
  fi
  exit 1
fi

# --- first account -----------------------------------------------------------

# Without an account the instance is unreachable: no default password, no signup route.
# Asked once the server answers, so that its migrations have run, and whenever the
# database holds no account, not only on a first install: an earlier run may have died
# after the service created the database. A failure here must be visible, never
# swallowed by a `|| true`.
# The service's Node, which may be the private copy: `node` alone is not always on the PATH.
ACCOUNT_HINT="$NODE_BIN $APP_DIR/current/server/cli/user-create.js"

# Read the database rather than assume the CLI succeeded. `require` resolves from the
# current directory: run elsewhere it fails, and the count would be "?" on a perfectly
# readable database.
user_count() {
  (cd "$APP_DIR/current" && node -e 'try {
    const db = require("better-sqlite3")(process.argv[1], { readonly: true, fileMustExist: true })
    process.stdout.write(String(db.prepare("select count(*) as c from users").get().c))
  } catch { process.stdout.write("?") }' "$DATA_DIR/sillage.db" 2>/dev/null) || echo '?'
}

ACCOUNT_CREATED="no"
if [ "$(user_count)" = "0" ]; then
  # curl | bash leaves no stdin: the account prompt needs a real terminal.
  if has_tty; then
    say "Create the first account (it gets admin rights):"
    if node "$APP_DIR/current/server/cli/user-create.js" < /dev/tty; then
      ACCOUNT_CREATED="yes"
    else
      say "warning: account creation failed."
    fi
  fi
  # A missing account breaks nothing visible: the server answers, but nobody gets in.
  if [ "$(user_count)" = "0" ]; then
    say "warning: no account exists — the UI will refuse every login."
    say "  Create one with:  $ACCOUNT_HINT"
  fi
fi

# --- Windows integration (WSL) -----------------------------------------------

# WSL stops a distribution about 15 seconds after the last process started from Windows
# exits, systemd services included: closing the terminal would take Sillage down with
# it. A keeper started from Windows holds the distribution open. Two shortcuts start it:
# one in the Startup folder (at Windows sign-in), one in the Start menu that also opens
# Sillage in the browser.

# Windows programs go through WSL interop. They are normally on the PATH, but
# `[interop] appendWindowsPath=false` removes them: fall back to their usual location.
win_exe() {
  local found
  found="$(command -v "$1" 2>/dev/null)" && { printf '%s\n' "$found"; return; }
  for found in "/mnt/c/Windows/System32/$1" "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/$1" "/mnt/c/Windows/$1"; do
    [ -x "$found" ] && { printf '%s\n' "$found"; return; }
  done
  return 1
}

# -EncodedCommand (UTF-16LE, base64) hands the script over whole: no quoting layer
# between bash, interop and PowerShell to get wrong.
run_powershell() {
  "$POWERSHELL" -NoProfile -NonInteractive -ExecutionPolicy Bypass \
    -EncodedCommand "$(printf '%s' "$1" | iconv -f UTF-8 -t UTF-16LE | base64 -w0)" </dev/null | tr -d '\r'
}

# The PowerShell that creates the shortcuts, after the variables PS_SCRIPT sets. A function
# and not a heredoc inside $(...): bash 3.2, macOS's, misreads one there, tripping over
# the first apostrophe of its text, and refuses the whole script, whatever the platform.
ps_shortcuts() {
  cat <<'PS'
$ErrorActionPreference = 'Stop'
# Without a console, progress records come out as CLIXML noise in an error message.
$ProgressPreference = 'SilentlyContinue'
# wslg.exe runs a Linux command without a console window; wsl.exe would leave one open,
# hence minimized. A wslg.exe error is a dialog box: shown, not minimized.
# wslg.exe has no -e: `--` hands the rest of the line to the user's shell, for both. It
# does not strip quotes either: the distribution name, which has no spaces, goes bare.
$wslg = Join-Path $env:ProgramFiles 'WSL\wslg.exe'
if (Test-Path $wslg) { $target = $wslg; $style = 1 } else { $target = (Get-Command wsl.exe).Source; $style = 7 }
$arguments = "-d $distro -- `"$keeper`""
# On the Windows side: the Start menu draws it while WSL is stopped.
$icon = ''
if ($iconSource) {
  $icon = Join-Path $env:LOCALAPPDATA 'Sillage\sillage.ico'
  New-Item -ItemType Directory -Force -Path (Split-Path $icon) | Out-Null
  Copy-Item -LiteralPath $iconSource -Destination $icon -Force
}
$shell = New-Object -ComObject WScript.Shell
function Set-Shortcut([string]$path, [string]$extra, [string]$description) {
  $link = $shell.CreateShortcut($path)
  $link.TargetPath = $target
  $link.Arguments = "$arguments$extra"
  $link.Description = $description
  $link.WindowStyle = $style
  if ($icon) { $link.IconLocation = "$icon,0" }
  $link.Save()
}
$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Sillage.lnk'
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Sillage.lnk'
Set-Shortcut $menu ' --open' 'Open Sillage'
if ($autostart) { Set-Shortcut $startup '' 'Keeps WSL running so that Sillage stays reachable' }
elseif (Test-Path $startup) { Remove-Item $startup }
# The Start menu entry itself, as a click would: the first launch goes the way every
# later one will. Started from here, it still outlives the WSL session of the installer.
if ($launch) { Start-Process -FilePath $menu }
PS
}

ps_quote() { printf "'%s'" "${1//\'/\'\'}"; }

# bytes N... — raw bytes, from decimal values.
bytes() { local b; for b in "$@"; do printf '%b' "\\0$(printf '%03o' "$b")"; done; }

# make_ico PNG ICO — a one-entry .ico holding the PNG as is, which Windows reads since
# Vista: the release's PWA icon becomes the shortcut icon without any image tool. The
# entry stores the width on one byte, 0 meaning 256, hence the low byte of the PNG's.
make_ico() {
  local width size
  width="$(od -An -tu1 -j19 -N1 "$1" | tr -d ' ')"
  size="$(stat -c %s "$1")"
  {
    bytes 0 0 1 0 1 0 "$width" "$width" 0 0 1 0 32 0 \
      $((size & 255)) $((size >> 8 & 255)) $((size >> 16 & 255)) $((size >> 24 & 255)) 22 0 0 0
    cat "$1"
  } > "$2"
}

WIN_LINKS="no"
if [ "$IS_WSL" = "yes" ]; then
  KEEPER="$DATA_DIR/wsl/keepalive"
  EXPLORER="$(win_exe explorer.exe || echo explorer.exe)"
  mkdir -p "$DATA_DIR/wsl"
  cat > "$KEEPER.tmp" <<EOF
#!/bin/sh
# Started from Windows by the "Sillage" shortcuts that install.sh creates, and rewritten
# by each run of it. WSL stops a distribution once nothing started from Windows runs in
# it any more, systemd services included: this process keeps Sillage up with every
# terminal closed.

if [ "\${1:-}" = "--open" ]; then
  # The service starts with the distribution, which may have just booted.
  tries=0
  until curl -fs -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/health"; do
    tries=\$((tries + 1))
    [ "\$tries" -ge 30 ] && break
    sleep 1
  done
  # explorer.exe hands the URL to the default browser, and exits 1 even then.
  "$EXPLORER" "http://localhost:$PORT/" || true
fi

# One keeper is enough: a second one (the Start menu entry while the sign-in one runs)
# leaves at once, and the first keeps the distribution open.
exec flock -n "$DATA_DIR/wsl/keepalive.lock" sleep infinity
EOF
  chmod +x "$KEEPER.tmp"
  mv "$KEEPER.tmp" "$KEEPER"

  if [ -z "${WSL_DISTRO_NAME:-}" ] || ! POWERSHELL="$(win_exe powershell.exe)"; then
    say "warning: Windows is not reachable from this shell (WSL interop disabled?), so no
    Start menu entry was created. Sillage stops about 15 seconds after the last WSL
    terminal closes. Run this installer again from a regular WSL terminal to fix it."
  else
    case "${SILLAGE_WSL_AUTOSTART:-}" in
      yes|no) WIN_AUTOSTART="$SILLAGE_WSL_AUTOSTART" ;;
      *) if ask "Start Sillage when you sign in to Windows? [Y/n]" yes; then WIN_AUTOSTART="yes"; else WIN_AUTOSTART="no"; fi ;;
    esac
    # Opening the browser only makes sense for someone sitting at the machine.
    LAUNCH="no"
    if has_tty; then LAUNCH="yes"; fi

    ICON_SOURCE=""
    if [ -f "$APP_DIR/current/web/icon-192.png" ]; then
      make_ico "$APP_DIR/current/web/icon-192.png" "$DATA_DIR/wsl/sillage.ico"
      ICON_SOURCE="$(wslpath -w "$DATA_DIR/wsl/sillage.ico")"
    fi

    PS_SCRIPT="\$distro = $(ps_quote "$WSL_DISTRO_NAME")
\$keeper = $(ps_quote "$KEEPER")
\$autostart = \$$([ "$WIN_AUTOSTART" = "yes" ] && echo true || echo false)
\$iconSource = $(ps_quote "$ICON_SOURCE")
\$launch = \$$([ "$LAUNCH" = "yes" ] && echo true || echo false)
$(ps_shortcuts)"
    if ERR="$(run_powershell "$PS_SCRIPT" 2>&1)"; then
      WIN_LINKS="yes"
    else
      say "warning: could not create the Windows shortcuts: $ERR"
    fi
  fi

  # Windows reaches the service through WSL's localhost forwarding: check it from that
  # side, where the browser will be. The forwarding can lag the listener by a second.
  if CURL_EXE="$(win_exe curl.exe)"; then
    WIN_CODE=""
    for _ in 1 2 3 4 5; do
      WIN_CODE="$("$CURL_EXE" -s -m 3 -o NUL -w '%{http_code}' "http://localhost:$PORT/api/health" </dev/null 2>/dev/null | tr -d '\r' || true)"
      [ "$WIN_CODE" = "200" ] && break
      sleep 1
    done
    if [ "$WIN_CODE" != "200" ]; then
      say "warning: Sillage answers inside WSL but not on http://localhost:$PORT from Windows.
    Check that localhostForwarding is not disabled in %UserProfile%\\.wslconfig, and that
    no Windows program already listens on port $PORT."
    fi
  fi
fi

if [ "$IS_WSL" = "yes" ]; then
  say "Done. Open http://localhost:$PORT in your Windows browser."
  if [ "$WIN_LINKS" = "yes" ]; then
    say "\"Sillage\" in the Start menu opens it too, and starts it if WSL was stopped."
    has_tty || say "Open it from the Start menu once: until then, Sillage stops when WSL does."
  fi
elif [ "$PLATFORM" = "darwin" ]; then
  say "Done. Sillage is listening on http://localhost:$PORT and starts with your session."
  # With the account just created, the browser goes straight to the login page.
  if [ "$ACCOUNT_CREATED" = "yes" ]; then open "http://localhost:$PORT/" || true; fi
else
  say "Done. Sillage is listening on http://127.0.0.1:$PORT"
fi
if [ "$PLATFORM" = "darwin" ]; then
  say "Logs:  tail -f $LOG_FILE"
  say "Stop:  launchctl bootout $DOMAIN/$LABEL  (re-running this script starts it again)"
else
  say "Logs:  journalctl --user -u sillage -f"
fi
say "Update later by re-running this script, or from the web UI (Settings > About)."

}
