import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { DEFAULT_CLAUDE_CONFIG, type SillageEvent } from '@sillage/protocol'
import { ClaudeRunner } from '../src/agents/claude/runner.js'
import { ClaudeSandboxSupport, readSandboxSupport, sandboxFailureReason } from '../src/agents/claude/sandbox-support.js'
import type { RunnerContext } from '../src/agents/types.js'

/** Card #136. Refusal recorded from Claude Code 2.1.332 on a host without socat. */
const REFUSAL = 'Sandbox required but unavailable: sandbox is enabled but dependencies are missing: socat not installed · install missing tools (e.g. apt install bubblewrap socat) or see https://code.claude.com/docs/en/sandboxing. Set sandbox.failIfUnavailable=false to allow unsandboxed execution.'
const REASON = 'sandbox is enabled but dependencies are missing: socat not installed · install missing tools (e.g. apt install bubblewrap socat) or see https://code.claude.com/docs/en/sandboxing.'

/** A control session as the SDK gives it: an initialization promise and the message stream. */
function session(init: () => Promise<unknown>, messages: unknown[]): Query {
  return {
    initializationResult: init,
    async *[Symbol.asyncIterator]() { yield* messages },
  } as unknown as Query
}

test('the CLI\'s refusal keeps its cause and drops its advice to run unconfined', () => {
  assert.equal(sandboxFailureReason([REFUSAL]), REASON)
  assert.equal(sandboxFailureReason([]), null)
})

test('a control session tells an available sandbox from a refused one, and from a failed check', async () => {
  assert.deepEqual(await readSandboxSupport(session(async () => ({ sandbox_enabled: true }), [])), { state: 'available', reason: null })
  const refused = session(async () => { throw new Error('Claude Code returned an error result') }, [
    { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [REFUSAL], startup_failure_reason: 'sandbox_required_unavailable' },
  ])
  assert.deepEqual(await readSandboxSupport(refused), { state: 'unavailable', reason: REASON })
  // Another refusal says nothing about the sandbox.
  const other = session(async () => { throw new Error('closed') }, [
    { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['The working directory was deleted'], startup_failure_reason: 'cwd_unavailable' },
  ])
  assert.deepEqual(await readSandboxSupport(other), { state: 'unknown', reason: 'The working directory was deleted' })
})

test('the check runs once per cache window and a failure to launch reads as unknown', async () => {
  let probes = 0
  const support = new ClaudeSandboxSupport(async () => 'claude', async () => { probes += 1; throw new Error('Native CLI binary not found') })
  assert.equal((await support.read()).state, 'unknown')
  await support.read()
  assert.equal(probes, 1)
  await support.read(true)
  assert.equal(probes, 2)
})

test('a session refused for its sandbox reports a translatable code with the cause', async (t) => {
  const events: SillageEvent[] = []
  const ctx: RunnerContext = {
    conversationId: 'test', cwd: tmpdir(), config: { ...DEFAULT_CLAUDE_CONFIG, bashSandbox: true }, resumeSessionId: null, attachmentsRoot: tmpdir(), binary: 'unused',
    projectOverview: () => null, maskedInstructionRoots: () => [], memoryDir: () => null,
    resolveMcpServers: () => ({ servers: [], failures: [] }), skillRoots: () => [],
    emit: (event) => events.push(event), setStatus: () => {}, setAgentSessionId: () => {},
    updateConfig: () => {}, openPermissionRequest: () => 'permission', closePermissionRequest: () => {},
  }
  const runner = new ClaudeRunner(ctx)
  t.after(() => runner.stop())
  ;(runner as unknown as { translate(message: unknown): void }).translate({
    uuid: 'u', session_id: 's', type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, total_cost_usd: 0,
    errors: [REFUSAL], startup_failure_reason: 'sandbox_required_unavailable',
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  })
  const error = events.find((event) => event.type === 'error')
  assert.ok(error?.type === 'error')
  assert.equal(error.code, 'sandbox_required_unavailable')
  assert.equal(error.message, REASON)
})
