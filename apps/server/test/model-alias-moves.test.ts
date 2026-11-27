import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { conversations, openDatabase, projects, runMigrations, scheduledRuns, scheduledTasks, users } from '@sillage/db'
import { DEFAULT_CLAUDE_CONFIG, type AgentKind, type SillageEvent } from '@sillage/protocol'
import { applyEvent, emptyChatState, type ChatState, type NoticeItem } from '@sillage/protocol/chat-state'
import { ClaudeRunner } from '../src/agents/claude/runner.js'
import type { RunnerContext } from '../src/agents/types.js'
import { aliasMoves, tasksToDto } from '../src/scheduler/tasks.js'

// Claude Code 2.1.293 moved `haiku` from Haiku 4.5 to 5.5 and 2.1.321 moved `fable` from 5.1 to
// 5.2, both silently. Probed on 2.1.332: init names the resolved id (`haiku` → claude-haiku-5-5,
// no model → claude-opus-5-5, `opus[1m]` → claude-opus-5-5), a full id comes back unchanged.

const init = { type: 'system', subtype: 'init', permissionMode: 'default', cwd: '/', tools: [], mcp_servers: [], slash_commands: [] }

function runner(model: string) {
  const events: SillageEvent[] = []
  const ctx: RunnerContext = {
    conversationId: 'test', cwd: tmpdir(), config: { ...DEFAULT_CLAUDE_CONFIG, model }, resumeSessionId: null, attachmentsRoot: tmpdir(), binary: 'unused',
    projectOverview: () => null, maskedInstructionRoots: () => [], memoryDir: () => null,
    resolveMcpServers: () => ({ servers: [], failures: [] }), skillRoots: () => [],
    emit: (event) => events.push(event), setStatus: () => {}, setAgentSessionId: () => {},
    updateConfig: () => {}, openPermissionRequest: () => 'permission', closePermissionRequest: () => {},
  }
  const instance = new ClaudeRunner(ctx)
  const translate = (message: Record<string, unknown>) =>
    (instance as unknown as { translate(message: unknown): void }).translate({ uuid: 'u', session_id: 's', ...message })
  const requested = () => events.flatMap((event) => event.type === 'session.started' ? [event.requestedModel] : [])
  return { translate, requested }
}

test('session.started names the configured model it was resolved from', () => {
  const haiku = runner('haiku')
  haiku.translate({ ...init, model: 'claude-haiku-5-5' })
  assert.deepEqual(haiku.requested(), ['haiku'])
  // The CLI default is stored as '': the catalog calls it `default`.
  const fallback = runner('')
  fallback.translate({ ...init, model: 'claude-opus-5-5' })
  assert.deepEqual(fallback.requested(), ['default'])
})

test('a session-wide refusal fallback is not attributed to the alias', () => {
  const f = runner('fable')
  f.translate({ ...init, model: 'claude-fable-5-2' })
  // A sub-agent falling back leaves the session model, and the alias, alone.
  f.translate({ type: 'system', subtype: 'model_refusal_fallback', trigger: 'refusal', direction: 'retry', scope: 'local', original_model: 'claude-fable-5-2', fallback_model: 'claude-opus-5-5', request_id: null })
  f.translate({ ...init, session_id: 's2', model: 'claude-fable-5-2' })
  f.translate({ type: 'system', subtype: 'model_refusal_fallback', trigger: 'refusal', direction: 'retry', scope: 'session', original_model: 'claude-fable-5-2', fallback_model: 'claude-opus-5-5', request_id: null })
  f.translate({ ...init, model: 'claude-opus-5-5' })
  assert.deepEqual(f.requested(), ['fable', 'fable', null])
})

function fold(events: SillageEvent[]): ChatState {
  let state = emptyChatState()
  events.forEach((event, index) => { state = applyEvent(state, index + 1, index + 1, event) })
  return state
}
const started = (model: string, requestedModel?: string | null, cliVersion?: string): SillageEvent =>
  ({ type: 'session.started', agent: 'claude', agentSessionId: 's', model, cwd: '/', tools: [], cliVersion, requestedModel })
const said: SillageEvent = { type: 'message.completed', messageId: 'm', role: 'assistant', blocks: [{ type: 'text', text: 'ok' }], parentToolCallId: null }
const notices = (state: ChatState) => state.items.filter((item): item is NoticeItem => item.kind === 'notice').map((item) => item.translation)

test('the thread says when the same alias resolves to another model', () => {
  const state = fold([started('claude-haiku-4-5-20251001', 'haiku', '2.1.290'), said, started('claude-haiku-5-5', 'haiku', '2.1.293'), said])
  assert.deepEqual(notices(state), [{ key: 'activity.modelAliasMoved', alias: 'haiku', model: 'claude-haiku-5-5', previous: 'claude-haiku-4-5-20251001' }])
  // Shown in the thread, not folded behind a warnings summary.
  assert.equal((state.items.find((item) => item.kind === 'notice') as NoticeItem).level, undefined)
})

test('a model someone picks stays a plain switch, and the alias remembers its own resolution', () => {
  const state = fold([
    started('claude-haiku-4-5-20251001', 'haiku'), said,
    // Picked in the composer: another configured value.
    started('claude-sonnet-5-5', 'sonnet'), said,
    // Back to haiku after a CLI update: compared with what haiku gave, not with sonnet.
    started('claude-haiku-5-5', 'haiku'), said,
    // A later session under the same resolution says nothing.
    started('claude-sonnet-5-5', 'sonnet'), said,
  ])
  assert.deepEqual(notices(state), [
    { key: 'activity.modelChanged', model: 'claude-sonnet-5-5' },
    { key: 'activity.modelAliasMoved', alias: 'haiku', model: 'claude-haiku-5-5', previous: 'claude-haiku-4-5-20251001' },
    { key: 'activity.modelChanged', model: 'claude-sonnet-5-5' },
  ])
})

test('journals without the configured model keep the plain switch notice', () => {
  const state = fold([started('claude-haiku-4-5-20251001'), said, started('claude-haiku-5-5', 'haiku'), said, started('claude-opus-5-5', null), said])
  assert.deepEqual(notices(state), [
    { key: 'activity.modelChanged', model: 'claude-haiku-5-5' },
    { key: 'activity.modelChanged', model: 'claude-opus-5-5' },
  ])
})

test('aliasMoves marks only the first run after the move', () => {
  // Newest first, as the history lists them.
  const moves = aliasMoves([
    { id: 'r5', requested: 'haiku', model: 'claude-haiku-5-5' },
    { id: 'r4', requested: 'haiku', model: 'claude-haiku-5-5' },
    { id: 'r3', requested: null, model: null },
    { id: 'r2', requested: 'haiku', model: 'claude-haiku-4-5-20251001' },
    { id: 'r1', requested: 'claude-haiku-4-5-20251001', model: 'claude-haiku-4-5-20251001' },
  ])
  assert.deepEqual([...moves], [['r4', { alias: 'haiku', model: 'claude-haiku-5-5', previous: 'claude-haiku-4-5-20251001' }]])
})

test('scheduled task history flags the run whose alias resolved elsewhere', () => {
  const { db, sqlite } = openDatabase(':memory:')
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  db.insert(users).values({ id: 'u', username: 'u', displayName: 'u', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'p', name: 'Test', workspacePath: '/tmp', ownerId: 'u', visibility: 'private', createdAt: 1 }).run()
  const config = JSON.stringify({ ...DEFAULT_CLAUDE_CONFIG, model: 'haiku' })
  db.insert(scheduledTasks).values({
    id: 't', projectId: 'p', userId: 'u', name: 'Veille', agent: 'claude', config, prompt: 'go',
    cadence: JSON.stringify({ kind: 'interval', minutes: 60 }), maxDurationMinutes: 30, createdAt: 1, updatedAt: 1,
  }).run()
  const run = (n: number, model: string | null, agent: AgentKind = 'claude') => {
    db.insert(conversations).values({ id: `c${n}`, projectId: 'p', userId: 'u', title: 'run', agent, config, model, scheduleId: 't', status: 'idle', createdAt: n, updatedAt: n }).run()
    db.insert(scheduledRuns).values({ id: `r${n}`, taskId: 't', conversationId: `c${n}`, trigger: 'schedule', status: 'succeeded', scheduledFor: n, startedAt: n }).run()
  }
  run(1, 'claude-haiku-4-5-20251001')
  run(2, 'claude-haiku-4-5-20251001')
  run(3, 'claude-haiku-5-5')
  run(4, 'claude-haiku-5-5')
  const [task] = tasksToDto(db, db.select().from(scheduledTasks).all(), 'https://example.test')
  assert.deepEqual(task!.runs.map((entry) => [entry.id, entry.modelAliasMoved]), [
    ['r4', null],
    ['r3', { alias: 'haiku', model: 'claude-haiku-5-5', previous: 'claude-haiku-4-5-20251001' }],
    ['r2', null],
    ['r1', null],
  ])
  sqlite.close()
})
