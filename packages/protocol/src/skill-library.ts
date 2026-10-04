import { z } from 'zod'

/**
 * Bibliothèque de skills tenue par Sillage, livrée aux CLI comme des skills natifs.
 *
 * À ne pas confondre avec `skills.ts`, qui décrit l'inventaire qu'un CLI publie de
 * lui-même. Ici, c'est Sillage qui possède les fichiers : il les range sur son disque et
 * les transmet à chaque lancement, sans rien écrire dans `~/.claude` ni dans `~/.codex`.
 * Une fois livrés, ils réapparaissent dans cet inventaire comme n'importe quel autre.
 */

/**
 * Globale : toutes les conversations de l'instance. Projet : celles d'un projet.
 *
 * Pas de portée intermédiaire qui masquerait un skill global dans un seul projet : les
 * deux CLI lisent une racine entière, et filtrer à la livraison masquerait aussi les
 * skills personnels de l'utilisateur.
 */
export const librarySkillScopeSchema = z.enum(['global', 'project'])
export type LibrarySkillScope = z.infer<typeof librarySkillScopeSchema>

/**
 * Bornes de la spécification Agent Skills, que les deux CLI appliquent.
 *
 * Le nom est aussi celui du dossier et de la commande : `/nom` côté Claude, `$nom` côté
 * Codex. D'où l'alphabet restreint, qui ne laisse passer ni séparateur de chemin ni
 * caractère qu'une saisie de commande couperait.
 */
export const SKILL_NAME_MAX_LENGTH = 64
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024
/** Plafond du corps de `SKILL.md`, chargé en entier dans le contexte à l'invocation. */
export const SKILL_BODY_MAX_LENGTH = 200_000

export const skillNameSchema = z
  .string()
  .max(SKILL_NAME_MAX_LENGTH)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)

/** C'est la description qui déclenche le skill : elle dit quand s'en servir. */
export const skillDescriptionSchema = z.string().trim().min(1).max(SKILL_DESCRIPTION_MAX_LENGTH)

export const skillBodySchema = z.string().max(SKILL_BODY_MAX_LENGTH)

/**
 * Ce qu'un skill fera différemment selon le CLI qui le charge.
 *
 * - `codex_no_arguments` : `$ARGUMENTS` ou `argument-hint`. Claude substitue, Codex
 *   laisse le marqueur au modèle, qui l'interprète ou non.
 * - `claude_only_field` : un champ du frontmatter que Codex ignore (`field` le nomme).
 * - `runs_scripts` : le skill embarque des scripts, que l'agent exécutera avec ses
 *   propres droits.
 */
export const skillCompatNoteSchema = z.object({
  code: z.enum(['codex_no_arguments', 'claude_only_field', 'runs_scripts']),
  field: z.string().nullable(),
})
export type SkillCompatNote = z.infer<typeof skillCompatNoteSchema>

/**
 * Pourquoi un skill de la bibliothèque n'est pas livrable tel quel.
 *
 * Le disque fait foi, et quelqu'un peut y avoir touché sans passer par Sillage : un
 * dossier disparu, un `SKILL.md` illisible, ou un `name` qui ne correspond plus au
 * dossier, que les CLI départagent chacun à sa façon.
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
  /** Relue dans le `SKILL.md`, vide quand le fichier est illisible. */
  description: z.string(),
  enabled: z.boolean(),
  /** Provenance d'un skill installé depuis une source, null pour un skill créé ici. */
  origin: z
    .object({
      sourceId: z.string().nullable(),
      path: z.string(),
      commit: z.string(),
    })
    .nullable(),
  /** Contenu différent de celui installé. Toujours faux sans provenance. */
  locallyModified: z.boolean(),
  compat: z.array(skillCompatNoteSchema),
  problem: librarySkillProblemSchema.nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type LibrarySkillDto = z.infer<typeof librarySkillSchema>

export const librarySkillDetailSchema = librarySkillSchema.extend({
  body: z.string(),
  /** Le frontmatter entier, `name` et `description` compris. */
  frontmatter: z.record(z.unknown()),
  /** Chemins relatifs au dossier du skill, `SKILL.md` compris, triés. */
  files: z.array(z.string()),
})
export type LibrarySkillDetailDto = z.infer<typeof librarySkillDetailSchema>

export interface LibrarySkillListDto {
  skills: LibrarySkillDto[]
  /**
   * Interrupteur d'instance (`[skills] library` dans `config.toml`). À faux, rien n'est
   * livré aux CLI, et l'interface le dit plutôt que de laisser croire le contraire.
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
 * Changer de portée passe par `scope` et `projectId` ensemble : le couple décrit une
 * destination, et un seul des deux ne suffit pas à la dire.
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
