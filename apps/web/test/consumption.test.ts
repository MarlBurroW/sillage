import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatBucket, formatUsd, periodStart, totalTokens } from '../src/lib/consumption'

test('periods start at local midnight and include today', () => {
  const now = new Date(2026, 10, 26, 15, 30)
  assert.equal(periodStart('7d', now), new Date(2026, 10, 20).getTime())
  assert.equal(periodStart('30d', now), new Date(2026, 9, 28).getTime())
  // Twelve months means twelve whole calendar months, the current one included.
  assert.equal(periodStart('12m', now), new Date(2025, 11, 1).getTime())
  assert.equal(periodStart('all', now), null)
})

test('periods cross year boundaries', () => {
  const now = new Date(2026, 0, 3, 8)
  assert.equal(periodStart('7d', now), new Date(2025, 11, 28).getTime())
  assert.equal(periodStart('12m', now), new Date(2025, 1, 1).getTime())
})

test('total tokens include cache reads and writes', () => {
  assert.equal(totalTokens({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 30, cacheWriteTokens: 400, costUsd: 9 }), 433)
})

test('dollar precision follows the amount', () => {
  assert.equal(formatUsd(0, 'en'), '$0.00')
  assert.equal(formatUsd(0.0042, 'en'), '$0.004')
  assert.equal(formatUsd(12.345, 'en'), '$12.35')
  assert.equal(formatUsd(1234.5, 'en'), '$1,235')
})

test('buckets read as days or months in the reader language', () => {
  assert.equal(formatBucket('2026-11-03', 'en'), 'Nov 3')
  assert.equal(formatBucket('2026-11', 'en'), 'Nov 26')
  assert.equal(formatBucket('2026-11', 'en', true), 'November 2026')
  assert.equal(formatBucket('2026-11-03', 'fr', true), 'mar. 3 novembre')
})
