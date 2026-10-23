import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { conversations, openDatabase, projects, runMigrations, users } from '@sillage/db'
import { EventLog } from '../src/events/event-log.js'

test('native tool lookup keeps the latest nonempty raw of each kind within its conversation', () => {
  const { db, sqlite } = openDatabase(':memory:')
  try {
    runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
    db.insert(users).values({ id: 'u', username: 'u', displayName: 'u', passwordHash: '', createdAt: 1 }).run()
    db.insert(projects).values({ id: 'p', name: 'Test', workspacePath: '/tmp', ownerId: 'u', visibility: 'private', createdAt: 1 }).run()
    for (const id of ['one', 'two']) db.insert(conversations).values({
      id, projectId: 'p', userId: 'u', title: id, agent: 'codex', config: '{}', status: 'idle', createdAt: 1, updatedAt: 1,
    }).run()
    const log = new EventLog(db)
    const started = (toolCallId: string) => ({ type: 'tool.started' as const, toolCallId, name: 'Edit', input: {}, parentToolCallId: null })
    const completed = (toolCallId: string) => ({ type: 'tool.completed' as const, toolCallId, output: '', isError: false, durationMs: 1 })

    log.append('one', started('edit'), { before: 'original' })
    log.append('one', completed('edit'), { after: 'first' })
    log.append('one', completed('other'), { after: 'unrelated' })
    // Reused call IDs can repeat either kind independently; omitted raw must not
    // erase the last available native payload (the historical reader's behavior).
    log.append('one', started('edit'), { before: 'first' })
    log.append('one', completed('edit'), { after: 'second' })
    log.append('one', started('edit'))
    log.append('one', completed('edit'))
    log.append('two', started('edit'), { before: 'another conversation' })
    log.append('two', completed('edit'), { after: 'another conversation' })
    assert.deepEqual(log.rawOfTool('one', 'edit'), { started: { before: 'first' }, completed: { after: 'second' } })
    assert.deepEqual(log.rawOfTool('one', 'absent'), { started: null, completed: null })
    assert.deepEqual(log.rawOfTool('absent', 'edit'), { started: null, completed: null })
    assert.deepEqual(log.rawOfTool('one', 'other'), { started: null, completed: { after: 'unrelated' } })

    // An explicit JSON null is a native value and supersedes the previous result.
    const last = log.append('one', completed('edit'), null)
    assert.deepEqual(log.rawOfTool('one', 'edit'), { started: { before: 'first' }, completed: null })
    // Legacy empty SQL strings were ignored too, independently of JSON null.
    sqlite.prepare("update events set raw = '' where conversation_id = ? and seq = ?").run('one', last.seq)
    assert.deepEqual(log.rawOfTool('one', 'edit'), { started: { before: 'first' }, completed: { after: 'second' } })
  } finally {
    sqlite.close()
  }
})
