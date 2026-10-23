/** Line-by-line unified text diff. Implement locally rather than add dependencies because tool excerpts need the same alignment in file diffs and conversation counters; git supplies other diffs. Emit git-compatible format for the same client parser. */

/** Beyond this threshold, longest-common-subsequence tables require tens of millions of cells for results nobody reads line by line. Present files as entirely replaced, which is accurate. */
const MAX_LINES = 2000

interface Op {
  kind: ' ' | '-' | '+'
  text: string
}

/** Longest common subsequence via dynamic programming. Flat tables avoid allocating one array per file line without changing the calculation. */
function align(before: string[], after: string[]): Op[] {
  const rows = before.length
  const cols = after.length
  const width = cols + 1
  const lengths = new Int32Array((rows + 1) * width)
  const at = (i: number, j: number) => lengths[i * width + j] ?? 0

  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      lengths[i * width + j] =
        before[i] === after[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
    }
  }

  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < rows && j < cols) {
    if (before[i] === after[j]) {
      ops.push({ kind: ' ', text: before[i] ?? '' })
      i += 1
      j += 1
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      ops.push({ kind: '-', text: before[i] ?? '' })
      i += 1
    } else {
      ops.push({ kind: '+', text: after[j] ?? '' })
      j += 1
    }
  }
  for (; i < rows; i += 1) ops.push({ kind: '-', text: before[i] ?? '' })
  for (; j < cols; j += 1) ops.push({ kind: '+', text: after[j] ?? '' })

  return ops
}

function replaceAll(before: string[], after: string[]): Op[] {
  return [
    ...before.map((text): Op => ({ kind: '-', text })),
    ...after.map((text): Op => ({ kind: '+', text })),
  ]
}

/** One hunk covers all compared text because fragments are short and splitting would hide surrounding context. */
export function unifiedDiff(path: string, before: string, after: string): string {
  const left = before.split('\n')
  const right = after.split('\n')

  const ops =
    left.length > MAX_LINES || right.length > MAX_LINES ? replaceAll(left, right) : align(left, right)

  const body = ops.map((op) => `${op.kind}${op.text}`).join('\n')
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${left.length} +1,${right.length} @@`,
    body,
  ].join('\n')
}

/** Whole-file creation/deletion has only one side to show. Both CLIs provide raw contents rather than diffs; wrap as git-compatible patches so rendering needs only one format. */
function wholeFileDiff(path: string, content: string, side: 'added' | 'removed'): string {
  const lines = content.split('\n')
  const added = side === 'added'
  return [
    `diff --git a/${path} b/${path}`,
    added ? 'new file mode 100644' : 'deleted file mode 100644',
    added ? '--- /dev/null' : `--- a/${path}`,
    added ? `+++ b/${path}` : '+++ /dev/null',
    added ? `@@ -0,0 +1,${lines.length} @@` : `@@ -1,${lines.length} +0,0 @@`,
    lines.map((line) => `${added ? '+' : '-'}${line}`).join('\n'),
  ].join('\n')
}

export function additionDiff(path: string, content: string): string {
  return wholeFileDiff(path, content, 'added')
}

export function deletionDiff(path: string, content: string): string {
  return wholeFileDiff(path, content, 'removed')
}

/** Count changed lines in excerpts without treating the final newline as an extra line. */
export function countTextChanges(before: string, after: string): { added: number; removed: number } | null {
  if (before.length + after.length > 1_000_000) return null
  const lines = (value: string) => value === '' ? [] : value.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  const left = lines(before)
  const right = lines(after)
  let start = 0
  while (start < left.length && start < right.length && left[start] === right[start]) start++
  let endLeft = left.length
  let endRight = right.length
  while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) { endLeft--; endRight-- }
  const a = left.slice(start, endLeft)
  const b = right.slice(start, endRight)
  // A long tool history must not allocate an unbounded LCS table on the UI thread.
  if (a.length === 0 || b.length === 0) return { added: b.length, removed: a.length }
  if ((a.length + 1) * (b.length + 1) > 1_000_000) return null
  const ops = align(a, b)
  return { added: ops.filter(op => op.kind === '+').length, removed: ops.filter(op => op.kind === '-').length }
}
