import { z } from 'zod'
import type { AgentKind } from './events.js'

export const EXPORT_MAX_BYTES = 50 * 1024 * 1024
export const EXPORT_TTL_MS = 60 * 60 * 1000

const key = z.string().min(1).max(200)
const toolOptions = z.object({
  mode: z.enum(['hidden', 'summary', 'details']).default('summary'),
  input: z.boolean().default(false),
  output: z.boolean().default(false),
})
export const exportOptionsSchema = z.object({
  locale: z.enum(['en', 'fr']),
  title: z.string().trim().min(1).max(200),
  introduction: z.string().max(5000).default(''),
  author: z.string().max(100).default(''),
  from: key.nullable().default(null),
  to: key.nullable().default(null),
  excluded: z.array(key).max(50_000).default([]),
  tools: toolOptions.default({}),
  toolOverrides: z.record(toolOptions).default({}),
  images: z.array(key).max(500).default([]),
})
export type ExportOptions = z.infer<typeof exportOptionsSchema>
export const exportSelectionSchema = exportOptionsSchema.pick({
  from: true, to: true, excluded: true, tools: true, toolOverrides: true, images: true,
})
export type ExportSelectionOptions = z.infer<typeof exportSelectionSchema>
export interface ExportSelectionDto {
  included: number
  messages: number
  tools: number
  images: number
  from: ExportItemDto | null
  to: ExportItemDto | null
}
export type ExportFieldKind = 'title' | 'introduction' | 'author' | 'message' | 'question' | 'plan' | 'input' | 'output' | 'caption'
export interface ExportField { id: string; kind: ExportFieldKind; text: string; entryId: string | null }
export interface ExportImageDto { id: string; label: string; available: boolean }
export interface ExportItemDto {
  id: string
  kind: 'message' | 'tool' | 'question' | 'plan'
  role: 'user' | 'assistant'
  text: string
  images: ExportImageDto[]
}
export interface ExportItemsDto { items: ExportItemDto[]; total: number; next: number | null }
export type RedactionKind = 'secret' | 'email' | 'ip' | 'path'
export interface ExportFinding {
  id: string
  fieldId: string
  start: number
  end: number
  kind: RedactionKind
  /** Groups equal values without exposing them in identifiers or logs. */
  group: string
}
export const exportRenderSchema = z.object({
  revision: z.number().int().positive(),
  kept: z.array(key).max(50_000).default([]),
  manual: z.array(z.object({
    fieldId: key,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })).max(10_000).default([]),
  reviewedImages: z.array(key).max(500).default([]),
})
export type ExportRenderRequest = z.infer<typeof exportRenderSchema>
export const exportPublishSchema = z.object({
  revision: z.number().int().positive(),
  expiresAt: z.number().int().positive().nullable(),
})
export interface ExportDraftDto {
  id: string
  conversationId: string
  agent: AgentKind
  throughSeq: number
  revision: number
  status: 'preparing' | 'ready' | 'analyzing' | 'review' | 'rendering' | 'complete' | 'failed'
  progress: number
  error: string | null
  expiresAt: number
  options: ExportOptions
  total: number
  canPublish: boolean
  fields?: ExportField[]
  findings?: ExportFinding[]
  selectedImages?: ExportImageDto[]
  bytes?: number
}
export interface ConversationShareDto {
  id: string
  url: string | null
  title: string
  createdAt: number
  expiresAt: number | null
  revokedAt: number | null
}
