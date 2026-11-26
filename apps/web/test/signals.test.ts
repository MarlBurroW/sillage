import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeSchedule, formatAgo, type ArmedLoop } from '../src/lib/loops'
import { buildSidebarSignals, buildSignals, presentSignal, type SignalInput } from '../src/lib/signals'
import type { SubAgent } from '../src/lib/subagents'

const idle: SignalInput = {
  status: 'idle',
  connected: true,
  subAgents: [],
  background: [],
  loops: [],
  queued: [],
  pending: null,
  now: 0,
}

const loop = (extra: Partial<ArmedLoop> = {}): ArmedLoop => ({
  id: 'l1',
  schedule: '*/5 * * * *',
  recurring: true,
  prompt: 'check CI',
  iterations: 2,
  lastFiredAt: 0,
  ...extra,
})

test('an idle, connected conversation has nothing to report', () => {
  assert.deepEqual(buildSignals(idle), [])
  assert.equal(presentSignal([]), null)
})

test('signals read from common to severe whatever order they were found in', () => {
  const signals = buildSignals({
    ...idle,
    status: 'error',
    connected: false,
    loops: [loop()],
    queued: [{ queueId: 'q', text: 'next', attachmentCount: 0 }],
    subAgents: [{ id: 's', type: 'Explore', description: '', activity: 'Reading' } as SubAgent],
    pending: 'opus',
  })
  assert.deepEqual(signals.map((signal) => signal.kind), ['subagents', 'loop', 'queued', 'pending', 'offline', 'error'])
  // Where only a dot fits, the most severe family wins.
  assert.equal(presentSignal(signals)?.kind, 'error')
  // A sub-agent without a description is named by its type.
  assert.equal(signals[0]!.detail, 'Explore · Reading')
})

test('loops are future work and never become the present signal', () => {
  const signals = buildSignals({ ...idle, loops: [loop()] })
  assert.equal(signals[0]!.family, 'scheduled')
  assert.equal(presentSignal(signals), null)
  assert.equal(presentSignal(buildSignals({ ...idle, status: 'running', loops: [loop()] }))?.kind, 'running')
})

test('loop details give cadence, wakeups and age from the render clock', () => {
  const [signal] = buildSignals({ ...idle, now: 3 * 60_000, loops: [loop(), loop({ id: 'l2', recurring: false, lastFiredAt: null, prompt: 'later', iterations: 1 })] })
  assert.equal(signal!.label, '2 loops')
  assert.equal(signal!.detail, '5m · 2 wakeups · last wakeup 3 min ago\ncheck CI\n\nself-paced · 1 wakeup · no wakeup yet\nlater')
})

// Plural forms follow the interface language: English pluralizes 0, French does not.
test('a loop that never fired reads "0 wakeups"', () => {
  const [signal] = buildSignals({ ...idle, loops: [loop({ iterations: 0, lastFiredAt: null })] })
  assert.match(signal!.detail, /^5m · 0 wakeups ·/)
})

test('the sidebar derives the same kinds from counters alone', () => {
  const signals = buildSidebarSignals({ status: 'awaiting_input', background: 1, loops: 3 })
  assert.deepEqual(signals.map(({ kind, label, detail }) => [kind, label, detail]), [
    ['background', '1 background job', ''],
    ['loop', '3 loops', ''],
    ['awaiting', 'Waiting for you', ''],
  ])
})

test('loop cadences are paraphrased only for the shapes /loop writes', () => {
  assert.equal(describeSchedule('*/10 * * * *'), '10m')
  assert.equal(describeSchedule('7 */2 * * *'), '2h')
  assert.equal(describeSchedule(' 30 * * * * '), '1h')
  // Anything handwritten is shown raw rather than approximated.
  assert.equal(describeSchedule('0 9 * * 1-5'), null)
  assert.equal(describeSchedule('*/5 9-17 * * *'), null)
  assert.equal(describeSchedule('0 0 1 * *'), null)
  assert.equal(describeSchedule(''), null)
})

test('wakeup ages round down to the useful unit', () => {
  assert.equal(formatAgo(59_999), '< 1 min')
  assert.equal(formatAgo(60_000), '1 min')
  assert.equal(formatAgo(59 * 60_000 + 59_999), '59 min')
  assert.equal(formatAgo(125 * 60_000), '2 h')
})
