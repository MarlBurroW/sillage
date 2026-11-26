import assert from 'node:assert/strict'
import { test } from 'node:test'
import { retainedBytes } from '../src/lib/cache-budget'

test('strings weigh two bytes per UTF-16 unit plus a header', () => {
  assert.equal(retainedBytes('', 1e9), 24)
  assert.equal(retainedBytes('abcd', 1e9), 32)
  assert.equal(retainedBytes(42, 1e9), 8)
})

test('objects, arrays and maps count their entries and keys', () => {
  // 64 per object + 16 per entry + 2 per key character + the value.
  assert.equal(retainedBytes({ ab: 1 }, 1e9), 64 + 16 + 4 + 8)
  assert.equal(retainedBytes(['x'], 1e9), 64 + 16 + 2 + 26)
  assert.equal(retainedBytes(new Map([['k', 1]]), 1e9), 64 + 48 + 26 + 8)
})

test('shared and cyclic references are counted once and terminate', () => {
  const shared = { text: 'x'.repeat(100) }
  const cyclic: Record<string, unknown> = { a: shared, b: shared }
  cyclic.self = cyclic
  const once = retainedBytes({ a: shared }, 1e9)
  assert.ok(retainedBytes(cyclic, 1e9) < once * 2)
})

test('the walk stops soon after the ceiling instead of traversing everything', () => {
  const huge = Array.from({ length: 100_000 }, (_, index) => ({ index, text: 'payload' }))
  const bytes = retainedBytes(huge, 1000)
  assert.ok(bytes > 1000)
  // The outer array's entries are counted in one step; the children behind them are never visited.
  assert.ok(bytes < retainedBytes(huge, Infinity) / 2)
})
