import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** After this, consider the shell stuck (a `.zshrc` prompt or slow network). */
const SHELL_TIMEOUT_MS = 10_000

/**
 * Common installer binary directories, taken from the installer's launchd service
 * (`deploy/sillage.plist.tmpl`). Used when the login shell does not respond.
 */
const COMMON_BIN_DIRS = [
  join(homedir(), '.local/bin'),
  join(homedir(), '.npm-global/bin'),
  join(homedir(), '.bun/bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
]

/**
 * The user's login-shell environment, matching their terminals.
 *
 * Launched from Finder or an application menu, the app inherits a minimal session
 * manager environment; on macOS, `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. Agent CLIs,
 * Homebrew, and nvm are absent, leaving the server nothing to launch. Ask the user's
 * shell, in login and interactive mode like a terminal, to print its environment.
 * Bundled Node writes JSON, independent of shell (zsh, bash, fish) or multiline values.
 *
 * `lang` supplies a missing locale, normal for Finder-launched apps: otherwise zsh
 * displays accented characters as byte sequences.
 */
export async function loginShellEnv(node: string, lang: string): Promise<NodeJS.ProcessEnv> {
  const base = withoutLauncherVars(process.env)
  let env: NodeJS.ProcessEnv
  try {
    env = process.platform === 'win32' ? base : await askLoginShell(node, base)
  } catch {
    env = { ...base, PATH: [base.PATH, ...COMMON_BIN_DIRS].filter(Boolean).join(delimiter) }
  }
  env.LANG ??= lang
  return env
}

async function askLoginShell(node: string, base: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const shell = base.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
  const mark = randomUUID()
  const script =
    '"$SILLAGE_ENV_NODE" -e "process.stdout.write(process.env.SILLAGE_ENV_MARK + JSON.stringify(process.env) + process.env.SILLAGE_ENV_MARK)"'
  const output = await run(shell, ['-ilc', script], { ...base, SILLAGE_ENV_NODE: node, SILLAGE_ENV_MARK: mark })
  // Shell startup output before or after the environment (a welcome message) stays
  // outside the markers.
  const json = output.split(mark)[1]
  if (!json) throw new Error("le shell de connexion n'a pas rendu son environnement")
  const env = JSON.parse(json) as NodeJS.ProcessEnv
  delete env.SILLAGE_ENV_NODE
  delete env.SILLAGE_ENV_MARK
  return withoutLauncherVars(env)
}

/**
 * The PATH key in `env`. On Windows it is `Path`, and a plain-object copy of
 * `process.env` loses case insensitivity: writing `PATH` alongside it would create
 * a second variable, only one of which the child process would read.
 */
export function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    // Close stdin so an interactive shell asking a question cannot wait for an
    // answer that will never arrive.
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'ignore'] })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), SHELL_TIMEOUT_MS)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(output)
      else reject(new Error(`le shell de connexion a rendu ${code}`))
    })
  })
}

/**
 * Remove packaging environment additions that do not belong in agents or terminals.
 * AppImage sets `APPDIR` and prefixes paths to its mount point, which changes on
 * every launch: otherwise an agent's `git` would load app-bundled libraries.
 * The launch check's disposable profile applies only to the app, not its children.
 */
function withoutLauncherVars(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source }
  const appDir = env.APPDIR
  for (const name of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD', 'CHROME_DESKTOP', 'ELECTRON_RUN_AS_NODE', 'SILLAGE_DESKTOP_USER_DATA']) {
    delete env[name]
  }
  if (appDir) {
    for (const name of ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS']) {
      const kept = env[name]?.split(delimiter).filter((entry) => entry && !entry.startsWith(appDir))
      if (kept && kept.length > 0) env[name] = kept.join(delimiter)
      else delete env[name]
    }
  }
  return env
}
