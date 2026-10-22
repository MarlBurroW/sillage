import { z } from 'zod'

/**
 * SILLAGE.md: Sillage-managed instructions injected into both CLIs' system prompts, with global
 * and per-project sections.
 *
 * A project keeps instructions either in Sillage or its repository. In `sillage` mode,
 * workspace `CLAUDE.md` and `AGENTS.md` are hidden from CLIs without touching disk; reading
 * both would duplicate instructions. In `repo` mode, CLIs read the repository file themselves
 * and Sillage adds nothing to the project section. Global instructions apply in both modes.
 */
export const instructionsModeSchema = z.enum(['sillage', 'repo'])
export type InstructionsMode = z.infer<typeof instructionsModeSchema>

/**
 * Recognized instruction files at the workspace root, in preference order. `AGENTS.md` first:
 * both Codex and Claude Code read it (probed on Claude Code 2.1.286), while Codex ignores
 * `CLAUDE.md`.
 */
export const REPO_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'] as const
export const repoInstructionFileSchema = z.enum(REPO_INSTRUCTION_FILES)
export type RepoInstructionFile = z.infer<typeof repoInstructionFileSchema>

/**
 * Size limit for a SILLAGE.md section. It enters every session's context; beyond this it weighs
 * more than it guides. Even a substantial imported `CLAUDE.md` fits.
 */
export const MAX_INSTRUCTIONS_CHARS = 40_000

/** Write limit for repository instruction files edited through the UI. */
export const MAX_REPO_INSTRUCTIONS_CHARS = 200_000

/** Last editor of a SILLAGE.md section. */
export type InstructionsAuthorDto =
  | { kind: 'user'; name: string }
  | { kind: 'session'; conversationId: string; projectId: string | null; title: string | null }

export interface InstructionsDto {
  content: string
  /** Null until someone writes content. */
  updatedAt: number | null
  author: InstructionsAuthorDto | null
  canEdit: boolean
}

export interface RepoInstructionFileDto {
  path: RepoInstructionFile
  content: string
}

export interface ProjectInstructionsDto extends InstructionsDto {
  /** Effective mode, resolved from the directory for projects predating the setting. */
  mode: InstructionsMode
  /** False if the mode was never chosen and was just inferred from the directory. */
  modeChosen: boolean
  /** Instruction files at the workspace root, read verbatim. */
  repoFiles: RepoInstructionFileDto[]
}

export const updateInstructionsBodySchema = z.object({
  content: z.string().max(MAX_INSTRUCTIONS_CHARS),
})

export const updateProjectInstructionsBodySchema = z
  .object({
    mode: instructionsModeSchema,
    content: z.string().max(MAX_INSTRUCTIONS_CHARS),
  })
  .partial()

export const writeRepoInstructionsBodySchema = z.object({
  path: repoInstructionFileSchema,
  content: z.string().max(MAX_REPO_INSTRUCTIONS_CHARS),
})
