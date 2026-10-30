import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** Working-directory file listings behind every file search (`search/search-files.ts`): mentions, the palette, the explorer. Listed here rather than asked of CLIs: both Claude and Codex can search, but completion would require dedicated processes and offer nothing before conversations start. */

/** Fallback traversal guard against oversized directories. */
const MAX_SCANNED_ENTRIES = 20_000

/** Directories skipped by fallback traversal. Outside git there are no declared ignore rules, and these would overwhelm results. */
const SKIPPED = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '.next',
  '.nuxt',
  '.venv',
  '__pycache__',
  '.pnpm-store',
  'coverage',
])

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

/**
 * Ignored files lying outside ignored directories: `.env`, `*.local.json`. `--directory` reports a
 * wholly ignored directory as one `dir/` entry without descending, so `node_modules` costs nothing.
 */
async function gitIgnoredFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await exec(
      'git',
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 10_000 },
    )
    return stdout.split('\0').filter((entry) => entry.length > 0 && !entry.endsWith('/'))
  } catch {
    return []
  }
}

/** Paths use `/` on every system, like git's: they are the explorer's paths, and Windows CLIs accept them. */
async function walk(cwd: string, { dotfiles }: { dotfiles: boolean }): Promise<string[]> {
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
      if (SKIPPED.has(entry.name) || (!dotfiles && entry.name.startsWith('.'))) continue

      const full = join(dir, entry.name)
      if (entry.isDirectory()) queue.push(full)
      else if (entry.isFile()) found.push(relative(cwd, full).split(sep).join('/'))
    }
  }

  return found
}

/** Working-directory files, tracked or not, excluding git-ignored entries. Offered to mentions and the palette. */
export async function listWorkspaceFiles(cwd: string): Promise<string[]> {
  return (await gitFiles(cwd)) ?? (await walk(cwd, { dotfiles: false }))
}

/**
 * Files the explorer's search offers: those of `listWorkspaceFiles`, plus ignored files outside
 * ignored directories. Opening `.env` is a common reason to search the explorer, while ignored
 * directories (`node_modules`, `dist`) would drown the results.
 */
export async function listBrowsableFiles(cwd: string): Promise<string[]> {
  const [listed, ignored] = await Promise.all([gitFiles(cwd), gitIgnoredFiles(cwd)])
  return listed ? [...listed, ...ignored] : walk(cwd, { dotfiles: true })
}
