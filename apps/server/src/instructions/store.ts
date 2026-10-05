import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { conversations, instructions, users, type Db, type InstructionsRow } from '@sillage/db'
import {
  REPO_INSTRUCTION_FILES,
  type InstructionsAuthorDto,
  type InstructionsMode,
  type RepoInstructionFile,
  type RepoInstructionFileDto,
} from '@sillage/protocol'

/**
 * SILLAGE.md : lecture, écriture, et ce qu'on en injecte aux CLI.
 *
 * Le contenu vit en base, une ligne `global` et une par projet. Le serveur MCP y écrit
 * aussi, de son côté (`edit_instructions` et `write_instructions` dans `mcp/sillage-mcp.mjs`) : les deux doivent
 * rester d'accord sur la forme des lignes et sur la résolution du mode.
 */

export const GLOBAL_INSTRUCTIONS_ID = 'global'

/** Les fichiers de consignes présents à la racine d'un dossier, dans l'ordre de préférence. */
export function repoInstructionFiles(workspacePath: string): RepoInstructionFile[] {
  return REPO_INSTRUCTION_FILES.filter((name) => existsSync(join(workspacePath, name)))
}

export async function readRepoInstructionFiles(
  workspacePath: string,
): Promise<RepoInstructionFileDto[]> {
  const found = await Promise.all(
    REPO_INSTRUCTION_FILES.map(async (path) => {
      const content = await readFile(join(workspacePath, path), 'utf8').catch(() => null)
      return content === null ? null : { path, content }
    }),
  )
  return found.filter((file) => file !== null)
}

/**
 * Le mode en vigueur pour un projet.
 *
 * Un projet d'avant le réglage n'en a pas : il garde ce qu'il faisait, c'est-à-dire les
 * fichiers du dépôt quand il en a. Sans fichier, Sillage ne change rien non plus, la
 * partie projet étant vide ; c'est la première écriture qui fixe alors le mode.
 */
export function resolveInstructionsMode(project: {
  instructionsMode: InstructionsMode | null
  workspacePath: string
}): InstructionsMode {
  if (project.instructionsMode) return project.instructionsMode
  return repoInstructionFiles(project.workspacePath).length > 0 ? 'repo' : 'sillage'
}

export function readInstructions(db: Db, projectId: string | null): InstructionsRow | undefined {
  return db
    .select()
    .from(instructions)
    .where(eq(instructions.id, projectId ?? GLOBAL_INSTRUCTIONS_ID))
    .get()
}

export function writeInstructions(
  db: Db,
  projectId: string | null,
  content: string,
  userId: string,
): InstructionsRow {
  const row: InstructionsRow = {
    id: projectId ?? GLOBAL_INSTRUCTIONS_ID,
    projectId,
    content,
    updatedAt: Date.now(),
    updatedByUserId: userId,
    updatedByConversationId: null,
  }
  db.insert(instructions)
    .values(row)
    .onConflictDoUpdate({
      target: instructions.id,
      set: {
        content: row.content,
        updatedAt: row.updatedAt,
        updatedByUserId: row.updatedByUserId,
        updatedByConversationId: null,
      },
    })
    .run()
  return row
}

export function instructionsAuthor(
  db: Db,
  row: InstructionsRow | undefined,
): InstructionsAuthorDto | null {
  if (!row) return null
  if (row.updatedByConversationId) {
    const conversation = db
      .select({ title: conversations.title, projectId: conversations.projectId })
      .from(conversations)
      .where(eq(conversations.id, row.updatedByConversationId))
      .get()
    return {
      kind: 'session',
      conversationId: row.updatedByConversationId,
      projectId: conversation?.projectId ?? null,
      title: conversation?.title ?? null,
    }
  }
  if (row.updatedByUserId) {
    const user = db
      .select({ name: users.displayName })
      .from(users)
      .where(eq(users.id, row.updatedByUserId))
      .get()
    if (user) return { kind: 'user', name: user.name }
  }
  return null
}

interface AppendixInput {
  projectId: string
  mode: InstructionsMode
  /** L'agent a-t-il les outils SILLAGE.md du serveur MCP sous la main. */
  sillageMcp: boolean
}

/**
 * Le bloc SILLAGE.md à ajouter au prompt système, ou null quand il n'y a rien à dire.
 *
 * Le rappel des outils part même quand les deux parties sont vides : c'est le seul moyen
 * pour un agent d'apprendre qu'il peut tenir ces consignes, et les outils MCP ne sont pas
 * toujours chargés d'emblée.
 */
export function instructionsAppendix(db: Db, input: AppendixInput): string | null {
  const global = readInstructions(db, null)?.content.trim() ?? ''
  const project =
    input.mode === 'sillage' ? (readInstructions(db, input.projectId)?.content.trim() ?? '') : ''

  const parts: string[] = []
  if (global || project) {
    parts.push(
      "# SILLAGE.md\n\nConsignes de l'utilisateur tenues dans Sillage, communes à Claude et à Codex. Elles ont la même autorité qu'un CLAUDE.md ou un AGENTS.md.",
    )
    if (global) parts.push(`## Pour tous les projets\n\n${global}`)
    if (project) parts.push(`## Pour ce projet\n\n${project}`)
  }

  if (input.sillageMcp) {
    parts.push(
      input.mode === 'sillage'
        ? "SILLAGE.md se lit et se modifie comme un fichier de consignes, avec `read_instructions`, `edit_instructions` et `write_instructions` du serveur `sillage`. Quand l'utilisateur te donne une consigne durable (une préférence, une convention, un piège à éviter) ou te demande de revoir ces consignes, c'est là qu'il faut écrire, plutôt que dans une mémoire propre à ton CLI que l'autre ne lit pas : elles vaudront pour les sessions suivantes, de Claude comme de Codex. Rien de ce qui ne vaut que pour la tâche en cours."
        : "Les consignes de ce projet vivent dans le `AGENTS.md` ou le `CLAUDE.md` de son dépôt : c'est là qu'une consigne propre au projet se retient, avec tes outils de fichiers. Les outils SILLAGE.md du serveur `sillage` (`read_instructions`, `edit_instructions`, `write_instructions`) ne servent qu'à la partie valable pour tous les projets.",
    )
  }

  return parts.length > 0 ? parts.join('\n\n') : null
}

/** Caractères spéciaux de picomatch, pour qu'un chemin compte pour lui-même. */
function escapeGlob(path: string): string {
  return path.replace(/[\\*?[\]{}()!+@]/g, '\\$&')
}

/**
 * Motifs `claudeMdExcludes` qui masquent à Claude les consignes du dépôt.
 *
 * Bornés aux dossiers donnés : un motif sans racine masquerait aussi le `CLAUDE.md` de
 * `~/.claude`, sondé sur Claude Code 2.1.286.
 */
export function claudeMdExcludes(roots: string[]): string[] {
  const bases = new Set(roots.map((root) => escapeGlob(root.replace(/\/+$/, ''))))
  return [...bases].flatMap((base) => [
    `${base}/**/CLAUDE.md`,
    `${base}/**/CLAUDE.local.md`,
    `${base}/**/AGENTS.md`,
  ])
}
