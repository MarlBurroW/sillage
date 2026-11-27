import assert from 'node:assert/strict'
import { test } from 'node:test'
import { screenText, tailLines } from '../src/terminals/screen-text.js'

test('terminal output loses its escapes and keeps what the last redraw wrote', () => {
  const raw = [
    '\x1b]0;pnpm test\x07',
    '\x1b[2m$ pnpm test\x1b[0m\r\n',
    '\x1b[32m✔ parses\x1b[39m\r\n',
    // A progress bar redrawn on one line, then a spinner erased with the cursor.
    'building 10%\rbuilding 55%\rbuilding 100%\r\n',
    '\x1b[2K\x1b[1Gwaiting\x1b(B\r\n',
    'tpyo\b\b\bypo\r\n',
    '\x1b[31m✖ fails\x1b[39m\r\r\n',
  ].join('')
  assert.equal(screenText(raw), '$ pnpm test\n✔ parses\nbuilding 100%\nwaiting\ntypo\n✖ fails\n')
})

test('the tail keeps the last lines and says how many came before', () => {
  const text = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\n') + '\n\n'
  assert.deepEqual(tailLines(text, 3, 1000), { text: 'line 8\nline 9\nline 10', omitted: 7 })
  // A character budget wins over the line count, down to one cut line.
  assert.deepEqual(tailLines(text, 3, 14), { text: 'line 9\nline 10', omitted: 8 })
  assert.deepEqual(tailLines('x'.repeat(50), 3, 10), { text: `…${'x'.repeat(10)}`, omitted: 0 })
})
