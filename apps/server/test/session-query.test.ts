import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { openDatabase, runMigrations, users } from '@sillage/db'
import {
  DEFAULT_SESSION_VIEWS,
  SESSION_STATES,
  clearQueryKey,
  evaluateSessionQuery,
  parseSessionQuery,
  queryValues,
  toggleQueryValue,
  type SessionFacts,
} from '@sillage/protocol'
import { registerUserSettingsRoutes } from '../src/http/routes/user-settings.js'
import { registerErrorHandler } from '../src/http/errors.js'
import type { AppContext } from '../src/http/context.js'

const NOW = 10_000_000
const MIN = 60_000
const session = (id: string, facts: Partial<SessionFacts>): SessionFacts => ({
  id, title: id, projectName: 'Sillage', agent: 'claude', state: 'idle', unread: false, favorite: false,
  worktree: null, activityAt: NOW - 60 * MIN, createdAt: 0, ...facts,
})
const sessions = [
  session('wall', { title: 'Écran multi-session', state: 'running', activityAt: NOW - MIN, worktree: 'dirty', unread: true, createdAt: 5 }),
  session('latency', { title: 'Latence Windows', agent: 'codex', state: 'attention', activityAt: NOW - 3 * MIN, worktree: 'dirty', unread: true, createdAt: 4 }),
  session('board', { title: 'Board GitHub', projectName: 'bardak', state: 'idle', activityAt: NOW - 25 * MIN, worktree: 'merged', unread: true, createdAt: 3 }),
  session('helm', { title: 'Chart Helm', projectName: 'infra-k8s', agent: 'codex', state: 'attention', activityAt: NOW - 29 * MIN, createdAt: 2 }),
  session('audit', { title: 'Audit du défilement', agent: 'grok', state: 'idle', activityAt: NOW - 90 * MIN, worktree: undefined, createdAt: 1 }),
  session('demo', { title: 'Déploiement démo', projectName: 'Client démo', state: 'running', activityAt: NOW - 2 * MIN, worktree: 'unmerged', createdAt: 6 }),
]
const ids = (query: string) => evaluateSessionQuery(query, sessions, NOW).ids

test('the wall answers each question the user listed with one short query', () => {
  // The X sessions that worked last.
  assert.deepEqual(ids('sort:activity limit:3'), ['wall', 'demo', 'latency'])
  // Sessions working now.
  assert.deepEqual(ids('is:running'), ['wall', 'demo'])
  // The X latest sessions of a project, with or without accents and spaces.
  assert.deepEqual(ids('project:sillage limit:2'), ['wall', 'latency'])
  assert.deepEqual(ids('project:client-demo'), ['demo'])
  assert.deepEqual(ids('project:"Client démo"'), ['demo'])
  // The X latest sessions active in the last Y minutes.
  assert.deepEqual(ids('active:30m limit:3'), ['wall', 'demo', 'latency'])
  assert.deepEqual(ids('active:30m'), ['wall', 'demo', 'latency', 'board', 'helm'])
  // Uncommitted worktree.
  assert.deepEqual(ids('worktree:dirty'), ['wall', 'latency'])
  // Needing my attention: waiting on a decision or in error.
  assert.deepEqual(ids('is:attention'), ['latency', 'helm'])
  // X unread sessions.
  assert.deepEqual(ids('is:unread limit:2'), ['wall', 'latency'])
})

test('tokens combine with and, values with or, and a dash negates', () => {
  assert.deepEqual(ids('is:running,attention'), ['wall', 'demo', 'latency', 'helm'])
  assert.deepEqual(ids('is:running is:unread'), ['wall'])
  assert.deepEqual(ids('-cli:codex is:attention'), [])
  assert.deepEqual(ids('cli:codex,grok sort:title'), ['audit', 'helm', 'latency'])
  assert.deepEqual(ids('-active:30m'), ['audit'])
  assert.deepEqual(ids('worktree:none'), ['helm'])
  assert.deepEqual(ids('worktree:any sort:created'), ['demo', 'wall', 'latency', 'board'])
})

test('bare words search titles without case or accents', () => {
  assert.deepEqual(ids('ecran'), ['wall'])
  assert.deepEqual(ids('"audit du"'), ['audit'])
  assert.deepEqual(ids('-helm is:attention'), ['latency'])
})

test('a worktree still loading matches no worktree filter, negated or not', () => {
  assert.equal(ids('worktree:none').includes('audit'), false)
  assert.equal(ids('-worktree:dirty').includes('audit'), false)
  assert.equal(ids('cli:grok').includes('audit'), true)
})

test('invalid tokens are flagged and ignored rather than emptying the result', () => {
  const tokens = parseSessionQuery('is:bogus colour:red -limit:3 active:0m project:sillage')
  assert.deepEqual(tokens.map((token) => token.problem), ['invalid_value', 'unknown_key', 'not_negatable', 'invalid_value', null])
  assert.deepEqual(ids('is:bogus project:sillage'), ids('project:sillage'))
  const result = evaluateSessionQuery('is:running limit:1', sessions, NOW)
  assert.equal(result.total, 2)
  assert.deepEqual(result.ids, ['wall'])
})

test('filter buttons only rewrite the text', () => {
  // Running and attention share a token: either state.
  let query = toggleQueryValue('', 'is', 'running', SESSION_STATES)
  query = toggleQueryValue(query, 'is', 'attention', SESSION_STATES)
  assert.equal(query, 'is:running,attention')
  // Unread keeps its own token: both must hold.
  query = toggleQueryValue(query, 'is', 'unread', ['unread'])
  assert.equal(query, 'is:running,attention is:unread')
  assert.deepEqual(queryValues(query, 'is', SESSION_STATES), ['running', 'attention'])
  assert.deepEqual(queryValues(query, 'is', ['unread']), ['unread'])
  // Single-value keys replace, and clicking the selected value removes it.
  query = toggleQueryValue(query, 'limit', '6')
  query = toggleQueryValue(query, 'limit', '8')
  assert.equal(query, 'is:running,attention is:unread limit:8')
  assert.equal(toggleQueryValue(query, 'limit', '8'), 'is:running,attention is:unread')
  // Names with spaces are quoted so the token stays whole.
  assert.equal(toggleQueryValue('', 'project', 'Client démo'), 'project:"Client démo"')
  // Clearing keeps hand-typed negations.
  assert.equal(clearQueryKey('cli:claude -cli:codex is:running', 'cli'), '-cli:codex is:running')
  assert.equal(toggleQueryValue(query, 'is', 'running', SESSION_STATES), 'is:attention is:unread limit:8')
})

test('saved views belong to the account and replace the built-in ones only once edited', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-session-views-'))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  for (const id of ['owner', 'other']) db.insert(users).values({ id, username: id, displayName: id, passwordHash: '', isAdmin: id === 'other', createdAt: 0 }).run()
  const app = Fastify()
  registerErrorHandler(app)
  app.addHook('preHandler', async (request) => {
    request.user = db.select().from(users).where(eq(users.id, String(request.headers['x-user']))).get()
  })
  registerUserSettingsRoutes(app, { db } as AppContext)
  t.after(async () => { await app.close(); sqlite.close(); await rm(dir, { recursive: true, force: true }) })

  const read = async (user: string) => (await app.inject({ url: '/api/me/settings', headers: { 'x-user': user } })).json()
  assert.equal((await read('owner')).sessionViews, null)

  const views = [...DEFAULT_SESSION_VIEWS.slice(1), { id: 'mine', name: 'Revue du matin', preset: null, query: 'is:unread project:sillage', layout: '3', pinned: ['c1'] }]
  const saved = await app.inject({ method: 'PATCH', url: '/api/me/settings', headers: { 'x-user': 'owner' }, payload: { sessionViews: views } })
  assert.equal(saved.statusCode, 200, saved.body)
  assert.deepEqual((await read('owner')).sessionViews, views)
  // Another account, administrator included, keeps its own defaults.
  assert.equal((await read('other')).sessionViews, null)
  // Deleting every view is a choice, not a reset to the built-in ones.
  await app.inject({ method: 'PATCH', url: '/api/me/settings', headers: { 'x-user': 'owner' }, payload: { sessionViews: [] } })
  assert.deepEqual((await read('owner')).sessionViews, [])

  const duplicate = await app.inject({ method: 'PATCH', url: '/api/me/settings', headers: { 'x-user': 'owner' }, payload: { sessionViews: [views[0], views[0]] } })
  assert.equal(duplicate.statusCode, 400)
})

test('a new question snaps the wall; a session leaving on its own stays until read', async () => {
  const { placeTiles } = await import('../../web/src/lib/wall-layout.js')
  const unread = new Set(['b'])
  const keep = (id: string) => unread.has(id)
  let placement = placeTiles(null, 'view\nis:running', ['a', 'b', 'c'], keep)
  assert.deepEqual(placement, { key: 'view\nis:running', ids: ['a', 'b', 'c'], away: [] })
  // `b` finishes while unread: it keeps its slot, marked away. `d` starts and takes the end.
  placement = placeTiles(placement, 'view\nis:running', ['d', 'a', 'c'], keep)
  assert.deepEqual(placement.ids, ['a', 'b', 'c', 'd'])
  assert.deepEqual(placement.away, ['b'])
  // Once read, it leaves; the others never reshuffle even when the query order changes.
  unread.delete('b')
  placement = placeTiles(placement, 'view\nis:running', ['c', 'd', 'a'], keep)
  assert.deepEqual(placement.ids, ['a', 'c', 'd'])
  // Editing the query is a new question: its answer replaces the wall, in query order, even for
  // unread tiles that no longer match.
  unread.add('a')
  placement = placeTiles(placement, 'view\nis:unread', ['e', 'a'], keep)
  assert.deepEqual(placement, { key: 'view\nis:unread', ids: ['e', 'a'], away: [] })
})

test('the grid fills the screen like a call layout and scrolls past the minimum size', async () => {
  const { wallLayout } = await import('../../web/src/lib/wall-layout.js')
  assert.equal(wallLayout(4, 1450, 760, 'auto').columns, 2)
  assert.equal(wallLayout(6, 1450, 760, 'auto').columns, 3)
  assert.equal(wallLayout(8, 1450, 760, 'auto').columns, 4)
  assert.equal(wallLayout(1, 1450, 760, 'auto').columns, 1)
  const crowded = wallLayout(16, 1450, 760, 'auto')
  assert.ok(crowded.rowHeight >= 260, 'tiles keep a readable height and the wall scrolls')
  assert.equal(wallLayout(6, 1450, 760, '2').columns, 2)
  assert.deepEqual(wallLayout(6, 390, 700, 'auto').columns, 1)
})
