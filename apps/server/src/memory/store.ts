import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MEMORY_INDEX_FILE, memoryFileSchema, type MemoryFileDto } from '@sillage/protocol'

/** Agent memory, one directory per project under `<data>/memory/projects/<id>`. Uses Claude Code's native automatic-memory format, supplied via `autoMemoryDirectory` (probed on Claude Code 2.1.286: writes require no permission, like its default directory). Scope by project rather than working directory so worktrees share learning. MCP also writes Codex notes (`write_memory` in `mcp/sillage-mcp.mjs`); both implementations must agree on filenames and index maintenance. */

/** Marker for one-time import of previous Claude memory. */
const IMPORT_MARKER = '.imported-from.json'

/** Beyond this size, Codex's injected index costs more context than guidance it provides. */
const MAX_INJECTED_INDEX_CHARS = 20_000

export function projectMemoryDir(root: string, projectId: string): string {
  return join(root, 'projects', projectId)
}

/** Claude Code's native memory directory for a working directory: replace each nonalphanumeric path character with a hyphen. */
export function claudeNativeMemoryDir(cwd: string): string {
  const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(config, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), 'memory')
}

function hasNotes(dir: string): boolean {
  return existsSync(dir) && readdirSync(dir).some((name) => name.endsWith('.md'))
}

/** Creates project memory when needed and imports existing Claude workspace memory once. Copy rather than move so CLI sessions outside Sillage retain originals. Import only into empty directories and record completion: otherwise manually emptied memory would reappear on the next launch. */
export function ensureProjectMemory(root: string, projectId: string, workspacePath: string): string {
  const dir = projectMemoryDir(root, projectId)
  mkdirSync(dir, { recursive: true })
  const marker = join(dir, IMPORT_MARKER)
  if (existsSync(marker)) return dir

  const native = claudeNativeMemoryDir(workspacePath)
  const imported = !hasNotes(dir) && hasNotes(native)
  if (imported) cpSync(native, dir, { recursive: true, errorOnExist: false, force: false })
  writeFileSync(marker, JSON.stringify({ dir: imported ? native : null, at: Date.now() }))
  return dir
}

export function readImportMarker(dir: string): { dir: string; at: number } | null {
  try {
    const marker = JSON.parse(readFileSync(join(dir, IMPORT_MARKER), 'utf8')) as {
      dir: string | null
      at: number
    }
    return marker.dir ? { dir: marker.dir, at: marker.at } : null
  } catch {
    return null
  }
}

export async function listMemory(dir: string): Promise<MemoryFileDto[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  const files = await Promise.all(
    names
      .filter((name) => memoryFileSchema.safeParse(name).success)
      .map(async (file) => {
        const path = join(dir, file)
        const info = await stat(path).catch(() => null)
        if (!info?.isFile()) return null
        return { file, content: await readFile(path, 'utf8'), updatedAt: info.mtimeMs }
      }),
  )
  return files
    .filter((file) => file !== null)
    .sort((a, b) =>
      a.file === MEMORY_INDEX_FILE ? -1 : b.file === MEMORY_INDEX_FILE ? 1 : a.file.localeCompare(b.file),
    )
}

export async function writeMemoryFile(dir: string, file: string, content: string): Promise<void> {
  memoryFileSchema.parse(file)
  await writeFile(join(dir, file), content, 'utf8')
}

/** Deletes notes and their index entries; pointers to missing files would mislead. */
export async function deleteMemoryFile(dir: string, file: string): Promise<void> {
  memoryFileSchema.parse(file)
  await rm(join(dir, file), { force: true })
  if (file === MEMORY_INDEX_FILE) return
  const indexPath = join(dir, MEMORY_INDEX_FILE)
  const index = await readFile(indexPath, 'utf8').catch(() => null)
  if (index === null) return
  const kept = index.split('\n').filter((line) => !line.includes(`](${file})`))
  await writeFile(indexPath, kept.join('\n'), 'utf8')
}

/** Memory supplied to Codex at session start: index and note read/write instructions. Claude loads its own index and needs none. Null without both an index and a write mechanism. */
export function memoryAppendixForCodex(dir: string, sillageMcp: boolean, scope: 'project' | 'personal' = 'project', includeIndex = true, nativeFileAccess = true): string | null {
  let index = ''
  try {
    if (includeIndex) index = readFileSync(join(dir, MEMORY_INDEX_FILE), 'utf8').trim()
  } catch {
    // No index yet.
  }
  if (!index && !sillageMcp) return null
  if (index.length > MAX_INJECTED_INDEX_CHARS) {
    index = `${index.slice(0, MAX_INJECTED_INDEX_CHARS)}\n… (index truncated; read the rest in ${MEMORY_INDEX_FILE})`
  }

  const parts = [
    // Antigravity's file viewer refuses paths outside its workspace and denies the whole parallel batch with them.
    `# ${scope === 'personal' ? 'Personal' : 'Project'} memory\n\nNotes left by previous sessions across CLIs. They are in \`${dir}\`, one file per note: ${nativeFileAccess ? 'use `cat`' : sillageMcp ? 'your file viewer cannot open that directory, so use the `sillage` server\'s `read_memory` tool' : 'your file viewer cannot open that directory, so use `cat` in a shell command'} to read those relevant to your task. Notes can become outdated; verify them before relying on them.`,
    ...(includeIndex ? [index ? `## ${MEMORY_INDEX_FILE}\n\n${index}` : 'Memory is empty.'] : []),
  ]
  if (sillageMcp) {
    parts.push(
      "To retain information useful to later sessions that the repository does not provide (a user preference, decision or pitfall), use the `sillage` server's `write_memory` tool: a Markdown file with frontmatter containing `name`, `description` and `type` (`user`, `feedback`, `project` or `reference`), followed by the information. Correct or remove false notes with `write_memory` and `delete_memory`. Explicit rules the user sets for all agents belong in SILLAGE.md; personal preferences belong in memory.",
    )
  }
  return parts.join('\n\n')
}
