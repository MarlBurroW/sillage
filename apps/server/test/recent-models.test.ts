import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { conversations, openDatabase, projects, runMigrations, users } from '@sillage/db'
import { DEFAULT_CONFIGS } from '@sillage/protocol'
import { recentModels } from '../src/http/routes/agents.js'

test('modèles récents : par compte et par CLI, du plus récent au plus ancien, sans doublon ni benchmark', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-recent-models-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'sillage.db'))
  t.after(() => sqlite.close())
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  for (const id of ['me', 'other']) db.insert(users).values({ id, username: id, displayName: id, passwordHash: '', createdAt: 1, isAdmin: false }).run()
  db.insert(projects).values({ id: 'p', name: 'P', workspacePath: dir, ownerId: 'me', visibility: 'private', instructionsMode: 'sillage', createdAt: 1 }).run()

  let at = 0
  const conversation = (userId: string, agent: 'opencode' | 'claude', model: string | null, configured = '', benchmarkId: string | null = null) =>
    db.insert(conversations).values({
      id: `c${++at}`, projectId: 'p', userId, title: 't', agent, model, benchmarkId,
      config: JSON.stringify({ ...DEFAULT_CONFIGS[agent], model: configured }), status: 'idle', createdAt: at, updatedAt: at,
    }).run()
  conversation('me', 'opencode', 'anthropic/claude-sonnet-5-5')
  conversation('me', 'opencode', null, 'github-copilot/auto') // no session yet: the configured model
  conversation('me', 'opencode', 'anthropic/claude-sonnet-5-5')
  conversation('me', 'opencode', 'opencode/big-pickle', '', null)
  conversation('me', 'claude', 'opus')
  conversation('other', 'opencode', 'openai/gpt-6')
  conversation('me', 'opencode', 'opencode/kimi', '', 'bench')

  assert.deepEqual(recentModels(db, 'me', 'opencode'), ['opencode/big-pickle', 'anthropic/claude-sonnet-5-5', 'github-copilot/auto'])
  assert.deepEqual(recentModels(db, 'me', 'claude'), ['opus'])
})
