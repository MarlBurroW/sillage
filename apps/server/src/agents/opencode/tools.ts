import type { ToolPart } from '@sillage/opencode-bindings'
import type { EditDiffDto, SillageEvent } from '@sillage/protocol'
import { additionDiff } from '../../diff-lines.js'
import { toWorkspacePath } from '../paths.js'

/**
 * Les outils d'opencode, ramenés aux noms et aux champs du journal (invariant I3).
 *
 * opencode nomme ses outils en minuscules et leurs champs en camelCase (`read` et
 * `filePath`), là où le journal porte ceux de Claude Code (`Read` et `file_path`), que
 * les vues du web et l'invite de permission savent déjà lire. La traduction se fait
 * ici, à la source ; le payload natif reste intact dans `raw`.
 */

type Fields = Record<string, unknown>

function fields(value: unknown): Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Renomme les clés connues, et garde les autres telles quelles plutôt que de les perdre. */
function rename(input: Fields, names: Record<string, string>): Fields {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [names[key] ?? key, value]))
}

const FILE_KEYS = { filePath: 'file_path', oldString: 'old_string', newString: 'new_string', replaceAll: 'replace_all' }

const BUILTIN: Record<string, { name: string; input: (input: Fields) => Fields }> = {
  bash: { name: 'Bash', input: (input) => rename(input, { workdir: 'cwd' }) },
  read: { name: 'Read', input: (input) => rename(input, FILE_KEYS) },
  edit: { name: 'Edit', input: (input) => rename(input, FILE_KEYS) },
  write: { name: 'Write', input: (input) => rename(input, FILE_KEYS) },
  glob: { name: 'Glob', input: (input) => input },
  grep: { name: 'Grep', input: (input) => input },
  webfetch: { name: 'WebFetch', input: (input) => input },
  websearch: { name: 'WebSearch', input: (input) => input },
  todowrite: { name: 'TodoWrite', input: (input) => input },
  task: { name: 'Agent', input: (input) => input },
  skill: { name: 'Skill', input: (input) => input },
  apply_patch: { name: 'ApplyPatch', input: (input) => rename(input, { patchText: 'patch' }) },
}

/** L'outil `question` n'a pas de carte : la question elle-même en tient lieu. */
export const QUESTION_TOOL = 'question'

/**
 * Nom et entrée d'un appel, tels que le journal les porte.
 *
 * opencode préfixe les outils d'un serveur MCP par son nom (`sillage_read_card`) : le
 * préfixe redevient le `serveur/outil` que publient les deux autres adaptateurs. Seuls
 * les serveurs connus comptent, pour ne pas couper un outil intégré qui porterait un
 * tiret bas.
 */
export function describeTool(
  tool: string,
  input: unknown,
  mcpServers: string[],
): { name: string; input: unknown } {
  const builtin = BUILTIN[tool]
  if (builtin) return { name: builtin.name, input: builtin.input(fields(input)) }

  const server = mcpServers
    .filter((name) => tool.startsWith(`${name}_`))
    .sort((a, b) => b.length - a.length)[0]
  if (server) return { name: `${server}/${tool.slice(server.length + 1)}`, input }

  return { name: tool, input }
}

/**
 * Ce qu'une demande de permission montre. La clé `permission` d'opencode est une
 * famille d'outils (`edit` couvre `edit`, `write` et `apply_patch`), et le détail est
 * dans `metadata`.
 */
export function describePermission(
  permission: string,
  patterns: string[],
  metadata: unknown,
  cwd: string,
): { toolName: string; input: unknown } {
  const meta = fields(metadata)
  switch (permission) {
    case 'bash':
      return { toolName: 'Bash', input: { command: text(meta.command) ?? patterns.join(' && ') } }
    case 'edit': {
      const path = text(meta.filepath) ?? patterns[0] ?? ''
      return { toolName: 'Edit', input: { file_path: toWorkspacePath(cwd, path), diff: meta.diff } }
    }
    case 'webfetch':
      return { toolName: 'WebFetch', input: { url: text(meta.url) ?? patterns[0] ?? '' } }
    case 'external_directory':
      return { toolName: 'ExternalDirectory', input: { path: text(meta.filepath) ?? patterns[0] ?? '', ...meta } }
    default:
      return { toolName: BUILTIN[permission]?.name ?? permission, input: { patterns, ...meta } }
  }
}

interface PatchedFile {
  path: string
  action: 'created' | 'modified' | 'deleted'
  /** Diff unifié du fichier quand opencode le fournit. */
  diff: string | null
}

/**
 * Les fichiers qu'un appel terminé a touchés, lus dans ses métadonnées.
 *
 * `edit` et `write` en touchent un, `apply_patch` plusieurs. Les trois formes sont
 * tolérantes : un champ absent rend une liste vide plutôt qu'une modification inventée.
 */
function patchedFiles(part: ToolPart): PatchedFile[] {
  if (part.state.status !== 'completed') return []
  const input = fields(part.state.input)
  const meta = fields(part.state.metadata)

  if (part.tool === 'edit') {
    const path = text(fields(meta.filediff).file) ?? text(input.filePath)
    return path ? [{ path, action: 'modified', diff: text(meta.diff) }] : []
  }

  if (part.tool === 'write') {
    const path = text(meta.filepath) ?? text(input.filePath)
    // `exists` dit si le fichier était là avant l'écriture.
    return path ? [{ path, action: meta.exists === false ? 'created' : 'modified', diff: null }] : []
  }

  if (part.tool === 'apply_patch' && Array.isArray(meta.files)) {
    return meta.files.flatMap((entry): PatchedFile[] => {
      const file = fields(entry)
      const path = text(file.movePath) ?? text(file.filePath) ?? text(file.relativePath)
      if (!path) return []
      const action = file.type === 'add' ? 'created' : file.type === 'delete' ? 'deleted' : 'modified'
      return [{ path, action, diff: text(file.diff) ?? text(file.patch) }]
    })
  }

  return []
}

/** Les `file.edited` d'un appel terminé. */
export function fileEdits(part: ToolPart, cwd: string): SillageEvent[] {
  return patchedFiles(part).map((file) => ({
    type: 'file.edited',
    toolCallId: part.callID,
    path: toWorkspacePath(cwd, file.path),
    action: file.action,
  }))
}

/**
 * Le diff d'opencode ouvre sur un en-tête `Index:` à chemins absolus. Seules ses
 * sections sont reprises, sous l'en-tête git que l'affichage attend.
 */
function toGitPatch(path: string, diff: string): string | null {
  const start = diff.indexOf('\n@@')
  if (start < 0) return diff.startsWith('@@') ? `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${diff}` : null
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}${diff.slice(start)}`
}

/** Ce qu'un appel a fait d'un fichier, reconstitué depuis la part native journalisée. */
export function describeEdit(completedRaw: unknown, cwd: string, path: string): EditDiffDto {
  const part = (completedRaw as { part?: ToolPart } | null)?.part
  const file = part?.type === 'tool'
    ? patchedFiles(part).find((entry) => toWorkspacePath(cwd, entry.path) === path)
    : undefined

  const patch = file?.diff ? toGitPatch(path, file.diff) : null
  if (patch) return { path, kind: 'patch', patch, content: '', partial: false, reason: null }

  // `write` ne donne pas de diff, seulement le contenu écrit : une création se rend en
  // entier, une réécriture se montre telle qu'elle est après coup.
  const content = part ? fields(part.state.input).content : undefined
  if (file && part?.tool === 'write' && typeof content === 'string') {
    return file.action === 'created'
      ? { path, kind: 'patch', patch: additionDiff(path, content), content: '', partial: false, reason: null }
      : { path, kind: 'content', patch: '', content, partial: false, reason: null }
  }

  return {
    path,
    kind: 'unavailable',
    patch: '',
    content: '',
    partial: false,
    reason: "Le détail de cet appel n'a pas été conservé.",
  }
}
