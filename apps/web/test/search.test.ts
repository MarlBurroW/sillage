import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SEARCH_MARK_CLOSE as CLOSE, SEARCH_MARK_OPEN as OPEN } from '@sillage/protocol'
import { scoreMatch, splitExcerpt } from '../src/lib/search'

test('excerpts split at the server match marks, never at markup', () => {
  assert.deepEqual(splitExcerpt(`a ${OPEN}hit${CLOSE} b ${OPEN}two${CLOSE}`), [
    { text: 'a ', hit: false },
    { text: 'hit', hit: true },
    { text: ' b ', hit: false },
    { text: 'two', hit: true },
  ])
  // Database text is displayed as text: tags stay literal.
  assert.deepEqual(splitExcerpt('<b>x</b>'), [{ text: '<b>x</b>', hit: false }])
  assert.deepEqual(splitExcerpt(''), [])
})

test('an unclosed mark leaves the rest as plain text', () => {
  // A truncated excerpt can cut through a match; dropping the text would lose context.
  assert.deepEqual(splitExcerpt(`${OPEN}a${CLOSE} and ${OPEN}cut`), [
    { text: 'a', hit: true },
    { text: ` and ${OPEN}cut`, hit: false },
  ])
})

test('subsequence scores favour literal runs and word starts, then shorter text', () => {
  assert.equal(scoreMatch('compaction', 'cpt'), 3 + 1 + 1 - 0.1)
  assert.equal(scoreMatch('Compaction', 'tpc'), null)
  assert.equal(scoreMatch('abc', 'abcd'), null)
  const literal = scoreMatch('compaction', 'comp')!
  const scattered = scoreMatch('c-o-m-p', 'comp')!
  assert.ok(literal > scattered)
  const initials = scoreMatch('git-graph', 'gg')!
  const inside = scoreMatch('gigantic', 'gg')!
  assert.ok(initials > inside)
  assert.ok(scoreMatch('deploy', 'dep')! > scoreMatch('deployment-notes', 'dep')!)
})
