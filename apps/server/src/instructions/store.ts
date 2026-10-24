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

/** SILLAGE.md reads, writes and CLI injection. Contents live in database rows, one `global` and one per project. MCP also writes independently (`edit_instructions` and `write_instructions` in `mcp/sillage-mcp.mjs`); both implementations must agree on row shape and mode resolution. */

export const GLOBAL_INSTRUCTIONS_ID = 'global'

/** Instruction files at directory roots in preference order. */
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

/** Effective project mode. Projects predating the setting preserve existing behavior: use repository files when present. Without files, Sillage changes nothing because project instructions are empty; the first write fixes the mode. */
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
  /** Whether agents have the MCP server's SILLAGE.md tools available. */
  sillageMcp: boolean
}

/** User instructions and response-language guidance added to system prompts. Include tool reminders even when both instruction sections are empty: agents need to learn they can maintain instructions, and MCP tools may not load immediately. */
export function instructionsAppendix(db: Db, input: AppendixInput): string | null {
  const global = readInstructions(db, null)?.content.trim() ?? ''
  const project =
    input.mode === 'sillage' ? (readInstructions(db, input.projectId)?.content.trim() ?? '') : ''

  // Apply even without MCP or stored instructions, in Server and Desktop alike.
  const parts: string[] = [
    "Reply in the user's language, following any explicit language preference they give. Otherwise, use the language of their current request; for unattended tasks, use the task request's language. Sillage's internal instructions and tool messages are in English for consistency, but their language does not determine your reply language. Do not switch languages because of tool results, quoted history, or messages from other agents.",
  ]
  if (global || project) {
    parts.push(
      "# SILLAGE.md\n\nUser instructions maintained in Sillage, shared by Claude, Codex, OpenCode, Grok and Antigravity. They have the same authority as a CLAUDE.md or AGENTS.md file.",
    )
    if (global) parts.push(`## For all projects\n\n${global}`)
    if (project) parts.push(`## For this project\n\n${project}`)
  }

  if (input.sillageMcp) {
    parts.push(
      input.mode === 'sillage'
        ? "Read and edit SILLAGE.md as an instruction file using the `sillage` server's `read_instructions`, `edit_instructions` and `write_instructions` tools. When the user gives a durable instruction (a preference, convention or pitfall to avoid), or asks you to review these instructions, write it there so it applies to future sessions across CLIs. Do not store task-specific details there; facts learned during work belong in project memory."
        : "This project's instructions live in its repository's `AGENTS.md` or `CLAUDE.md`: use your file tools to store project-specific instructions there. The `sillage` server's SILLAGE.md tools (`read_instructions`, `edit_instructions`, `write_instructions`) apply only to instructions shared by all projects.",
    )
  }

  return parts.length > 0 ? parts.join('\n\n') : null
}

/** Escapes picomatch special characters so paths match literally. */
function escapeGlob(path: string): string {
  return path.replace(/[\\*?[\]{}()!+@]/g, '\\$&')
}

/** `claudeMdExcludes` patterns hiding repository instructions from Claude. Restrict to supplied directories: rootless patterns also hide `~/.claude/CLAUDE.md`, as probed on Claude Code 2.1.286. */
export function claudeMdExcludes(roots: string[]): string[] {
  const bases = new Set(roots.map((root) => escapeGlob(root.replace(/\/+$/, ''))))
  return [...bases].flatMap((base) => [
    `${base}/**/CLAUDE.md`,
    `${base}/**/CLAUDE.local.md`,
    `${base}/**/AGENTS.md`,
  ])
}
