import { z } from 'zod'
import type { CardColumn } from './cards.js'

/**
 * Search palette results not already found in the UI's navigation lists (projects,
 * conversations, tasks, MCP servers).
 */

/** Files returned per project: enough to expand a group without fetching everything. */
export const PALETTE_FILES_PER_PROJECT = 12

export const paletteFilesQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  /**
   * Conversation from which the palette opened: search its project in its working directory,
   * including its worktree, where the selected file will open.
   */
  conversationId: z.string().min(1).optional(),
})

export interface PaletteFileGroupDto {
  projectId: string
  /** Paths relative to the searched directory, most to least likely. */
  paths: string[]
}

export interface PaletteFilesDto {
  projects: PaletteFileGroupDto[]
}

/** A card reduced to searchable data displayed on one line. */
export interface PaletteCardDto {
  id: string
  projectId: string
  number: number
  title: string
  column: CardColumn
}

/** A library skill without the inspection required by its page. */
export interface PaletteSkillDto {
  id: string
  /** Null for global skills. */
  projectId: string | null
  name: string
  description: string
  enabled: boolean
}

/**
 * Data filtered by the palette itself, loaded once on opening: at most a few hundred rows that
 * then respond to typing without round trips.
 */
export interface PaletteCatalogDto {
  cards: PaletteCardDto[]
  skills: PaletteSkillDto[]
}
