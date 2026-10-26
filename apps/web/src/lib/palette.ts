import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import {
  foldForMatch,
  fuzzyTokens,
  matchFields,
  type ConversationDto,
  type FuzzyField,
  type PaletteCatalogDto,
  type PaletteFilesDto,
} from '@sillage/protocol'
import { api } from './api'
import { useDebounced } from './search'

/**
 * Search palette: every destination in one ranked list grouped by project. This module only handles
 * already-described results: the component builds them from UI lists, and ranking works uniformly
 * for conversations, files, and settings.
 */

export type PaletteKind =
  | 'project'
  | 'action'
  | 'conversation'
  | 'file'
  | 'card'
  | 'schedule'
  | 'skill'
  | 'mcp'
  | 'setting'
  | 'command'
  | 'message'

/**
 * Rank by kind: named entities before files, files before message excerpts. Repositories always
 * contain a file resembling the query: score alone let files bury the Power Rush project when
 * searching for power.
 */
const TIER: Record<PaletteKind, number> = {
  project: 0,
  action: 0,
  conversation: 0,
  card: 0,
  schedule: 0,
  skill: 0,
  mcp: 0,
  setting: 0,
  command: 0,
  file: 1,
  message: 2,
}

/** Break ties by putting commonly visited destinations first. */
const KIND_ORDER: Record<PaletteKind, number> = {
  project: 0,
  action: 1,
  conversation: 2,
  file: 3,
  card: 4,
  schedule: 5,
  skill: 6,
  mcp: 7,
  setting: 8,
  command: 9,
  message: 10,
}

export interface PaletteField extends FuzzyField {
  /**
   * Display field to highlight: title, detail line, or neither for filtering-only fields such as
   * project name or result kind.
   */
  role: 'title' | 'detail' | 'context'
  /**
   * Context sufficient by itself to include the result: typing skill lists skills, and typing a
   * project name lists its conversations. Otherwise context only narrows results: nimbus does not
   * return every Nimbus file.
   */
  browse?: boolean
  /** Field that must match at least one word for inclusion. */
  required?: boolean
}

export type PaletteTarget =
  | { type: 'navigate'; to: string }
  | { type: 'file'; projectId: string; path: string }
  | { type: 'run'; run: () => void }

export interface PaletteItem {
  key: string
  kind: PaletteKind
  /** Null for results belonging to no project: settings, global skills, MCP. */
  projectId: string | null
  title: string
  detail?: string
  /** Message excerpt including match bounds. */
  excerpt?: string
  /** Row marker: conversation agent, file icon, and so on. */
  icon: ReactNode
  /** Right-hand annotation: result kind or conversation state. */
  aside?: string
  /** Result timestamp: displayed as age after `aside`, also breaks ties in favor of newer results. */
  at?: number
  fields: PaletteField[]
  target: PaletteTarget
  /** Score adjustment: favorites rise, archived threads and disabled skills fall. */
  boost?: number
  /** Result already selected elsewhere, such as a server-found message. */
  fixedScore?: number
}

export interface PaletteHit {
  item: PaletteItem
  score: number
  /** Character indices to highlight in displayed title and detail. */
  title: number[]
  detail: number[]
}

export interface PaletteGroup {
  /** Project ID or `GENERAL_GROUP`. */
  key: string
  projectId: string | null
  hits: PaletteHit[]
  score: number
}

const GENERAL_GROUP = 'general'

/** Current-project bonus: prefer it for equal matches, but a stronger result elsewhere must still win. */
const CURRENT_PROJECT_BONUS = 1

/** Weights shared by result builders. */
export const WEIGHT = {
  title: 1,
  dir: 0.6,
  detail: 0.4,
  context: 0.35,
} as const

/** Search-ready field with its folded form computed once rather than on each keystroke. */
export function field(text: string, role: PaletteField['role'], weight: number, extra: Partial<PaletteField> = {}): PaletteField {
  return { text, role, weight, folded: foldForMatch(text), ...extra }
}

/** Project name, filtering without highlighting. */
export function projectField(name: string, extra: Pick<PaletteField, 'browse' | 'required'> = {}): PaletteField {
  return field(name, 'context', WEIGHT.context, { mode: 'strict', ...extra })
}

/** Result kind: typing ticket or skill lists that kind. */
export function kindField(label: string): PaletteField {
  return field(label, 'context', WEIGHT.context, { mode: 'strict', browse: true })
}

function hitOf(item: PaletteItem, tokens: readonly string[]): PaletteHit | null {
  if (item.fixedScore !== undefined) return { item, score: item.fixedScore, title: [], detail: [] }

  const match = matchFields(item.fields, tokens)
  if (!match) return null
  if (item.fields.some((entry, index) => entry.required && !match.matched[index])) return null
  const own = item.fields.some((entry, index) => match.matched[index] && entry.role !== 'context')
  const browsed = item.fields.some(
    (entry, index) => match.matched[index] && entry.role === 'context' && entry.browse,
  )
  if (!own && !browsed) return null

  const title = new Set<number>()
  const detail = new Set<number>()
  for (const [index, entry] of item.fields.entries()) {
    if (entry.role === 'context') continue
    const target = entry.role === 'title' ? title : detail
    for (const position of match.positions[index] ?? []) target.add(position)
  }

  return {
    item,
    score: match.score + (item.boost ?? 0),
    title: [...title].sort((a, b) => a - b),
    detail: [...detail].sort((a, b) => a - b),
  }
}

function compareHits(a: PaletteHit, b: PaletteHit): number {
  return (
    TIER[a.item.kind] - TIER[b.item.kind] ||
    b.score - a.score ||
    KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] ||
    (b.item.at ?? 0) - (a.item.at ?? 0) ||
    a.item.title.localeCompare(b.item.title)
  )
}

export interface RankContext {
  currentProjectId: string | null
  /** Sidebar order, breaking ties between equally scored groups. */
  projectOrder: readonly string[]
}

function groupRank(context: RankContext, group: PaletteGroup): number {
  if (group.projectId === null) return Number.MAX_SAFE_INTEGER
  const index = context.projectOrder.indexOf(group.projectId)
  return index === -1 ? Number.MAX_SAFE_INTEGER - 1 : index
}

/**
 * Rank all results against the query and group by project. Order groups by their best result rather
 * than sidebar position: searching a project name must bring it first even from another project.
 */
export function rankPalette(items: readonly PaletteItem[], query: string, context: RankContext): PaletteGroup[] {
  const tokens = fuzzyTokens(query)
  const groups = new Map<string, PaletteGroup>()

  for (const item of items) {
    const hit = hitOf(item, tokens)
    if (!hit) continue
    const key = item.projectId ?? GENERAL_GROUP
    let group = groups.get(key)
    if (!group) {
      group = { key, projectId: item.projectId, hits: [], score: 0 }
      groups.set(key, group)
    }
    group.hits.push(hit)
  }

  for (const group of groups.values()) {
    group.hits.sort(compareHits)
    const current = group.projectId !== null && group.projectId === context.currentProjectId
    group.score = (group.hits[0]?.score ?? 0) + (current ? CURRENT_PROJECT_BONUS : 0)
  }

  const tier = (group: PaletteGroup) => (group.hits[0] ? TIER[group.hits[0].item.kind] : 0)
  return [...groups.values()].sort(
    (a, b) => tier(a) - tier(b) || b.score - a.score || groupRank(context, a) - groupRank(context, b),
  )
}

/** Conversations offered with no query, by project. */
const RECENT_IN_CURRENT = 5
const RECENT_PER_PROJECT = 3
const RECENT_PROJECTS = 4

/**
 * Without a query the palette is a quick switcher: recent conversations, current project first,
 * then most recently used projects. Exclude the open conversation, which leads nowhere, and
 * scheduled runs, which are not interactive sessions.
 */
export function recentPalette(
  conversations: readonly ConversationDto[],
  items: ReadonlyMap<string, PaletteItem>,
  { currentProjectId, currentConversationId, visibleProjects }: {
    currentProjectId: string | null
    currentConversationId: string | null
    visibleProjects: ReadonlySet<string>
  },
): PaletteGroup[] {
  const byProject = new Map<string, ConversationDto[]>()
  const recent = [...conversations]
    .filter(
      (entry) =>
        entry.id !== currentConversationId &&
        entry.archivedAt === null &&
        entry.scheduleId === null &&
        (entry.projectId === null || visibleProjects.has(entry.projectId)),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
  for (const entry of recent) {
    const list = byProject.get(entry.projectId ?? '') ?? []
    list.push(entry)
    byProject.set(entry.projectId ?? '', list)
  }

  // Current-project actions precede its conversations: when opened, the palette is also the
  // shortest path to an action button.
  const runs = currentProjectId
    ? [...items.values()].filter(
        (item) => item.key.startsWith('run:') && item.projectId === currentProjectId,
      )
    : []
  if (runs.length > 0 && currentProjectId && !byProject.has(currentProjectId)) byProject.set(currentProjectId, [])

  const order = [...byProject.keys()].sort((a, b) => {
    if (a === currentProjectId) return -1
    if (b === currentProjectId) return 1
    return 0
  })

  return order.slice(0, RECENT_PROJECTS).map((projectId) => {
    const limit = projectId === currentProjectId ? RECENT_IN_CURRENT : RECENT_PER_PROJECT
    const hits = (byProject.get(projectId) ?? [])
      .slice(0, limit)
      .map((entry) => items.get(`conversation:${entry.id}`))
      .filter((item) => item !== undefined)
      .map((item): PaletteHit => ({ item, score: 0, title: [], detail: [] }))
    const lead = projectId === currentProjectId
      ? runs.map((item): PaletteHit => ({ item, score: 0, title: [], detail: [] }))
      : []
    return { key: projectId || GENERAL_GROUP, projectId: projectId || null, hits: [...lead, ...hits], score: 0 }
  })
}

/**
 * Lists filtered by the palette itself: cards and skills from all projects. Reread on every opening
 * rather than maintaining them live: renamed cards and newly added skills must appear, and the list
 * is lightweight.
 */
export function usePaletteCatalog(enabled: boolean) {
  return useQuery({
    queryKey: ['palette', 'catalog'],
    queryFn: () => api.get<PaletteCatalogDto>('/api/palette/catalog'),
    enabled,
    staleTime: 0,
  })
}

/** Below this length filenames are insufficiently distinctive and the tree walk is most expensive. */
export const PALETTE_FILES_MIN_QUERY = 2

/**
 * Files from all projects. `keepPreviousData` works because the palette reranks every file against
 * the current query: a late response never displays a nonmatching file, and the section does not
 * empty on every keystroke.
 */
export function usePaletteFiles(query: string, conversationId: string | null) {
  const trimmed = query.trim()
  const settled = useDebounced(trimmed, 150)
  const result = useQuery({
    queryKey: ['palette', 'files', settled, conversationId],
    queryFn: () => {
      const params = new URLSearchParams({ q: settled })
      if (conversationId) params.set('conversationId', conversationId)
      return api.get<PaletteFilesDto>(`/api/palette/files?${params}`)
    },
    enabled: settled.length >= PALETTE_FILES_MIN_QUERY,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  })
  return {
    data: result.data,
    isFetching: result.isFetching,
    isError: result.isError,
    // As with messages, the query is still waiting for its typing debounce.
    settling: settled !== trimmed && trimmed.length >= PALETTE_FILES_MIN_QUERY,
  }
}
