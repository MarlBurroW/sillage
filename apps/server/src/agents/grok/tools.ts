import type { EditDiffDto } from '@sillage/protocol'
import { additionDiff, unifiedDiff } from '../../diff-lines.js'
import { toWorkspacePath } from '../paths.js'

/**
 * Les outils de Grok Build, ramenés aux noms et aux champs du journal (invariant I3).
 *
 * Grok nomme ses outils en snake_case (`read_file`, `search_replace`,
 * `run_terminal_command`) et leurs champs à sa façon (`target_file`), là où le journal
 * porte ceux de Claude Code, que les vues du web et l'invite de permission savent lire.
 * La traduction se fait ici, à la source ; le payload ACP reste intact dans `raw`.
 *
 * Le nom vient de `_meta["x.ai/tool"].name`, que Grok pose sur chaque appel : le
 * `title` de l'ACP est une phrase (« Read `note.txt` ») qui change d'une mise à jour à
 * l'autre. Tout ce qui est affirmé ici a été sondé sur Grok Build 1.0.62.
 */

type Fields = Record<string, unknown>

export function fields(value: unknown): Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Renomme les clés connues et retire `variant`, l'étiquette Rust que Grok ajoute à l'entrée. */
function rename(input: Fields, names: Record<string, string>): Fields {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => key !== 'variant')
      .map(([key, value]) => [names[key] ?? key, value]),
  )
}

const BUILTIN: Record<string, { name: string; input: (input: Fields) => Fields }> = {
  read_file: { name: 'Read', input: (input) => rename(input, { target_file: 'file_path', path: 'file_path' }) },
  search_replace: { name: 'Edit', input: (input) => rename(input, { path: 'file_path' }) },
  write: { name: 'Write', input: (input) => rename(input, { target_file: 'file_path', path: 'file_path' }) },
  run_terminal_command: {
    name: 'Bash',
    input: (input) => rename(input, { is_background: 'run_in_background' }),
  },
  bash: { name: 'Bash', input: (input) => rename(input, { is_background: 'run_in_background' }) },
  grep: { name: 'Grep', input: (input) => rename(input, { query: 'pattern', target_directory: 'path' }) },
  list_dir: { name: 'LS', input: (input) => rename(input, { target_directory: 'path', directory: 'path' }) },
  web_search: { name: 'WebSearch', input: (input) => rename(input, {}) },
  web_fetch: { name: 'WebFetch', input: (input) => rename(input, {}) },
  todo_write: { name: 'TodoWrite', input: (input) => rename(input, {}) },
  spawn_subagent: { name: 'Agent', input: (input) => rename(input, {}) },
  search_tool: { name: 'ToolSearch', input: (input) => rename(input, {}) },
}

/**
 * L'outil `ask_user_question` n'a pas de carte : la question elle-même en tient lieu,
 * comme chez opencode.
 */
export const QUESTION_TOOL = 'ask_user_question'

/** Le nom natif d'un appel : celui que Grok déclare, à défaut le titre de l'ACP. */
export function nativeToolName(meta: unknown, title: unknown): string {
  return text(fields(fields(meta)['x.ai/tool']).name) ?? text(title) ?? 'tool'
}

/**
 * Nom et entrée d'un appel, tels que le journal les porte.
 *
 * Grok n'expose pas les outils MCP un par un : le modèle les cherche (`search_tool`)
 * puis les appelle par `use_tool`, avec `serveur__outil` pour nom. L'appel redevient le
 * `serveur/outil` que publient les autres adaptateurs, avec l'entrée de l'outil appelé.
 */
export function describeTool(name: string, rawInput: unknown): { name: string; input: unknown } {
  const input = fields(rawInput)
  if (name === 'use_tool') {
    const target = text(input.tool_name)
    const separator = target?.indexOf('__') ?? -1
    if (target && separator > 0) {
      return { name: `${target.slice(0, separator)}/${target.slice(separator + 2)}`, input: input.tool_input ?? {} }
    }
  }
  const builtin = BUILTIN[name]
  if (builtin) return { name: builtin.name, input: builtin.input(input) }
  return { name, input: rename(input, {}) }
}

/** Un bloc `diff` de l'ACP : un fichier, et l'extrait avant et après quand c'est une édition. */
export interface AcpDiff {
  path: string
  oldText: string | null
  newText: string
}

/** Les blocs `diff` d'un contenu d'appel, dans l'ordre où Grok les a donnés. */
export function diffsOf(content: unknown): AcpDiff[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((block): AcpDiff[] => {
    const entry = fields(block)
    if (entry.type !== 'diff' || typeof entry.path !== 'string' || typeof entry.newText !== 'string') return []
    return [{ path: entry.path, oldText: typeof entry.oldText === 'string' ? entry.oldText : null, newText: entry.newText }]
  })
}

/** Le texte que l'appel a rendu, tel que Grok le donne en blocs `content`. */
export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const entry = fields(block)
      return entry.type === 'content' ? (text(fields(entry.content).text) ?? '') : ''
    })
    .join('')
}

/**
 * La sortie d'une commande telle que Grok la cumule dans `rawOutput.output` : des
 * octets, et non du texte, pour ne rien perdre d'une sortie binaire. Null quand
 * l'appel n'est pas une commande.
 */
export function commandOutput(rawOutput: unknown): string | null {
  const output = fields(rawOutput)
  if (output.type !== 'Bash' || !Array.isArray(output.output)) return null
  return Buffer.from(output.output.filter((byte): byte is number => typeof byte === 'number')).toString('utf8')
}

/**
 * Ce que l'appel a fait d'un fichier, reconstitué depuis les blocs `diff` gardés à la
 * clôture. Une édition ponctuelle ne porte que l'extrait remplacé : le diff est alors
 * partiel, comme celui d'un `Edit` de Claude.
 */
export function describeEdit(completedRaw: unknown, cwd: string, path: string): EditDiffDto {
  const diffs = (fields(completedRaw).diffs as AcpDiff[] | undefined) ?? []
  const diff = diffs.find((entry) => toWorkspacePath(cwd, entry.path) === path)
  if (!diff) {
    return { path, kind: 'unavailable', patch: '', content: '', partial: false, reason: "Le détail de cet appel n'a pas été conservé." }
  }
  if (diff.oldText === null || diff.oldText === '') {
    return { path, kind: 'patch', patch: additionDiff(path, diff.newText), content: '', partial: false, reason: null }
  }
  return { path, kind: 'patch', patch: unifiedDiff(path, diff.oldText, diff.newText), content: '', partial: true, reason: null }
}
