import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationStatus, SillageEvent } from '@sillage/protocol'
import { TurnLifecycle } from '../src/agents/turn-lifecycle.js'

function lifecycle(blocking = false) {
  const log: string[] = []
  const events: SillageEvent[] = []
  const ctx = {
    emit: (event: SillageEvent) => { events.push(event); log.push(event.type) },
    setStatus: (status: ConversationStatus) => { log.push(`status:${status}`) },
  }
  const interactions = { hasBlocking: blocking, expireAll: () => { log.push('expire') } }
  return { turn: new TurnLifecycle(ctx, interactions), log, events }
}

test('a completion answering an earlier turn does not close the one in progress', () => {
  const f = lifecycle()
  const first = f.turn.begin()
  assert.equal(f.turn.end({ stopReason: 'cancelled' }, first), true)
  const second = f.turn.begin()
  // The cancelled prompt resolves late, carrying the first token.
  assert.equal(f.turn.end({ stopReason: 'completed' }, first), false)
  assert.equal(f.turn.open, true)
  assert.equal(f.turn.end({ stopReason: 'completed' }, second), true)
  assert.equal(f.events.filter((event) => event.type === 'turn.completed').length, 2)
})

test('begin is idempotent and end closes the runner state inside the turn, then goes idle', () => {
  const f = lifecycle()
  const token = f.turn.begin()
  assert.equal(f.turn.begin(), token)
  f.turn.end({ stopReason: 'completed', close: () => f.log.push('close') })
  assert.deepEqual(f.log, ['turn.started', 'status:running', 'close', 'expire', 'turn.completed', 'status:idle'])
  const completed = f.events.at(-1)
  assert.equal(completed?.type === 'turn.completed' && completed.inputTokens, 0)
  assert.equal(f.turn.end({ stopReason: 'completed' }), false)
})

test('a turn opened over a waiting prompt is awaiting input; an imported one sets no status', () => {
  const blocked = lifecycle(true)
  blocked.turn.begin()
  assert.deepEqual(blocked.log, ['turn.started', 'status:awaiting_input'])
  const imported = lifecycle()
  imported.turn.begin({ status: false })
  assert.deepEqual(imported.log, ['turn.started'])
})

test('the watchdog belongs to the turn it was armed for', async () => {
  const f = lifecycle()
  const first = f.turn.begin()
  const fired: number[] = []
  f.turn.armWatchdog(20, (token) => fired.push(token))
  f.turn.end({ stopReason: 'interrupted' }, first)
  f.turn.begin()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(fired, [])
  const second = f.turn.token!
  f.turn.armWatchdog(10, (token) => { fired.push(token); f.turn.end({ stopReason: 'cancelled' }, token) })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(fired, [second])
  assert.equal(f.turn.open, false)
})

test('a dead process forgets its turn without journaling an end', async () => {
  const f = lifecycle()
  f.turn.begin()
  let fired = false
  f.turn.armWatchdog(10, () => { fired = true })
  f.turn.abandon()
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(fired, false)
  assert.equal(f.turn.open, false)
  assert.equal(f.events.some((event) => event.type === 'turn.completed'), false)
  f.turn.settleWithoutTurn()
  assert.deepEqual(f.log.slice(-2), ['expire', 'status:idle'])
})
