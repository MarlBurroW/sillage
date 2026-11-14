import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { openDatabase, runMigrations, users } from '@sillage/db'
import { claudeLoginExpiry } from '@sillage/protocol'
import { ClaudeHostStatus, parseHostLogin } from '../src/claude-accounts/host-status.js'
import type { OutgoingNotification } from '../src/notifications/dispatcher.js'

async function database(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-claude-host-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  for (const [id, isAdmin] of [['admin', true], ['member', false], ['another-admin', true]] as const) {
    db.insert(users).values({ id, username: id, displayName: id, passwordHash: '', isAdmin, createdAt: 1 }).run()
  }
  return db
}

test('host status retains only state and a valid subscription expiry, including old and logged-out CLIs', () => {
  const fields = { loggedIn: true, authMethod: 'claude.ai', loginExpiresAt: '2026-12-11T20:53:03.641Z', email: 'private@example.test', token: 'never-return-this' }
  assert.deepEqual(parseHostLogin(JSON.stringify(fields)), { state: 'connected', loginExpiresAt: fields.loginExpiresAt })
  assert.deepEqual(parseHostLogin(JSON.stringify({ ...fields, authMethod: 'api_key' })), { state: 'connected', loginExpiresAt: null })
  assert.deepEqual(parseHostLogin(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })), { state: 'connected', loginExpiresAt: null })
  assert.deepEqual(parseHostLogin(JSON.stringify({ ...fields, loginExpiresAt: 'invalid' })), { state: 'connected', loginExpiresAt: null })
  assert.deepEqual(parseHostLogin(JSON.stringify({ loggedIn: false })), { state: 'disconnected', loginExpiresAt: null })
  for (const raw of ['', 'null', 'unknown auth command', '{}']) assert.deepEqual(parseHostLogin(raw), { state: 'unavailable', loginExpiresAt: null })
})

test('expiry thresholds allow a three-day safety margin without treating unknown dates as safe', () => {
  const now = Date.parse('2026-11-14T12:00:00Z')
  const afterDays = (days: number) => new Date(now + days * 86_400_000).toISOString()
  assert.equal(claudeLoginExpiry(afterDays(11), now), null)
  assert.equal(claudeLoginExpiry(afterDays(10), now), 'soon')
  assert.equal(claudeLoginExpiry(afterDays(3), now), 'urgent')
  assert.equal(claudeLoginExpiry(afterDays(0), now), 'expired')
  assert.equal(claudeLoginExpiry(afterDays(-3), now), 'expired')
  assert.equal(claudeLoginExpiry(null, now), null)
  assert.equal(claudeLoginExpiry('invalid', now), null)
})

test('host checks share probes, notify administrators once per threshold, and survive restarts and renewal', async (t) => {
  const db = await database(t)
  let calls = 0
  let expiresAt = new Date(Date.now() + 9 * 86_400_000).toISOString()
  const probe = async () => { calls++; return JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', loginExpiresAt: expiresAt }) }
  const sent: Array<{ userId: string; notification: OutgoingNotification }> = []
  const notifications = { dispatch: async (userId: string, notification: OutgoingNotification) => { sent.push({ userId, notification }) } }
  const service = new ClaudeHostStatus(db, async () => 'fixture', notifications, probe)
  const [a, b] = await Promise.all([service.read(), service.read()])
  assert.equal(calls, 1)
  assert.deepEqual(a, b)
  await Promise.all([service.check(), service.check()])
  assert.equal(calls, 1)
  assert.deepEqual(sent.map((entry) => entry.userId).sort(), ['admin', 'another-admin'])
  assert.ok(sent.every((entry) => entry.notification.kind === 'credentialExpiry' && entry.notification.push.url === '/settings/comptes-claude'))
  assert.deepEqual(sent[0]?.notification.toast, { kind: 'credentialExpiry', agent: 'claude', loginExpiresAt: expiresAt })
  await service.check()
  assert.equal(sent.length, 2)
  const restarted = new ClaudeHostStatus(db, async () => 'fixture', notifications, probe)
  await restarted.check()
  assert.equal(sent.length, 2)

  // Native auth status may revise an estimated date; announce the tighter window.
  expiresAt = new Date(Date.now() + 2 * 86_400_000).toISOString()
  await service.read(true)
  await service.check()
  assert.equal(sent.length, 4)
  expiresAt = new Date(Date.now() - 1000).toISOString()
  await service.read(true)
  await service.check()
  assert.equal(sent.length, 6)
  expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString()
  await service.read(true)
  await service.check()
  assert.equal(sent.length, 6)
  assert.equal(claudeLoginExpiry((await service.read()).loginExpiresAt), null)
})

test('disabled CLIs and failed probes never launch repeatedly or leak diagnostics into account state', async (t) => {
  const db = await database(t)
  let calls = 0
  const notifications = { dispatch: async () => { assert.fail('no warning without an expiry') } }
  const disabled = new ClaudeHostStatus(db, async () => { calls++; return 'fixture' }, notifications, async () => '', false)
  await disabled.check()
  assert.equal(calls, 0)
  const failed = new ClaudeHostStatus(db, async () => 'fixture', notifications, async () => { calls++; throw new Error('private diagnostic') })
  const status = await failed.read()
  assert.equal(status.state, 'unavailable')
  assert.equal(status.loginExpiresAt, null)
  await failed.check()
  assert.equal(calls, 1)
})
