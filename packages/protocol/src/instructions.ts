import { z } from 'zod'

/**
 * SILLAGE.md : des consignes tenues par Sillage et injectées dans le prompt système des
 * deux CLI, une partie globale et une par projet.
 *
 * Un projet garde ses consignes soit dans Sillage, soit dans son dépôt. En mode
 * `sillage`, les `CLAUDE.md` et `AGENTS.md` du workspace sont masqués aux CLI sans être
 * touchés sur le disque : les garder lus en plus doublerait les consignes. En mode
 * `repo`, la partie projet est le fichier du dépôt, que les CLI lisent d'eux-mêmes, et
 * Sillage n'y ajoute rien. La partie globale vaut dans les deux cas.
 */
export const instructionsModeSchema = z.enum(['sillage', 'repo'])
export type InstructionsMode = z.infer<typeof instructionsModeSchema>

/**
 * Fichiers de consignes reconnus à la racine d'un workspace, dans l'ordre de préférence.
 * `AGENTS.md` d'abord : Codex et Claude Code le lisent tous deux (sondé sur Claude Code
 * 2.1.286), alors que Codex ignore `CLAUDE.md`.
 */
export const REPO_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'] as const
export const repoInstructionFileSchema = z.enum(REPO_INSTRUCTION_FILES)
export type RepoInstructionFile = z.infer<typeof repoInstructionFileSchema>

/**
 * Plafond d'une partie de SILLAGE.md. Elle entre dans le contexte de chaque session : au
 * delà, elle pèse plus qu'elle n'oriente. Un `CLAUDE.md` copieux importé tient dedans.
 */
export const MAX_INSTRUCTIONS_CHARS = 40_000

/** Plafond d'écriture d'un fichier de consignes du dépôt depuis l'interface. */
export const MAX_REPO_INSTRUCTIONS_CHARS = 200_000

/** Dernière main sur une partie de SILLAGE.md. */
export type InstructionsAuthorDto =
  | { kind: 'user'; name: string }
  | { kind: 'session'; conversationId: string; projectId: string | null; title: string | null }

export interface InstructionsDto {
  content: string
  /** Null tant que personne n'y a rien écrit. */
  updatedAt: number | null
  author: InstructionsAuthorDto | null
  canEdit: boolean
}

export interface RepoInstructionFileDto {
  path: RepoInstructionFile
  content: string
}

export interface ProjectInstructionsDto extends InstructionsDto {
  /** Le mode en vigueur, résolu d'après le dossier pour un projet d'avant le réglage. */
  mode: InstructionsMode
  /** Faux quand le mode n'a jamais été choisi et vient d'être déduit du dossier. */
  modeChosen: boolean
  /** Les fichiers de consignes présents à la racine du workspace, lus tels quels. */
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
