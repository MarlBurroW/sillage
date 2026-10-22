import { z } from 'zod'

/**
 * Project memory: notes agents take themselves in Claude Code auto-memory format (`MEMORY.md`
 * index, one note per file).
 *
 * Distinct from SILLAGE.md: instructions are rules given to agents; memory is what they learned
 * along the way. Claude writes it natively; Sillage only relocates its directory
 * (`autoMemoryDirectory`). Codex receives it at session start and writes through Sillage MCP
 * tools.
 */
export const MEMORY_INDEX_FILE = 'MEMORY.md'

/**
 * Project memory location: Sillage (`sillage`), one directory per project shared across CLIs
 * and worktrees, or each CLI (`native`), with Claude using per-working-directory memory in
 * `~/.claude` and other CLIs using their own, invisible to Sillage.
 */
export const memoryModeSchema = z.enum(['sillage', 'native'])
export type MemoryMode = z.infer<typeof memoryModeSchema>

/** Note name: a flat markdown filename without a path. */
export const memoryFileSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.md$/, 'Expected a flat markdown file name.')

/** Size limit for a note written through the UI or by an agent. */
export const MAX_MEMORY_FILE_CHARS = 100_000

export interface MemoryFileDto {
  file: string
  content: string
  updatedAt: number
}

export interface ProjectMemoryDto {
  mode: MemoryMode
  /** On-disk directory written by Claude and read by Codex; empty in native mode. */
  dir: string
  /** `MEMORY.md` first, then notes by name. */
  files: MemoryFileDto[]
  /** Directory of Claude memory imported at first launch, if any. */
  importedFrom: { dir: string; at: number } | null
  canEdit: boolean
}

export const writeMemoryFileBodySchema = z.object({
  content: z.string().max(MAX_MEMORY_FILE_CHARS),
})
