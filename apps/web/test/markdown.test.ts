import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseMarkdown, type MarkdownSegment } from '../src/lib/markdown'

function html(text: string, options: Parameters<typeof parseMarkdown>[1] = {}): string {
  return parseMarkdown(text, options)
    .segments.map((segment) => (segment.kind === 'code' ? '' : segment.html))
    .join('')
}

test('raw model HTML is escaped, never interpreted', () => {
  const out = html('<img src=x onerror=alert(1)> <script>bad()</script>')
  assert.doesNotMatch(out, /<img|<script/)
  assert.match(out, /&lt;script&gt;/)
})

test('only URLs with a scheme become links, opened outside the Sillage tab', () => {
  // `CLAUDE.md` is also a valid domain: fuzzy linkify would send readers to http://claude.md.
  assert.doesNotMatch(html('read CLAUDE.md first'), /<a /)
  const out = html('see https://example.com/docs')
  assert.match(out, /<a href="https:\/\/example\.com\/docs" target="_blank" rel="noopener noreferrer">/)
})

test('code fences and tables become their own segments around the prose', () => {
  const { segments } = parseMarkdown(['intro', '', '```ts title=a.ts', 'const a = 1', '```', '', '| A | B |', '|---|---|', '| `x` | **y** |', '', 'outro'].join('\n'))
  assert.deepEqual(segments.map((segment: MarkdownSegment) => segment.kind), ['html', 'code', 'table', 'html'])
  // The info string may carry metadata after the language; the trailing newline is not code.
  assert.deepEqual(segments[1], { kind: 'code', language: 'ts', code: 'const a = 1' })
  // CSV export reads plain cell text: inline code kept, emphasis markup dropped.
  assert.deepEqual(segments[2]!.kind === 'table' && segments[2]!.rows, [['A', 'B'], ['x', 'y']])
})

test('task list markers become disabled checkboxes', () => {
  const out = html('- [ ] todo\n- [x] done\n- plain')
  assert.match(out, /<input type="checkbox" disabled>todo/)
  assert.match(out, /<input type="checkbox" disabled checked>done/)
  assert.equal(out.match(/sg-task-item/g)?.length, 2)
})

test('code spans that may name files are collected, words and commands are not', () => {
  const { candidates } = parseMarkdown('`src/app.ts:12:5` `./README.md` `useState` `--force` `https://x.io/a.ts` `../up.ts` `C:\\Users\\me\\a.txt`')
  // Grep locations and the `./` prefix are stripped so the workspace receives the bare path.
  assert.deepEqual([...candidates].sort(), ['C:/Users/me/a.txt', 'README.md', 'src/app.ts'])
})

test('only confirmed paths become buttons; unconfirmed file links render as text', () => {
  const knownFiles = new Set(['src/app.ts', 'docs/shot.png'])
  const out = html('`src/app.ts` `src/missing.ts` [app](src/app.ts) [gone](src/gone.ts) [local](file:///tmp/x.txt)', { knownFiles })
  assert.match(out, /<button type="button" class="sg-file" data-sg-path="src\/app\.ts">src\/app\.ts<\/button>/)
  assert.match(out, /<code>src\/missing\.ts<\/code>/)
  assert.match(out, /<button type="button" class="sg-file" data-sg-path="src\/app\.ts">app<\/button>/)
  // A site-relative href would leave Sillage for a missing page; a file: URL must never reach an href.
  assert.doesNotMatch(out, /href="src\/gone\.ts"|href="file:/)
  assert.match(out, /gone/)
  assert.match(out, /local/)
})

test('relative link targets resolve against the document directory and may not climb out', () => {
  const { candidates } = parseMarkdown('![shot](../img/shot.png) [up](../../../etc/passwd)', { base: 'docs/guide' })
  assert.deepEqual([...candidates], ['docs/img/shot.png'])
  // Without a base the same target would leave the workspace root.
  assert.deepEqual([...parseMarkdown('![shot](../img/shot.png)').candidates], [])
  // Drive paths written URL-style keep their spaces once decoded.
  assert.deepEqual([...parseMarkdown('[doc](/D:/My%20Docs/a.txt)').candidates], ['D:/My Docs/a.txt'])
})

// BUG: `pathTarget` decodes `%20` precisely so paths with spaces reach the editor intact (see its
// comment), but `PATH_CANDIDATE` has no space in its character class, so every non-Windows link or
// image target containing a space is dropped: `[notes](my%20notes.md)` never becomes clickable.
test.todo('link targets with encoded spaces are offered as files', () => {
  assert.deepEqual([...parseMarkdown('[notes](docs/my%20notes.md)').candidates], ['docs/my notes.md'])
})

test('a confirmed image is served through the workspace read route', () => {
  const out = html('![shot](docs/shot.png)', { knownFiles: new Set(['docs/shot.png']), scope: 'project:p1' })
  assert.match(out, /<button type="button" class="sg-file-image" data-sg-path="docs\/shot\.png"><img src="\/api\/projects\/p1\/file\/raw\?path=docs%2Fshot\.png" alt="shot"><\/button>/)
})

test('card references link only to known cards and never inside code or links', () => {
  const out = html('fixes #12 and #99, `#12`, [#12](https://x.test)', { cards: new Set([12]) })
  assert.equal(out.match(/data-sg-card="12"/g)?.length, 1)
  assert.doesNotMatch(out, /data-sg-card="99"/)
})
