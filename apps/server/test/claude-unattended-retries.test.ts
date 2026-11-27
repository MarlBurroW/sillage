import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  UNATTENDED_OVERLOADED_MAX_DELAY_MS,
  UNATTENDED_RETRY_MAX_WAIT_MS,
  unattendedRetryEnv,
} from '../src/agents/claude/unattended-retries.js'

const interactive = { scheduleId: null, createdByTokenId: null, maxDurationMinutes: null }

test('an interactive conversation keeps the CLI defaults', () => {
  assert.deepEqual(unattendedRetryEnv(interactive, {}), {})
})

test('a scheduled run waits out overloads within half its maximum duration', () => {
  // Default task duration (30 min): the bound is 15 min, under the scheduler's interruption.
  assert.deepEqual(unattendedRetryEnv({ ...interactive, scheduleId: 'task', maxDurationMinutes: 30 }, {}), {
    CLAUDE_CODE_RETRY_WATCHDOG: '1',
    CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS: String(15 * 60_000),
    CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS: '1',
    CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS: String(UNATTENDED_OVERLOADED_MAX_DELAY_MS),
  })
  // A long task is capped at the general bound; a one-minute task still gets a positive one.
  const long = unattendedRetryEnv({ ...interactive, scheduleId: 'task', maxDurationMinutes: 24 * 60 }, {})
  assert.equal(long.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS, String(UNATTENDED_RETRY_MAX_WAIT_MS))
  const short = unattendedRetryEnv({ ...interactive, scheduleId: 'task', maxDurationMinutes: 1 }, {})
  assert.equal(short.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS, '30000')
})

test('an API task and a run whose task is gone use the general bound', () => {
  for (const origin of [{ ...interactive, createdByTokenId: 'token' }, { ...interactive, scheduleId: 'deleted' }]) {
    const env = unattendedRetryEnv(origin, {})
    assert.equal(env.CLAUDE_CODE_RETRY_WATCHDOG, '1')
    assert.equal(env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS, String(UNATTENDED_RETRY_MAX_WAIT_MS))
  }
})

test('values set in the daemon environment are never overridden', () => {
  const env = unattendedRetryEnv({ ...interactive, createdByTokenId: 'token' }, {
    CLAUDE_CODE_RETRY_WATCHDOG: '0',
    CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS: '60000',
    // Set but empty still counts as the administrator's choice.
    CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS: '',
  })
  assert.deepEqual(env, { CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS: String(UNATTENDED_RETRY_MAX_WAIT_MS) })
})

test('the bounds stay inside the ranges the 2.1.332 binary accepts', () => {
  // MAX_DELAY is read as an integer in [32 000, 300 000]; a value outside is not taken as given.
  assert.ok(UNATTENDED_OVERLOADED_MAX_DELAY_MS >= 32_000 && UNATTENDED_OVERLOADED_MAX_DELAY_MS <= 300_000)
  assert.ok(UNATTENDED_RETRY_MAX_WAIT_MS >= 1)
})
