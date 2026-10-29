import { z } from 'zod'
import {
  librarySkillScopeSchema,
  skillFilePathSchema,
  skillNameSchema,
  type LibrarySkillDto,
  type LibrarySkillScope,
} from './skill-library.js'

/**
 * Skill library sources: git repositories used for installation.
 *
 * Installation copies the skill and records its commit. Later repository changes do not enter
 * agent context without review: updates are shown as diffs and applied only on request.
 */

export interface SkillSourceDto {
  id: string
  name: string
  url: string
  /** Branch or tag; null for the default branch. */
  ref: string | null
  /** Repository directory to search for skills; null for the whole repository. */
  subpath: string | null
  builtin: boolean
  enabled: boolean
  /** Commit of the latest successful refresh; null before any fetch. */
  lastCommit: string | null
  lastFetchedAt: number | null
  lastError: string | null
  /** Skills from the latest catalog; null before fetching the source. */
  skillCount: number | null
}

export interface SkillSourceListDto {
  sources: SkillSourceDto[]
}

/**
 * `url` accepts a repository URL or GitHub `owner/repo`, the form used by skills.sh and
 * READMEs.
 */
export const createSkillSourceBodySchema = z.object({
  url: z.string().trim().min(1).max(500),
  name: z.string().trim().min(1).max(100).optional(),
  ref: z.string().trim().min(1).max(200).nullable().default(null),
  subpath: skillFilePathSchema.nullable().default(null),
})
export type CreateSkillSourceBody = z.infer<typeof createSkillSourceBodySchema>

export const updateSkillSourceBodySchema = z
  .object({
    url: z.string().trim().min(1).max(500),
    name: z.string().trim().min(1).max(100),
    ref: z.string().trim().min(1).max(200).nullable(),
    subpath: skillFilePathSchema.nullable(),
    enabled: z.boolean(),
  })
  .partial()
export type UpdateSkillSourceBody = z.infer<typeof updateSkillSourceBodySchema>

/** A source skill and what the library has already installed from it. */
export interface SourceSkillDto {
  /** Directory path within the repository, used as the installation key. */
  path: string
  name: string
  description: string
  problem: 'skill_unreadable' | 'skill_name_invalid' | null
  /** The skill bundles scripts that the agent will execute. */
  scripts: boolean
  installed: {
    skillId: string
    scope: LibrarySkillScope
    projectId: string | null
    name: string
    updateAvailable: boolean
  }[]
}

export interface SkillSourceCatalogDto {
  source: SkillSourceDto
  skills: SourceSkillDto[]
}

/**
 * Review before installation: full `SKILL.md` as the model will receive it, plus the list of
 * accompanying files.
 */
export interface SourceSkillPreviewDto {
  path: string
  commit: string
  main: string
  files: string[]
}

/** Skill path within its source. Empty if the repository itself is the skill. */
export const sourceSkillPathSchema = z.union([z.literal(''), skillFilePathSchema])

export const installSourceSkillBodySchema = z
  .object({
    path: sourceSkillPathSchema,
    scope: librarySkillScopeSchema,
    projectId: z.string().nullable().default(null),
    name: skillNameSchema.optional(),
  })
  .refine((body) => (body.scope === 'project') === (body.projectId !== null), {
    message: 'projectId is required for a project skill, and forbidden for a global one',
    path: ['projectId'],
  })
export type InstallSourceSkillBody = z.infer<typeof installSourceSkillBodySchema>

/** What applying the update would change, as a unified diff from the skill to the source. */
export interface LibrarySkillUpdateDto {
  skill: LibrarySkillDto
  fromCommit: string
  toCommit: string
  patch: string
}

/** A skills.sh result. `sourceId` identifies the already registered source for this repository. */
export interface SkillSearchResultDto {
  /** Directory identifier, which can differ from the display name. */
  slug?: string
  /** GitHub `owner/repo`. */
  repository: string
  name: string
  installs: number
  sourceId: string | null
}

/**
 * `available` is false when skills.sh responds unexpectedly: its API is undocumented, so the UI
 * hides search rather than showing an error beyond the user's control.
 */
export interface SkillSearchDto {
  available: boolean
  results: SkillSearchResultDto[]
}
