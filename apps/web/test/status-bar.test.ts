import './helpers/storage'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SillageEvent } from '@sillage/protocol'
import { applyEvent, emptyChatState } from '@sillage/protocol/chat-state'
import { formatClock, statusPieces } from '../src/components/chat/status-bar/pieces'
import { translate } from '../src/lib/i18n'
import { DEFAULT_STATUS_BAR, STATUS_ITEMS, resolveStatusBar, storeStatusBar, type StatusItem } from '../src/lib/status-bar'
import { mergeLiveWindow, type StatusData } from '../src/lib/status-data'

test('an account that never chose gets the default line, then every other item switched off', () => {
  const items = resolveStatusBar(null)
  assert.deepEqual(items.filter((item) => item.on).map((item) => item.key), DEFAULT_STATUS_BAR.map((item) => item.key))
  assert.equal(items.length, STATUS_ITEMS.length)
  assert.deepEqual(new Set(items.map((item) => item.key)), new Set(STATUS_ITEMS.map((spec) => spec.key)))
})

test('a stored line keeps its order, drops unknown and repeated keys, and gains new items last', () => {
  const items = resolveStatusBar([
    { key: 'tokens', on: true },
    { key: 'gone-in-a-later-version', on: true },
    { key: 'quota', on: true, format: 'ring', windows: 'all' },
    { key: 'tokens', on: false },
  ])
  assert.deepEqual(items.slice(0, 2).map((item) => [item.key, item.on]), [['tokens', true], ['quota', true]])
  assert.equal(items.length, STATUS_ITEMS.length)
  assert.ok(items.slice(2).every((item) => !item.on))
  assert.equal(items[1]!.format, 'ring')
  assert.equal(items[1]!.windows, 'all')
})

test('a format an item does not accept falls back to its default, and text items carry none', () => {
  const [context, tokens] = resolveStatusBar([{ key: 'context', on: true, format: 'bar' }, { key: 'tokens', on: true, format: 'bar' }])
  assert.equal(context!.format, 'bar')
  assert.equal(tokens!.format, null)
  assert.equal(resolveStatusBar([{ key: 'model', on: true, format: 'ring' }])[0]!.format, null)
  // Stored back without the fields an item does not use.
  assert.deepEqual(storeStatusBar([tokens!]), [{ key: 'tokens', on: true }])
  assert.deepEqual(storeStatusBar(resolveStatusBar([{ key: 'quota', on: true }])).slice(0, 1), [{ key: 'quota', on: true, format: 'bar', windows: 'busiest' }])
})

test('the live window from the stream overrides the cached reading, or stands alone', () => {
  const cached = [
    { id: 'five_hour', label: '5 heures', utilization: 0.4, resetsAt: 1 },
    { id: 'seven_day', label: '7 jours', utilization: 0.2, resetsAt: 2 },
  ]
  const live = { type: 'five_hour', status: 'allowed' as const, utilization: 0.55, resetsAt: 3 }
  assert.deepEqual(mergeLiveWindow(cached, live)[0], { id: 'five_hour', label: '5 heures', utilization: 0.55, resetsAt: 3 })
  assert.equal(mergeLiveWindow(cached, live)[1], cached[1])
  assert.deepEqual(mergeLiveWindow([], live), [{ id: 'five_hour', label: 'five_hour', utilization: 0.55, resetsAt: 3 }])
  // Without a figure, the stream says nothing worth drawing.
  assert.equal(mergeLiveWindow(cached, { ...live, utilization: null }), cached)
})

test('the fold dates the running turn and keeps the tokens of the last one', () => {
  const completed: SillageEvent = { type: 'turn.completed', stopReason: 'end_turn', costUsd: 0, inputTokens: 10, outputTokens: 20, cacheCreationTokens: 30, cacheReadTokens: 40 }
  let state = applyEvent(emptyChatState(), 1, 1_000, { type: 'turn.started' })
  assert.equal(state.turnStartedAt, 1_000)
  state = applyEvent(state, 2, 5_000, { type: 'message.delta', messageId: 'm', text: 'hi', parentToolCallId: null })
  assert.equal(state.turnStartedAt, 1_000, 'output during the turn keeps its start')
  state = applyEvent(state, 3, 9_000, completed)
  assert.equal(state.turnStartedAt, null)
  assert.equal(state.lastTurnTokens, 100)
  // A resumed session opens its turn by output alone.
  state = applyEvent(state, 4, 12_000, { type: 'tool.started', toolCallId: 't', name: 'Bash', input: {}, parentToolCallId: null })
  assert.equal(state.turnStartedAt, 12_000)
  assert.equal(state.lastTurnTokens, 100)
})

const data: StatusData = {
  agent: 'claude',
  warm: false,
  windows: [
    { id: 'five_hour', label: '5 heures', utilization: 0.42, resetsAt: null },
    { id: 'seven_day', label: '7 jours', utilization: 0.81, resetsAt: null },
    { id: 'seven_day_opus', label: '7 jours · Opus', utilization: null, resetsAt: null },
  ],
  context: null,
  tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
  lastTurnTokens: null,
  costUsd: null,
  subAgents: [],
  background: [],
  turnStartedAt: null,
  model: null,
  cliVersion: null,
  versionGap: null,
  worktree: null,
  files: 0,
  tools: null,
  previews: [],
}
const item = (key: StatusItem['key'], patch: Partial<StatusItem> = {}): StatusItem => ({ ...resolveStatusBar([{ key, on: true }])[0]!, ...patch })
const ids = (pieces: { id: string }[]) => pieces.map((piece) => piece.id)
const context = { compact: false, t: translate, locale: 'en' as const }

test('the quota shows its busiest window, or every window with a figure', () => {
  assert.deepEqual(ids(statusPieces(item('quota'), data, context)), ['quota:seven_day'])
  assert.deepEqual(ids(statusPieces(item('quota', { windows: 'all' }), data, context)), ['quota:five_hour', 'quota:seven_day'])
  assert.deepEqual(ids(statusPieces(item('quota'), { ...data, windows: [] }, context)), [])
})

test('an item without a value hides instead of showing zero', () => {
  for (const key of ['context', 'tokens', 'lastTurn', 'cost', 'agents', 'clock', 'model', 'version', 'worktree', 'files', 'tools', 'previews'] as const) {
    assert.deepEqual(ids(statusPieces(item(key), data, context)), [], key)
  }
  assert.deepEqual(ids(statusPieces(item('agents'), { ...data, subAgents: ['Explore'] }, context)), ['agents'])
  assert.deepEqual(ids(statusPieces(item('tokens', { on: false }), { ...data, tokens: { ...data.tokens, input: 5 } }, context)), [])
})

test('the shortcut reminder stays off touch-sized screens and keeps the far right', () => {
  const [piece] = statusPieces(item('shortcuts'), data, context)
  assert.equal(piece?.end, true)
  assert.deepEqual(statusPieces(item('shortcuts'), data, { ...context, compact: true }), [])
})

test('the turn clock reads like a clock, without decimals that flicker each second', () => {
  assert.equal(formatClock(0), '0:00')
  assert.equal(formatClock(134_900), '2:14')
  assert.equal(formatClock(3_734_000), '1:02:14')
  assert.equal(formatClock(-5), '0:00')
})
