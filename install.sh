#!/usr/bin/env bash
#
# Sillage installer for Linux (x64 / arm64) with systemd, WSL2 on Windows included.
#
#   curl -fsSL https://raw.githubusercontent.com/MarlBurroW/sillage/main/install.sh | bash
#
# Idempotent: run it again to update to the latest release. Pin a version with
# SILLAGE_VERSION=1.2.3. Everything lives under ~/.local/share/sillage; the
# application itself under app/releases/<version> with an atomic `current`
# symlink, which is also what the in-app updater manages.
#
# Without Node.js 22+ on the PATH, a private Node LTS goes to ~/.local/share/sillage/node,
# used by the service alone. Under WSL2 the script also enables systemd if needed and
# adds a "Sillage" Start menu entry plus a sign-in entry that keeps WSL running
# (SILLAGE_WSL_AUTOSTART=yes|no answers that question in advance).

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

[ "$(uname -s)" = "Linux" ] || fail "this installer targets Linux and WSL2; on macOS use Docker or the dev setup."

case "$(uname -m)" in
  x86_64)  ARCH="x64" ;;
  aarch64) ARCH="arm64" ;;
  *) fail "unsupported architecture: $(uname -m) (x86_64 and aarch64 only)" ;;
esac

# WSL sets WSL_DISTRO_NAME in every shell it starts; the kernel name tells WSL 1, which
# translates system calls and has no systemd, from WSL 2, which runs a real kernel.
IS_WSL="no"
if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
  IS_WSL="yes"
  case "$(cat /proc/sys/kernel/osrelease)" in
    *WSL2*|*microsoft-standard*) ;;
    *) fail "WSL 1 is not supported. Convert the distribution from PowerShell, then run this again:
  wsl --set-version ${WSL_DISTRO_NAME:-<distribution>} 2" ;;
  esac
fi

# Under WSL the Windows PATH is appended to the Linux one: a `claude` or `node` found on
# a Windows drive is a Windows program, unusable by a Linux service.
linux_command() {
  local found
  found="$(command -v "$1" 2>/dev/null)" || return 1
  [ "$IS_WSL" = "yes" ] && case "$found" in /mnt/*) return 1 ;; esac
  printf '%s\n' "$found"
}

apt_hint() { command -v apt-get >/dev/null && printf ' (sudo apt install %s)' "$1"; }

command -v curl >/dev/null || fail "curl is required$(apt_hint curl)."
command -v tar  >/dev/null || fail "tar is required$(apt_hint tar)."
command -v git  >/dev/null || fail "git is required, Sillage drives git repositories$(apt_hint git)."

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

systemctl --user show-environment >/dev/null 2>&1 \
  || fail "systemd user session unreachable. Log in as a regular user (not su/sudo) and retry."

# --- Node.js -----------------------------------------------------------------

node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# The latest release of NODE_LINE, unpacked under NODE_DIR/<version> behind a `current`
# symlink, so that the unit keeps one path across Node updates. Checked against the
# SHASUMS256 file published next to the archives.
install_private_node() {
  local base="https://nodejs.org/dist/latest-v$NODE_LINE.x" sums file version
  sums="$(curl -fsSL "$base/SHASUMS256.txt")" || return 1
  file="$(printf '%s\n' "$sums" | grep -oE "node-v[0-9.]+-linux-$ARCH\.tar\.gz" | head -1)"
  [ -n "$file" ] || return 1
  version="${file#node-}"
  version="${version%%-linux-*}"

  if [ ! -x "$NODE_DIR/$version/bin/node" ]; then
    say "Downloading Node.js $version, for Sillage only (nothing changes system-wide)…"
    curl -fL --progress-bar -o "$TMP/$file" "$base/$file" || return 1
    printf '%s\n' "$sums" | grep "  $file\$" | (cd "$TMP" && sha256sum -c --quiet -) \
      || fail "Node.js archive checksum mismatch: $base/$file"
    rm -rf "$NODE_DIR/.staging"
    mkdir -p "$NODE_DIR/.staging"
    tar -xzf "$TMP/$file" --strip-components=1 -C "$NODE_DIR/.staging"
    mv "$NODE_DIR/.staging" "$NODE_DIR/$version"
  fi
  ln -sfn "$version" "$NODE_DIR/current.tmp"
  mv -T "$NODE_DIR/current.tmp" "$NODE_DIR/current"
  # The running service keeps its binary open; once restarted, older versions are unused.
  find "$NODE_DIR" -mindepth 1 -maxdepth 1 -name 'v*' ! -name "$version" -exec rm -rf {} +
}

# A Node 22+ already on the PATH wins: it is what the user maintains. Otherwise the
# private copy, refreshed to the latest patch of its line on every run.
NODE_BIN=""
if SYSTEM_NODE="$(linux_command node)" && [ "$(node_major "$SYSTEM_NODE")" -ge 22 ]; then
  NODE_BIN="$SYSTEM_NODE"
else
  if ! install_private_node; then
    [ -x "$NODE_DIR/current/bin/node" ] \
      || fail "Node.js >= 22 is required and could not be downloaded from nodejs.org.
  Install it yourself (https://nodejs.org, or fnm/nvm) and run this script again."
    say "warning: could not check nodejs.org for a newer Node.js; keeping $("$NODE_DIR/current/bin/node" -v)."
  fi
  NODE_BIN="$NODE_DIR/current/bin/node"
  # node, npm and npx of the private copy for the rest of this script.
  export PATH="$NODE_DIR/current/bin:$PATH"
fi

linux_command claude >/dev/null || say "note: 'claude' CLI not found on PATH. Sillage can install it for you from the web interface; you will still need to authenticate it."
linux_command codex  >/dev/null || say "note: 'codex' CLI not found on PATH. Sillage can install it for you from the web interface; you will still need to authenticate it."

# --- resolve version ---------------------------------------------------------

if [ -n "${SILLAGE_VERSION:-}" ]; then
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

  TARBALL_URL="https://github.com/$REPO/releases/download/v$VERSION/sillage-v$VERSION-linux-$ARCH.tar.gz"

  say "Downloading Sillage $VERSION (linux-$ARCH)…"
  curl -fL --progress-bar -o "$TMP/sillage.tar.gz" "$TARBALL_URL" \
    || fail "download failed: $TARBALL_URL"

  say "Unpacking…"
  mkdir -p "$APP_DIR/releases"
  rm -rf "$RELEASE_DIR" "$APP_DIR/releases/.staging"
  mkdir -p "$APP_DIR/releases/.staging"
  tar -xzf "$TMP/sillage.tar.gz" --strip-components=1 -C "$APP_DIR/releases/.staging"
  mv "$APP_DIR/releases/.staging" "$RELEASE_DIR"

  # Atomic switch: rename over the old symlink, never a bare ln in place.
  ln -sfn "releases/v$VERSION" "$APP_DIR/current.tmp"
  mv -T "$APP_DIR/current.tmp" "$APP_DIR/current"
  say "Version $VERSION activated."

  # Keep the current release plus the two previous ones.
  ls -1d "$APP_DIR"/releases/v* 2>/dev/null | sort -V | head -n -3 | xargs -r rm -rf
fi

# --- native modules ----------------------------------------------------------

# Every native module in the tree is N-API — stable across Node versions — so the
# shipped binaries should load anywhere. Should: a truncated download or a platform the
# prebuild does not cover still yields a module that will not load, and the failure mode
# is a service that starts, dies, and gets restarted forever. Catching it here costs a
# second; discovering it afterwards costs a debugging session.
sqlite_loads() {
  (cd "$APP_DIR/current" && node -e 'require("better-sqlite3")') 2>&1
}

if ! ERR="$(sqlite_loads)"; then
  say "better-sqlite3 does not load under $(node -v); rebuilding from source…"
  command -v npm >/dev/null || fail "npm is required to rebuild better-sqlite3. Detail: $ERR"
  # Sources travel inside the archive (binding.gyp, deps/, src/): the rebuild downloads
  # nothing, but it does need a toolchain.
  if ! (cd "$APP_DIR/current" && npm rebuild better-sqlite3 >/dev/null 2>&1); then
    fail "could not rebuild better-sqlite3.
  Install a toolchain (Debian/Ubuntu: sudo apt install build-essential python3) and run
  this script again.
  Original error: $ERR"
  fi
  ERR="$(sqlite_loads)" || fail "better-sqlite3 still unusable after the rebuild: $ERR"
  say "better-sqlite3 rebuilt."
fi

# --- systemd unit ------------------------------------------------------------

# Sampled before the service boots and creates the database itself.
FRESH_INSTALL="no"
[ -f "$DATA_DIR/sillage.db" ] || FRESH_INSTALL="yes"

mkdir -p "$UNIT_DIR"
sed -e "s|__NODE__|$NODE_BIN|g" \
    -e "s|__NODE_DIR__|$(dirname "$NODE_BIN")|g" \
    -e "s|__INSTALL_DIR__|$APP_DIR|g" \
    -e "s|__HOME__|$HOME|g" \
    "$APP_DIR/current/deploy/sillage.service.tmpl" > "$UNIT_DIR/sillage.service"

say "Starting the service…"
systemctl --user daemon-reload
systemctl --user enable --now sillage.service
# enable --now is a no-op when already running: restart to pick up the new version.
systemctl --user restart sillage.service

# Without lingering, systemd stops user services when the last session closes: on a
# remote box Sillage would go down on every SSH logout. Enable it rather than suggest
# it — one more line in the installer output protects nobody. Recent systemd lets a user
# enable it for their own account without root.
#
# Under WSL it also starts Sillage as soon as the distribution boots, whoever boots it,
# and a WSL user has a sudo password but no reason to have it cached: ask for it there.
SUDO_LINGER=(sudo -n)
if [ "$IS_WSL" = "yes" ] && has_tty; then SUDO_LINGER=(sudo); fi
if ! loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes'; then
  say "Enabling lingering so Sillage survives logout…"
  loginctl enable-linger "$USER" 2>/dev/null \
    || "${SUDO_LINGER[@]}" loginctl enable-linger "$USER" 2>/dev/null \
    || say "warning: could not enable lingering. Sillage will stop when you log out.
    Run it yourself:  sudo loginctl enable-linger $USER"
fi

# --- first account -----------------------------------------------------------

# Without this account the instance is unreachable: no default password, no signup
# route. A failure here must be visible, never swallowed by a `|| true`.
ACCOUNT_HINT="node $APP_DIR/current/server/cli/user-create.js"

if [ "$FRESH_INSTALL" = "yes" ]; then
  # curl | bash leaves no stdin: the account prompt needs a real terminal.
  if has_tty; then
    say "Create the first account (it gets admin rights):"
    node "$APP_DIR/current/server/cli/user-create.js" < /dev/tty \
      || say "warning: account creation failed. Retry with:  $ACCOUNT_HINT"
  else
    say "No terminal available. Create the first account with:"
    say "  $ACCOUNT_HINT"
  fi
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
say "Checking that Sillage answers on port $PORT…"
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
  systemctl --user --no-pager --lines=0 status sillage.service || true
  say "Application log:  journalctl --user -u sillage -n 50 --no-pager"
  exit 1
fi

# A missing account breaks nothing visible: the server answers, but nobody can get in.
# Read the database rather than assume the CLI succeeded. `require` resolves from the
# current directory: run elsewhere it fails, and the check would report "unknown" on a
# perfectly readable database.
USER_COUNT="$(cd "$APP_DIR/current" && node -e 'try {
  const db = require("better-sqlite3")(process.argv[1], { readonly: true, fileMustExist: true })
  process.stdout.write(String(db.prepare("select count(*) as c from users").get().c))
} catch { process.stdout.write("?") }' "$DATA_DIR/sillage.db" 2>/dev/null || echo '?')"

if [ "$USER_COUNT" = "0" ]; then
  say "warning: no account exists — the UI will refuse every login."
  say "  Create one with:  $ACCOUNT_HINT"
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
$(cat <<'PS'
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
)"
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
else
  say "Done. Sillage is listening on http://127.0.0.1:$PORT"
fi
say "Logs:  journalctl --user -u sillage -f"
say "Update later by re-running this script, or from the web UI (Settings > About)."

}
