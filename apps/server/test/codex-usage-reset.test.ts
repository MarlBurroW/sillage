import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { conversations, openDatabase, projects, runMigrations, usageLimitResumes, users } from '@sillage/db'
import { DEFAULT_CODEX_CONFIG, DEFAULT_CLAUDE_CONFIG } from '@sillage/protocol'
import { CodexUsageReader } from '../src/agents/codex/usage.js'
import { CodexAccountHomes } from '../src/codex-accounts/homes.js'
import { CodexAccountStore } from '../src/codex-accounts/store.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerAgentRoutes } from '../src/http/routes/agents.js'
import type { AgentAdapter, AgentRegistry } from '../src/agents/registry.js'
import type { AppContext } from '../src/http/context.js'
import { fixture } from './codex-support.js'

// The reader speaks to the fixture app-server only: a real call would spend a reset of the host.
test('the usage reading lists free resets with the soonest expiry, and spending one picks that credit', async (t) => {
  const f = await fixture(t)
  const reader = new CodexUsageReader(async () => f.binary)
  const usage = await reader.readForAccount('account', f.cwd)
  assert.deepEqual(usage.resetCredits, { available: 2, nextExpiresAt: 1796164434_000, title: 'Full reset', description: 'Thanks for using Codex!' })

  assert.equal(await reader.consumeReset(f.cwd), 'reset')
  const calls = (await readFile(join(f.cwd, 'rpc.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  const consumed = calls.filter((call) => call.method === 'account/rateLimitResetCredit/consume')
  assert.equal(consumed.length, 1)
  assert.equal(consumed[0].params.creditId, 'soon')
  assert.match(consumed[0].params.idempotencyKey, /^[0-9a-f-]{36}$/)
})

async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-codex-reset-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'admin', username: 'admin', displayName: 'Admin', passwordHash: '', isAdmin: true, createdAt: 1 }).run()
  db.insert(users).values({ id: 'member', username: 'member', displayName: 'Member', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'P', workspacePath: dir, ownerId: 'admin', visibility: 'private', createdAt: 1 }).run()

  const accounts = new CodexAccountStore(db)
  const mine = accounts.create('member', 'Work')
  accounts.setIdentity(mine.id, { authMode: 'chatgpt', email: null, planType: 'plus' })
  const homes = new CodexAccountHomes(join(dir, 'codex'))

  const consumed: Array<string | null> = []
  const adapter = {
    kind: 'codex', label: 'Codex',
    consumeUsageReset: async (credential: string | null) => { consumed.push(credential); return 'reset' },
  } as unknown as AgentAdapter
  const registry = { find: (agent: string) => (agent === 'codex' ? adapter : undefined), all: () => [adapter] } as unknown as AgentRegistry

  // Sessions waiting on a limit: one per account, plus another CLI.
  const later = Date.now() + 3 * 86_400_000
  const waiting = (id: string, agent: 'codex' | 'claude', config: object) => {
    db.insert(conversations).values({ id, projectId: 'project', userId: 'member', title: id, agent, config: JSON.stringify(config), status: 'idle', createdAt: 1, updatedAt: 1 }).run()
    db.insert(usageLimitResumes).values({ id: `resume-${id}`, conversationId: id, userId: 'member', resetsAt: later, resumeAt: later, status: 'scheduled', message: null, createdAt: 1 }).run()
  }
  waiting('cli', 'codex', DEFAULT_CODEX_CONFIG)
  waiting('work', 'codex', { ...DEFAULT_CODEX_CONFIG, account: mine.id })
  waiting('claude', 'claude', DEFAULT_CLAUDE_CONFIG)
  const resumeAt = (id: string) => db.select().from(usageLimitResumes).where(eq(usageLimitResumes.conversationId, id)).get()!.resumeAt

  const app = Fastify()
  app.addHook('preHandler', async (request) => {
    request.user = db.select().from(users).where(eq(users.id, String(request.headers['x-user'] ?? 'admin'))).get()
  })
  registerErrorHandler(app)
  registerAgentRoutes(app, { db } as AppContext, registry, {} as never, {} as never, { store: accounts, homes }, {} as never, {} as never, {} as never)
  t.after(() => app.close())
  const reset = (user: string, account: string | null) =>
    app.inject({ method: 'POST', url: '/api/agents/codex/usage/reset', payload: { account }, headers: { 'x-user': user } })
  return { mine, homes, consumed, reset, resumeAt, later }
}

test('a reset follows the account rule and brings forward the sessions waiting on that account', async (t) => {
  const { mine, homes, consumed, reset, resumeAt, later } = await harness(t)

  // The CLI's own login belongs to the admin; a member cannot spend its resets.
  assert.equal((await reset('member', null)).statusCode, 403)
  // An additional account belongs to its owner only, admin included.
  assert.equal((await reset('admin', mine.id)).statusCode, 404)
  assert.deepEqual(consumed, [])

  const own = await reset('member', mine.id)
  assert.equal(own.statusCode, 200, own.body)
  assert.deepEqual(own.json(), { outcome: 'reset', resumed: 1 })
  assert.deepEqual(consumed, [homes.ensure(mine.id)])
  assert.ok(resumeAt('work')! <= Date.now())
  assert.equal(resumeAt('cli'), later)
  assert.equal(resumeAt('claude'), later)

  const cli = await reset('admin', null)
  assert.deepEqual(cli.json(), { outcome: 'reset', resumed: 1 })
  assert.deepEqual(consumed.at(-1), null)
  assert.ok(resumeAt('cli')! <= Date.now())
  assert.equal(resumeAt('claude'), later)
})
