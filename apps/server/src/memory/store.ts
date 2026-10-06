import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MEMORY_INDEX_FILE, memoryFileSchema, type MemoryFileDto } from '@sillage/protocol'

/**
 * Mémoire des agents, un dossier par projet sous `<data>/memory/projects/<id>`.
 *
 * Au format de la mémoire automatique de Claude Code, parce que c'est Claude qui l'écrit
 * nativement : Sillage lui passe ce dossier en `autoMemoryDirectory` (sondé sur Claude
 * Code 2.1.286, les écritures y passent sans permission, comme dans le dossier par
 * défaut). Un dossier par projet et non par répertoire de travail, comme le fait Claude
 * seul : les worktrees d'un projet partagent ce qu'ils apprennent.
 *
 * Le serveur MCP y écrit aussi pour Codex (`write_memory` dans `mcp/sillage-mcp.mjs`) :
 * les deux doivent rester d'accord sur la forme des noms et sur la tenue de l'index.
 */

/** Trace de l'import de la mémoire Claude d'avant, pour ne le faire qu'une fois. */
const IMPORT_MARKER = '.imported-from.json'

/** Au-delà, l'index injecté à Codex pèse plus qu'il n'oriente. */
const MAX_INJECTED_INDEX_CHARS = 20_000

export function projectMemoryDir(root: string, projectId: string): string {
  return join(root, 'projects', projectId)
}

/**
 * Le dossier où Claude Code range seul la mémoire d'un répertoire de travail : le chemin
 * dont chaque caractère hors lettres et chiffres devient un tiret.
 */
export function claudeNativeMemoryDir(cwd: string): string {
  const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(config, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), 'memory')
}

function hasNotes(dir: string): boolean {
  return existsSync(dir) && readdirSync(dir).some((name) => name.endsWith('.md'))
}

/**
 * Le dossier de mémoire du projet, créé au besoin, avec la mémoire que Claude tenait
 * déjà pour ce workspace importée la première fois.
 *
 * Copiée et non déplacée : l'original reste là pour une session lancée hors de Sillage.
 * L'import n'a lieu que dans un dossier encore vide, et une seule fois, d'où la trace :
 * sans elle, une mémoire vidée à la main se remplirait de nouveau au lancement suivant.
 */
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

/** Retire une note et sa ligne d'index : un pointeur vers un fichier absent tromperait. */
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

/**
 * La mémoire telle qu'on la donne à Codex en début de session : l'index, et de quoi
 * lire et écrire les notes. Claude n'en a pas besoin, il charge l'index de lui-même.
 * Null quand il n'y a ni index ni moyen d'écrire : rien à dire.
 */
export function memoryAppendixForCodex(dir: string, sillageMcp: boolean): string | null {
  let index = ''
  try {
    index = readFileSync(join(dir, MEMORY_INDEX_FILE), 'utf8').trim()
  } catch {
    // Pas encore d'index.
  }
  if (!index && !sillageMcp) return null
  if (index.length > MAX_INJECTED_INDEX_CHARS) {
    index = `${index.slice(0, MAX_INJECTED_INDEX_CHARS)}\n… (index tronqué, la suite est dans ${MEMORY_INDEX_FILE})`
  }

  const parts = [
    `# Mémoire du projet\n\nNotes que les sessions précédentes, quel que soit leur CLI, ont prises sur ce projet. Elles sont dans \`${dir}\`, une par fichier : lis avec \`cat\` celles qui touchent ta tâche. Une note peut avoir vieilli ; vérifie-la avant de t'appuyer dessus.`,
    index ? `## ${MEMORY_INDEX_FILE}\n\n${index}` : 'La mémoire est encore vide.',
  ]
  if (sillageMcp) {
    parts.push(
      "Pour retenir un fait qui servira aux sessions suivantes et que le dépôt ne dit pas (une préférence de l'utilisateur, une décision, un piège rencontré), écris une note avec `write_memory` du serveur `sillage` : un fichier markdown avec un en-tête `name`, `description` et `type` (`user`, `feedback`, `project` ou `reference`), puis le fait. Corrige ou retire une note fausse avec `write_memory` et `delete_memory`. Une règle que l'utilisateur fixe pour tous ses agents va plutôt dans SILLAGE.md.",
    )
  }
  return parts.join('\n\n')
}
