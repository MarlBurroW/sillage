import assert from 'node:assert/strict'
import { test } from 'node:test'
import { releaseSummary } from '../src/lib/release-notes'

test('the summary is the opening paragraph as plain text', () => {
  const body = 'Adds **folder** mentions and [a radio](https://x.test) ![shot](a.png) to `the composer`.\r\nSecond line.\r\n\r\n## Details\n- one'
  assert.equal(releaseSummary(body), 'Adds folder mentions and a radio to the composer. Second line.')
})

test('a leading warning quote is skipped, but only for the first few blocks', () => {
  assert.equal(releaseSummary('> Back up first.\n\nThe real summary.'), 'The real summary.')
  assert.equal(releaseSummary('> one\n\n> two\n\n> three\n\nToo far.'), null)
})

test('notes opening on structure have no summary rather than a fragment', () => {
  for (const body of ['## Features\n\nText', '- item\n\nText', '1. item', '| a | b |', '```\ncode\n```', '', '   \n\n  ']) {
    assert.equal(releaseSummary(body), null, JSON.stringify(body))
  }
})
