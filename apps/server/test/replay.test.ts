import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { conversations, openDatabase, projects, runMigrations, users } from '@sillage/db'
import type { JournalEntry, SillageEvent } from '@sillage/protocol'
import { coalesceDeltas } from '../src/events/coalesce.js'
import { EventLog } from '../src/events/event-log.js'
import { MAX_OUTPUT_BYTES } from '../src/events/tool-output.js'

// The fold is React-independent; only initial language selection reads the browser.
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => 'fr' }, configurable: true })
const { applyEvent, emptyChatState } = await import('../../web/src/lib/chat-fold.js')
type ChatState = ReturnType<typeof emptyChatState>

const user = (messageId: string, text: string): SillageEvent =>
  ({ type: 'message.completed', messageId, role: 'user', blocks: [{ type: 'text', text }], parentToolCallId: null })
const said = (messageId: string, text: string): SillageEvent =>
  ({ type: 'message.completed', messageId, role: 'assistant', blocks: [{ type: 'text', text }], parentToolCallId: null })
const typing = (messageId: string, text: string): SillageEvent =>
  ({ type: 'message.delta', messageId, text, parentToolCallId: null })
const bash = (toolCallId: string, command: string): SillageEvent =>
  ({ type: 'tool.started', toolCallId, name: 'Bash', input: { command }, parentToolCallId: null })
const chunk = (toolCallId: string, text: string): SillageEvent => ({ type: 'tool.output_delta', toolCallId, chunk: text })
const done = (toolCallId: string, output: string): SillageEvent =>
  ({ type: 'tool.completed', toolCallId, output, isError: false, durationMs: 5 })
const diff = (patch: string): SillageEvent =>
  ({ type: 'diff.updated', patch, files: [{ path: 'a.ts', added: patch.length, removed: 0 }] })
const commands = (...names: string[]): SillageEvent =>
  ({ type: 'commands.updated', commands: names.map((name) => ({ name, description: '', argumentHint: '', aliases: [] })) })
const mcp = (state: 'pending' | 'connected'): SillageEvent =>
  ({ type: 'mcp.updated', servers: [{ name: 'docs', state, tools: [], error: null, external: false }] })
const skills = (...names: string[]): SillageEvent =>
  ({ type: 'skills.updated', skills: names.map((name) => ({ name, description: '' })) })
const turnStart: SillageEvent = { type: 'turn.started' }
const turnEnd: SillageEvent = {
  type: 'turn.completed', stopReason: 'end_turn', costUsd: 0.01, inputTokens: 1, outputTokens: 1,
  cacheCreationTokens: 0, cacheReadTokens: 0,
}

/** Everything replay may omit and similar entries it must retain: interrupted calls without `tool.completed`, reused call IDs after completion, active calls and text deltas merged within pages. */
const JOURNAL: SillageEvent[] = [
  turnStart,
  user('u1', 'Lance les tests'),
  commands('a'),
  mcp('pending'),
  bash('t1', 'npm test'),
  chunk('t1', 'un '),
  diff('p1'),
  chunk('t1', 'deux'),
  typing('m1', 'Je '),
  typing('m1', 'regarde'),
  diff('p1p2'),
  done('t1', 'un deux'),
  commands('a', 'b'),
  diff('p1p2p3'),
  said('m1', 'Je regarde'),
  mcp('connected'),
  turnEnd,
  turnStart,
  user('u2', 'Construis'),
  bash('t2', 'build'),
  chunk('t2', 'interrompu en route'),
  turnEnd,
  turnStart,
  user('u3', 'Encore'),
  bash('t1', 'npm test'),
  chunk('t1', 'de nouveau'),
  diff('q1'),
  skills('s'),
  diff('q1q2'),
  skills('s', 't'),
  bash('t3', 'watch'),
  chunk('t3', 'toujours en cours'),
]

function openJournal(events: SillageEvent[] = JOURNAL): { log: EventLog; close: () => void } {
  const { db, sqlite } = openDatabase(':memory:')
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'Test', workspacePath: '/tmp', ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  db.insert(conversations).values({ id: 'c', projectId: 'project', userId: 'owner', title: 'Relecture', agent: 'claude', config: '{}', status: 'idle', createdAt: 1, updatedAt: 1 }).run()
  const log = new EventLog(db)
  for (const event of events) log.append('c', event)
  return { log, close: () => sqlite.close() }
}

/** Client entry handling: idempotency guard then fold. */
function fold(state: ChatState, entries: Pick<JournalEntry, 'seq' | 'ts' | 'event'>[]): ChatState {
  let next = state
  for (const entry of entries) {
    if (entry.seq <= next.lastSeq) continue
    next = applyEvent(next, entry.seq, entry.ts, entry.event)
  }
  return next
}

/** Full unfiltered journal as the reference. */
function reference(log: EventLog, throughSeq = Number.POSITIVE_INFINITY): ChatState {
  return fold(emptyChatState(), log.read('c', 0, 10_000).filter((entry) => entry.seq <= throughSeq))
}

/** Replay as routes serve it and clients concatenate it page by page. */
function replay(log: EventLog, state: ChatState, after: number, limits = { rows: 3, bytes: 400 }) {
  const received: JournalEntry[] = []
  let cursor = after
  for (;;) {
    const page = log.readForReplay('c', cursor, limits)
    const entries = coalesceDeltas(page.entries)
    received.push(...entries)
    state = fold(state, entries)
    if (page.nextAfter <= cursor) return { state, received }
    cursor = page.nextAfter
  }
}

/** Displayed state excluding `lastSeq`, a replay cursor already changed by merged deltas rather than visible conversation content. */
const shown = (state: ChatState) =>
  JSON.stringify({ ...state, lastSeq: 0 }, (_key, value: unknown) => (value instanceof Map ? [...value] : value))

test('relecture : le fil replié est le même que celui du journal entier, quelle que soit la page', () => {
  const { log, close } = openJournal()
  try {
    const expected = shown(reference(log))
    for (const limits of [{ rows: 1, bytes: 1 }, { rows: 3, bytes: 400 }, { rows: 5000, bytes: 8_000_000 }]) {
      assert.equal(shown(replay(log, emptyChatState(), 0, limits).state), expected, JSON.stringify(limits))
    }
  } finally { close() }
})

test('relecture : un client repris à n’importe quel point du journal retrouve le même fil', () => {
  const { log, close } = openJournal()
  try {
    const expected = shown(reference(log))
    // A tab followed live through `seq`, then disconnected: catch up through routes
    // mid-turn with existing diff cards or running tools.
    for (let seq = 0; seq <= JOURNAL.length; seq += 1) {
      assert.equal(shown(replay(log, reference(log, seq), seq).state), expected, `repris après ${seq}`)
    }
  } finally { close() }
})

test('relecture : ce que la suite rend caduc n’est pas envoyé', () => {
  const { log, close } = openJournal()
  try {
    const { received } = replay(log, emptyChatState(), 0, { rows: 5000, bytes: 8_000_000 })
    const events = received.map((entry) => entry.event)
    const of = <T extends SillageEvent['type']>(type: T) =>
      events.filter((event): event is Extract<SillageEvent, { type: T }> => event.type === type)

    // t1 output lives in `tool.completed`; interrupted t2 and running t3 exist
    // only through deltas, as does restarted t1.
    assert.deepEqual(of('tool.output_delta').map((event) => event.chunk), ['interrompu en route', 'de nouveau', 'toujours en cours'])
    // Each turn's first diff creates the card; its last diff fills it.
    assert.deepEqual(of('diff.updated').map((event) => event.patch), ['p1', 'p1p2p3', 'q1', 'q1q2'])
    assert.deepEqual(of('commands.updated').map((event) => event.commands.map((command) => command.name)), [['a', 'b']])
    assert.deepEqual(of('mcp.updated').map((event) => event.servers[0]?.state), ['connected'])
    assert.deepEqual(of('skills.updated').map((event) => event.skills.map((skill) => skill.name)), [['s', 't']])
  } finally { close() }
})

test('relecture : une page s’arrête à sa borne en octets, mais garde toujours un événement', () => {
  const { log, close } = openJournal([turnStart, said('big', 'x'.repeat(10_000)), said('small', 'y'), turnEnd])
  try {
    const page = (after: number) => {
      const read = log.readForReplay('c', after, { rows: 5000, bytes: 1_000 })
      return { seqs: read.entries.map((entry) => entry.seq), nextAfter: read.nextAfter }
    }
    // Pages stop before events exceeding their budget…
    assert.deepEqual(page(0), { seqs: [1], nextAfter: 1 })
    // …then return those events alone on the next page so they can always pass.
    assert.deepEqual(page(1), { seqs: [2], nextAfter: 2 })
    assert.deepEqual(page(2), { seqs: [3, 4], nextAfter: 4 })
    // At journal end cursors stop advancing, which stops clients.
    assert.deepEqual(page(4), { seqs: [], nextAfter: 4 })
  } finally { close() }
})

test('relecture : une sortie volumineuse n’est ni lue ni envoyée, et ne remplit pas la page', () => {
  const big = 'é'.repeat(MAX_OUTPUT_BYTES)
  const { log, close } = openJournal([
    bash('small', 'ls'), done('small', 'a.ts'),
    bash('big', 'cat'), done('big', big),
    bash('blocks', 'shot'), { type: 'tool.completed', toolCallId: 'blocks', output: [{ type: 'text', text: big }], isError: false, durationMs: 1 },
  ])
  try {
    const completed = replay(log, emptyChatState(), 0, { rows: 5000, bytes: 3 * MAX_OUTPUT_BYTES })
      .received.flatMap((entry) => (entry.event.type === 'tool.completed' ? [entry.event] : []))
    assert.deepEqual(completed.map((event) => [event.toolCallId, event.output, event.outputBytes]), [
      ['small', 'a.ts', undefined],
      // Size reflects JSON clients would receive, including accented characters.
      ['big', null, Buffer.byteLength(JSON.stringify(big))],
      ['blocks', null, Buffer.byteLength(JSON.stringify([{ type: 'text', text: big }]))],
    ])
    // Both outputs occupy 16 KB each in the database but count only their retained
    // replay representation: six events fit a 24 KB page.
    assert.equal(log.readForReplay('c', 0, { rows: 5000, bytes: 3 * MAX_OUTPUT_BYTES }).entries.length, 6)
  } finally { close() }
})

test('relecture : l’index suit un journal qui s’allonge entre deux pages', () => {
  const { log, close } = openJournal()
  try {
    const halfway = replay(log, emptyChatState(), 0, { rows: 5000, bytes: 8_000_000 })
    // t3 completes and turn 3 receives another diff: the former final diff becomes
    // intermediate and t3 deltas become unnecessary for full replay.
    for (const event of [diff('q1q2q3'), done('t3', 'fini'), turnEnd]) log.append('c', event)

    const expected = shown(reference(log))
    const resumed = replay(log, halfway.state, JOURNAL.length)
    assert.equal(shown(resumed.state), expected)

    const fresh = replay(log, emptyChatState(), 0)
    assert.equal(shown(fresh.state), expected)
    const chunks = fresh.received.flatMap((entry) => (entry.event.type === 'tool.output_delta' ? [entry.event.chunk] : []))
    assert.deepEqual(chunks, ['interrompu en route', 'de nouveau'])
  } finally { close() }
})
