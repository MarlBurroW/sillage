import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detach, faultHandlers } from '../src/detach.js'

/** Silences the expected error lines and returns what was logged. */
function captureErrors(t: { after: (fn: () => void) => void }): unknown[][] {
  const logged: unknown[][] = []
  const original = console.error
  console.error = (...args: unknown[]) => { logged.push(args) }
  t.after(() => { console.error = original })
  return logged
}

test('detach logs a rejection instead of leaving it unhandled', async (t) => {
  const logged = captureErrors(t)
  let unhandled = false
  const onUnhandled = () => { unhandled = true }
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.off('unhandledRejection', onUnhandled))

  detach(Promise.reject(new Error('Conversation inconnue : gone')), 'message delivery')
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(unhandled, false)
  assert.equal(logged.length, 1)
  assert.match(String(logged[0]![0]), /message delivery failed/)
})

test('an unhandled rejection is logged and the process keeps running', (t) => {
  const logged = captureErrors(t)
  const exits: number[] = []
  const handlers = faultHandlers({ onFatal: async () => {}, exit: (code) => exits.push(code) })

  handlers.onRejection(new Error('busy database'))
  handlers.onRejection(new Error('again'))

  assert.deepEqual(exits, [])
  assert.equal(logged.length, 2)
})

test('an uncaught exception shuts down once, then exits with a failure code', async (t) => {
  captureErrors(t)
  const exits: number[] = []
  let shutdowns = 0
  const handlers = faultHandlers({ onFatal: async () => { shutdowns++ }, exit: (code) => exits.push(code) })

  handlers.onException(new Error('EPIPE'))
  handlers.onException(new Error('second, during shutdown'))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(shutdowns, 1)
  assert.deepEqual(exits, [1])
})

test('a shutdown that throws or hangs still ends the process', async (t) => {
  captureErrors(t)
  const failing: number[] = []
  faultHandlers({ onFatal: async () => { throw new Error('stopAll failed') }, exit: (code) => failing.push(code) })
    .onException(new Error('boom'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(failing, [1])

  const hanging: number[] = []
  faultHandlers({ onFatal: () => new Promise(() => {}), deadlineMs: 10, exit: (code) => hanging.push(code) })
    .onException(new Error('boom'))
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(hanging, [1])
})
