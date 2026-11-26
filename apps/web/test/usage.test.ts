import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentUsage } from '@sillage/protocol'
import { busiestWindows, usageAccountOf } from '../src/lib/usage'

const usage = (utilizations: (number | null)[]): AgentUsage => ({
  agent: 'claude',
  plan: 'max',
  limitsAvailable: true,
  windows: utilizations.map((utilization, index) => ({ id: `w${index}`, label: `W${index}`, utilization, resetsAt: null })),
  credits: null,
  fetchedAt: 0,
})

test('the busiest windows come first and unreported ones are left out', () => {
  // CLIs add windows server-side, most still null: they must not take a gauge slot.
  assert.deepEqual(busiestWindows(usage([0.2, null, 0.9, 0.5])).map((window) => window.id), ['w2', 'w3'])
  assert.deepEqual(busiestWindows(usage([0.2, null, 0.9]), 5).map((window) => window.id), ['w2', 'w0'])
  assert.deepEqual(busiestWindows(usage([null])), [])
})

test('only CLIs with extra accounts carry an account', () => {
  assert.equal(usageAccountOf({ agent: 'codex', account: 'work' }), 'work')
  assert.equal(usageAccountOf({ agent: 'claude' }), null)
  // OpenCode has no extra accounts: a stale value from a previous CLI choice must be ignored.
  assert.equal(usageAccountOf({ agent: 'opencode', account: 'stale' }), null)
  assert.equal(usageAccountOf(null), null)
})
