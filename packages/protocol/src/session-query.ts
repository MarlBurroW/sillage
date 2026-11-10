import { z } from 'zod'
import type { WorktreeState } from './api.js'
import { slugifyProjectName } from './api.js'
import type { AgentKind } from './events.js'
import { agentKindSchema } from './events.js'
import { foldForMatch } from './fuzzy.js'

/**
 * Session query, modeled on GitHub's issue search: space-separated tokens must all hold,
 * `key:a,b` accepts either value, a leading `-` negates, bare words and "quoted phrases" search
 * the title. The text is the single source of truth: filter buttons only rewrite it, so a view
 * saved from buttons reads exactly like one typed by hand.
 *
 * Pure and dependency-free so the session wall, the sidebar or an agent tool can share it.
 */

/** Exclusive activity states: a session is in exactly one, so values combine with “or”. */
export const SESSION_STATES = ['running', 'attention', 'idle'] as const
export type SessionState = (typeof SESSION_STATES)[number]

export const SESSION_QUERY_VALUES = {
  is: [...SESSION_STATES, 'unread', 'favorite'],
  worktree: ['dirty', 'unmerged', 'leftovers', 'merged', 'missing', 'any', 'none'],
  active: ['15m', '30m', '1h', '2h', '1d'],
  sort: ['activity', 'created', 'title'],
  limit: ['4', '6', '8', '12'],
  cli: agentKindSchema.options,
} as const

export const SESSION_QUERY_KEYS = ['is', 'project', 'cli', 'worktree', 'active', 'sort', 'limit'] as const
export type SessionQueryKey = (typeof SESSION_QUERY_KEYS)[number]

/** Keys that accept several comma-separated values. The others take one. */
const MULTI: ReadonlySet<SessionQueryKey> = new Set(['is', 'project', 'cli', 'worktree'])
/** Keys that shape the result rather than select sessions: negating them means nothing. */
const SHAPING: ReadonlySet<SessionQueryKey> = new Set(['sort', 'limit'])
const MAX_LIMIT = 99

/** What the query can know about a session; callers build it from their own sources. */
export interface SessionFacts {
  id: string
  title: string
  /** Project name; null for personal discussions. Matched through `projectHandle`. */
  projectName: string | null
  agent: AgentKind
  state: SessionState
  unread: boolean
  favorite: boolean
  /** Null for a main-tree session, undefined while the project's trees are unknown. */
  worktree: WorktreeState | null | undefined
  /** Last journaled event or observed activity, in milliseconds. */
  activityAt: number
  createdAt: number
}

export type QueryProblem = 'unknown_key' | 'invalid_value' | 'not_negatable'

export interface QueryToken {
  /** Exact source text, including the `-` prefix and quotes. */
  raw: string
  start: number
  end: number
  negated: boolean
  /** Null for a title search. */
  key: SessionQueryKey | null
  /** Unknown key as typed, kept so the field can underline it. */
  typedKey: string | null
  /** Filter values, or the title words as one value. */
  values: string[]
  problem: QueryProblem | null
}

/**
 * Project name as typed after `project:`: lowercase, accents dropped, other characters folded to
 * dashes. `client-demo` and `"Client démo"` therefore name the same project.
 */
export function projectHandle(name: string): string {
  return slugifyProjectName(name)
}

/** Durations like `30m`, `2h` or `1d`, in milliseconds; null when malformed. */
export function parseQueryDuration(value: string): number | null {
  const match = /^(\d{1,4})([mhd])$/.exec(value)
  if (!match) return null
  const amount = Number(match[1])
  if (amount === 0) return null
  return amount * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 'm' | 'h' | 'd']
}

const TOKEN = /(-?)(?:([A-Za-z]+):)?("[^"]*"?|[^\s"]+)/g

export function parseSessionQuery(query: string): QueryToken[] {
  const tokens: QueryToken[] = []
  for (const match of query.matchAll(TOKEN)) {
    const [raw, dash, typedKey, body] = match as unknown as [string, string, string | undefined, string]
    const start = match.index ?? 0
    const negated = dash === '-'
    const value = body.startsWith('"') ? body.replace(/^"|"$/g, '') : body
    const base = { raw, start, end: start + raw.length, negated }
    if (typedKey === undefined) {
      tokens.push({ ...base, key: null, typedKey: null, values: [value], problem: value.trim() ? null : 'invalid_value' })
      continue
    }
    const key = (SESSION_QUERY_KEYS as readonly string[]).includes(typedKey.toLowerCase())
      ? (typedKey.toLowerCase() as SessionQueryKey)
      : null
    const values = value.split(',').map((entry) => entry.trim()).filter(Boolean)
    if (!key) {
      tokens.push({ ...base, key: null, typedKey, values, problem: 'unknown_key' })
      continue
    }
    tokens.push({ ...base, key, typedKey, values, problem: problemOf(key, values, negated) })
  }
  return tokens
}

function problemOf(key: SessionQueryKey, values: string[], negated: boolean): QueryProblem | null {
  if (negated && SHAPING.has(key)) return 'not_negatable'
  if (values.length === 0 || (!MULTI.has(key) && values.length > 1)) return 'invalid_value'
  const valid = (value: string): boolean => {
    switch (key) {
      case 'project': return projectHandle(value).length > 0
      case 'active': return parseQueryDuration(value) !== null
      case 'limit': return /^\d{1,2}$/.test(value) && Number(value) >= 1 && Number(value) <= MAX_LIMIT
      default: return (SESSION_QUERY_VALUES[key] as readonly string[]).includes(value)
    }
  }
  return values.every(valid) ? null : 'invalid_value'
}

function matches(session: SessionFacts, token: QueryToken, now: number): boolean {
  if (token.key === null) {
    const haystack = foldForMatch(session.title)
    return foldForMatch(token.values[0] ?? '').split(/\s+/).filter(Boolean).every((word) => haystack.includes(word))
  }
  const any = (test: (value: string) => boolean) => token.values.some(test)
  switch (token.key) {
    case 'is':
      return any((value) => value === 'unread' ? session.unread : value === 'favorite' ? session.favorite : session.state === value)
    case 'project': {
      const handle = session.projectName === null ? null : projectHandle(session.projectName)
      return any((value) => handle === projectHandle(value))
    }
    case 'cli':
      return token.values.includes(session.agent)
    case 'worktree':
      // Unknown trees match nothing either way: a negation must not claim what is not loaded.
      if (session.worktree === undefined) return token.negated
      return any((value) => value === 'any' ? session.worktree !== null : value === 'none' ? session.worktree === null : session.worktree === value)
    case 'active':
      return now - session.activityAt <= (parseQueryDuration(token.values[0]!) ?? 0)
    default:
      return true
  }
}

export interface SessionQueryResult {
  /** Matching ids in query order, cut to the limit. */
  ids: string[]
  /** Matches before the limit, so the screen can say “6 of 14”. */
  total: number
  sort: 'activity' | 'created' | 'title'
  limit: number | null
  tokens: QueryToken[]
}

/** Invalid tokens are reported and ignored: a typo must never empty the wall. */
export function evaluateSessionQuery(query: string, sessions: readonly SessionFacts[], now: number): SessionQueryResult {
  const tokens = parseSessionQuery(query)
  const valid = tokens.filter((token) => token.problem === null)
  const last = (key: SessionQueryKey) => valid.filter((token) => token.key === key).at(-1)?.values[0]
  const sort = (last('sort') ?? 'activity') as SessionQueryResult['sort']
  const limitText = last('limit')
  const limit = limitText ? Number(limitText) : null
  const filters = valid.filter((token) => token.key === null || !SHAPING.has(token.key))
  const hits = sessions.filter((session) => filters.every((token) => matches(session, token, now) !== token.negated))
  hits.sort(sort === 'title'
    ? (a, b) => a.title.localeCompare(b.title)
    : sort === 'created'
      ? (a, b) => b.createdAt - a.createdAt
      : (a, b) => b.activityAt - a.activityAt)
  const ids = hits.map((session) => session.id)
  return { ids: limit === null ? ids : ids.slice(0, limit), total: ids.length, sort, limit, tokens }
}

/* Editing helpers used by filter buttons: they rewrite the text and never hold state of their own. */

function rebuild(tokens: string[]): string {
  return tokens.filter(Boolean).join(' ')
}

/** Value written back into a token, quoted when it would otherwise split. */
function quoted(value: string): string {
  return /[\s,"]/.test(value) ? `"${value.replace(/"/g, '')}"` : value
}

/**
 * The positive token a button edits for `key`. `group` narrows it when one key carries several
 * independent buttons: running and attention share a token (“or”), unread keeps its own (“and”).
 */
function editable(tokens: QueryToken[], key: SessionQueryKey, group?: readonly string[]): QueryToken | undefined {
  return tokens.find((token) => token.key === key && !token.negated && (!group || token.values.every((value) => group.includes(value))))
}

/** Values a button shows as selected for `key`. */
export function queryValues(query: string, key: SessionQueryKey, group?: readonly string[]): string[] {
  return editable(parseSessionQuery(query), key, group)?.values ?? []
}

/** Adds or removes one value; single-value keys replace their value instead of accumulating. */
export function toggleQueryValue(query: string, key: SessionQueryKey, value: string, group?: readonly string[]): string {
  const tokens = parseSessionQuery(query)
  const raws = tokens.map((token) => token.raw)
  const target = editable(tokens, key, group)
  if (!target) return rebuild([...raws, `${key}:${quoted(value)}`])
  const index = tokens.indexOf(target)
  const selected = target.values.includes(value)
  const next = selected
    ? target.values.filter((entry) => entry !== value)
    : MULTI.has(key) ? [...target.values, value] : [value]
  raws[index] = next.length ? `${key}:${next.map(quoted).join(',')}` : ''
  return rebuild(raws)
}

/** Drops every positive token for `key`, as the “clear” entry of a filter menu. */
export function clearQueryKey(query: string, key: SessionQueryKey): string {
  return rebuild(parseSessionQuery(query).filter((token) => token.key !== key || token.negated).map((token) => token.raw))
}

/* Saved views: personal, stored in the account settings so they follow the user across devices. */

export const SESSION_VIEW_PRESETS = ['attention', 'running', 'unread', 'recent'] as const
export const SESSION_WALL_LAYOUTS = ['auto', '2', '3', '4'] as const

export const sessionViewSchema = z.object({
  id: z.string().min(1).max(64),
  /** Null while a built-in view keeps its translated name; renaming stores the user's text. */
  name: z.string().trim().min(1).max(60).nullable(),
  preset: z.enum(SESSION_VIEW_PRESETS).nullable(),
  query: z.string().max(500),
  layout: z.enum(SESSION_WALL_LAYOUTS),
  /** Sessions kept on this view whatever the query says. */
  pinned: z.array(z.string().max(64)).max(32),
})
export type SessionView = z.infer<typeof sessionViewSchema>
export const MAX_SESSION_VIEWS = 30

/** Views offered before the account saves any; editable and deletable like the others. */
export const DEFAULT_SESSION_VIEWS: SessionView[] = [
  { id: 'preset-attention', name: null, preset: 'attention', query: 'is:attention', layout: 'auto', pinned: [] },
  { id: 'preset-running', name: null, preset: 'running', query: 'is:running', layout: 'auto', pinned: [] },
  { id: 'preset-unread', name: null, preset: 'unread', query: 'is:unread limit:8', layout: 'auto', pinned: [] },
  { id: 'preset-recent', name: null, preset: 'recent', query: 'active:30m limit:6', layout: 'auto', pinned: [] },
]
