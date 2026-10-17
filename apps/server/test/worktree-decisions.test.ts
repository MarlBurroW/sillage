import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import Fastify from 'fastify'
import { requestedDecisionSources } from '@sillage/protocol'
import { conversations, decisions, openDatabase, projects, runMigrations, users } from '@sillage/db'
import type { Config } from '../src/config.js'
import { DecisionService } from '../src/decisions/service.js'
import { EventLog } from '../src/events/event-log.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerDecisionRoutes } from '../src/http/routes/decisions.js'
import type { TerminalManager } from '../src/terminals/terminal-manager.js'
import { WorktreeCleanup } from '../src/worktrees/cleanup.js'
import { watchMergedWorktrees } from '../src/worktrees/merge-watch.js'
import { WorktreeStatusService } from '../src/worktrees/status-service.js'

/**
 * « À décider » propose de nettoyer un arbre fusionné et propre : détection, une seule
 * question par arbre, retrait quand l'arbre bouge, et réponse qui nettoie ou garde.
 */
const isolation = mkdtempSync(join(tmpdir(), 'sillage-worktree-decision-isolation-'))
writeFileSync(join(isolation, 'gitconfig'), '')
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = join(isolation, 'gitconfig')
after(() => rmSync(isolation, { recursive: true, force: true }))

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** Laisse passer les abonnés du calcul, qui tournent hors du chemin de la réponse. */
const settle = () => new Promise((done) => setTimeout(done, 100))

function harness(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-worktree-decisions-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'Decision test')
  git(repo, 'config', 'user.email', 'decision@example.test')
  writeFileSync(join(repo, 'README.md'), 'base\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'root')

  /** Une branche dans son arbre, fusionnée par squash dans main. */
  const merged = (branch: string) => {
    const path = join(dir, 'trees', branch.replace(/\//g, '__'))
    git(repo, 'worktree', 'add', '-q', '-b', branch, path, 'main')
    writeFileSync(join(path, `${branch.replace(/\//g, '-')}.txt`), `${branch}\n`)
    git(path, 'add', '-A')
    git(path, 'commit', '-q', '-m', branch)
    git(repo, 'merge', '-q', '--squash', branch)
    git(repo, 'commit', '-q', '-m', `squash ${branch}`)
    return path
  }

  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'Owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'project', workspacePath: repo, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  const project = db.select().from(projects).where(eq(projects.id, 'project')).get()!

  const log = new EventLog(db)
  const status = new WorktreeStatusService(db, log)
  const announced: string[] = []
  const service = new DecisionService(
    { db, config: {} as Config },
    { sendMessage: async () => { throw new Error('une proposition de nettoyage ne s’adresse à aucune session') } },
    { dispatch: async (_user, payload) => { announced.push(String((payload.toast as { question?: string } | undefined)?.question ?? '')) }, decisionsChanged: () => {} },
  )
  const terminals = { underCwd: () => [] as string[], close: () => {} } as unknown as TerminalManager
  const cleanup = new WorktreeCleanup(db, dir, status, terminals, async () => {})
  watchMergedWorktrees(db, status, service, cleanup)

  /** Recalcule comme après un tour, et laisse la détection passer. */
  const compute = async () => {
    status.invalidate('project')
    await status.current(project)
    await settle()
  }
  const rows = () => db.select().from(decisions).all()

  return { db, repo, merged, compute, rows, service, announced }
}

test('un arbre fusionné et propre est proposé une fois, au propriétaire', async (t) => {
  const { db, repo, merged, compute, rows, announced } = harness(t)
  const path = merged('feat/done')
  // Un arbre qui porte encore du travail n'est pas proposé.
  const busyTree = join(repo, '..', 'trees', 'feat__wip')
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/wip', busyTree, 'main')
  writeFileSync(join(busyTree, 'wip.txt'), 'wip\n')

  await compute()
  const [first, ...others] = rows()
  assert.equal(others.length, 0)
  assert.deepEqual(
    [first!.sourceKind, first!.sourceLabel, first!.worktreePath, first!.userId, first!.status, JSON.parse(first!.options)],
    ['worktree', 'feat/done', path, 'owner', 'pending', ['clean', 'keep']],
  )
  assert.equal(first!.conversationId, '')
  assert.deepEqual(announced, ['feat/done est fusionnée et propre : nettoyer ?'])

  // Les calculs suivants ne reposent pas la question.
  await compute()
  assert.equal(rows().length, 1)

  // L'échéance la clôt sans rien remettre ni nettoyer : la session n'existe pas.
  db.update(decisions).set({ expiresAt: Date.now() - 1 }).run()
  await new DecisionService({ db, config: {} as Config }, { sendMessage: async () => { throw new Error('aucune remise attendue') } }, { dispatch: async () => {}, decisionsChanged: () => {} }).tick()
  assert.equal(rows()[0]!.status, 'expired')
  assert.ok(rows()[0]!.deliveredAt)
  assert.ok(existsSync(path))
  await compute()
  assert.equal(rows().length, 1, 'une question expirée ne revient pas')
})

test('une session qui travaille encore dans l’arbre repousse la question', async (t) => {
  const { db, merged, compute, rows } = harness(t)
  const path = merged('feat/agent')
  db.insert(conversations).values({
    id: 'agent', projectId: 'project', userId: 'owner', title: 'Agent', agent: 'claude', config: '{}', status: 'running',
    createdAt: 1, updatedAt: 5,
  }).run()
  new EventLog(db).append('agent', { type: 'file.edited', toolCallId: 't', path: join(path, 'x.txt'), action: 'modified' })

  await compute()
  assert.equal(rows().length, 0)

  db.update(conversations).set({ status: 'idle' }).where(eq(conversations.id, 'agent')).run()
  await compute()
  assert.equal(rows().length, 1)
  assert.equal(rows()[0]!.conversationId, 'agent')
})

test('la proposition se retire quand l’arbre reprend du travail ou disparaît', async (t) => {
  const { merged, compute, rows, repo } = harness(t)
  const reopened = merged('feat/reopened')
  const removed = merged('feat/removed')
  await compute()
  assert.equal(rows().filter((row) => row.status === 'pending').length, 2)

  writeFileSync(join(reopened, 'again.txt'), 'again\n')
  git(repo, 'worktree', 'remove', '--force', removed)
  await compute()
  const byPath = new Map(rows().map((row) => [row.worktreePath, row]))
  assert.equal(byPath.get(reopened)!.status, 'withdrawn')
  assert.match(byPath.get(reopened)!.withdrawnReason ?? '', /de nouveau du travail/)
  assert.equal(byPath.get(removed)!.status, 'withdrawn')

  // Fusionné de nouveau, l'arbre est reproposé : le retrait ne vaut pas réponse.
  rmSync(join(reopened, 'again.txt'))
  await compute()
  assert.equal(rows().filter((row) => row.worktreePath === reopened && row.status === 'pending').length, 1)
})

test('répondre « Garder » laisse l’arbre, « Nettoyer » le retire avec sa branche', async (t) => {
  const { repo, merged, compute, rows, service } = harness(t)
  const kept = merged('feat/kept')
  const cleaned = merged('feat/cleaned')
  await compute()
  const id = (path: string) => rows().find((row) => row.worktreePath === path)!.id

  const keep = await service.answer('owner', id(kept), { option: 'keep', text: '' })
  assert.equal(keep.status, 'answered')
  assert.equal(keep.answer?.option, 'keep')
  assert.equal(keep.source.worktreePath, kept)
  assert.ok(existsSync(kept))

  await assert.rejects(service.answer('owner', id(cleaned), { option: null, text: 'vas-y' }), /Choose one of the options/)
  const clean = await service.answer('owner', id(cleaned), { option: 'clean', text: '' })
  assert.equal(clean.status, 'answered')
  assert.ok(!existsSync(cleaned))
  assert.equal(git(repo, 'branch', '--list', 'feat/cleaned'), '')
  assert.equal(git(repo, 'branch', '--list', 'feat/kept').replace(/^[*+ ]+/, ''), 'feat/kept')

  await compute()
  assert.equal(rows().filter((row) => row.status === 'pending').length, 0, 'ni l’arbre gardé ni le nettoyé ne reviennent')
})

test('« Nettoyer » sur un arbre qui a bougé depuis la question ne nettoie rien', async (t) => {
  const { merged, compute, rows, service } = harness(t)
  const path = merged('feat/moved')
  await compute()
  const decision = rows()[0]!
  // Du travail arrive après la question, sans nouveau calcul entre-temps.
  writeFileSync(join(path, 'late.txt'), 'late\n')

  await assert.rejects(service.answer('owner', decision.id, { option: 'clean', text: '' }), /changed since the question/)
  assert.ok(existsSync(join(path, 'late.txt')))
  assert.equal(rows()[0]!.status, 'withdrawn')
})

test('une interface plus ancienne ne reçoit jamais les propositions de nettoyage', async (t) => {
  const { db, merged, compute, rows, service } = harness(t)
  merged('feat/old-tab')
  await compute()
  const id = rows()[0]!.id

  assert.deepEqual(requestedDecisionSources(undefined), ['schedule', 'webhook', 'board'])
  assert.deepEqual(requestedDecisionSources('worktree,inconnue'), ['schedule', 'webhook', 'board', 'worktree'])

  const app = Fastify()
  app.addHook('preHandler', async (request) => {
    request.user = db.select().from(users).where(eq(users.id, 'owner')).get()
  })
  registerErrorHandler(app)
  registerDecisionRoutes(app, service)
  t.after(() => app.close())

  // L'ancien onglet ne nomme aucune source : ni dans la liste, ni à l'ouverture.
  const oldList = await app.inject({ method: 'GET', url: '/api/decisions?status=pending' })
  assert.deepEqual(oldList.json().decisions, [])
  const oldOpen = await app.inject({ method: 'GET', url: `/api/decisions/${id}` })
  assert.equal(oldOpen.statusCode, 404)

  // La nouvelle interface nomme toutes celles qu'elle connaît.
  const newList = await app.inject({ method: 'GET', url: '/api/decisions?status=pending&sources=schedule,webhook,board,worktree' })
  assert.deepEqual(newList.json().decisions.map((entry: { id: string }) => entry.id), [id])
  const newOpen = await app.inject({ method: 'GET', url: `/api/decisions/${id}?sources=worktree` })
  assert.equal(newOpen.statusCode, 200)
  assert.equal(newOpen.json().source.kind, 'worktree')
})
