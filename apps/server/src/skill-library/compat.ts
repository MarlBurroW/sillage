import type { SkillCompatNote } from '@sillage/protocol'

/** CLI-specific skill behavior. Both CLIs share the format but interpret different fields. Skills generally work in either CLI except for these differences, disclosed by the interface rather than discovered through use. */

/** Frontmatter fields interpreted by Claude Code but ignored by Codex. Excludes `argument-hint`, which belongs to separately reported argument substitution. */
const CLAUDE_ONLY_FIELDS = [
  'allowed-tools',
  'disable-model-invocation',
  'user-invocable',
  'model',
  'context',
  'agent',
  'hooks',
]

/** `$ARGUMENTS`, `$0`, `$1`…: Claude substitutes these; Codex leaves them to the model. */
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
