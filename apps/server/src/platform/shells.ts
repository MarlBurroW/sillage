import { existsSync } from 'node:fs'
import path from 'node:path'
import { resolveBinary } from '../agents/cli-binary.js'

/** Shell and preparatory arguments preceding caller arguments. */
export interface Shell {
  command: string
  args: string[]
}

/** Interactive terminal shell. Linux/macOS use `$SHELL`, falling back to `/bin/sh`; macOS uses login shells like Terminal so /etc/zprofile extends PATH and ~/.zprofile loads Homebrew. Windows uses PowerShell like Windows Terminal and VS Code: PowerShell 7 when available, otherwise the system version. */
export function interactiveShell(platform: NodeJS.Platform = process.platform): Shell {
  if (platform === 'win32') return { command: powershell(), args: ['-NoLogo'] }
  return { command: posixShell(), args: platform === 'darwin' ? ['-l'] : [] }
}

/** Shell for POSIX-syntax commands: project actions, their terminals and shebangless checks. Agents commonly write sh commands; Claude Code itself uses Git for Windows bash on Windows. Follow that approach using Sillage's required Git installation. PowerShell is a fallback where elaborate POSIX commands will fail. */
export function commandShell(platform: NodeJS.Platform = process.platform): Shell {
  if (platform !== 'win32') return { command: posixShell(), args: ['-lc'] }
  const bash = gitBash()
  return bash ? { command: bash, args: ['-lc'] } : { command: powershell(), args: ['-NoLogo', '-Command'] }
}

/** Git for Windows bash, or null. Prefer `CLAUDE_CODE_GIT_BASH_PATH` like Claude Code, then beside PATH `git.exe` (`…\Git\cmd\git.exe` → `…\Git\bin\bash.exe`), then default installation paths. */
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
