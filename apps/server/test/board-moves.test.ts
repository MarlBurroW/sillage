import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { cardNotes, cards, conversations, openDatabase, projects, runMigrations, users, worktrees } from '@sillage/db'
import type { WorktreeStatusDto, WorktreeStatusListDto } from '@sillage/protocol'
import { closeMergedCards } from '../src/worktrees/merged-cards.js'

/** Cards changing columns without user actions: agent MCP move_card, worktree merges and column arrival timestamps maintained by migration 0047 triggers. */
function harness(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-board-moves-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'test.sqlite')
  const { db, sqlite } = openDatabase(dbPath)
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'project', workspacePath: dir, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()

  const card = (number: number, column: 'todo' | 'in_progress' | 'review' | 'done', createdAt = 1000) => {
    db.insert(cards).values({
      id: `card-${number}`, projectId: 'project', number, title: `Carte ${number}`, column,
      createdBy: 'owner', createdAt, updatedAt: createdAt,
    }).run()
    return `card-${number}`
  }
  const session = (id: string, cardId: string | null, status = 'idle') => {
    db.insert(conversations).values({
      id, projectId: 'project', userId: 'owner', title: id, agent: 'claude', config: '{}', status,
      cardId, createdAt: 2000, updatedAt: 2000,
    }).run()
  }
  const row = (id: string) => db.select().from(cards).where(eq(cards.id, id)).get()!
  const notes = (id: string) => db.select().from(cardNotes).where(eq(cardNotes.cardId, id)).all()
  return { db, dbPath, card, session, row, notes }
}

test('la date d’arrivée suit la colonne, et elle seule', (t) => {
  const { db, card, row } = harness(t)
  const id = card(1, 'todo', 1234)
  assert.equal(row(id).columnEnteredAt, 1234, 'à la création, l’arrivée est la naissance')

  db.update(cards).set({ title: 'Renommée', updatedAt: 5000 }).where(eq(cards.id, id)).run()
  assert.equal(row(id).columnEnteredAt, 1234, 'renommer ne fait pas arriver la carte')

  const before = Date.now()
  db.update(cards).set({ column: 'in_progress' }).where(eq(cards.id, id)).run()
  assert.ok(row(id).columnEnteredAt! >= before - 1, 'un changement de colonne date l’arrivée')
})

/** Real MCP tool call in conversation `agent`. */
async function call(dbPath: string, name: string, args: object) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp/sillage-mcp.mjs', import.meta.url))], {
    env: { ...process.env, SILLAGE_MCP_DB: dbPath, SILLAGE_MCP_PROJECT: 'project', SILLAGE_MCP_CONVERSATION: 'agent' },
  })
  let stdout = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n')
  const deadline = Date.now() + 20000
  while (!stdout.includes('\n') && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50))
  child.kill()
  return JSON.parse(stdout).result as { content: { text: string }[]; isError?: boolean }
}

test('move_card déplace la carte de la conversation ou une autre, et le note', async (t) => {
  const { dbPath, card, session, row, notes } = harness(t)
  const own = card(1, 'in_progress')
  const other = card(2, 'todo')
  session('agent', own)

  const done = await call(dbPath, 'move_card', { column: 'review', reason: 'Prête à relire.' })
  assert.ok(!done.isError, done.content[0]?.text)
  assert.equal(row(own).column, 'review')
  assert.match(notes(own)[0]!.body, /“in progress” to “awaiting review”\. Prête à relire\./)

  const moved = await call(dbPath, 'move_card', { number: 2, column: 'abandoned' })
  assert.ok(!moved.isError, moved.content[0]?.text)
  assert.equal(row(other).column, 'abandoned')

  const same = await call(dbPath, 'move_card', { number: 2, column: 'abandoned' })
  assert.match(same.content[0]!.text, /already/)
  assert.equal(notes(other).length, 1, 'rien à noter quand rien ne bouge')

  const missing = await call(dbPath, 'move_card', { number: 99, column: 'done' })
  assert.equal(missing.isError, true)
  const wrong = await call(dbPath, 'move_card', { column: 'ailleurs' })
  assert.equal(wrong.isError, true)
})

function list(tree: Partial<WorktreeStatusDto>): WorktreeStatusListDto {
  return {
    base: 'main',
    computedAt: Date.now(),
    fresh: true,
    worktrees: [{
      id: 'tree', name: 'feat/x', path: '/tmp/feat-x', branch: 'feat/x', external: false, state: 'merged',
      ahead: 0, behind: 0, modified: 0, untracked: 0, conflicts: false, lastCommitAt: 9000, lastEditAt: null,
      conversations: [{ id: 'worker', link: 'worktree' }],
      ...tree,
    }],
  }
}

test('la fusion du worktree passe sa carte en Terminé, une seule fois', (t) => {
  const { db, card, session, row, notes } = harness(t)
  const project = db.select().from(projects).where(eq(projects.id, 'project')).get()!
  db.insert(worktrees).values({ id: 'tree', projectId: 'project', name: 'feat/x', path: '/tmp/feat-x', baseRef: 'main', createdBy: 'owner', createdAt: 5000 }).run()
  const id = card(1, 'review')
  session('worker', id)

  // Fresh trees without independent commits already look merged but are not completed work.
  assert.equal(closeMergedCards(db, project, list({ lastCommitAt: 4000 })), 0)
  assert.equal(row(id).column, 'review')

  // Sessions still working in trees prevent card completion.
  db.update(conversations).set({ status: 'running' }).where(eq(conversations.id, 'worker')).run()
  assert.equal(closeMergedCards(db, project, list({})), 0)
  db.update(conversations).set({ status: 'idle' }).where(eq(conversations.id, 'worker')).run()

  // Not merged: no change.
  assert.equal(closeMergedCards(db, project, list({ state: 'unmerged', ahead: 2 })), 0)

  assert.equal(closeMergedCards(db, project, list({})), 1)
  assert.equal(row(id).column, 'done')
  assert.equal(row(id).doneByMerge, '/tmp/feat-x')
  assert.match(notes(id)[0]!.body, /`feat\/x` est fusionnée dans `main`/)

  // Manually moved-back cards are not completed again by the same tree.
  db.update(cards).set({ column: 'in_progress' }).where(eq(cards.id, id)).run()
  assert.equal(closeMergedCards(db, project, list({})), 0)
  assert.equal(row(id).column, 'in_progress')
})

test('une carte à faire ou sans session dans l’arbre n’est pas touchée', (t) => {
  const { db, card, session, row } = harness(t)
  const project = db.select().from(projects).where(eq(projects.id, 'project')).get()!
  db.insert(worktrees).values({ id: 'tree', projectId: 'project', name: 'feat/x', path: '/tmp/feat-x', baseRef: 'main', createdBy: 'owner', createdAt: 5000 }).run()
  const todo = card(1, 'todo')
  session('worker', todo)
  const elsewhere = card(2, 'in_progress')
  assert.equal(closeMergedCards(db, project, list({})), 0)
  assert.equal(row(todo).column, 'todo')
  assert.equal(row(elsewhere).column, 'in_progress')
})
