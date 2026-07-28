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

# --- systemd unit ------------------------------------------------------------

# Sampled before the service boots and creates the database itself.
FRESH_INSTALL="no"
[ -f "$DATA_DIR/sillage.db" ] || FRESH_INSTALL="yes"

NODE_BIN="$(command -v node)"
mkdir -p "$UNIT_DIR" "$DATA_DIR/logs"
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

if ! loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes'; then
  say "Enable lingering so Sillage survives logout:  loginctl enable-linger $USER"
fi

# --- first account -----------------------------------------------------------

if [ "$FRESH_INSTALL" = "yes" ]; then
  # curl | bash leaves no stdin: the account prompt needs a real terminal.
  if [ -e /dev/tty ]; then
    say "Create the first account (it gets admin rights):"
    node "$APP_DIR/current/server/cli/user-create.js" < /dev/tty || true
  else
    say "No terminal available. Create the first account with:"
    say "  node $APP_DIR/current/server/cli/user-create.js"
  fi
fi

say "Done. Sillage is listening on http://127.0.0.1:7317"
say "Update later by re-running this script, or from the web UI (Settings > About)."
