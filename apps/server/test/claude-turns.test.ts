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
