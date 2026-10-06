import { randomUUID } from 'node:crypto'
import { mkdtemp, copyFile, chmod, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { DEFAULT_OPENCODE_CONFIG, type SillageEvent, type ConversationStatus } from '@sillage/protocol'
import type { RunnerContext } from '../src/agents/types.js'
import { OpencodeRunner } from '../src/agents/opencode/runner.js'

export const ROOT = 'ses_root'

export async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'sillage-opencode-test-'))
  const binary = join(cwd, 'opencode.mjs')
  await copyFile(new URL('./fixtures/opencode-server.mjs', import.meta.url), binary)
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
    /** Requêtes reçues par le faux serveur, hors flux d'événements. */
    records: () => lines('http.jsonl') as Promise<{ method: string; path: string; body: any }[]>,
    launch: async () => JSON.parse(await readFile(join(cwd, 'launch.json'), 'utf8')) as { config: any; disableProjectConfig: string | null; pid: number },
  }
}

export function context(overrides: Partial<RunnerContext> = {}) {
  const events: SillageEvent[] = []
  const raw: unknown[] = []
  const statuses: ConversationStatus[] = []
  const ctx: RunnerContext = {
    conversationId: 'test', cwd: tmpdir(), binary: 'unused', attachmentsRoot: '/attachments',
    config: DEFAULT_OPENCODE_CONFIG, resumeSessionId: null,
    projectOverview: () => null, maskedInstructionRoots: () => [], memoryDir: () => null,
    resolveMcpServers: () => ({ servers: [], failures: [] }), skillRoots: () => [],
    emit: (event, native) => { events.push(event); raw.push(native) },
    setStatus: (status) => { statuses.push(status) }, setAgentSessionId: () => {},
    updateConfig: () => {}, openPermissionRequest: () => randomUUID(), closePermissionRequest: () => {},
    ...overrides,
  }
  return { ctx, events, raw, statuses }
}

/** Attend qu'une condition du journal soit vraie : le flux SSE est asynchrone. */
export async function until(check: () => boolean, label = 'condition'): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Délai dépassé : ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export async function runnerFixture(t: TestContext, overrides: Partial<RunnerContext> = {}) {
  const transport = await fixture(t)
  const state = context({ cwd: transport.cwd, binary: transport.binary, ...overrides })
  const runner = new OpencodeRunner(state.ctx)
  transport.onClose(() => runner.stop())
  await runner.start()
  const count = (type: SillageEvent['type']) => state.events.filter((event) => event.type === type).length
  return {
    ...state, ...transport, runner, count,
    /** Envoie un message dont le faux serveur joue le scénario. */
    play: (events: unknown[], extra: Record<string, unknown> = {}) =>
      runner.send(`fixture:${JSON.stringify({ events, ...extra })}`, [], []),
    /** Joue un scénario et attend la clôture du tour qu'il contient. */
    turn: async (events: unknown[]) => {
      const before = count('turn.completed')
      await runner.send(`fixture:${JSON.stringify({ events })}`, [], [])
      await until(() => count('turn.completed') > before, 'turn.completed')
    },
  }
}

// Événements natifs, dans la forme sondée sur opencode 1.18.25.

export const busy = (sessionID = ROOT) => ({ type: 'session.status', properties: { sessionID, status: { type: 'busy' } } })
export const idle = (sessionID = ROOT) => ({ type: 'session.idle', properties: { sessionID } })

export const assistant = (id: string, extra: Record<string, unknown> = {}, sessionID = ROOT) => ({
  type: 'message.updated',
  properties: { sessionID, info: {
    id, sessionID, role: 'assistant', parentID: 'msg_user', modelID: 'small', providerID: 'fixture', mode: 'build', agent: 'build',
    path: { cwd: '/', root: '/' }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1 }, ...extra,
  } },
})

export const part = (fields: Record<string, unknown>, messageID = 'msg_a', sessionID = ROOT) => ({
  type: 'message.part.updated',
  properties: { sessionID, time: 1, part: { id: `prt_${fields.type}`, sessionID, messageID, ...fields } },
})

export const delta = (partID: string, text: string, messageID = 'msg_a', sessionID = ROOT) => ({
  type: 'message.part.delta', properties: { sessionID, messageID, partID, field: 'text', delta: text },
})

export const tool = (callID: string, name: string, state: Record<string, unknown>, messageID = 'msg_a', sessionID = ROOT) =>
  part({ id: `prt_${callID}`, type: 'tool', callID, tool: name, state }, messageID, sessionID)

export const stepFinish = (tokens: { input: number; output: number; read?: number }, cost = 0, messageID = 'msg_a', sessionID = ROOT) =>
  part({ id: `prt_step_${messageID}`, type: 'step-finish', reason: 'stop', cost,
    tokens: { input: tokens.input, output: tokens.output, reasoning: 0, cache: { read: tokens.read ?? 0, write: 0 } } }, messageID, sessionID)
