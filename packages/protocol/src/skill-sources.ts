import { z } from 'zod'
import {
  librarySkillScopeSchema,
  skillFilePathSchema,
  skillNameSchema,
  type LibrarySkillDto,
  type LibrarySkillScope,
} from './skill-library.js'

/**
 * Sources de la bibliothèque de skills : des dépôts git d'où l'on installe.
 *
 * Installer copie le skill et retient le commit. Rien de ce qui arrive ensuite dans le
 * dépôt n'entre dans le contexte des agents sans qu'on l'ait relu : une mise à jour se
 * montre en diff, et ne s'applique qu'à la demande.
 */

export interface SkillSourceDto {
  id: string
  name: string
  url: string
  /** Branche ou tag, null pour la branche par défaut. */
  ref: string | null
  /** Dossier du dépôt où chercher les skills, null pour tout le dépôt. */
  subpath: string | null
  builtin: boolean
  enabled: boolean
  /** Commit du dernier rafraîchissement réussi, null tant que rien n'a été récupéré. */
  lastCommit: string | null
  lastFetchedAt: number | null
  lastError: string | null
  /** Skills du dernier catalogue, null tant que la source n'a pas été récupérée. */
  skillCount: number | null
}

export interface SkillSourceListDto {
  sources: SkillSourceDto[]
}

/**
 * `url` accepte une URL de dépôt, ou `owner/repo` pour GitHub, la forme sous laquelle
 * skills.sh et les README désignent un dépôt.
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

/** Un skill d'une source, et ce que la bibliothèque en a déjà installé. */
export interface SourceSkillDto {
  /** Chemin du dossier dans le dépôt, clé de l'installation. */
  path: string
  name: string
  description: string
  problem: 'skill_unreadable' | 'skill_name_invalid' | null
  /** Le skill embarque des scripts, que l'agent exécutera. */
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
 * Ce qu'on relit avant d'installer : le `SKILL.md` entier, tel que le modèle le
 * recevra, et la liste des fichiers qui viendront avec.
 */
export interface SourceSkillPreviewDto {
  path: string
  commit: string
  main: string
  files: string[]
}

/** Chemin d'un skill dans sa source. Vide quand le dépôt lui-même est le skill. */
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

/** Ce qu'appliquer la mise à jour changerait, en diff unifié, du skill vers la source. */
export interface LibrarySkillUpdateDto {
  skill: LibrarySkillDto
  fromCommit: string
  toCommit: string
  patch: string
}

/** Un résultat de skills.sh. `sourceId` désigne la source déjà déclarée pour ce dépôt. */
export interface SkillSearchResultDto {
  /** `owner/repo` sur GitHub. */
  repository: string
  name: string
  installs: number
  sourceId: string | null
}

/**
 * `available` à faux quand skills.sh n'a pas répondu comme attendu : son API n'est pas
 * documentée, et l'interface masque alors la recherche plutôt que d'afficher une
 * erreur qui ne dépend pas de l'utilisateur.
 */
export interface SkillSearchDto {
  available: boolean
  results: SkillSearchResultDto[]
}
