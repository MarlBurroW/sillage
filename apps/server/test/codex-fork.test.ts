import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { conversations, openDatabase, projects, runMigrations, users } from '@sillage/db'
import { CodexAdapter } from '../src/agents/codex/adapter.js'
import { ForkError } from '../src/agents/registry.js'
import { EventLog } from '../src/events/event-log.js'

/**
 * Point de coupe d'un fork Codex : l'identifiant du dernier tour conservé, relu dans
 * la notification native conservée avec `turn.completed`. Ce que le test protège,
 * c'est la lecture du journal, pas l'appel au CLI.
 */
function openJournal(): { log: EventLog; adapter: CodexAdapter; close: () => void } {
  const { db, sqlite } = openDatabase(':memory:')
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'Test', workspacePath: '/tmp', ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  db.insert(conversations).values({ id: 'c', projectId: 'project', userId: 'owner', title: 'Fork', agent: 'codex', config: '{}', status: 'idle', createdAt: 1, updatedAt: 1 }).run()
  const adapter = new CodexAdapter({
    agents: { codex: { binary: 'codex', enabled: true } },
    paths: { agents: '/tmp' },
  } as unknown as ConstructorParameters<typeof CodexAdapter>[0])
  return { log: new EventLog(db), adapter, close: () => sqlite.close() }
}

function turn(log: EventLog, id: string, raw = true): number {
  log.append('c', { type: 'turn.started' })
  const entry = log.append(
    'c',
    { type: 'turn.completed', stopReason: 'completed', costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    raw ? { threadId: 't', turn: { id, status: 'completed', items: [] } } : undefined,
    raw ? 'codex-app-server@v2' : undefined,
  )
  return entry.seq
}

test('fork Codex : couper à un tour désigne son identifiant natif, à la fin aucun', () => {
  const { log, adapter, close } = openJournal()
  try {
    const first = turn(log, 'turn-1')
    const second = turn(log, 'turn-2')
    turn(log, 'turn-3')

    assert.deepEqual(adapter.forkCut(log, 'c', first), { lastTurnId: 'turn-1' })
    assert.deepEqual(adapter.forkCut(log, 'c', second), { lastTurnId: 'turn-2' })
    // Au bout du fil, rien à retirer : le fork copie tout, sans désigner de tour.
    assert.deepEqual(adapter.forkCut(log, 'c', 1_000), { lastTurnId: null })
    // Avant le premier tour terminé, la branche n'aurait rien à reprendre.
    assert.throws(() => adapter.forkCut(log, 'c', first - 1), ForkError)
  } finally {
    close()
  }
})

test('fork Codex : un journal sans notification native refuse la coupe plutôt que de forker tout', () => {
  const { log, adapter, close } = openJournal()
  try {
    const first = turn(log, 'turn-1', false)
    turn(log, 'turn-2', false)
    assert.throws(() => adapter.forkCut(log, 'c', first), ForkError)
    assert.deepEqual(adapter.forkCut(log, 'c', 1_000), { lastTurnId: null })
  } finally {
    close()
  }
})
