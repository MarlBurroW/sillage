import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ContentMatchDto, ContentSearchDto } from '@sillage/protocol'
import { listWorkspaceFiles } from '../files.js'

/**
 * Search inside the working directory's files, for the explorer. `git grep` in a repository: fast,
 * honoring .gitignore, untracked files included. Elsewhere a bounded scan of the same files the
 * other searches list.
 *
 * Smart case, as in ripgrep: a query with capitals matches exactly, one without ignores case.
 */

/** Beyond this, the list is unreadable: the query should be refined. */
const MAX_MATCHES = 300
/** One file full of matches must not hide every other file. */
const MAX_PER_FILE = 20
/** Context kept around a match in long lines (minified files). */
const BEFORE = 60
const AFTER = 180
const TIMEOUT_MS = 10_000
/** The scan outside git skips larger files: generated, not read. */
const SCAN_MAX_BYTES = 1024 * 1024

interface Collector {
  files: Map<string, ContentMatchDto[]>
  count: number
}

/** Adds a line to the results; false once full. */
function collect(results: Collector, path: string, line: number, text: string, query: string, caseSensitive: boolean): boolean {
  const haystack = caseSensitive ? text : text.toLowerCase()
  const index = haystack.indexOf(caseSensitive ? query : query.toLowerCase())
  // git matches bytes; lines where the decoded text no longer contains the query are skipped.
  if (index === -1) return true
  const matches = results.files.get(path) ?? []
  if (matches.length >= MAX_PER_FILE) return true
  const start = Math.max(0, index - BEFORE)
  const end = Math.min(text.length, index + query.length + AFTER)
  const prefix = start > 0 ? '…' : ''
  matches.push({
    line,
    column: index + 1,
    text: `${prefix}${text.slice(start, end)}${end < text.length ? '…' : ''}`,
    from: prefix.length + index - start,
    length: query.length,
  })
  results.files.set(path, matches)
  results.count += 1
  return results.count < MAX_MATCHES
}

function toDto(results: Collector, truncated: boolean): ContentSearchDto {
  return { files: [...results.files].map(([path, matches]) => ({ path, matches })), truncated }
}

/** Null when `cwd` is not in a repository or git is missing: the caller scans instead. */
function gitGrep(cwd: string, query: string, caseSensitive: boolean): Promise<ContentSearchDto | null> {
  return new Promise((resolve) => {
    const results: Collector = { files: new Map(), count: 0 }
    let truncated = false
    let pending = ''
    let settled = false
    const child = spawn(
      'git',
      ['grep', '-I', '-n', '-z', '--no-color', '--untracked', ...(caseSensitive ? [] : ['-i']), '-F', '-e', query, '--', '.'],
      // A read: no index refresh, so no lock taken from under an agent.
      { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const finish = (value: ContentSearchDto | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      truncated = true
      child.kill()
    }, TIMEOUT_MS)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (truncated) return
      pending += chunk
      let newline = pending.indexOf('\n')
      while (newline !== -1) {
        // `path\0line\0text`: lines cannot contain the newline that ends them.
        const [path, line, ...rest] = pending.slice(0, newline).split('\0')
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
        if (!path || !line) continue
        if (!collect(results, path, Number(line), rest.join('\0'), query, caseSensitive)) {
          truncated = true
          child.kill()
          return
        }
      }
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => {
      // 1: no match. 128 and the like: not a repository, which the scan handles.
      if (truncated || code === 0 || code === 1) finish(toDto(results, truncated))
      else finish(null)
    })
  })
}

async function scan(cwd: string, query: string, caseSensitive: boolean): Promise<ContentSearchDto> {
  const results: Collector = { files: new Map(), count: 0 }
  const started = Date.now()
  for (const path of await listWorkspaceFiles(cwd)) {
    if (Date.now() - started > TIMEOUT_MS) return toDto(results, true)
    const absolute = join(cwd, path)
    const info = await stat(absolute).catch(() => null)
    if (!info?.isFile() || info.size > SCAN_MAX_BYTES) continue
    const buffer = await readFile(absolute).catch(() => null)
    // Binary: same test as the editor's.
    if (!buffer || buffer.subarray(0, 8192).includes(0)) continue
    const lines = buffer.toString('utf8').split(/\r\n?|\n/)
    for (const [index, text] of lines.entries()) {
      if (!collect(results, path, index + 1, text, query, caseSensitive)) return toDto(results, true)
    }
  }
  return toDto(results, false)
}

export async function searchContent(cwd: string, query: string): Promise<ContentSearchDto> {
  const caseSensitive = query !== query.toLowerCase()
  return (await gitGrep(cwd, query, caseSensitive)) ?? scan(cwd, query, caseSensitive)
}
