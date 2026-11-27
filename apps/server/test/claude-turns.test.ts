import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { DEFAULT_CLAUDE_CONFIG, type SillageEvent } from '@sillage/protocol'
import { ClaudeRunner } from '../src/agents/claude/runner.js'
import type { RunnerContext } from '../src/agents/types.js'

/** A runner never started: `translate` is fed SDK messages directly, as the consumption loop would. */
function runner() {
  const events: SillageEvent[] = []
  const ctx: RunnerContext = {
    conversationId: 'test', cwd: tmpdir(), config: DEFAULT_CLAUDE_CONFIG, resumeSessionId: null, attachmentsRoot: tmpdir(), binary: 'unused',
    projectOverview: () => null, maskedInstructionRoots: () => [], memoryDir: () => null,
    resolveMcpServers: () => ({ servers: [], failures: [] }), skillRoots: () => [],
    emit: (event) => events.push(event), setStatus: () => {}, setAgentSessionId: () => {},
    updateConfig: () => {}, openPermissionRequest: () => 'permission', closePermissionRequest: () => {},
  }
  const instance = new ClaudeRunner(ctx)
  const translate = (message: Record<string, unknown>) =>
    (instance as unknown as { translate(message: unknown): void }).translate({ uuid: 'u', session_id: 's', ...message })
  return { instance, events, translate }
}

const ping = (parent: string | null) => ({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'ping' } })
const count = (events: SillageEvent[], type: SillageEvent['type']) => events.filter((event) => event.type === type).length

test('a stream failure is journaled even though the error status stops the runner at once', async () => {
  const f = runner()
  // As the manager does: `error` stops the runner synchronously, before the death is journaled.
  ;(f.instance as unknown as { ctx: RunnerContext }).ctx.setStatus = (status) => {
    if (status === 'error') void f.instance.stop()
  }
  const internals = f.instance as unknown as { session: AsyncIterable<unknown>; consume(): Promise<void> }
  internals.session = (async function* () { throw new Error('spawn ENOENT') })()
  await internals.consume()

  const failure = f.events.find((event) => event.type === 'error')
  assert.ok(failure?.type === 'error' && failure.code === 'runner_failed' && failure.message === 'spawn ENOENT')
  assert.equal(f.events.at(-1)?.type, 'session.ended')
})

test('a stopped session refuses a message rather than opening a turn nothing would close', async () => {
  const f = runner()
  await f.instance.stop()
  await assert.rejects(f.instance.send('hello', [], [], []), /stopped before receiving/)
  assert.equal(count(f.events, 'turn.started'), 0)
})

test('a sub-agent still talking neither keeps an interrupted turn open nor opens another', async (t) => {
  const grace = ClaudeRunner.turnCloseGraceMs
  ClaudeRunner.turnCloseGraceMs = 40
  t.after(() => { ClaudeRunner.turnCloseGraceMs = grace })
  const f = runner()
  t.after(() => f.instance.stop())

  f.translate(ping(null))
  assert.equal(count(f.events, 'turn.started'), 1)
  await f.instance.interrupt()
  // The sub-agent flushes during the grace period: the watchdog must still fire.
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setTimeout(resolve, 15))
    f.translate(ping('toolu_agent'))
  }
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(count(f.events, 'turn.completed'), 1)
  // Its later messages open no turn that no `result` would close.
  f.translate(ping('toolu_agent'))
  assert.equal(count(f.events, 'turn.started'), 1)
  // The main thread speaking does.
  f.translate(ping(null))
  assert.equal(count(f.events, 'turn.started'), 2)
})

test('session.started carries the version of the CLI process holding the session', () => {
  const init = { type: 'system', subtype: 'init', permissionMode: 'default', cwd: '/', tools: [], mcp_servers: [], slash_commands: [] }
  const f = runner()
  f.translate({ ...init, model: 'opus', claude_code_version: '2.1.320' })
  // An older CLI omits the field: null, never the version of a previous process.
  f.translate({ ...init, model: 'sonnet' })
  const started = f.events.filter((event) => event.type === 'session.started')
  assert.deepEqual(started.map((event) => event.type === 'session.started' && event.cliVersion), ['2.1.320', null])
})

test('quota warnings relay whether the account has extra usage enabled', () => {
  const f = runner()
  const warning = (extra: Record<string, unknown>) => f.translate({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.9, resetsAt: 1_800_000_000, ...extra },
  })
  warning({ overageEnabled: false })
  warning({ overageEnabled: true })
  // Older CLIs do not say: null, which the interface leaves unstated.
  warning({})
  const relayed = f.events.map((event) => event.type === 'usage.updated' ? event.rateLimit?.overageEnabled : 'other')
  assert.deepEqual(relayed, [false, true, null])
})

// Shape recorded from Claude Code 2.1.332, 13 ms after `interrupt()` (card #133).
const aborted = (extra: Record<string, unknown> = {}) => ({
  type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, total_cost_usd: 0.01,
  errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'],
  usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  ...extra,
})
const closing = (events: SillageEvent[]) => events.find((event) => event.type === 'turn.completed')

test('a turn the user interrupted closes as interrupted, without the CLI\'s internal diagnostic as an error', async (t) => {
  for (const reason of ['aborted_tools', 'aborted_streaming']) {
    const f = runner()
    t.after(() => f.instance.stop())
    f.translate(ping(null))
    f.translate(aborted({ terminal_reason: reason }))
    assert.equal(count(f.events, 'error'), 0, reason)
    const completed = closing(f.events)
    assert.ok(completed?.type === 'turn.completed')
    assert.equal(completed.stopReason, 'interrupted')
  }
})

test('without terminal_reason, Sillage\'s own interrupt request tells the abort apart', async (t) => {
  const f = runner()
  t.after(() => f.instance.stop())
  f.translate(ping(null))
  await f.instance.interrupt()
  f.translate(aborted())
  assert.equal(count(f.events, 'error'), 0)
  assert.equal((closing(f.events) as { stopReason?: string } | undefined)?.stopReason, 'interrupted')

  // The request ends with its turn: the next one failing is an error again.
  f.translate(ping(null))
  f.translate(aborted({ errors: ['API overloaded'] }))
  const failure = f.events.find((event) => event.type === 'error')
  assert.ok(failure?.type === 'error')
  assert.equal(failure.code, 'error_during_execution')
  assert.equal(failure.message, 'API overloaded')
})
