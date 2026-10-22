import { isAbsolute } from 'node:path'
import type { SillageEvent } from '@sillage/protocol'

/** Absolute paths exposed outside working directories. Journaled edits retain absolute paths outside cwd (`toWorkspacePath`), indicating sessions working elsewhere, typically shell-created worktrees. Bash edits (`sed`, `git apply`) evade edit events; retain directories explicitly named by `cd`, `git -C` or `git worktree add`, enough to attach sessions to their working tree. */
export function touchedPaths(event: SillageEvent): string[] {
  if (event.type === 'file.edited') {
    return isAbsolute(event.path) ? [event.path] : []
  }
  if (event.type === 'tool.started' && event.name === 'Bash') {
    const input = event.input as { command?: unknown } | null
    const command = typeof input?.command === 'string' ? input.command : null
    return command ? commandDirectories(command) : []
  }
  return []
}

/** Command argument: quoted with spaces or bare until shell separators. Three capture groups with exactly one populated. */
const ARG = String.raw`(?:'(\/[^']+)'|"(\/[^"]+)"|(\/[^\s'"\`;&|)]+))`

const DIRECTORY_FORMS = [
  new RegExp(String.raw`(?:^|[\s;&|(])cd\s+(?:--\s+)?${ARG}`, 'g'),
  new RegExp(String.raw`\bgit\s+-C\s+${ARG}`, 'g'),
  new RegExp(String.raw`\bgit\s+worktree\s+add\s+(?:-[-\w]+(?:\s+\S+)?\s+)*${ARG}`, 'g'),
  new RegExp(String.raw`--working-directory=${ARG}`, 'g'),
]

function commandDirectories(command: string): string[] {
  const found = new Set<string>()
  for (const form of DIRECTORY_FORMS) {
    for (const match of command.matchAll(form)) {
      const path = match[1] ?? match[2] ?? match[3]
      if (path) found.add(path.replace(/\/+$/, ''))
    }
  }
  return [...found]
}
