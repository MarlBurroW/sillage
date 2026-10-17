import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { conversationPaths, conversations, openDatabase, projects, runMigrations, users, worktrees } from '@sillage/db'
import type { AgentRegistry } from '../src/agents/registry.js'
import type { Config } from '../src/config.js'
import { EventLog } from '../src/events/event-log.js'
import { projectOverview } from '../src/agents/overview.js'
import { AgentRequests } from '../src/sessions/agent-requests.js'
import type { SessionManager } from '../src/sessions/session-manager.js'
import { linkedWorktreePaths } from '../src/worktrees/linked.js'
import { WorktreeStatusService } from '../src/worktrees/status-service.js'

/**
 * Les worktrees créés par un agent : le vrai serveur MCP en sous-processus, le daemon
 * qui balaie ses demandes, un vrai dépôt.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function harness(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-worktree-mcp-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const repo = join(dir, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  git(repo, 'config', 'user.name', 'Worktree test')
  git(repo, 'config', 'user.email', 'worktree@example.test')
  writeFileSync(join(repo, 'README.md'), 'main\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'root')
  // L'arbre principal est resté sur une autre branche : la base doit rester main.
  git(repo, 'checkout', '-q', '-b', 'elsewhere')
  writeFileSync(join(repo, 'README.md'), 'elsewhere\n')
  git(repo, 'commit', '-q', '-am', 'elsewhere')

  const dbPath = join(dir, 'test.sqlite')
  const { db, sqlite } = openDatabase(dbPath)
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'project', workspacePath: repo, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  db.insert(conversations).values({
    id: 'agent', projectId: 'project', userId: 'owner', title: 'Session', agent: 'claude', config: '{}', status: 'running',
    createdAt: 1, updatedAt: Date.now(),
  }).run()

  const config = { paths: { data: join(dir, 'data'), worktrees: join(dir, 'worktrees') } } as unknown as Config
  const status = new WorktreeStatusService(db, new EventLog(db))
  const requests = new AgentRequests(
    { db, config }, {} as SessionManager, {} as AgentRegistry,
    undefined, undefined, undefined, undefined, undefined, status,
  )

  const rpc = async (message: object) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp/sillage-mcp.mjs', import.meta.url))], {
      env: { ...process.env, SILLAGE_MCP_DB: dbPath, SILLAGE_MCP_PROJECT: 'project', SILLAGE_MCP_CONVERSATION: 'agent' },
    })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, ...message }) + '\n')
    const deadline = Date.now() + 20000
    while (!stdout.includes('\n') && Date.now() < deadline) {
      await requests.sweep()
      await new Promise((done) => setTimeout(done, 50))
    }
    child.kill()
    return JSON.parse(stdout).result
  }
  const call = async (name: string, args: object) =>
    (await rpc({ method: 'tools/call', params: { name, arguments: args } })) as { content: { text: string }[]; isError?: boolean }

  return { db, repo, config, rpc, call }
}

test('les deux outils sont proposés aux sessions', async (t) => {
  const { rpc } = harness(t)
  const { tools } = (await rpc({ method: 'tools/list' })) as { tools: { name: string; inputSchema: { required?: string[] } }[] }
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
  assert.deepEqual(byName.create_worktree?.inputSchema.required, ['branch'])
  assert.ok(byName.list_worktrees)
})

test('create_worktree : depuis la branche par défaut, rattaché sans toucher au cwd', async (t) => {
  const { db, repo, config, call } = harness(t)

  assert.match((await call('list_worktrees', {})).content[0]!.text, /Aucun worktree/)

  const created = await call('create_worktree', { branch: 'feat/mcp' })
  assert.equal(created.isError, undefined, created.content[0]?.text)
  const path = join(config.paths.worktrees, 'project', 'feat__mcp')
  assert.match(created.content[0]!.text, new RegExp(`prêt dans ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(created.content[0]!.text, /partie de main/)
  // Parti de main, pas de la branche où l'arbre principal était resté.
  assert.equal(git(path, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'main'))

  const row = db.select().from(worktrees).where(eq(worktrees.name, 'feat/mcp')).get()!
  assert.equal(row.path, path)
  assert.equal(db.select().from(conversations).where(eq(conversations.id, 'agent')).get()?.worktreeId, null, 'le cwd de la session ne bouge pas')
  assert.deepEqual(db.select({ path: conversationPaths.path }).from(conversationPaths).all(), [{ path }])
  assert.deepEqual(linkedWorktreePaths(db, 'agent', 'project'), [path])

  // Redemander le même arbre le rend tel quel.
  const again = await call('create_worktree', { branch: 'feat/mcp' })
  assert.equal(again.isError, undefined)
  assert.match(again.content[0]!.text, /existait déjà/)

  // Une branche déjà extraite ailleurs ne peut pas l'être deux fois : git refuse, et
  // l'agent l'apprend en clair.
  const busy = await call('create_worktree', { branch: 'elsewhere' })
  assert.equal(busy.isError, true)
  assert.match(busy.content[0]!.text, /déjà extraite/)

  // Une branche existante et libre est reprise telle quelle, pas recréée depuis la base.
  git(repo, 'branch', 'feat/kept', 'elsewhere')
  const reused = await call('create_worktree', { branch: 'feat/kept' })
  assert.equal(reused.isError, undefined, reused.content[0]?.text)
  assert.match(reused.content[0]!.text, /reprise telle quelle/)
  assert.equal(git(join(config.paths.worktrees, 'project', 'feat__kept'), 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'elsewhere'))

  const listed = (await call('list_worktrees', {})).content[0]!.text
  assert.match(listed, /comparés à main/)
  assert.match(listed, /`feat\/mcp` : fusionné/)
  assert.match(listed, /toi y a travaillé/)
})

test('create_worktree refuse un nom ou une base qui serait lu comme autre chose', async (t) => {
  const { call } = harness(t)
  const missing = await call('create_worktree', {})
  assert.equal(missing.isError, true)
  assert.match(missing.content[0]!.text, /`branch` est requis/)

  const traversal = await call('create_worktree', { branch: 'feat/../escape' })
  assert.equal(traversal.isError, true)
  assert.match(traversal.content[0]!.text, /Nom de worktree invalide/)

  const option = await call('create_worktree', { branch: 'feat/option', base: '--detach' })
  assert.equal(option.isError, true)
  assert.match(option.content[0]!.text, /Base invalide/)
})

test('le prompt dynamique cite les deux outils quand d’autres sessions travaillent dans le projet', async (t) => {
  const { db } = harness(t)
  db.insert(conversations).values({
    id: 'other', projectId: 'project', userId: 'owner', title: 'Voisine', agent: 'codex', config: '{}', status: 'running',
    createdAt: 1, updatedAt: Date.now(),
  }).run()
  const overview = projectOverview(db, { projectId: 'project', conversationId: 'agent', sillageMcp: true }) ?? ''
  assert.match(overview, /`list_worktrees` et `create_worktree` pour travailler dans un arbre à l'écart des autres plutôt que par `git worktree add`/)
})
