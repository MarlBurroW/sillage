import { z } from 'zod'

/**
 * Sillage-managed skill library, delivered to CLIs as native skills.
 *
 * Distinct from `skills.ts`, which describes inventory published by a CLI itself. Here Sillage
 * owns the files, stores them on its disk and passes them at each launch without writing into
 * `~/.claude` or `~/.codex`. Once delivered, they appear in that inventory like any other
 * skill.
 */

/**
 * Global: every conversation in the instance. Project: conversations in one project.
 *
 * No intermediate scope hiding a global skill from one project: both CLIs read entire roots,
 * and filtering delivery would also hide the user's personal skills.
 */
export const librarySkillScopeSchema = z.enum(['global', 'project'])
export type LibrarySkillScope = z.infer<typeof librarySkillScopeSchema>

/**
 * Agent Skills specification limits, enforced by both CLIs.
 *
 * The name is also the directory and command name: `/name` in Claude, `$name` in Codex. Hence
 * the restricted alphabet, excluding path separators and characters that would split command
 * input.
 */
export const SKILL_NAME_MAX_LENGTH = 64
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024
/** Maximum `SKILL.md` body size, loaded entirely into context on invocation. */
export const SKILL_BODY_MAX_LENGTH = 200_000

export const skillNameSchema = z
  .string()
  .max(SKILL_NAME_MAX_LENGTH)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)

/** The description triggers a skill by explaining when to use it. */
export const skillDescriptionSchema = z.string().trim().min(1).max(SKILL_DESCRIPTION_MAX_LENGTH)

export const skillBodySchema = z.string().max(SKILL_BODY_MAX_LENGTH)

/**
 * How a skill behaves differently depending on the CLI loading it.
 *
 * - `codex_no_arguments`: `$ARGUMENTS` or `argument-hint`. Claude substitutes them; Codex
 * leaves markers for the model, which may or may not interpret them.
 * - `claude_only_field`: frontmatter field ignored by Codex (`field` names it).
 * - `runs_scripts`: bundled scripts executed with the agent's own permissions.
 */
export const skillCompatNoteSchema = z.object({
  code: z.enum(['codex_no_arguments', 'claude_only_field', 'runs_scripts']),
  field: z.string().nullable(),
})
export type SkillCompatNote = z.infer<typeof skillCompatNoteSchema>

/**
 * Why a library skill cannot be delivered as-is.
 *
 * Disk is authoritative, and someone may have changed it outside Sillage: a missing directory,
 * unreadable `SKILL.md`, or `name` no longer matching the directory, which each CLI resolves
 * differently.
 */
export const librarySkillProblemSchema = z.enum([
  'skill_missing',
  'skill_unreadable',
  'skill_name_mismatch',
])
export type LibrarySkillProblem = z.infer<typeof librarySkillProblemSchema>

export const librarySkillSchema = z.object({
  id: z.string(),
  scope: librarySkillScopeSchema,
  projectId: z.string().nullable(),
  name: z.string(),
  /** Reread from `SKILL.md`; empty if unreadable. */
  description: z.string(),
  enabled: z.boolean(),
  /** Origin of a source-installed skill; null for one created here. */
  origin: z
    .object({
      /** Null if the source was since deleted: origin remains readable. */
      sourceId: z.string().nullable(),
      sourceName: z.string().nullable(),
      path: z.string(),
      commit: z.string(),
    })
    .nullable(),
  /** Contents differ from the installed version. Always false without an origin. */
  locallyModified: z.boolean(),
  /** Source had a different version from the installed one at the latest refresh. */
  updateAvailable: z.boolean(),
  compat: z.array(skillCompatNoteSchema),
  problem: librarySkillProblemSchema.nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type LibrarySkillDto = z.infer<typeof librarySkillSchema>

export const librarySkillDetailSchema = librarySkillSchema.extend({
  body: z.string(),
  /** Entire frontmatter, including `name` and `description`. */
  frontmatter: z.record(z.unknown()),
  /** Sorted paths relative to the skill directory, including `SKILL.md`. */
  files: z.array(z.string()),
})
export type LibrarySkillDetailDto = z.infer<typeof librarySkillDetailSchema>

export interface LibrarySkillListDto {
  skills: LibrarySkillDto[]
  /**
   * Instance switch (`[skills] library` in `config.toml`). When false, nothing is delivered to
   * CLIs and the UI says so rather than implying otherwise.
   */
  enabled: boolean
}

export const createLibrarySkillBodySchema = z
  .object({
    scope: librarySkillScopeSchema,
    projectId: z.string().nullable().default(null),
    name: skillNameSchema,
    description: skillDescriptionSchema,
    body: skillBodySchema.default(''),
  })
  .refine((body) => (body.scope === 'project') === (body.projectId !== null), {
    message: 'projectId is required for a project skill, and forbidden for a global one',
    path: ['projectId'],
  })
export type CreateLibrarySkillBody = z.infer<typeof createLibrarySkillBodySchema>

/**
 * Scope changes require both `scope` and `projectId`: together they describe the destination;
 * either alone is insufficient.
 */
export const updateLibrarySkillBodySchema = z
  .object({
    name: skillNameSchema,
    description: skillDescriptionSchema,
    body: skillBodySchema,
    enabled: z.boolean(),
    scope: librarySkillScopeSchema,
    projectId: z.string().nullable(),
  })
  .partial()
  .refine((body) => (body.scope === undefined) === (body.projectId === undefined), {
    message: 'scope and projectId must be changed together',
    path: ['scope'],
  })
  .refine(
    (body) => body.scope === undefined || (body.scope === 'project') === (body.projectId !== null),
    { message: 'projectId is required for a project skill, and forbidden for a global one', path: ['projectId'] },
  )
export type UpdateLibrarySkillBody = z.infer<typeof updateLibrarySkillBodySchema>

/** Destination scope shared by every way of adding a skill to the library. */
const targetFields = {
  scope: librarySkillScopeSchema,
  projectId: z.string().nullable().default(null),
}
const targetIsConsistent = (body: { scope: LibrarySkillScope; projectId: string | null }) =>
  (body.scope === 'project') === (body.projectId !== null)
const targetMessage = {
  message: 'projectId is required for a project skill, and forbidden for a global one',
  path: ['projectId'],
}

// Supporting files

/**
 * File path within a skill directory, using `/` separators.
 *
 * The server rechecks it because it writes to disk. This schema rejects early and explains why.
 */
export const skillFilePathSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.includes('\0') &&
      path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    { message: 'relative path expected, without empty, "." or ".." segments' },
  )

/**
 * `SKILL.md` is excluded: its frontmatter carries the name, which must match the directory.
 * Edit it through skill fields.
 */
export const SKILL_MAIN_FILE = 'SKILL.md'

/** Larger supporting files can be downloaded but not edited in the UI. */
export const SKILL_TEXT_FILE_MAX_BYTES = 1_000_000

export interface LibrarySkillFileDto {
  path: string
  size: number
  /** Null for binary files or files too large for the editor. */
  content: string | null
}

export const writeSkillFileBodySchema = z.object({
  content: z.string().max(SKILL_TEXT_FILE_MAX_BYTES),
})

// Adding skills to the library

/**
 * Imports a `.zip` or `.skill` archive, with scope and name in URL parameters: multipart fields
 * arrive only at their turn in the stream, as with explorer uploads.
 *
 * `name` overrides frontmatter to import a skill whose name is already taken without editing
 * the archive.
 */
export const importLibrarySkillQuerySchema = z
  .object({
    ...targetFields,
    projectId: z.string().min(1).optional().transform((value) => value ?? null),
    name: skillNameSchema.optional(),
  })
  .refine(targetIsConsistent, targetMessage)
export type ImportLibrarySkillQuery = z.infer<typeof importLibrarySkillQuerySchema>

export const duplicateLibrarySkillBodySchema = z
  .object({ ...targetFields, name: skillNameSchema })
  .refine(targetIsConsistent, targetMessage)
export type DuplicateLibrarySkillBody = z.infer<typeof duplicateLibrarySkillBodySchema>

/**
 * Where an existing local skill was found, hence which CLI sees it: `claude-*` for Claude only,
 * `agents-*` and `codex-*` for Codex only.
 */
export const localSkillOriginSchema = z.enum([
  'claude-user',
  'agents-user',
  'codex-user',
  'claude-repo',
  'agents-repo',
])
export type LocalSkillOrigin = z.infer<typeof localSkillOriginSchema>

export interface LocalSkillDto {
  origin: LocalSkillOrigin
  /** Absolute directory path, used as the import key. */
  path: string
  name: string
  description: string
  /** Unreadable or invalid name: listed for visibility, but cannot be imported. */
  problem: 'skill_unreadable' | 'skill_name_invalid' | null
}

export interface LocalSkillListDto {
  skills: LocalSkillDto[]
}

/** Import a skill found on the machine: copy it, leaving the original in place. */
export const adoptLibrarySkillBodySchema = z
  .object({ ...targetFields, path: z.string().min(1), name: skillNameSchema.optional() })
  .refine(targetIsConsistent, targetMessage)
export type AdoptLibrarySkillBody = z.infer<typeof adoptLibrarySkillBodySchema>
