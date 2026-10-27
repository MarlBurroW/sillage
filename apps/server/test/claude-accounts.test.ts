import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { claudeAccounts, openDatabase, runMigrations, users } from '@sillage/db'
import type { AgentUsage, ClaudeAccount } from '@sillage/protocol'
import { ClaudeAccountStore } from '../src/claude-accounts/store.js'
import { CodexAccountHomes } from '../src/codex-accounts/homes.js'
import { CodexAccountStore } from '../src/codex-accounts/store.js'
import { GrokAccountHomes } from '../src/grok-accounts/homes.js'
import { GrokAccountStore } from '../src/grok-accounts/store.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerAgentRoutes } from '../src/http/routes/agents.js'
import { registerClaudeAccountRoutes } from '../src/http/routes/claude-accounts.js'
import type { AgentAdapter, AgentRegistry } from '../src/agents/registry.js'
import type { CliInstaller } from '../src/agents/cli-install.js'
import type { AppContext } from '../src/http/context.js'

const TOKEN = 'sk-ant-oat01-' + 'a'.repeat(40)

async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-claude-accounts-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  for (const id of ['owner', 'other']) {
    db.insert(users).values({ id, username: id, displayName: id, passwordHash: '', createdAt: 1 }).run()
  }
  const store = new ClaudeAccountStore(db, randomBytes(32))

  // Usage under a token: the fake adapter echoes the received token,
  // which is all the route must guarantee.
  const seen: Array<{ accountId: string; token: string }> = []
  const adapter = {
    kind: 'claude',
    label: 'Claude',
    usage: async () => ({ agent: 'claude', plan: 'cli', limitsAvailable: true, windows: [], credits: null, fetchedAt: 1 }) as AgentUsage,
    usageForAccount: async (accountId: string, token: string) => {
      seen.push({ accountId, token })
      return { agent: 'claude', plan: accountId, limitsAvailable: true, windows: [], credits: null, fetchedAt: 1 } as AgentUsage
    },
  } as unknown as AgentAdapter
  const registry = { find: (agent: string) => (agent === 'claude' ? adapter : undefined), all: () => [adapter] } as unknown as AgentRegistry

  const app = Fastify()
  app.addHook('preHandler', async (request) => {
    request.user = db.select().from(users).where(eq(users.id, String(request.headers['x-user'] ?? 'owner'))).get()
  })
  registerErrorHandler(app)
  registerClaudeAccountRoutes(app, store, {} as never)
  registerAgentRoutes(app, { db } as AppContext, registry, {} as CliInstaller, store, { store: new CodexAccountStore(db), homes: new CodexAccountHomes(join(dir, 'codex')) }, { store: new GrokAccountStore(db), homes: new GrokAccountHomes(join(dir, 'grok')) })
  t.after(() => app.close())
  return { db, store, app, seen }
}

test('comptes Claude : par utilisateur, jeton jamais rendu, résolu avec son propriétaire', async (t) => {
  const { db, store, app, seen } = await harness(t)

  const created = await app.inject({ method: 'POST', url: '/api/claude-accounts', payload: { label: ' Boulot ', token: TOKEN } })
  assert.equal(created.statusCode, 201, created.body)
  const account = created.json<ClaudeAccount>()
  assert.equal(account.label, 'Boulot')
  assert.equal(account.kind, 'oauth')
  assert.ok(!('token' in account))

  // Tokens are stored only as ciphertext.
  const row = db.select().from(claudeAccounts).where(eq(claudeAccounts.id, account.id)).get()!
  assert.ok(!row.ciphertext.includes('sk-ant'))
  assert.equal(store.resolveToken('owner', account.id)?.token, TOKEN)
  assert.equal(store.resolveToken('other', account.id), undefined, "Le compte d'un autre ne se résout pas")

  assert.equal((await app.inject({ method: 'POST', url: '/api/claude-accounts', payload: { label: 'Boulot', token: TOKEN } })).statusCode, 409)
  assert.equal((await app.inject({ method: 'POST', url: '/api/claude-accounts', payload: { label: 'Perso', token: 'sk-ant-api03-nope' } })).statusCode, 400, 'Un secret tronqué est refusé')
  const keyed = (await app.inject({ method: 'POST', url: '/api/claude-accounts', payload: { label: 'Boîte', token: 'sk-ant-api03-' + 'k'.repeat(40) } })).json<ClaudeAccount>()
  assert.equal(keyed.kind, 'apiKey', 'Une clé API Console se reconnaît à son préfixe')
  assert.equal(store.resolveToken('owner', keyed.id)?.kind, 'apiKey')
  assert.equal((await app.inject({ method: 'POST', url: '/api/claude-accounts', payload: { label: 'Boulot', token: TOKEN }, headers: { 'x-user': 'other' } })).statusCode, 201, 'Le même nom chez un autre utilisateur passe')

  const list = (await app.inject('/api/claude-accounts')).json<{ accounts: ClaudeAccount[] }>()
  assert.deepEqual(list.accounts.map((entry) => entry.label), ['Boulot', 'Boîte'])
  assert.ok(list.accounts.every((entry) => !('token' in entry)))

  // Per-account usage requires that account and only its owner.
  const usage = await app.inject(`/api/agents/claude/usage?account=${account.id}`)
  assert.equal(usage.statusCode, 200, usage.body)
  assert.equal(usage.json<AgentUsage>().plan, account.id)
  // Subscription tokens read their own usage; API keys have no plan and reach the
  // adapter as empty strings, never as secrets.
  assert.equal((await app.inject(`/api/agents/claude/usage?account=${keyed.id}`)).statusCode, 200)
  assert.deepEqual(seen, [{ accountId: account.id, token: TOKEN }, { accountId: keyed.id, token: '' }])
  assert.equal((await app.inject({ url: `/api/agents/claude/usage?account=${account.id}`, headers: { 'x-user': 'other' } })).statusCode, 404)
  assert.equal((await app.inject('/api/agents/claude/usage')).json<AgentUsage>().plan, 'cli', 'Sans compte, la connexion du CLI')

  // Renaming, replacing tokens or no changes: each has its own response.
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/claude-accounts/${account.id}`, payload: {} })).statusCode, 400)
  const replaced = TOKEN.replace(/a+$/, 'b'.repeat(40))
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/claude-accounts/${account.id}`, payload: { label: 'Travail', token: replaced } })).statusCode, 204)
  assert.equal(store.resolveToken('owner', account.id)?.token, replaced)
  assert.deepEqual(store.list('owner').map((entry) => entry.label), ['Boîte', 'Travail'])
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/claude-accounts/${account.id}`, payload: { label: 'X' }, headers: { 'x-user': 'other' } })).statusCode, 404)

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/claude-accounts/${account.id}`, headers: { 'x-user': 'other' } })).statusCode, 404)
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/claude-accounts/${account.id}` })).statusCode, 204)
  assert.equal(store.list('owner').length, 1)
  assert.equal(store.list('other').length, 1)
})

test('jauge d’un abonnement : fenêtres lues dans les événements de limite du CLI', async () => {
  const { usageFromRateLimits } = await import('../src/agents/claude/usage.js')
  // Shape observed on 2.1.301 with a setup-token token after one Haiku turn.
  const usage = usageFromRateLimits([
    {
      status: 'allowed',
      resetsAt: 1793119800,
      rateLimitType: 'five_hour',
      unifiedWindows: { five_hour: { utilization: 0.03, resetsAt: 1793119800 }, seven_day: { utilization: 0.28, resetsAt: 1793404800 } },
    } as never,
  ])
  assert.equal(usage.limitsAvailable, true)
  assert.deepEqual(usage.windows, [
    { id: 'five_hour', label: '5 heures', utilization: 0.03, resetsAt: 1793119800_000 },
    { id: 'seven_day', label: '7 jours', utilization: 0.28, resetsAt: 1793404800_000 },
  ])
  // Without `unifiedWindows`, each event still gives its own window.
  const fallback = usageFromRateLimits([{ status: 'allowed', rateLimitType: 'seven_day', utilization: 0.5, resetsAt: 10 }])
  assert.deepEqual(fallback.windows, [{ id: 'seven_day', label: '7 jours', utilization: 0.5, resetsAt: 10_000 }])
  assert.equal(usageFromRateLimits([]).limitsAvailable, false)
})
