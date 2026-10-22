/**
 * Unified diff parsing. Local implementation rather than a dependency: Git's output format fits in
 * roughly a hundred lines, while most diff libraries primarily compute diffs, which Git already
 * does.
 */

export interface DiffLine {
  kind: 'added' | 'removed' | 'context' | 'meta'
  text: string
  /** Line number in the old file, absent for additions. */
  before: number | null
  /** Line number in the new file, absent for deletions. */
  after: number | null
}

export interface DiffHunk {
  /** The `@@ ... @@` header, also containing the enclosing function name. */
  header: string
  lines: DiffLine[]
}

export interface DiffFile {
  path: string
  /** Original path for a moved file. */
  oldPath: string | null
  status: 'added' | 'removed' | 'renamed' | 'modified' | 'binary'
  hunks: DiffHunk[]
  added: number
  removed: number
}

/** `@@ -12,7 +12,9 @@ context`: only the two starting positions are needed. */
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * Path from `diff --git a/x b/y`. Split halves at ` b/`, not spaces: filenames may contain spaces
 * and Git does not escape them in this line.
 */
function parseHeaderPaths(line: string): { from: string; to: string } | null {
  const body = line.slice('diff --git '.length)
  const at = body.indexOf(' b/')
  if (at === -1) return null
  return { from: body.slice(2, at), to: body.slice(at + 3) }
}

export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let before = 0
  let after = 0

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const paths = parseHeaderPaths(line)
      file = {
        path: paths?.to ?? '',
        oldPath: null,
        status: 'modified',
        hunks: [],
        added: 0,
        removed: 0,
      }
      hunk = null
      files.push(file)
      continue
    }

    if (!file) continue

    if (line.startsWith('new file mode')) {
      file.status = 'added'
      continue
    }
    if (line.startsWith('deleted file mode')) {
      file.status = 'removed'
      continue
    }
    if (line.startsWith('rename from ')) {
      file.oldPath = line.slice('rename from '.length)
      file.status = 'renamed'
      continue
    }
    if (line.startsWith('Binary files ')) {
      file.status = 'binary'
      continue
    }

    const bounds = HUNK.exec(line)
    if (bounds) {
      before = Number(bounds[1])
      after = Number(bounds[2])
      hunk = { header: line, lines: [] }
      file.hunks.push(hunk)
      continue
    }

    if (!hunk) continue

    if (line.startsWith('+')) {
      file.added += 1
      hunk.lines.push({ kind: 'added', text: line.slice(1), before: null, after })
      after += 1
    } else if (line.startsWith('-')) {
      file.removed += 1
      hunk.lines.push({ kind: 'removed', text: line.slice(1), before, after: null })
      before += 1
    } else if (line.startsWith('\\')) {
      // No-newline-at-end marker: an annotation on the preceding line, not a line itself.
      hunk.lines.push({ kind: 'meta', text: line.slice(2), before: null, after: null })
    } else {
      hunk.lines.push({ kind: 'context', text: line.slice(1), before, after })
      before += 1
      after += 1
    }
  }

  return files
}
