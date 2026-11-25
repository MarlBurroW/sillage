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

/** What the palette shows after an action that leaves it open. */
export interface PaletteNotice {
  text: string
  /** A result worth opening next, such as the ticket just created. */
  item?: PaletteItem
  /** Close shortly after: the notice was only there to confirm an invisible effect. */
  close?: boolean
  error?: boolean
}

/**
 * A second question asked in the palette itself: choose among a few results, or type a value. Its
 * name takes the token's place before the input, and going back is the token's gesture.
 */
export type PaletteStep =
  | {
      type: 'pick'
      key: string
      title: string
      placeholder: string
      /** Built on entry: the list may be long and most steps are never opened. */
      items: () => PaletteItem[]
    }
  | {
      type: 'input'
      key: string
      title: string
      placeholder: string
      initial: string
      /** Label of the only row, given the typed text. */
      action: (text: string) => string
      submit: (text: string) => void
    }

export type PaletteTarget =
  | { type: 'navigate'; to: string }
  | { type: 'file'; projectId: string; path: string }
  | { type: 'run'; run: () => void }
  | { type: 'step'; step: PaletteStep }
  /** Runs with the palette open, which then shows the outcome: creating things in a row, copying. */
  | { type: 'stay'; run: () => Promise<PaletteNotice> }

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
  /** Group shown instead of the project's: the open session's commands, creations. */
  group?: string
  /** Live state shown before the annotation, such as a session's activity. */
  badge?: ReactNode
  /** Left out of usage ranking: its key does not name a lasting destination. */
  transient?: boolean
  /** Order among equal results without a timestamp, higher first: ticket numbers. */
  rank?: number
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
/** Commands acting on the open session. */
export const SESSION_GROUP = 'session'
/** Sessions waiting on the user, leading the palette before any query. */
export const ATTENTION_GROUP = 'attention'
/** Things made from the typed text. */
export const CREATE_GROUP = 'create'

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

function hitOf(item: PaletteItem, tokens: readonly string[], usage?: ReadonlyMap<string, number>): PaletteHit | null {
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
    score: match.score + (item.boost ?? 0) + (usage?.get(item.key) ?? 0),
    title: [...title].sort((a, b) => a - b),
    detail: [...detail].sort((a, b) => a - b),
  }
}

function compareHits(a: PaletteHit, b: PaletteHit): number {
  return (
    TIER[a.item.kind] - TIER[b.item.kind] ||
    b.score - a.score ||
    KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] ||
    (b.item.at ?? b.item.rank ?? 0) - (a.item.at ?? a.item.rank ?? 0) ||
    a.item.title.localeCompare(b.item.title)
  )
}

export interface RankContext {
  currentProjectId: string | null
  /** Sidebar order, breaking ties between equally scored groups. */
  projectOrder: readonly string[]
  /** Score added per result key for what this browser picks often; see `paletteUsageBoosts`. */
  usage?: ReadonlyMap<string, number>
}

function groupTier(group: PaletteGroup): number {
  return group.hits[0] ? TIER[group.hits[0].item.kind] : 0
}

function groupRank(context: RankContext, group: PaletteGroup): number {
  if (group.key === SESSION_GROUP) return -1
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
    const hit = hitOf(item, tokens, context.usage)
    if (hit) groupOf(groups, item).hits.push(hit)
  }

  for (const group of groups.values()) {
    group.hits.sort(compareHits)
    const current = group.projectId !== null && group.projectId === context.currentProjectId
    group.score = (group.hits[0]?.score ?? 0) + (current ? CURRENT_PROJECT_BONUS : 0)
  }

  return [...groups.values()].sort(
    (a, b) => groupTier(a) - groupTier(b) || b.score - a.score || groupRank(context, a) - groupRank(context, b),
  )
}

function groupOf(groups: Map<string, PaletteGroup>, item: PaletteItem): PaletteGroup {
  const key = item.group ?? item.projectId ?? GENERAL_GROUP
  let group = groups.get(key)
  if (!group) {
    group = { key, projectId: item.group ? null : item.projectId, hits: [], score: 0 }
    groups.set(key, group)
  }
  return group
}

/**
 * Every result of the given kinds without a query, for a prefix typed alone: `>` lists the commands.
 * The open session's commands lead, then the current project, then the rest in sidebar order.
 */
export function browsePalette(items: readonly PaletteItem[], context: RankContext): PaletteGroup[] {
  const groups = new Map<string, PaletteGroup>()
  for (const item of items) {
    if (item.fixedScore !== undefined) continue
    groupOf(groups, item).hits.push({ item, score: (item.boost ?? 0) + (context.usage?.get(item.key) ?? 0), title: [], detail: [] })
  }
  for (const group of groups.values()) group.hits.sort(compareHits)
  const rank = (group: PaletteGroup) =>
    group.projectId !== null && group.projectId === context.currentProjectId ? -0.5 : groupRank(context, group)
  return [...groups.values()].sort((a, b) => rank(a) - rank(b))
}

/** Key of the synthetic group naming other projects inside a scoped search. */
export const PROJECTS_GROUP = 'projects'

/**
 * Threads of no project sit in the general group beside commands and settings. A scope hides them
 * like any other content found outside the project.
 */
const THREAD_KINDS: ReadonlySet<PaletteKind> = new Set(['conversation', 'message'])

export interface ScopedPalette {
  groups: PaletteGroup[]
  /** Results the scope hides, offered by the row that widens the search. */
  elsewhere: number
  /** Nothing matched inside the scope, so `groups` holds the unscoped results instead of a dead end. */
  fallback: boolean
}

/**
 * Narrow ranked groups to one project. The scope filters content, not navigation: other projects
 * stay reachable by name, and commands and settings by theirs, or the default scope would make
 * switching projects a two-step gesture.
 */
export function scopePalette(groups: readonly PaletteGroup[], scopeId: string): ScopedPalette {
  const kept: PaletteGroup[] = []
  const projects: PaletteHit[] = []
  let elsewhere = 0

  for (const group of groups) {
    if (group.projectId === scopeId) {
      kept.push(group)
    } else if (group.projectId === null) {
      const hits = group.hits.filter((hit) => !THREAD_KINDS.has(hit.item.kind))
      elsewhere += group.hits.length - hits.length
      if (hits[0]) kept.push({ ...group, hits, score: hits[0].score })
    } else {
      for (const hit of group.hits) {
        if (hit.item.kind === 'project') projects.push(hit)
        else elsewhere += 1
      }
    }
  }

  if (kept.length === 0 && projects.length === 0) return { groups: [...groups], elsewhere: 0, fallback: elsewhere > 0 }

  if (projects[0]) {
    projects.sort(compareHits)
    kept.push({ key: PROJECTS_GROUP, projectId: null, hits: projects, score: projects[0].score })
  }
  // Stable: equal groups keep the ranked order, scoped project first.
  kept.sort((a, b) => groupTier(a) - groupTier(b) || b.score - a.score)
  return { groups: kept, elsewhere, fallback: false }
}

/**
 * A first character that restricts the search to one family of results, the way editors do it.
 * Kind names typed as words keep working; the prefix is the short form that never collides with
 * a title containing the word.
 */
export const PALETTE_PREFIXES = {
  '>': ['command', 'action', 'setting'],
  '#': ['card'],
  '/': ['file'],
} as const satisfies Record<string, readonly PaletteKind[]>

export type PalettePrefix = keyof typeof PALETTE_PREFIXES

export function parsePaletteQuery(raw: string): { prefix: PalettePrefix | null; text: string } {
  const trimmed = raw.trimStart()
  const first = trimmed[0]
  if (first !== undefined && first in PALETTE_PREFIXES) {
    return { prefix: first as PalettePrefix, text: trimmed.slice(1).trim() }
  }
  return { prefix: null, text: trimmed.trim() }
}

export function prefixKinds(prefix: PalettePrefix): ReadonlySet<PaletteKind> {
  return new Set<PaletteKind>(PALETTE_PREFIXES[prefix])
}

const USAGE_KEY = 'sillage.palette.usage'
/** Entries kept: beyond the most recent picks, a count no longer says anything about habits. */
const USAGE_ENTRIES = 200
/** A pick weighs half as much after this long: habits follow the current work. */
const USAGE_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000
/**
 * Below the current-project bonus: habit settles ties and near-ties, and never lifts a weak match
 * over a clearly better one.
 */
const USAGE_MAX = 0.8

type UsageLog = Record<string, { count: number; at: number }>

function readUsage(): UsageLog {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(USAGE_KEY) ?? '{}')
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as UsageLog) : {}
  } catch {
    // Unreadable storage or a damaged entry only costs the habit ranking.
    return {}
  }
}

/** Remember that a result was chosen. Per browser on purpose: it is a habit of this device's hands. */
export function recordPaletteUse(key: string, now = Date.now()): void {
  const log = readUsage()
  log[key] = { count: (log[key]?.count ?? 0) + 1, at: now }
  const kept = Object.entries(log).sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0)).slice(0, USAGE_ENTRIES)
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify(Object.fromEntries(kept)))
  } catch {
    // Private browsing or a full quota: the palette works the same without it.
  }
}

/** Score to add per result key, read once per palette opening. */
export function paletteUsageBoosts(now = Date.now()): Map<string, number> {
  const boosts = new Map<string, number>()
  for (const [key, entry] of Object.entries(readUsage())) {
    if (typeof entry?.count !== 'number' || typeof entry.at !== 'number') continue
    const decay = 0.5 ** (Math.max(0, now - entry.at) / USAGE_HALF_LIFE_MS)
    boosts.set(key, Math.min(USAGE_MAX, 0.3 * Math.log2(1 + entry.count)) * decay)
  }
  return boosts
}

/** Conversations offered with no query, by project. */
const RECENT_IN_CURRENT = 5
const RECENT_PER_PROJECT = 3
const RECENT_PROJECTS = 4
/** A scoped palette shows one project, so its recent conversations get the room of the others. */
const RECENT_IN_SCOPE = 8

/**
 * Without a query the palette is a quick switcher: recent conversations, current project first,
 * then most recently used projects. Exclude the open conversation, which leads nowhere, and
 * scheduled runs, which are not interactive sessions. `scoped` keeps the current project alone
 * and names the other recent projects instead of listing their conversations.
 */
export function recentPalette(
  conversations: readonly ConversationDto[],
  items: ReadonlyMap<string, PaletteItem>,
  { currentProjectId, currentConversationId, visibleProjects, scoped = false, attention = [] }: {
    currentProjectId: string | null
    currentConversationId: string | null
    visibleProjects: ReadonlySet<string>
    scoped?: boolean
    /** What waits on the user, shown first; a session listed there is not repeated below. */
    attention?: readonly PaletteItem[]
  },
): PaletteGroup[] {
  const waiting = new Set(attention.map((item) => item.key))
  const byProject = new Map<string, ConversationDto[]>()
  const recent = [...conversations]
    .filter(
      (entry) =>
        entry.id !== currentConversationId &&
        !waiting.has(`conversation:${entry.id}`) &&
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

  const blank = (item: PaletteItem): PaletteHit => ({ item, score: 0, title: [], detail: [] })
  const others = scoped
    ? order
        .filter((projectId) => projectId !== '' && projectId !== currentProjectId)
        .slice(0, RECENT_PROJECTS)
        .map((projectId) => items.get(`project:${projectId}`))
        .filter((item) => item !== undefined)
        .map(blank)
    : []
  const shown = scoped ? order.filter((projectId) => projectId === currentProjectId) : order.slice(0, RECENT_PROJECTS)

  const groups = shown.map((projectId): PaletteGroup => {
    const limit = scoped ? RECENT_IN_SCOPE : projectId === currentProjectId ? RECENT_IN_CURRENT : RECENT_PER_PROJECT
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
  return [
    ...(attention.length > 0 ? [{ key: ATTENTION_GROUP, projectId: null, hits: attention.map(blank), score: 0 }] : []),
    ...groups,
    ...(others.length > 0 ? [{ key: PROJECTS_GROUP, projectId: null, hits: others, score: 0 }] : []),
  ]
}

/** The modifier key the platform actually uses, as written on its keyboards. */
export const PALETTE_MODIFIER = navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl'
export const PALETTE_SHORTCUT = `${PALETTE_MODIFIER} K`

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
export function usePaletteFiles(query: string, conversationId: string | null, scopeId: string | null) {
  const trimmed = query.trim()
  const settled = useDebounced(trimmed, 150)
  const result = useQuery({
    queryKey: ['palette', 'files', settled, conversationId, scopeId],
    queryFn: () => {
      const params = new URLSearchParams({ q: settled })
      if (conversationId) params.set('conversationId', conversationId)
      if (scopeId) params.set('projectId', scopeId)
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
