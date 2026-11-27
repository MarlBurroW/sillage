import { mkdtemp, copyFile, chmod, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import type { SillageEvent } from '@sillage/protocol'
import type { RunnerContext } from '../src/agents/types.js'
import { OpencodeRunnerSwitch } from '../src/agents/opencode/runner-switch.js'
import { context, until } from './opencode-support.js'

export { until }

export const ROOT = 'ses_root'
export const CHILD = 'ses_child'

/** The fake 2.x server, copied beside a scratch directory like the 1.x fixture. */
export async function fixture2(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'sillage-opencode2-test-'))
  const binary = join(cwd, 'opencode.mjs')
  await copyFile(new URL('./fixtures/opencode2-server.mjs', import.meta.url), binary)
  await chmod(binary, 0o700)
  const finalizers: (() => void | Promise<void>)[] = []
  t.after(async () => {
    for (const close of finalizers) await close()
    await rm(cwd, { recursive: true, force: true })
  })
  const lines = async (file: string) =>
    (await readFile(join(cwd, file), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  return {
    cwd, binary, onClose: (close: () => void | Promise<void>) => finalizers.push(close),
    records: () => lines('http.jsonl') as Promise<{ method: string; path: string; body: any }[]>,
    launch: async () => JSON.parse(await readFile(join(cwd, 'launch.json'), 'utf8')) as { config: any; disableProjectConfig: string | null },
  }
}

/** A runner behind the version switch, so tests cover the 2.x detection too. */
export async function runner2Fixture(t: TestContext, overrides: Partial<RunnerContext> = {}) {
  const transport = await fixture2(t)
  const formats: (string | undefined)[] = []
  const state = context({ cwd: transport.cwd, binary: transport.binary, ...overrides })
  const emit = state.ctx.emit
  state.ctx.emit = (event, raw, rawFormat) => { formats.push(rawFormat); emit(event, raw) }
  const runner = new OpencodeRunnerSwitch(state.ctx)
  transport.onClose(() => runner.stop())
  await runner.start()
  const count = (type: SillageEvent['type']) => state.events.filter((event) => event.type === type).length
  const of = <T extends SillageEvent['type']>(type: T) => state.events.filter((event): event is Extract<SillageEvent, { type: T }> => event.type === type)
  return {
    ...state, ...transport, runner, count, of, formats,
    /** Sends messages whose scenarios the fake server executes. */
    play: (events: unknown[], extra: Record<string, unknown> = {}) =>
      runner.send(`fixture:${JSON.stringify({ events, ...extra })}`, [], [], []),
    turn: async (events: unknown[]) => {
      const before = count('turn.completed')
      await runner.send(`fixture:${JSON.stringify({ events })}`, [], [], [])
      await until(() => count('turn.completed') > before, 'turn.completed')
    },
  }
}

// Native events in the shapes probed on OpenCode 2.4.1.

const ev = (type: string, data: Record<string, unknown>) => ({ type, data })

export const started = (sessionID = ROOT) => ev('session.execution.started', { sessionID })
export const succeeded = (sessionID = ROOT) => ev('session.execution.succeeded', { sessionID })
export const step = (assistantMessageID: string, sessionID = ROOT) =>
  ev('session.step.started', { sessionID, assistantMessageID, agent: 'build', model: { id: 'small', providerID: 'fixture' } })
export const stepEnded = (assistantMessageID: string, tokens: { input: number; output: number; read?: number }, cost = 0, sessionID = ROOT) =>
  ev('session.step.ended', { sessionID, assistantMessageID, finish: 'stop', cost,
    tokens: { input: tokens.input, output: tokens.output, reasoning: 0, cache: { read: tokens.read ?? 0, write: 0 } } })
/** A session's running total, as 2.x reports it after each step and for spending without one. */
export const usage = (tokens: { input: number; output: number; read?: number }, cost = 0, sessionID = ROOT) =>
  ev('session.usage.updated', { sessionID, cost, tokens: { input: tokens.input, output: tokens.output, reasoning: 0, cache: { read: tokens.read ?? 0, write: 0 } } })
export const text = (kind: 'text' | 'reasoning', assistantMessageID: string, parts: string[], final?: string, sessionID = ROOT) => [
  ev(`session.${kind}.started`, { sessionID, assistantMessageID, ordinal: 0 }),
  ...parts.map((delta) => ev(`session.${kind}.delta`, { sessionID, assistantMessageID, ordinal: 0, delta })),
  ev(`session.${kind}.ended`, { sessionID, assistantMessageID, ordinal: 0, text: final ?? parts.join('') }),
]
export const toolCall = (id: string, name: string, input: unknown, assistantMessageID = 'msg_a', sessionID = ROOT) => [
  ev('session.tool.input.started', { sessionID, assistantMessageID, id, name }),
  ev('session.tool.input.ended', { sessionID, assistantMessageID, id, text: JSON.stringify(input) }),
  ev('session.tool.called', { sessionID, assistantMessageID, id, input, executed: false }),
]
export const toolSuccess = (id: string, output: string, metadata: Record<string, unknown> = {}, assistantMessageID = 'msg_a', sessionID = ROOT) =>
  ev('session.tool.success', { sessionID, assistantMessageID, id, content: [{ type: 'text', text: output }], metadata, executed: false })
export const toolProgress = (id: string, metadata: Record<string, unknown>, assistantMessageID = 'msg_a', sessionID = ROOT) =>
  ev('session.tool.progress', { sessionID, assistantMessageID, id, metadata })
export const permission = (id: string, action: string, resources: string[], metadata: Record<string, unknown> = {}, sessionID = ROOT, save = ['*']) =>
  ev('permission.asked', { id, sessionID, action, resources, save, metadata })
export const form = (id: string, kind: string, fields: unknown[], sessionID = ROOT, title = 'Questions') =>
  ev('form.created', { form: { id, sessionID, title, metadata: { kind }, fields } })
export const job = (status: string, extra: Record<string, unknown> = {}) =>
  ev('experimental.job.updated', { info: {
    kind: 'subagent', id: CHILD, sessionID: ROOT, status, title: 'Read note', childSessionID: CHILD, agent: 'General',
    description: 'Read note', time: { started: 1000, ...(status === 'running' ? {} : { completed: 4000 }) }, ...extra,
  } })
export const childCreated = () => ev('session.created', { sessionID: CHILD, parentID: ROOT, location: { directory: '/' }, title: 'Read note' })
export const report = (body: string) => ev('session.inbox.enqueued', { sessionID: ROOT, inboxID: 'msg_inbox', item: {
  type: 'synthetic',
  payload: { text: `<background-result kind="subagent" sessionID="${CHILD}" state="completed" description="Read note">\n${body}\n</background-result>` },
} })
