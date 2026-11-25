import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { openDatabase, projects, runMigrations, users } from '@sillage/db'
import { agentToolSettingsSchema, applyAgentToolOverrides, resolveAgentTools, sanitizeAgentToolSettings } from '@sillage/protocol'
import { agentToolsFor } from '../src/agents/agent-tools.js'
import type { Config } from '../src/config.js'
import { writeAppSettings } from '../src/settings/app-settings.js'

test('a family follows the project, then the instance, then its default', () => {
  assert.deepEqual(resolveAgentTools({}, null), { browser: false })
  assert.deepEqual(resolveAgentTools({ browser: true }, null), { browser: true })
  assert.deepEqual(resolveAgentTools({ browser: true }, {}), { browser: true })
  // The owner may turn off what the instance offers, and turn on what it leaves off.
  assert.deepEqual(resolveAgentTools({ browser: true }, { browser: false }), { browser: false })
  assert.deepEqual(resolveAgentTools({}, { browser: true }), { browser: true })
})

test('project patches clear with null and keep what they omit', () => {
  assert.deepEqual(applyAgentToolOverrides({ browser: true }, {}), { browser: true })
  assert.deepEqual(applyAgentToolOverrides({ browser: true }, { browser: null }), {})
  assert.deepEqual(applyAgentToolOverrides({}, { browser: false }), { browser: false })
})

test('unknown families are refused on write and dropped on read', () => {
  assert.equal(agentToolSettingsSchema.safeParse({ brower: true }).success, false)
  assert.deepEqual(sanitizeAgentToolSettings({ browser: 'yes', other: true }), {})
  assert.deepEqual(sanitizeAgentToolSettings('garbage'), {})
})

test('a session reads the instance setting and its project override', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-agent-tools-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  t.after(() => sqlite.close())
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  db.insert(users).values({ id: 'u', username: 'u', displayName: 'u', passwordHash: '', isAdmin: true, createdAt: 1 }).run()
  db.insert(projects).values({ id: 'p', name: 'p', workspacePath: dir, ownerId: 'u', visibility: 'private', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'q', name: 'q', workspacePath: dir, ownerId: 'u', visibility: 'private', agentTools: '{"browser":false}', createdAt: 1 }).run()
  const config = { retention: { autoArchiveDays: 0, autoArchiveSchedule: '0 3 * * *' }, limits: { maxConcurrentSessions: 4 }, server: { publicUrl: '' } } as unknown as Config

  assert.equal(agentToolsFor(db, config, 'p').browser, false)
  writeAppSettings(db, { agentTools: { browser: true } })
  assert.equal(agentToolsFor(db, config, 'p').browser, true)
  assert.equal(agentToolsFor(db, config, null).browser, true)
  assert.equal(agentToolsFor(db, config, 'q').browser, false)
})
