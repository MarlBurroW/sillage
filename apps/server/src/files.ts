import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { subsequenceGaps } from './subsequence.js'

const exec = promisify(execFile)

/** Working-directory file search for mention completion. Implement here rather than query CLIs: both Claude and Codex can search, but completion would require dedicated processes and offer nothing before conversations start. Directory listing is not protocol-specific data. */

/** Beyond this limit lists no longer fit screens and sorting adds no value. */
const MAX_RESULTS = 30

/** Fallback traversal guard against oversized directories. */
const MAX_SCANNED_ENTRIES = 20_000

/** Directories skipped by fallback traversal. Outside git there are no declared ignore rules, and these four would overwhelm results. */
const SKIPPED = new Set(['.git', 'node_modules', 'dist', '.venv'])

export interface FileMatch {
  /** Working-directory-relative path as written in messages. */
  path: string
  name: string
}

/** Git-tracked files excluding ignored directories. `--others --exclude-standard` includes untracked files while honoring .gitignore, so newly created files can be offered. */
async function gitFiles(cwd: string): Promise<string[] | null> {
  try {
    const { stdout } = await exec(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      // Unignored directories with millions of files would stall completion indefinitely:
      // after this timeout, switch to bounded traversal.
      { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 10_000 },
    )
    return stdout.split('\0').filter((entry) => entry.length > 0)
  } catch {
    // Outside git, or when git is missing, use fallback traversal.
    return null
  }
}

async function walk(cwd: string): Promise<string[]> {
  const found: string[] = []
  const queue: string[] = [cwd]
  let scanned = 0

  while (queue.length > 0 && scanned < MAX_SCANNED_ENTRIES) {
    const dir = queue.shift()
    if (dir === undefined) break

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // Skip unreadable directories rather than the entire search.
      continue
    }

    for (const entry of entries) {
      scanned += 1
      if (entry.name.startsWith('.') || SKIPPED.has(entry.name)) continue

      const full = join(dir, entry.name)
      if (entry.isDirectory()) queue.push(full)
      else if (entry.isFile()) found.push(relative(cwd, full))
    }
  }

  return found
}

/** Lower scores indicate stronger matches. */
function score(path: string, query: string): number | null {
  const gaps = subsequenceGaps(path, query)
  if (gaps === null) return null

  const haystack = path.toLowerCase()
  // Break equal-match ties by shorter paths and earlier filename
  // matches.
  const inName = haystack.lastIndexOf(sep) < haystack.indexOf(query[0]?.toLowerCase() ?? '') ? 0 : 40
  return gaps * 4 + path.length + inName
}

/** Working-directory files, tracked or not, excluding git-ignored entries. */
export async function listWorkspaceFiles(cwd: string): Promise<string[]> {
  return (await gitFiles(cwd)) ?? (await walk(cwd))
}

export async function searchFiles(cwd: string, query: string): Promise<FileMatch[]> {
  const paths = await listWorkspaceFiles(cwd)
  const trimmed = query.trim()

  const scored = trimmed
    ? paths
        .map((path) => ({ path, rank: score(path, trimmed) }))
        .filter((entry): entry is { path: string; rank: number } => entry.rank !== null)
        .sort((a, b) => a.rank - b.rank)
    : // Without queries, shorter paths are nearer the root
      // and therefore likelier targets.
      paths.map((path) => ({ path, rank: path.length })).sort((a, b) => a.rank - b.rank)

  return scored.slice(0, MAX_RESULTS).map(({ path }) => ({
    path,
    name: path.slice(path.lastIndexOf(sep) + 1),
  }))
}
