import assert from 'node:assert/strict'
import { test } from 'node:test'
import { highlightRanges, mentionsIn } from '../src/lib/composer-highlights'

const none = { mentions: [], skills: [], commands: [] }

test('a folder mention does not survive inside a longer file mention', () => {
  // Opening `@src/` to pick a file inside it leaves `@src/app.ts`: only the file is still sent.
  assert.deepEqual(mentionsIn('look at @src/app.ts', ['src/', 'src/app.ts']), ['src/app.ts'])
  assert.deepEqual(mentionsIn('@src/ and @src/app.ts', ['src/', 'src/app.ts']), ['src/', 'src/app.ts'])
})

test('a mention is a whole token: preceded by space or an opening mark, followed by a boundary', () => {
  assert.deepEqual(mentionsIn('mail@a.ts', ['a.ts']), [])
  assert.deepEqual(mentionsIn('(@a.ts)', ['a.ts']), ['a.ts'])
  assert.deepEqual(mentionsIn('"@a.ts"', ['a.ts']), ['a.ts'])
  assert.deepEqual(mentionsIn('@a.tsx', ['a.ts']), [])
  // A sentence's final period ends the token; a period followed by a letter continues the name.
  assert.deepEqual(mentionsIn('see @a.ts.', ['a.ts']), ['a.ts'])
  assert.deepEqual(mentionsIn('see @a.ts.map', ['a.ts']), [])
})

test('only a leading known command is highlighted', () => {
  assert.deepEqual(highlightRanges('/review now', { ...none, commands: ['review'] }), [{ start: 0, end: 7, kind: 'command' }])
  assert.deepEqual(highlightRanges('please /review', { ...none, commands: ['review'] }), [])
  assert.deepEqual(highlightRanges('/reviewer', { ...none, commands: ['review'] }), [])
  assert.deepEqual(highlightRanges('/unknown', { ...none, commands: ['review'] }), [])
  // Namespaced plugin commands carry a colon.
  assert.deepEqual(highlightRanges('/plugin:run', { ...none, commands: ['plugin:run'] }), [{ start: 0, end: 11, kind: 'command' }])
})

test('ranges come out in text order without overlaps, the longest path winning', () => {
  const text = '$deploy @src/app.ts then @src'
  assert.deepEqual(highlightRanges(text, { mentions: ['src', 'src/app.ts'], skills: ['deploy'], commands: [] }), [
    { start: 0, end: 7, kind: 'skill' },
    { start: 8, end: 19, kind: 'mention' },
    { start: 25, end: 29, kind: 'mention' },
  ])
})
