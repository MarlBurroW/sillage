import { z } from 'zod'
import { type ConversationStatus } from './api.js'
import { type AgentKind } from './events.js'

/**
 * Board column: a card's chosen workflow position.
 *
 * Deliberately not named `status`: that describes conversation execution state, and confusing
 * them is the central pitfall here. A card has three independent axes: its chosen column;
 * activity observed from associated conversations, never persisted here; and merge state read
 * from git. Only the first is a table field.
 *
 * The list is closed: customizable columns would make state ambiguous for derivations and tools
 * reading the board.
 */
export const cardColumnSchema = z.enum(['todo', 'in_progress', 'review', 'done', 'abandoned'])
export type CardColumn = z.infer<typeof cardColumnSchema>

/** Column display order, from backlog to exit columns. */
export const CARD_COLUMNS: readonly CardColumn[] = [
  'todo',
  'in_progress',
  'review',
  'done',
  'abandoned',
]

/**
 * Exit columns, collapsed by default: otherwise an old project becomes dominated by its
 * graveyard.
 */
export const CARD_CLOSED_COLUMNS: readonly CardColumn[] = ['done', 'abandoned']

export const CARD_TITLE_MAX = 200
const DESCRIPTION_MAX = 20_000

/**
 * Tag palette, as `#rrggbb` like project colors so every theme renders the same values. New tags
 * take the next unused color, so a board's first tags stay distinguishable without a choice.
 */
export const CARD_TAG_COLORS: readonly string[] = [
  '#5B9DF9', '#5BC98C', '#E5665F', '#D9B441', '#8B7BF7', '#3FBFC4', '#E8894F', '#E070A8', '#9AA3AF',
]
export const CARD_TAG_NAME_MAX = 40
export const CARD_TAG_DESCRIPTION_MAX = 300
/** Beyond a handful a tag stops classifying: the cap keeps agents from tagging everything. */
export const CARD_TAGS_PER_CARD_MAX = 8

/** Display form of a tag name: trimmed, inner whitespace collapsed. */
export function normalizeCardTagName(name: string): string {
  return name.trim().replace(/\s+/g, ' ')
}

/** Uniqueness key: `Bug`, `bug ` and `BUG` are one tag. */
export function cardTagKey(name: string): string {
  return normalizeCardTagName(name).toLocaleLowerCase()
}

const tagNameSchema = z
  .string()
  .transform(normalizeCardTagName)
  .pipe(z.string().min(1).max(CARD_TAG_NAME_MAX))
const tagColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const tagIdsSchema = z.array(z.string().uuid()).max(CARD_TAGS_PER_CARD_MAX)

export const createCardTagBodySchema = z.object({
  name: tagNameSchema,
  color: tagColorSchema.optional(),
  description: z.string().trim().max(CARD_TAG_DESCRIPTION_MAX).default(''),
})

export const updateCardTagBodySchema = z
  .object({
    name: tagNameSchema,
    color: tagColorSchema,
    description: z.string().trim().max(CARD_TAG_DESCRIPTION_MAX),
  })
  .partial()

/** Moves every card of the source tag onto `into`, then deletes the source. */
export const mergeCardTagBodySchema = z.object({ into: z.string().uuid() })

export const cardTagSettingsBodySchema = z.object({ agentsCanCreate: z.boolean() })

/** A tag as shown on a card: enough to render its chip. */
export interface CardTagRefDto {
  id: string
  name: string
  color: string
}

/** A tag in the project catalog. */
export interface CardTagDto extends CardTagRefDto {
  description: string
  cardCount: number
  /** Session that created it, for agent-made tags; null when a person did or it was deleted. */
  createdBy: { conversationId: string; title: string } | null
  createdAt: number
}

export interface CardTagCatalogDto {
  tags: CardTagDto[]
  /** Whether agents may create new tags by naming them (project setting). */
  agentsCanCreate: boolean
}

export const createCardBodySchema = z.object({
  /**
   * Create the card as an issue in the linked repository; if absent, board settings decide.
   * Ignored without a linked board.
   */
  github: z.boolean().optional(),
  title: z.string().min(1).max(CARD_TITLE_MAX),
  description: z.string().max(DESCRIPTION_MAX).default(''),
  column: cardColumnSchema.default('todo'),
  tagIds: tagIdsSchema.default([]),
})

export const updateCardBodySchema = z
  .object({
    title: z.string().min(1).max(CARD_TITLE_MAX),
    description: z.string().max(DESCRIPTION_MAX),
    column: cardColumnSchema,
    /** Replaces the card's full tag set. */
    tagIds: tagIdsSchema,
  })
  .partial()

/**
 * Card order per column, top to bottom.
 *
 * Moving a card affects one column when reordering, two when changing columns. Both are
 * therefore written atomically: separate requests would temporarily duplicate or lose the card.
 */
export const reorderCardsBodySchema = z.object({
  columns: z
    .array(
      z.object({
        column: cardColumnSchema,
        ids: z.array(z.string().uuid()),
      }),
    )
    .min(1)
    .max(CARD_COLUMNS.length),
})

/** A card viewed from another card: enough to render a `#12` badge without a second request. */
export interface CardLinkDto {
  id: string
  number: number
  title: string
  column: CardColumn
}

/** Inverse directions are views: only one relationship is persisted. */
export const cardRelationKindSchema = z.enum([
  'blocks', 'blocked_by', 'related', 'duplicates', 'duplicated_by',
  'parent', 'child', 'replaces', 'replaced_by',
])
export type CardRelationKind = z.infer<typeof cardRelationKindSchema>
export type StoredCardRelationKind = 'blocks' | 'related' | 'duplicates' | 'parent' | 'replaces'
export const CARD_RELATION_INVERSE: Record<CardRelationKind, CardRelationKind> = {
  blocks: 'blocked_by', blocked_by: 'blocks', related: 'related',
  duplicates: 'duplicated_by', duplicated_by: 'duplicates',
  parent: 'child', child: 'parent', replaces: 'replaced_by', replaced_by: 'replaces',
}
export const createCardRelationBodySchema = z.object({
  target: z.number().int().positive(),
  kind: cardRelationKindSchema,
})
export interface CardRelationDto {
  id: string
  kind: CardRelationKind
  card: CardLinkDto
}

/**
 * An associated conversation, with the information needed by the card.
 *
 * `status` is its load-time state, as elsewhere: WebSocket status updates have the final say on
 * the client.
 */
export interface CardConversationDto {
  id: string
  title: string
  agent: AgentKind
  status: ConversationStatus
  costUsd: number
  worktreeId: string | null
  worktreeName: string | null
  archivedAt: number | null
  createdAt: number
}

const NOTE_MAX = 8_000

export const createCardNoteBodySchema = z.object({
  body: z.string().min(1).max(NOTE_MAX),
  /** For a card linked to an issue: also publish the note as a comment. */
  publish: z.boolean().default(false),
})

/**
 * Publication state of a local note on the linked issue: sent, in progress, or rejected by
 * GitHub. Absent for notes that stayed local or came from GitHub.
 */
export type CardNotePublication = 'pending' | 'published' | 'failed'

/**
 * A note in a card's thread: what a session did, found or decided.
 *
 * Appended, never rewritten, and separate from the description: the description states the work
 * and is maintained by a person; notes are its history, written mostly by agents.
 */
export interface CardNoteDto {
  id: string
  body: string
  createdAt: number
  /**
   * Author. Agent notes carry their conversation so readers can inspect the work reported;
   * `null` if the conversation was later deleted, since the note outlives it.
   */
  author:
    | { kind: 'agent'; agent: AgentKind; conversationId: string | null; conversationTitle: string }
    | { kind: 'user'; name: string }
    /** A GitHub comment written by a community member or oneself. */
    | { kind: 'github'; login: string }
  /** The note's GitHub comment, either received from there or published from here. */
  externalUrl: string | null
  publication: CardNotePublication | null
  /** GitHub rejection code for a failed publication. */
  publicationError: string | null
}

/** Issue mirrored by a card, or from which it was detached. */
export interface CardExternalDto {
  provider: 'github'
  number: number
  url: string
  author: string | null
  labels: string[]
  state: 'open' | 'closed'
  /**
   * Detached: the card is local again, the issue lives independently on GitHub, and sync no
   * longer touches it. The link remains to preserve its origin.
   */
  detached: boolean
}

export interface CardDto {
  id: string
  projectId: string
  /** Short number, unique within the project, as written after `#`. */
  number: number
  title: string
  description: string
  column: CardColumn
  position: number
  createdBy: string
  createdByName: string
  createdAt: number
  updatedAt: number
  /** Arrival in the current column, for the board's arrival ordering. */
  columnEnteredAt: number
  conversations: CardConversationDto[]
  /** Notes are not included in listings: the board only displays their count. */
  attachmentCount: number
  noteCount: number
  /** Cards mentioned by this card's description. */
  references: CardLinkDto[]
  /** Cards whose descriptions mention this one. */
  referencedBy: CardLinkDto[]
  /** Linked GitHub issue for a connected board card; null for local cards. */
  external: CardExternalDto | null
  /** Sorted by name. */
  tags: CardTagRefDto[]
}

/**
 * `#` must start a word, like `@` for files: otherwise hexadecimal colors or URL fragments
 * would be mistaken for references.
 */
const CARD_REFERENCE = /(?:^|[^\w#])#(\d+)\b/g

/**
 * Card numbers cited in text, deduplicated in order of appearance.
 *
 * Shared by the server, which derives backlinks on save, and the web frontend, which builds
 * clickable badges. Two parsers would eventually diverge; a reference rendered on one side but
 * absent on the other is worse than no reference.
 */
export function parseCardReferences(text: string): number[] {
  const found: number[] = []
  for (const { number } of cardReferenceRanges(text)) {
    if (!found.includes(number)) found.push(number)
  }
  return found
}

/**
 * Every `#n` in text with its position: start of `#` and end of the number. Rendering replaces
 * it with a link without touching the preceding character.
 */
export function cardReferenceRanges(text: string): { start: number; end: number; number: number }[] {
  const ranges: { start: number; end: number; number: number }[] = []
  for (const match of text.matchAll(CARD_REFERENCE)) {
    const number = Number(match[1])
    if (!Number.isSafeInteger(number) || number <= 0) continue
    const end = match.index + match[0].length
    ranges.push({ start: end - (match[1] ?? '').length - 1, end, number })
  }
  return ranges
}

/**
 * Suggested branch name for a card's first session.
 *
 * The number comes first to link the branch to its card at a glance in `git branch`, where a
 * title alone does not reveal its origin.
 */
export function cardBranchName(number: number, title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug.length > 0 ? `feat/${number}-${slug}` : `feat/${number}`
}
