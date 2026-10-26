import { z } from 'zod'
import { createProjectBodySchema } from './api.js'
import type { MemoryFileDto } from './memory.js'

export interface PersonalWorkspaceDto {
  id: string
  name: string
  path: string
  createdAt: number
  conversations: { id: string; title: string }[]
}

export interface PersonalMemoryChangeDto {
  id: string
  file: string
  before: string | null
  after: string | null
  conversationId: string | null
  createdAt: number
}

export interface PersonalMemoryDto {
  mode: 'sillage'
  dir: string
  files: MemoryFileDto[]
  importedFrom: null
  canEdit: true
  changes: PersonalMemoryChangeDto[]
}

export const continueInProjectBodySchema = z.object({
  project: createProjectBodySchema,
  brief: z.string().trim().min(1).max(40_000),
  /** Explicit selection; personal memory and the full transcript never transfer implicitly. */
  files: z.array(z.string().min(1).max(1024)).max(100).default([]),
})
