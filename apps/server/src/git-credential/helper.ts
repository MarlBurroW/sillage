import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Paths } from '../config.js'

/** Registers git credential helpers. Cloning receives the helper through environment before repositories exist; clones retain it in `.git/config` for agent pushes, terminal fetches and worktrees sharing the main repository's local configuration. */

/** Helper file in source and bundled execution. Development uses neighboring `.mjs` beside `src/git-credential/helper.ts`; production bundles the module into `dist/main.js` and copies `.mjs` into `dist/git-credential/`. */
function resolveEntry(): string {
  const candidates = [
    join(import.meta.dirname, 'sillage-git-credential.mjs'),
    join(import.meta.dirname, 'git-credential/sillage-git-credential.mjs'),
  ]
  const found = candidates.find((path) => existsSync(path))
  if (!found) {
    throw new Error(
      `Helper de credentials git introuvable (cherché : ${candidates.join(', ')})`,
    )
  }
  return found
}

/** Git executes `!`-prefixed helpers through shells, so quote every argument. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Stable helper launcher under the data directory. Clone `.git/config` survives release cleanup and Node removal (`nvm uninstall`), so store only this stable path. Rewrite the launcher on startup with the running server's Node and `.mjs` paths. */
export function credentialLauncherPath(paths: Pick<Paths, 'data'>): string {
  return join(paths.data, 'bin', 'sillage-git-credential')
}

/** Launcher content in POSIX sh, compatible with Debian dash, macOS bash 3.2 and container shells. Use the writer server's Node and `.mjs`, not `app/current/…` or PATH `node`: better-sqlite3 targets a particular Node ABI and only the running pair is guaranteed compatible. Missing components deserve clear errors rather than Node traces. Database and key paths live here rather than `.git/config` because they follow the data directory like the launcher. */
export function credentialLauncherScript(paths: Pick<Paths, 'data' | 'database'>, node: string, entry: string): string {
  return [
    '#!/bin/sh',
    '# Lanceur du helper de credentials git de Sillage.',
    '# Réécrit à chaque démarrage du serveur : ne pas modifier à la main.',
    `node=${shellQuote(gitPath(node))}`,
    `entry=${shellQuote(gitPath(entry))}`,
    'if [ ! -x "$node" ] || [ ! -f "$entry" ]; then',
    '  echo "sillage: helper de credentials introuvable ($node, $entry) ; redémarrez Sillage pour le réinstaller." >&2',
    '  exit 1',
    'fi',
    `exec "$node" "$entry" --db ${shellQuote(gitPath(paths.database))} --key ${shellQuote(gitPath(join(paths.data, 'secret.key')))} "$@"`,
    '',
  ].join('\n')
}

/** Writes missing launchers or those describing another server. Reread on every call rather than cache: a few hundred bytes at clone/push time allow damaged or externally replaced launchers to repair themselves. Atomically rename temporary files so concurrent git sees either old or new launchers, never partial writes. */
export function installCredentialLauncher(paths: Pick<Paths, 'data' | 'database'>): string {
  const target = credentialLauncherPath(paths)
  const script = credentialLauncherScript(paths, process.execPath, resolveEntry())
  let current: string | null = null
  try {
    current = readFileSync(target, 'utf8')
  } catch {
    // Missing on this version's first startup or after directory cleanup.
  }
  if (current !== script) {
    mkdirSync(dirname(target), { recursive: true })
    const temp = `${target}.${process.pid}.tmp`
    writeFileSync(temp, script, { mode: 0o755 })
    renameSync(temp, target)
  }
  return target
}

/** Value stored in `credential.helper`: launcher and owner only, with no installed-version dependency (see `credentialLauncherPath`). Never put tokens in arguments: the helper reads them from the database when git asks. Anyone with a shell can read command lines through `ps`. */
export function credentialHelperCommand(paths: Pick<Paths, 'data' | 'database'>, ownerId: string): string {
  const launcher = installCredentialLauncher(paths)
  return `!${[gitPath(launcher), '--owner', ownerId].map(shellQuote).join(' ')}`
}

/** Path as read by the helper's sh. On Windows this is Git for Windows, which accepts `C:/…` like its launched Node; native backslashes interact badly with shells. */
function gitPath(path: string): string {
  return process.platform === 'win32' ? path.replaceAll('\\', '/') : path
}

/** Environment for Sillage-launched git without existing configuration, meaning clones. Use `GIT_CONFIG_COUNT` instead of command-line `-c` for the same reasons above and to reach git child processes. `GIT_TERMINAL_PROMPT=0` prevents password prompts from hanging until timeout without terminals. An initial empty value clears inherited helpers: otherwise system/global helpers such as macOS `osxkeychain` answer before Sillage and retain Sillage tokens after successful operations. */
export function credentialEnv(paths: Pick<Paths, 'data' | 'database'>, ownerId: string): NodeJS.ProcessEnv {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: credentialHelperCommand(paths, ownerId),
  }
}
