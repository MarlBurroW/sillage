import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { conversations, openDatabase, projects, runMigrations, users } from '@sillage/db'
import type { JournalEntry, SillageEvent } from '@sillage/protocol'
import { EventLog } from '../src/events/event-log.js'
import {
  buildHandoff,
  clampHandoffTokens,
  collectHandoffItems,
  DEFAULT_HANDOFF_TOKENS,
  HandoffError,
  itemBytes,
  MAX_HANDOFF_TOKENS,
  MIN_HANDOFF_TOKENS,
  readHandoffItems,
  selectHandoff,
  type HandoffItem,
} from '../src/conversations/handoff.js'

/** Selection handed to another CLI: retained content, order and omission references. No CLI launches here. */

const SOURCE = { id: 'src', title: 'Refonte du cache', agent: 'claude' as const }

const user = (messageId: string, text: string): SillageEvent =>
  ({ type: 'message.completed', messageId, role: 'user', blocks: [{ type: 'text', text }], parentToolCallId: null })
const said = (messageId: string, text: string): SillageEvent =>
  ({ type: 'message.completed', messageId, role: 'assistant', blocks: [{ type: 'text', text }], parentToolCallId: null })
const bash = (toolCallId: string, command: string, parent: string | null = null): SillageEvent =>
  ({ type: 'tool.started', toolCallId, name: 'Bash', input: { command }, parentToolCallId: parent })
const done = (toolCallId: string, output: unknown, isError = false): SillageEvent =>
  ({ type: 'tool.completed', toolCallId, output, isError, durationMs: 5 })
const turnEnd = (stopReason: string): SillageEvent => ({
  type: 'turn.completed', stopReason, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
})

function journal(events: SillageEvent[]): JournalEntry[] {
  return events.map((event, index) => ({ conversationId: 'src', seq: index + 1, ts: index, event }))
}

const bytesOf = (items: HandoffItem[]) => items.reduce((total, item) => total + itemBytes(item), 0)

test('portable forks and transfers retain inherited context without exceeding their budget', () => {
  const items: HandoffItem[] = [{ kind: 'user', seq: 1, text: 'Continue the implementation' }, { kind: 'assistant', seq: 2, text: 'The current change' }]
  const inherited = { fromConversationId: 'earlier-session', throughSeq: 42, text: 'Keep the original requirement' }
  const full = buildHandoff(items, SOURCE, 'antigravity', 1000, inherited)
  assert.ok(full.text.includes(inherited.text))
  assert.ok(full.text.includes('The current change'))
  assert.ok(full.bytes <= 1000)
  const bounded = buildHandoff(items, SOURCE, 'antigravity', 1000, { ...inherited, text: 'old context '.repeat(1000) })
  assert.ok(bounded.text.includes('id="earlier-session" et before=43'))
  assert.ok(bounded.text.includes('Continue the implementation'))
  assert.ok(bounded.bytes <= 1000)
})

test('repli : messages du fil principal, outils avec leur sortie, tours interrompus', () => {
  const items = collectHandoffItems(journal([
    user('u1', 'Corrige le cache'),
    bash('t1', 'npm test'),
    bash('sub', 'ls', 't1'),
    done('t1', [{ type: 'text', text: 'ok' }]),
    { type: 'message.completed', messageId: 'm1', role: 'assistant', blocks: [{ type: 'thinking', text: 'hmm' }, { type: 'text', text: 'Je regarde' }], parentToolCallId: null },
    { type: 'message.completed', messageId: 'm1', role: 'assistant', blocks: [{ type: 'text', text: 'Fait.' }], parentToolCallId: null },
    { type: 'message.completed', messageId: 'child', role: 'assistant', blocks: [{ type: 'text', text: 'sous-agent' }], parentToolCallId: 't1' },
    turnEnd('end_turn'),
    user('u2', 'Continue'),
    bash('t2', 'sleep 100'),
    turnEnd('interrupted'),
  ]))

  assert.deepEqual(items.map((item) => item.kind), ['user', 'tool', 'assistant', 'user', 'tool', 'interrupted'])
  const tool = items[1]
  assert.ok(tool.kind === 'tool')
  assert.equal(tool.output, 'ok')
  assert.equal(tool.input, '{"command":"npm test"}')
  // Combine two `message.completed` entries for one message, excluding reasoning.
  const message = items[2]
  assert.ok(message.kind === 'assistant')
  assert.equal(message.text, 'Je regarde\n\nFait.')
  // Unfinished calls remain without output, describing interrupted work.
  const pending = items[4]
  assert.ok(pending.kind === 'tool' && pending.output === '')
})

test('repli : une sortie retirée de la relecture est signalée par sa taille, une longue est coupée', () => {
  const items = collectHandoffItems(journal([
    bash('t1', 'cat big'),
    { type: 'tool.completed', toolCallId: 't1', output: null, isError: false, durationMs: 1, outputBytes: 50_000 },
    bash('t2', 'cat long'),
    done('t2', 'x'.repeat(5_000)),
  ]))
  const [big, long] = items
  assert.ok(big?.kind === 'tool' && big.output.includes('50000 octets'))
  assert.ok(long?.kind === 'tool' && long.output.length < 1_400 && long.output.includes('tronqué'))
})

test('sélection : la demande d\'origine, puis la fin du fil, les messages avant les outils', () => {
  const items = collectHandoffItems(journal([
    user('u1', 'Demande'),
    said('a1', 'A'.repeat(300)),
    user('u2', 'B'.repeat(300)),
    bash('t1', 'cmd'),
    done('t1', 'O'.repeat(500)),
    said('a2', 'C'.repeat(300)),
    user('u3', 'D'.repeat(300)),
    said('a3', 'E'.repeat(300)),
  ]))
  const head = items[0]!
  const last3 = items.slice(-3)
  // Budget fits the original request and latest three messages, not the tool.
  const budget = itemBytes(head) + bytesOf(last3) + 10
  const selection = selectHandoff(items, budget)

  assert.equal(selection.head, head)
  assert.deepEqual(selection.tail.map((item) => item.kind), ['assistant', 'user', 'assistant'])
  assert.deepEqual(selection.omitted, { messages: 2, fromSeq: 2, toSeq: 3 })
  // The tool lies after the last omitted message and before the first retained one:
  // it prepares that response within the window but does not fit.
  assert.equal(selection.omittedTools, 1)

  // With extra tool space, retain it at its original position.
  const wider = selectHandoff(items, budget + itemBytes(items[3]!) + bytesOf(items.slice(1, 3)))
  assert.deepEqual(wider.tail.map((item) => item.kind), ['assistant', 'user', 'tool', 'assistant', 'user', 'assistant'])
  assert.equal(wider.omitted, null)
})

test('sélection : un outil de la fenêtre qui ne tient pas est compté, pas glissé ailleurs', () => {
  const items = collectHandoffItems(journal([
    user('u1', 'Demande'),
    said('a1', 'A'),
    bash('t1', 'cmd'),
    done('t1', 'O'.repeat(1_000)),
    said('a2', 'B'),
  ]))
  const selection = selectHandoff(items, bytesOf(items.filter((item) => item.kind !== 'tool')) + 10)
  assert.deepEqual(selection.tail.map((item) => item.kind), ['assistant', 'assistant'])
  assert.equal(selection.omittedTools, 1)
  assert.equal(selection.omitted, null)
})

test('sélection : la demande seule au-delà du budget échoue plutôt que de partir tronquée', () => {
  const items = collectHandoffItems(journal([user('u1', 'X'.repeat(2_000)), said('a1', 'ok')]))
  assert.throws(() => selectHandoff(items, 500), (err: unknown) => err instanceof HandoffError && err.code === 'handoff_too_large')
})

test('rendu : la référence vers les messages omis cite la source et le curseur de read_conversation', () => {
  const items = collectHandoffItems(journal([
    user('u1', 'Demande'),
    said('a1', 'M'.repeat(700)),
    user('u2', 'N'.repeat(700)),
    said('a2', 'Fin'),
  ]))
  const result = buildHandoff(items, SOURCE, 'codex', MIN_HANDOFF_TOKENS)

  assert.ok(result.text.startsWith("# Suite d'une conversation menée avec Claude Code"))
  assert.match(result.text, /poursuivie maintenant avec Codex/)
  assert.match(result.text, /## Utilisateur \(message 1\)\nDemande/)
  assert.match(result.text, /\[2 message\(s\) omis ici, du message 2 au message 3\. Pour les relire : read_conversation avec id="src" et before=4/)
  assert.match(result.text, /## Agent \(message 4\)\nFin$/)
  assert.equal(result.selected, 2)
  assert.equal(result.omitted, 2)
  // History counted excluding headers and within budget.
  assert.ok(result.bytes < Buffer.byteLength(result.text))
  assert.ok(result.bytes <= MIN_HANDOFF_TOKENS)
})

test('rendu : tout tient, aucune référence ; un tour interrompu est dit', () => {
  const items = collectHandoffItems(journal([
    user('u1', 'Demande'),
    bash('t1', 'sleep'),
    turnEnd('interrupted'),
    user('u2', 'Reprends'),
    said('a1', 'Reprise'),
  ]))
  const result = buildHandoff(items, SOURCE, 'opencode', DEFAULT_HANDOFF_TOKENS)
  assert.doesNotMatch(result.text, /message\(s\) omis|appel\(s\) d'outil/)
  assert.match(result.text, /### Outil Bash\nEntrée : \{"command":"sleep"\}\nSortie : aucune, le tour a été interrompu avant\./)
  assert.match(result.text, /\[Tour interrompu par l'utilisateur/)
  assert.equal(result.omitted, 0)
})

test('rendu : un fil vide ou un budget qui ne tient pas même la référence échouent proprement', () => {
  assert.throws(() => buildHandoff([], SOURCE, 'codex', DEFAULT_HANDOFF_TOKENS), (err: unknown) => err instanceof HandoffError && err.code === 'handoff_empty')
  const items = collectHandoffItems(journal([user('u1', 'Demande')]))
  assert.throws(() => buildHandoff(items, SOURCE, 'codex', 200), (err: unknown) => err instanceof HandoffError && err.code === 'handoff_too_large')
})

test('budget : le défaut, puis les bornes', () => {
  assert.equal(clampHandoffTokens(undefined), DEFAULT_HANDOFF_TOKENS)
  assert.equal(clampHandoffTokens(10), MIN_HANDOFF_TOKENS)
  assert.equal(clampHandoffTokens(1_000_000), MAX_HANDOFF_TOKENS)
  assert.equal(clampHandoffTokens(20_000.7), 20_000)
})

test('journal : la sélection se lit par pages, sans les sorties volumineuses', () => {
  const { db, sqlite } = openDatabase(':memory:')
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'Test', workspacePath: '/tmp', ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  db.insert(conversations).values({ id: 'src', projectId: 'project', userId: 'owner', title: SOURCE.title, agent: 'claude', config: '{}', status: 'idle', createdAt: 1, updatedAt: 1 }).run()
  const log = new EventLog(db)
  try {
    log.append('src', user('u1', 'Demande'))
    log.append('src', bash('t1', 'cat big'))
    log.append('src', done('t1', 'x'.repeat(20_000)))
    log.append('src', said('a1', 'Voilà'))

    const items = readHandoffItems(log, 'src')
    assert.deepEqual(items.map((item) => item.kind), ['user', 'tool', 'assistant'])
    const tool = items[1]
    assert.ok(tool?.kind === 'tool' && tool.output.includes('non transférée'))
  } finally {
    sqlite.close()
  }
})
