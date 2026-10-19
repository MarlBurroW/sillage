import { existsSync } from 'node:fs'
import path from 'node:path'
import { resolveBinary } from '../agents/cli-binary.js'

/** Un shell, et les arguments qui le préparent avant ceux de l'appelant. */
export interface Shell {
  command: string
  args: string[]
}

/**
 * Le shell d'un terminal interactif.
 *
 * Celui de l'utilisateur sous Linux et macOS (`$SHELL`, à défaut `/bin/sh`), en shell de
 * connexion sur macOS comme l'ouvre Terminal : c'est là que /etc/zprofile complète le
 * PATH et que ~/.zprofile charge Homebrew.
 *
 * Sous Windows, PowerShell : celui qu'ouvrent le Terminal Windows et VS Code par défaut,
 * PowerShell 7 quand il est installé, sinon celui du système.
 */
export function interactiveShell(platform: NodeJS.Platform = process.platform): Shell {
  if (platform === 'win32') return { command: powershell(), args: ['-NoLogo'] }
  return { command: posixShell(), args: platform === 'darwin' ? ['-l'] : [] }
}

/**
 * Le shell qui exécute une commande écrite en syntaxe POSIX : une action de projet, la
 * commande d'un terminal ouvert pour elle, un script de vérification sans shebang.
 *
 * Ces commandes sont écrites pour `sh`, souvent par un agent : sous Windows, Claude Code
 * lui-même exécute les siennes dans le bash de Git for Windows. On fait de même, le Git
 * que Sillage exige y apportant ce bash ; PowerShell ne sert qu'à défaut, et une commande
 * POSIX un peu élaborée y échouera.
 */
export function commandShell(platform: NodeJS.Platform = process.platform): Shell {
  if (platform !== 'win32') return { command: posixShell(), args: ['-lc'] }
  const bash = gitBash()
  return bash ? { command: bash, args: ['-lc'] } : { command: powershell(), args: ['-NoLogo', '-Command'] }
}

/**
 * Le bash de Git for Windows, ou null.
 *
 * `CLAUDE_CODE_GIT_BASH_PATH` d'abord, la variable que Claude Code lit pour la même
 * question. Sinon à côté du `git.exe` du PATH (`…\Git\cmd\git.exe` → `…\Git\bin\bash.exe`),
 * puis à l'emplacement d'installation par défaut.
 */
export function gitBash(env: NodeJS.ProcessEnv = process.env): string | null {
  const declared = env.CLAUDE_CODE_GIT_BASH_PATH
  if (declared && existsSync(declared)) return declared
  const git = resolveBinary('git', undefined, env, 'win32')
  const candidates = [
    ...(git ? [path.win32.join(path.win32.dirname(git), '..', 'bin', 'bash.exe')] : []),
    path.win32.join(env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

function posixShell(): string {
  const fromEnv = process.env.SHELL
  return fromEnv && fromEnv.length > 0 ? fromEnv : '/bin/sh'
}

function powershell(): string {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  return resolveBinary('pwsh', undefined, process.env, 'win32') ??
    path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}
