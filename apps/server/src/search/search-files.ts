import {
  PALETTE_FILES_PER_PROJECT,
  containsInOrder,
  foldForMatch,
  fuzzyTokens,
  matchFields,
  type FuzzyField,
  type PaletteFileGroupDto,
} from '@sillage/protocol'
import { listWorkspaceFiles } from '../files.js'

/** Cross-project file search for the palette. Cache briefly because typing triggers repeated searches and rerunning `git ls-files` per project per letter wastes work. Keep short enough for newly created files to appear on the next search. */
const LISTING_TTL_MS = 15_000

/** Per-directory cap prevents oversized repositories from exhausting daemon memory. */
const MAX_FILES = 50_000

/** Concurrent directory listings: forty simultaneous git processes would compete. */
const CONCURRENCY = 6

/** Field weights match the palette's later ranking: filenames matter more than directories, while project names only restrict matches. */
const NAME_WEIGHT = 1
const DIR_WEIGHT = 0.6
const PROJECT_WEIGHT = 0.35

interface Listing {
  paths: string[]
  /** The same values normalized once for subsequent keystrokes. */
  folded: string[]
}

const listings = new Map<string, Promise<Listing>>()

function listing(cwd: string): Promise<Listing> {
  const cached = listings.get(cwd)
  if (cached) return cached

  const pending = listWorkspaceFiles(cwd)
    .then((all) => {
      const paths = all.slice(0, MAX_FILES)
      return { paths, folded: paths.map(foldForMatch) }
    })
    // Missing or unreadable directories must not suppress results from other projects.
    .catch((): Listing => ({ paths: [], folded: [] }))
  listings.set(cwd, pending)
  // Remove rather than mark stale: release memory once typing stops,
  // since the palette may not reopen for hours.
  setTimeout(() => {
    if (listings.get(cwd) === pending) listings.delete(cwd)
  }, LISTING_TTL_MS).unref()
  return pending
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
async function searchOne(target: FileSearchTarget, tokens: string[]): Promise<PaletteFileGroupDto> {
  const { paths, folded } = await listing(target.cwd)
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

    // Fuzzy-match filenames but require contiguous directory matches, like
    // VS Code: fuzzy-matching whole paths always found one letter
    // per directory, making palette match packages/…/RateLimitResetType.ts.
    const slash = path.lastIndexOf('/')
    const dir = Math.max(slash, 0)
    const match = matchFields(
      [
        { text: path.slice(slash + 1), folded: lower.slice(slash + 1), weight: NAME_WEIGHT },
        { text: path.slice(0, dir), folded: lower.slice(0, dir), weight: DIR_WEIGHT, mode: 'strict' },
        projectField,
      ],
      tokens,
    )
    if (match && (match.matched[0] || match.matched[1])) scored.push({ path, score: match.score })
  }

  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length)
  return { projectId: target.projectId, paths: scored.slice(0, PALETTE_FILES_PER_PROJECT).map(({ path }) => path) }
}

export async function searchProjectFiles(
  targets: readonly FileSearchTarget[],
  query: string,
): Promise<PaletteFileGroupDto[]> {
  const tokens = fuzzyTokens(query)
  if (tokens.length === 0) return []
  const groups = await inBatches(targets, CONCURRENCY, (target) => searchOne(target, tokens))
  return groups.filter((group) => group.paths.length > 0)
}
