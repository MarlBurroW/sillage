import type { SkillCompatNote } from '@sillage/protocol'

/**
 * Ce qu'un skill fera différemment selon le CLI qui le charge.
 *
 * Les deux CLI suivent le même format, mais chacun lit des champs que l'autre ignore.
 * Un skill écrit pour l'un marche donc chez l'autre, sauf sur ces points, que l'interface
 * signale plutôt que de laisser découvrir à l'usage.
 */

/**
 * Champs du frontmatter que Claude Code interprète et que Codex ignore.
 * `argument-hint` n'y est pas : il relève de la substitution d'arguments, notée à part.
 */
const CLAUDE_ONLY_FIELDS = [
  'allowed-tools',
  'disable-model-invocation',
  'user-invocable',
  'model',
  'context',
  'agent',
  'hooks',
]

/** `$ARGUMENTS`, ou `$0`, `$1`… : Claude les remplace, Codex les laisse au modèle. */
const ARGUMENTS_PLACEHOLDER = /\$(ARGUMENTS\b|\d)/

const SCRIPT_EXTENSIONS = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1)$/i

export function compatNotes(
  frontmatter: Record<string, unknown>,
  body: string,
  files: string[],
): SkillCompatNote[] {
  const notes: SkillCompatNote[] = []

  if ('argument-hint' in frontmatter || ARGUMENTS_PLACEHOLDER.test(body)) {
    notes.push({ code: 'codex_no_arguments', field: null })
  }
  for (const field of CLAUDE_ONLY_FIELDS) {
    if (field in frontmatter) notes.push({ code: 'claude_only_field', field })
  }
  if (files.some((file) => file.startsWith('scripts/') || SCRIPT_EXTENSIONS.test(file))) {
    notes.push({ code: 'runs_scripts', field: null })
  }

  return notes
}
