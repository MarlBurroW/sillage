import { z } from 'zod'

/**
 * Mémoire d'un projet : les notes que les agents prennent eux-mêmes, au format de la
 * mémoire automatique de Claude Code (`MEMORY.md` en index, une note par fichier).
 *
 * À distinguer de SILLAGE.md : les consignes sont des règles qu'on donne aux agents, la
 * mémoire est ce qu'ils ont appris en route. Claude l'écrit nativement, Sillage ne fait
 * que déplacer son dossier (`autoMemoryDirectory`) ; Codex la reçoit en début de session
 * et l'écrit par les outils MCP de Sillage.
 */
export const MEMORY_INDEX_FILE = 'MEMORY.md'

/** Un nom de note : un fichier markdown à plat, sans chemin. */
export const memoryFileSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.md$/, 'Expected a flat markdown file name.')

/** Plafond d'une note écrite depuis l'interface ou par un agent. */
export const MAX_MEMORY_FILE_CHARS = 100_000

export interface MemoryFileDto {
  file: string
  content: string
  updatedAt: number
}

export interface ProjectMemoryDto {
  /** Le dossier sur le disque, que Claude écrit et que Codex lit. */
  dir: string
  /** `MEMORY.md` d'abord, puis les notes par nom. */
  files: MemoryFileDto[]
  /** Dossier de la mémoire Claude importée au premier lancement, s'il y en a eu un. */
  importedFrom: { dir: string; at: number } | null
  canEdit: boolean
}

export const writeMemoryFileBodySchema = z.object({
  content: z.string().max(MAX_MEMORY_FILE_CHARS),
})
