import {
  PALETTE_FILES_IN_SCOPE,
  PALETTE_FILES_PER_PROJECT,
  containsInOrder,
  foldForMatch,
  fuzzyTokens,
  matchFields,
  type FuzzyField,
  type PaletteFileGroupDto,
  type TreeSearchDto,
} from '@sillage/protocol'
import { listBrowsableFiles, listWorkspaceFiles } from '../files.js'

/**
 * File search for the palette, the explorer, quick open, `@` mentions and the agents' `find_files`:
 * one listing and one ranking, so they agree. Listings are cached because typing triggers repeated
 * searches and rerunning `git ls-files` per letter wastes work. The palette, which lists every
 * project at each keystroke, accepts them this old.
 */
const LISTING_TTL_MS = 15_000

/**
 * Age accepted by searches of a single directory: enough for a burst of typing, short enough that
 * a file an agent just created shows up at the next pause, as when these searches read the disk
 * every time. The explorer also drops listings when it changes entries.
 */
const FRESH_MS = 2_000

/** Per-directory cap prevents oversized repositories from exhausting daemon memory. */
const MAX_FILES = 50_000

/** Concurrent directory listings: forty simultaneous git processes would compete. */
const CONCURRENCY = 6

/** Field weights match the palette's later ranking: filenames matter more than directories, while project names only restrict matches. */
const NAME_WEIGHT = 1
const DIR_WEIGHT = 0.6
const PROJECT_WEIGHT = 0.35

/** Mention completion results: beyond this, lists no longer fit the composer's popover. */
export const MENTION_RESULTS = 30

/** Explorer search results: beyond this, the list is unreadable. */
const TREE_RESULTS = 80

/**
 * Which files a listing holds. `workspace` honors .gitignore entirely, for mentions and the
 * palette; `browsable` adds ignored files outside ignored directories, see `listBrowsableFiles`.
 */
type ListingKind = 'workspace' | 'browsable'

interface Listing {
  paths: string[]
  /** The same values normalized once for subsequent keystrokes. */
  folded: string[]
  /** Cut at MAX_FILES. */
  capped: boolean
  /** Shortest paths first, computed on first empty query. */
  byLength?: string[]
  /** Folders holding listed files, computed on the first search that offers folders. */
  dirs?: { paths: string[]; folded: string[] }
  /** Files and folders together, shortest first, for an empty mention query. */
  entriesByLength?: WorkspaceEntry[]
}

export interface WorkspaceEntry {
  path: string
  isDirectory: boolean
}

const listings = new Map<string, { pending: Promise<Listing>; at: number }>()
const listingKey = (cwd: string, kind: ListingKind) => `${kind}:${cwd}`

function listing(cwd: string, kind: ListingKind, maxAge: number): Promise<Listing> {
  const key = listingKey(cwd, kind)
  const cached = listings.get(key)
  if (cached && Date.now() - cached.at < maxAge) return cached.pending

  const pending = (kind === 'browsable' ? listBrowsableFiles(cwd) : listWorkspaceFiles(cwd))
    .then((all) => {
      const paths = all.slice(0, MAX_FILES)
      return { paths, folded: paths.map(foldForMatch), capped: all.length > MAX_FILES }
    })
    // Missing or unreadable directories must not suppress results from other projects.
    .catch((): Listing => ({ paths: [], folded: [], capped: false }))
  const entry = { pending, at: Date.now() }
  listings.set(key, entry)
  // Remove rather than mark stale: release memory once typing stops,
  // since the palette may not reopen for hours.
  setTimeout(() => {
    if (listings.get(key) === entry) listings.delete(key)
  }, LISTING_TTL_MS).unref()
  return pending
}

/** Forgets a directory's listings: the explorer just changed its entries, and its search must see that. */
export function forgetListings(cwd: string): void {
  listings.delete(listingKey(cwd, 'workspace'))
  listings.delete(listingKey(cwd, 'browsable'))
}

/**
 * Path score for query words, or null if one is missing. Filenames match fuzzily but directories
 * only contiguously, like VS Code: fuzzy-matching whole paths always found one letter per
 * directory, making the palette match packages/…/RateLimitResetType.ts. `extra` fields (a project
 * name) can take words but never make a match alone.
 */
function matchPath(path: string, folded: string, tokens: readonly string[], extra: readonly FuzzyField[] = []): number | null {
  const slash = path.lastIndexOf('/')
  const dir = Math.max(slash, 0)
  const match = matchFields(
    [
      { text: path.slice(slash + 1), folded: folded.slice(slash + 1), weight: NAME_WEIGHT },
      { text: path.slice(0, dir), folded: folded.slice(0, dir), weight: DIR_WEIGHT, mode: 'strict' },
      ...extra,
    ],
    tokens,
  )
  return match && (match.matched[0] || match.matched[1]) ? match.score : null
}

/**
 * Files of one directory matching a query, best first. Every word must occur in the path. Without
 * words, shorter paths come first: nearer the root, likelier targets.
 */
export async function searchWorkspaceFiles(
  cwd: string,
  query: string,
  { limit, includeIgnored = false }: { limit: number; includeIgnored?: boolean },
): Promise<{ paths: string[]; truncated: boolean }> {
  const found = await listing(cwd, includeIgnored ? 'browsable' : 'workspace', FRESH_MS)
  const tokens = fuzzyTokens(query)
  if (tokens.length === 0) {
    found.byLength ??= [...found.paths].sort((a, b) => a.length - b.length || a.localeCompare(b))
    return { paths: found.byLength.slice(0, limit), truncated: found.capped || found.paths.length > limit }
  }

  const scored: { path: string; score: number }[] = []
  for (const [index, path] of found.paths.entries()) {
    const folded = found.folded[index] as string
    if (!tokens.every((token) => containsInOrder(folded, token))) continue
    const score = matchPath(path, folded, tokens)
    if (score !== null) scored.push({ path, score })
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
  return { paths: scored.slice(0, limit).map(({ path }) => path), truncated: found.capped || scored.length > limit }
}

/**
 * Folders that hold at least one listed file. Derived rather than listed: git knows no folders,
 * and an empty one is no useful mention. Nested repositories, which git lists as `dir/`, count as
 * folders and are dropped from the files.
 */
function directoriesOf(found: Listing): { paths: string[]; folded: string[] } {
  if (!found.dirs) {
    const seen = new Set<string>()
    for (const path of found.paths) {
      for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) seen.add(path.slice(0, slash))
    }
    const paths = [...seen]
    found.dirs = { paths, folded: paths.map(foldForMatch) }
  }
  return found.dirs
}

/**
 * Files and folders for `@` mentions, best first. A query ending in `/` that names a folder lists
 * what it directly holds, folders first, so picking a folder can lead into it; otherwise both kinds
 * are ranked together, as files alone are by `searchWorkspaceFiles`.
 */
export async function searchWorkspaceEntries(
  cwd: string,
  query: string,
  { limit }: { limit: number },
): Promise<{ entries: WorkspaceEntry[]; truncated: boolean }> {
  const found = await listing(cwd, 'workspace', FRESH_MS)
  const dirs = directoriesOf(found)
  const files = (index: number) => !(found.paths[index] as string).endsWith('/')

  const prefix = query.trim()
  if (prefix.endsWith('/')) {
    const childOf = (path: string) => path.startsWith(prefix) && !path.includes('/', prefix.length)
    const children = [
      ...dirs.paths.filter(childOf).sort((a, b) => a.localeCompare(b)).map((path) => ({ path, isDirectory: true })),
      ...found.paths.filter((path, index) => files(index) && childOf(path)).sort((a, b) => a.localeCompare(b)).map((path) => ({ path, isDirectory: false })),
    ]
    // A slash typed as a separator (`web/pal` style) names no folder: rank instead.
    if (children.length > 0) return { entries: children.slice(0, limit), truncated: found.capped || children.length > limit }
  }

  const tokens = fuzzyTokens(query)
  if (tokens.length === 0) {
    found.entriesByLength ??= [
      ...dirs.paths.map((path) => ({ path, isDirectory: true })),
      ...found.paths.filter((_, index) => files(index)).map((path) => ({ path, isDirectory: false })),
    ].sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path))
    return { entries: found.entriesByLength.slice(0, limit), truncated: found.capped || found.entriesByLength.length > limit }
  }

  const scored: (WorkspaceEntry & { score: number })[] = []
  const rank = (paths: string[], folded: string[], isDirectory: boolean) => {
    for (const [index, path] of paths.entries()) {
      if (!isDirectory && !files(index)) continue
      const lower = folded[index] as string
      if (!tokens.every((token) => containsInOrder(lower, token))) continue
      const score = matchPath(path, lower, tokens)
      if (score !== null) scored.push({ path, isDirectory, score })
    }
  }
  rank(dirs.paths, dirs.folded, true)
  rank(found.paths, found.folded, false)
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
  return {
    entries: scored.slice(0, limit).map(({ path, isDirectory }) => ({ path, isDirectory })),
    truncated: found.capped || scored.length > limit,
  }
}

/** The explorer's search, ignored loose files included: results as tree entries. */
export async function searchTree(cwd: string, query: string): Promise<TreeSearchDto> {
  const { paths, truncated } = await searchWorkspaceFiles(cwd, query, { limit: TREE_RESULTS, includeIgnored: true })
  return {
    entries: paths.map((path) => ({ name: path.slice(path.lastIndexOf('/') + 1), path, isDirectory: false })),
    truncated,
  }
}

export interface FileSearchTarget {
  projectId: string
  projectName: string
  cwd: string
}

async function inBatches<T, R>(items: readonly T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (let start = 0; start < items.length; start += size) {
    results.push(...(await Promise.all(items.slice(start, start + size).map(run))))
  }
  return results
}

/** Every word must appear in the path or project name, with at least one in the path: 'nimbus forecast' searches `forecast` in Nimbus, while 'nimbus' alone does not return all its files. */
async function searchOne(target: FileSearchTarget, tokens: string[], limit: number): Promise<PaletteFileGroupDto> {
  const { paths, folded } = await listing(target.cwd, 'workspace', LISTING_TTL_MS)
  const project = foldForMatch(target.projectName)
  // Words absent from project names must all occur in paths,
  // ruling out thousands of irrelevant paths immediately.
  const required = tokens.filter((token) => !project.includes(token))
  const projectField: FuzzyField = { text: target.projectName, folded: project, weight: PROJECT_WEIGHT, mode: 'strict' }

  const scored: { path: string; score: number }[] = []
  for (const [index, path] of paths.entries()) {
    const lower = folded[index] as string
    if (!required.every((token) => containsInOrder(lower, token))) continue
    if (!tokens.some((token) => containsInOrder(lower, token))) continue

    const score = matchPath(path, lower, tokens, [projectField])
    if (score !== null) scored.push({ path, score })
  }

  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length)
  return { projectId: target.projectId, paths: scored.slice(0, limit).map(({ path }) => path) }
}

/** `scopeId` names the project the palette is scoped to, which gets the larger share of results. */
export async function searchProjectFiles(
  targets: readonly FileSearchTarget[],
  query: string,
  scopeId?: string,
): Promise<PaletteFileGroupDto[]> {
  const tokens = fuzzyTokens(query)
  if (tokens.length === 0) return []
  const groups = await inBatches(targets, CONCURRENCY, (target) =>
    searchOne(target, tokens, target.projectId === scopeId ? PALETTE_FILES_IN_SCOPE : PALETTE_FILES_PER_PROJECT))
  return groups.filter((group) => group.paths.length > 0)
}
