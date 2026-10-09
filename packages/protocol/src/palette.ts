import { z } from 'zod'
import type { CardColumn } from './cards.js'

/**
 * Palette de recherche : ce qu'elle ne trouve pas déjà dans les listes que l'interface
 * tient pour la navigation (projets, conversations, tâches, serveurs MCP).
 */

/** Fichiers rendus par projet : de quoi déplier un groupe sans tout rapatrier. */
export const PALETTE_FILES_PER_PROJECT = 12

export const paletteFilesQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  /**
   * Conversation d'où la palette est ouverte : son projet se cherche dans son répertoire,
   * worktree compris, puisque c'est là que le fichier choisi s'ouvrira.
   */
  conversationId: z.string().min(1).optional(),
})

export interface PaletteFileGroupDto {
  projectId: string
  /** Chemins relatifs au répertoire cherché, du plus probable au moins probable. */
  paths: string[]
}

export interface PaletteFilesDto {
  projects: PaletteFileGroupDto[]
}

/** Une carte réduite à ce qui se cherche et s'affiche sur une ligne. */
export interface PaletteCardDto {
  id: string
  projectId: string
  number: number
  title: string
  column: CardColumn
}

/** Un skill de la bibliothèque, sans l'inspection que demande sa page. */
export interface PaletteSkillDto {
  id: string
  /** Null pour un skill global. */
  projectId: string | null
  name: string
  description: string
  enabled: boolean
}

/**
 * Ce que la palette filtre elle-même, chargé une fois à l'ouverture : quelques centaines
 * de lignes au plus, qui répondent ensuite à la frappe sans aller-retour.
 */
export interface PaletteCatalogDto {
  cards: PaletteCardDto[]
  skills: PaletteSkillDto[]
}
