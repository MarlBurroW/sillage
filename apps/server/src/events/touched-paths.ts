import { isAbsolute } from 'node:path'
import type { SillageEvent } from '@sillage/protocol'

/**
 * Chemins absolus qu'un événement révèle hors du répertoire de travail.
 *
 * Les éditions journalisées gardent un chemin absolu quand elles sortent du cwd
 * (`toWorkspacePath`) : c'est le signe qu'une session travaille ailleurs que là où
 * Sillage la croit, typiquement dans un worktree créé au shell. Une édition faite par
 * Bash (`sed`, `git apply`) échappe au journal : on retient alors les dossiers que la
 * commande nomme explicitement, `cd`, `git -C` ou `git worktree add`, qui suffisent à
 * rattacher la session à l'arbre où elle s'est installée.
 */
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

/**
 * Un argument de commande : entre guillemets, avec ses espaces, ou nu jusqu'au premier
 * séparateur du shell. Trois groupes de capture, un seul renseigné.
 */
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
