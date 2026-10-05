#!/usr/bin/env bash
#
# Installation macOS de bout en bout, sur une machine jetable (runner de CI) :
#
#   scripts/macos-install-check.sh sillage-<version>-darwin-arm64.tar.gz
#
# Lance install.sh avec un Node trop vieux sur le PATH, qu'il doit écarter pour le sien, puis vérifie
# l'agent launchd, la relance après un arrêt (le chemin de la mise à jour intégrée), une
# réinstallation à l'identique et le passage à une autre version. Installe pour de bon
# sous ~/.local/share/sillage et ~/Library/LaunchAgents : pas sur un poste de travail.
set -euo pipefail

ARCHIVE="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$HOME/.local/share/sillage"
LABEL="io.github.marlburrow.sillage"
SERVICE="gui/$(id -u)/$LABEL"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

step() { printf '\n\033[1;35m### %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31mcheck failed:\033[0m %s\n' "$*" >&2; exit 1; }

# Le PATH de launchd, précédé de $2 s'il est donné. Sans terminal, comme sous
# `curl | bash` lancé par un script.
# install.sh s'est déjà arrêté à mi-chemin sur le runner, sur une erreur d'expansion du
# bash 3.2, sans que son code de sortie le dise : on exige aussi son dernier message.
run_installer() {
  env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/bin/zsh LANG=fr_FR.UTF-8 \
    PATH="${2:-}/usr/bin:/bin:/usr/sbin:/sbin" SILLAGE_ARCHIVE="$1" \
    bash "$ROOT/install.sh" </dev/null 2>&1 | tee "$WORK/install.log"
  grep -q 'Update later by re-running this script' "$WORK/install.log" \
    || fail "install.sh stopped before its last message"
}

service_pid() { launchctl print "$SERVICE" | sed -nE 's/^[[:space:]]*pid = ([0-9]+)$/\1/p'; }

wait_healthy() {
  for _ in $(seq 30); do
    curl -fs -m 2 -o /dev/null http://127.0.0.1:7317/api/health && return 0
    sleep 1
  done
  fail "Sillage does not answer on port 7317"
}

# Aucun lien `current.tmp` ne doit rester, ni à côté de `current` ni dedans : c'est là
# qu'un mv sans -h l'aurait déposé, en laissant l'ancien lien en place.
check_links() {
  local dir
  for dir in "$DATA_DIR/app" "$DATA_DIR/node"; do
    [ ! -e "$dir/current.tmp" ] && [ ! -L "$dir/current.tmp" ] || fail "$dir/current.tmp left behind"
    [ ! -L "$dir/current/current.tmp" ] || fail "link moved into $dir/current"
  done
}

# Node 22.12 a N-API 9 : il charge better-sqlite3, puis plante à la première requête.
# Un Node nvm de cet âge est courant sur un poste de développeur.
step "First install, Node 22.12 on the PATH: too old, install.sh brings its own"
curl -fsSL https://nodejs.org/dist/v22.12.0/node-v22.12.0-darwin-arm64.tar.gz | tar -xz -C "$WORK"
run_installer "$ARCHIVE" "$WORK/node-v22.12.0-darwin-arm64/bin:"
grep -q 'is older than 22.14' "$WORK/install.log" || fail "Node 22.12 was not set aside"
wait_healthy
VERSION="$(cat "$DATA_DIR/app/current/VERSION")"
[ "$(readlink "$DATA_DIR/app/current")" = "releases/v$VERSION" ] || fail "app/current does not point at v$VERSION"
NODE="$DATA_DIR/node/current/bin/node"
[ "$("$NODE" -p process.arch)" = arm64 ] || fail "private Node is not arm64"
grep -q "<string>$NODE</string>" "$HOME/Library/LaunchAgents/$LABEL.plist" || fail "the agent does not run the private Node"
plutil -lint "$HOME/Library/LaunchAgents/$LABEL.plist"
check_links

step "launchd restarts the service after a clean stop, as after an in-app update"
PID="$(service_pid)"
[ -n "$PID" ] || fail "no pid for $SERVICE"
kill -TERM "$PID"
for _ in $(seq 30); do
  NEW_PID="$(service_pid)"
  [ -n "$NEW_PID" ] && [ "$NEW_PID" != "$PID" ] && break
  sleep 1
done
[ -n "${NEW_PID:-}" ] && [ "$NEW_PID" != "$PID" ] || fail "launchd did not restart the service"
wait_healthy

step "Same archive again: nothing to install, links swapped in place"
run_installer "$ARCHIVE"
wait_healthy
check_links

step "Another version: the release link moves"
mkdir "$WORK/next"
tar -xzf "$ARCHIVE" -C "$WORK/next"
printf '%s\n' "$VERSION-next" > "$WORK/next/sillage/VERSION"
tar --no-mac-metadata --no-xattrs -czf "$WORK/next.tar.gz" -C "$WORK/next" sillage
run_installer "$WORK/next.tar.gz"
wait_healthy
[ "$(readlink "$DATA_DIR/app/current")" = "releases/v$VERSION-next" ] || fail "app/current did not move to v$VERSION-next"
check_links

step "Log file"
[ -s "$DATA_DIR/logs/sillage.log" ] || fail "empty log file"
tail -n 5 "$DATA_DIR/logs/sillage.log"

printf '\n\033[1;32mmacOS install checks passed.\033[0m\n'
