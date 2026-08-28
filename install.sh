#!/usr/bin/env bash
#
# Sillage installer for Linux (x64 / arm64) with systemd.
#
#   curl -fsSL https://raw.githubusercontent.com/MarlBurroW/sillage/main/install.sh | bash
#
# Idempotent: run it again to update to the latest release. Pin a version with
# SILLAGE_VERSION=1.2.3. Everything lives under ~/.local/share/sillage; the
# application itself under app/releases/<version> with an atomic `current`
# symlink, which is also what the in-app updater manages.

set -euo pipefail

REPO="MarlBurroW/sillage"
DATA_DIR="${SILLAGE_DATA_DIR:-$HOME/.local/share/sillage}"
APP_DIR="$DATA_DIR/app"
UNIT_DIR="$HOME/.config/systemd/user"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# --- preflight ---------------------------------------------------------------

[ "$(uname -s)" = "Linux" ] || fail "this installer targets Linux; on macOS use Docker or the dev setup."

case "$(uname -m)" in
  x86_64)  ARCH="x64" ;;
  aarch64) ARCH="arm64" ;;
  *) fail "unsupported architecture: $(uname -m) (x86_64 and aarch64 only)" ;;
esac

command -v curl >/dev/null || fail "curl is required."
command -v tar  >/dev/null || fail "tar is required."
command -v git  >/dev/null || fail "git is required (Sillage drives git repositories)."
command -v node >/dev/null || fail "Node.js >= 22 is required. See https://nodejs.org or use fnm/nvm."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js >= 22 is required (found $(node -v))."

systemctl --user show-environment >/dev/null 2>&1 \
  || fail "systemd user session unreachable. Log in as a regular user (not su/sudo) and retry."

command -v claude >/dev/null || say "note: 'claude' CLI not found on PATH. Sillage can install it for you from the web interface; you will still need to authenticate it."
command -v codex  >/dev/null || say "note: 'codex' CLI not found on PATH. Sillage can install it for you from the web interface; you will still need to authenticate it."

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
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT

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

# Releases ship `better-sqlite3` compiled for the Node ABI of the build runner (Node
# 22). It is the only module affected: node-pty and @node-rs/argon2 use N-API, which is
# stable across versions. On any other Node the service starts, loads the module, dies,
# and systemd restarts it forever. Catching it here costs a second; discovering it
# afterwards costs a debugging session.
sqlite_loads() {
  (cd "$APP_DIR/current" && node -e 'require("better-sqlite3")') 2>&1
}

if ! ERR="$(sqlite_loads)"; then
  say "better-sqlite3 was built for another Node ABI; rebuilding for $(node -v)…"
  command -v npm >/dev/null || fail "npm is required to rebuild better-sqlite3. Detail: $ERR"
  # Sources travel inside the archive (binding.gyp, deps/, src/): the rebuild downloads
  # nothing, but it does need a toolchain.
  if ! (cd "$APP_DIR/current" && npm rebuild better-sqlite3 >/dev/null 2>&1); then
    fail "could not rebuild better-sqlite3.
  Install a toolchain (Debian/Ubuntu: sudo apt install build-essential python3) and run
  this script again, or use Node 22, the ABI the shipped binaries were built for.
  Original error: $ERR"
  fi
  ERR="$(sqlite_loads)" || fail "better-sqlite3 still unusable after the rebuild: $ERR"
  say "better-sqlite3 rebuilt."
fi

# --- systemd unit ------------------------------------------------------------

# Sampled before the service boots and creates the database itself.
FRESH_INSTALL="no"
[ -f "$DATA_DIR/sillage.db" ] || FRESH_INSTALL="yes"

NODE_BIN="$(command -v node)"
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
if ! loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes'; then
  say "Enabling lingering so Sillage survives logout…"
  loginctl enable-linger "$USER" 2>/dev/null \
    || sudo -n loginctl enable-linger "$USER" 2>/dev/null \
    || say "warning: could not enable lingering. Sillage will stop when you log out.
    Run it yourself:  sudo loginctl enable-linger $USER"
fi

# --- first account -----------------------------------------------------------

# Without this account the instance is unreachable: no default password, no signup
# route. A failure here must be visible, never swallowed by a `|| true`.
ACCOUNT_HINT="node $APP_DIR/current/server/cli/user-create.js"

if [ "$FRESH_INSTALL" = "yes" ]; then
  # curl | bash leaves no stdin: the account prompt needs a real terminal.
  if [ -e /dev/tty ]; then
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
  if curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/health"; then
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

say "Done. Sillage is listening on http://127.0.0.1:$PORT"
say "Logs:  journalctl --user -u sillage -f"
say "Update later by re-running this script, or from the web UI (Settings > About)."
