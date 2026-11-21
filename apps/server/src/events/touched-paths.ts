import { isAbsolute } from 'node:path'
import type { SillageEvent } from '@sillage/protocol'

/** Absolute paths exposed outside working directories. Journaled edits retain absolute paths outside cwd (`toWorkspacePath`), indicating sessions working elsewhere, typically shell-created worktrees. Bash edits (`sed`, `git apply`) evade edit events; retain directories explicitly named by `cd`, `git -C` or `git worktree add`, enough to attach sessions to their working tree. */
export function touchedPaths(event: SillageEvent, platform: NodeJS.Platform = process.platform): string[] {
  if (event.type === 'file.edited') {
    return isAbsolute(event.path) ? [event.path] : []
  }
  if (event.type === 'tool.started' && event.name === 'Bash') {
    const input = event.input as { command?: unknown } | null
    const command = typeof input?.command === 'string' ? input.command : null
    return command ? commandDirectories(command, platform) : []
  }
  return []
}

/** An absolute path: POSIX `/…`, or a Windows drive `C:\…` / `C:/…`, which a leading `/` alone never matched. */
const ROOT = String.raw`(?:\/|[A-Za-z]:[\\/])`
/** Command argument: quoted with spaces or bare until shell separators. Three capture groups with exactly one populated. */
const ARG = String.raw`(?:'(${ROOT}[^']+)'|"(${ROOT}[^"]+)"|(${ROOT}[^\s'"\`;&|)]+))`

const DIRECTORY_FORMS = [
  new RegExp(String.raw`(?:^|[\s;&|(])cd\s+(?:--\s+)?${ARG}`, 'g'),
  new RegExp(String.raw`\bgit\s+-C\s+${ARG}`, 'g'),
  new RegExp(String.raw`\bgit\s+worktree\s+add\s+(?:-[-\w]+(?:\s+\S+)?\s+)*${ARG}`, 'g'),
  new RegExp(String.raw`--working-directory=${ARG}`, 'g'),
]

function commandDirectories(command: string, platform: NodeJS.Platform): string[] {
  const found = new Set<string>()
  for (const form of DIRECTORY_FORMS) {
    for (const match of command.matchAll(form)) {
      const path = match[1] ?? match[2] ?? match[3]
      if (path) found.add(nativePath(path.replace(/(?<=.)[\\/]+$/, ''), platform))
    }
  }
  return [...found]
}

/** Git Bash, the shell agents get on Windows, writes `C:\Users` as `/c/Users`: stored as is, it matched no tree Sillage knows by its Windows path. */
function nativePath(path: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return path
  const drive = /^\/([a-zA-Z])(?=\/|$)/.exec(path)
  return drive ? `${drive[1]!.toUpperCase()}:${path.slice(2) || '/'}` : path
}
