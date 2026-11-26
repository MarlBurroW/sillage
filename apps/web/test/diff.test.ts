import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseUnifiedDiff } from '../src/lib/diff'

const MODIFIED = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -10,3 +10,4 @@ export function main() {',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '+const c = 4',
  ' return a',
  '\\ No newline at end of file',
].join('\n')

test('numbers old and new lines independently across additions and removals', () => {
  const [file] = parseUnifiedDiff(MODIFIED)
  assert.ok(file)
  assert.equal(file.path, 'src/app.ts')
  assert.equal(file.status, 'modified')
  // `--- a/` and `+++ b/` start with change markers but precede the first hunk: not counted.
  assert.equal(file.added, 2)
  assert.equal(file.removed, 1)
  assert.equal(file.hunks[0]!.header, '@@ -10,3 +10,4 @@ export function main() {')
  assert.deepEqual(
    file.hunks[0]!.lines.map(({ kind, before, after }) => [kind, before, after]),
    [
      ['context', 10, 10],
      ['removed', 11, null],
      ['added', null, 11],
      ['added', null, 12],
      ['context', 12, 13],
      // The no-newline marker annotates the previous line and must not shift the numbering.
      ['meta', null, null],
    ],
  )
  assert.equal(file.hunks[0]!.lines[5]!.text, 'No newline at end of file')
})

test('reads status, rename source and paths containing spaces', () => {
  const files = parseUnifiedDiff([
    'diff --git a/docs/my notes.md b/docs/my notes.md',
    'new file mode 100644',
    '@@ -0,0 +1 @@',
    '+hello',
    'diff --git a/old.txt b/old.txt',
    'deleted file mode 100644',
    '@@ -1 +0,0 @@',
    '-bye',
    'diff --git a/before.ts b/after.ts',
    'similarity index 90%',
    'rename from before.ts',
    'rename to after.ts',
    'diff --git a/logo.png b/logo.png',
    'Binary files a/logo.png and b/logo.png differ',
  ].join('\n'))
  assert.deepEqual(
    files.map(({ path, oldPath, status, added, removed }) => ({ path, oldPath, status, added, removed })),
    [
      { path: 'docs/my notes.md', oldPath: null, status: 'added', added: 1, removed: 0 },
      { path: 'old.txt', oldPath: null, status: 'removed', added: 0, removed: 1 },
      { path: 'after.ts', oldPath: 'before.ts', status: 'renamed', added: 0, removed: 0 },
      { path: 'logo.png', oldPath: null, status: 'binary', added: 0, removed: 0 },
    ],
  )
  // A one-line hunk omits its count (`-0,0 +1`): numbering still starts at the given position.
  assert.deepEqual(files[0]!.hunks[0]!.lines[0], { kind: 'added', text: 'hello', before: null, after: 1 })
})

test('ignores text before the first file and restarts numbering at each hunk', () => {
  const [file, ...rest] = parseUnifiedDiff([
    'warning: something unrelated',
    'diff --git a/a.ts b/a.ts',
    '@@ -1,1 +1,1 @@',
    ' one',
    '@@ -40,1 +41,1 @@',
    ' forty',
  ].join('\n'))
  assert.equal(rest.length, 0)
  assert.deepEqual(file!.hunks.map((hunk) => hunk.lines.map(({ before, after }) => [before, after])), [[[1, 1]], [[40, 41]]])
})

// Git ends every patch with a newline, passed through untrimmed by the server: the empty string
// after it once became a phantom numbered context row at the end of every diff.
test('a trailing newline does not add a phantom context line', () => {
  const [file] = parseUnifiedDiff(`${MODIFIED}\n`)
  assert.equal(file!.hunks[0]!.lines.length, 6)
})
