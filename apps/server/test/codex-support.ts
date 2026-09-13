import { randomUUID } from 'node:crypto'
import { mkdtemp, copyFile, chmod, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { DEFAULT_CODEX_CONFIG, type SillageEvent, type ConversationStatus } from '@sillage/protocol'
import type { RunnerContext } from '../src/agents/types.js'
import { CodexRunner } from '../src/agents/codex/runner.js'

export async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'sillage-codex-test-'))
  const binary = join(cwd, 'codex.mjs')
  await copyFile(new URL('./fixtures/codex-app-server.mjs', import.meta.url), binary)
  await chmod(binary, 0o700)
  const finalizers: (() => void | Promise<void>)[] = []
  t.after(async () => {
    for (const close of finalizers) await close()
    await rm(cwd, { recursive: true, force: true })
  })
  return { cwd, binary, onClose: (close: () => void | Promise<void>) => finalizers.push(close),
    records: async () => (await readFile(join(cwd, 'rpc.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line)) }
}

export function context(overrides: Partial<RunnerContext> = {}) {
  const events: SillageEvent[] = []
  const raw: unknown[] = []
  const statuses: ConversationStatus[] = []
  const ctx: RunnerContext = {
    conversationId: 'test', cwd: tmpdir(), binary: 'unused', attachmentsRoot: tmpdir(),
    config: DEFAULT_CODEX_CONFIG, resumeSessionId: null,
    projectOverview: () => null, resolveMcpServers: () => ({ servers: [], failures: [] }),
    emit: (event, native) => { events.push(event); raw.push(native) },
    setStatus: (status) => { statuses.push(status) }, setAgentSessionId: () => {},
    updateConfig: () => {}, openPermissionRequest: () => randomUUID(), closePermissionRequest: () => {},
    ...overrides,
  }
  return { ctx, events, raw, statuses }
}

export async function runnerFixture(t: TestContext) {
  const transport = await fixture(t)
  const state = context(transport)
  const runner = new CodexRunner(state.ctx)
  transport.onClose(() => runner.stop())
  await runner.start()
  return { ...state, ...transport, runner,
    emit: (notifications: unknown[] = [], requests: unknown[] = []) =>
      runner.send(`fixture:${JSON.stringify({ notifications, requests })}`, [], [], []),
  }
}

export const done = (id = 'turn-1', threadId = 'root') => ({
  method: 'turn/completed', params: { threadId, turn: { id, status: 'completed', items: [], error: null } },
})

export const itemEvent = (item: unknown, method = 'item/completed', threadId = 'root') => ({
  method, params: { threadId, turnId: 'turn-1', item },
})

export const asyncMessage = {
  type: 'agentMessage' as const, id: 'question-message', text: '- Blue\n- Green', phase: 'commentary' as const,
  memoryCitation: null, delivery: 'async' as const,
  questions: [{ title: 'Which color?', options: ['Blue', 'Green'] }, { title: 'Any constraints?', options: null }],
}
