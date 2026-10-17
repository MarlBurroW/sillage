import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eq as sqlEq, sql } from 'drizzle-orm'
import { cards, conversationPaths, conversations, openDatabase, projects, runMigrations, users, worktrees } from '@sillage/db'
import type { TerminalManager } from '../src/terminals/terminal-manager.js'
import { EventLog } from '../src/events/event-log.js'
import { touchedPaths } from '../src/events/touched-paths.js'
import { assessWorktree, defaultBase, listWorktrees } from '../src/worktrees/assess.js'
import { backfillCommandPaths } from '../src/worktrees/backfill.js'
import { WorktreeCleanup } from '../src/worktrees/cleanup.js'
import { WorktreeStatusService } from '../src/worktrees/status-service.js'

/**
 * L'avancement des worktrees : chaque état de la carte #46 sur un dépôt jetable.
 *
 * Même cloisonnement que `checkpoints.test.ts` : la configuration git de la machine
 * ne doit pas décider du résultat.
 */
const isolation = mkdtempSync(join(tmpdir(), 'sillage-worktree-isolation-'))
writeFileSync(join(isolation, 'gitconfig'), '')
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = join(isolation, 'gitconfig')
for (const name of ['EMAIL', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
  delete process.env[name]
}
after(() => rmSync(isolation, { recursive: true, force: true }))

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function write(repo: string, file: string, content: string): void {
  mkdirSync(dirname(join(repo, file)), { recursive: true })
  writeFileSync(join(repo, file), content)
}

/** Un dépôt sur `main` avec un commit, et de quoi créer des worktrees à côté. */
function repository(t: TestContext): { repo: string; trees: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-worktree-status-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.name', 'Worktree test')
  git(repo, 'config', 'user.email', 'worktree@example.test')
  write(repo, 'README.md', 'base\n')
  write(repo, 'src/app.ts', 'export const app = 1\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'root')
  return { repo, trees: join(dir, 'trees') }
}

function addTree(repo: string, trees: string, branch: string): string {
  const path = join(trees, branch.replace(/\//g, '__'))
  git(repo, 'worktree', 'add', '-b', branch, path, 'main')
  return path
}

function commitAll(cwd: string, message: string): string {
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-m', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

async function assess(repo: string, path: string, options: { legacyGit?: boolean } = {}) {
  const entry = (await listWorktrees(repo)).find((e) => e.path === path)
  assert.ok(entry, `arbre ${path} inconnu de git`)
  return assessWorktree(repo, 'main', entry, options)
}

test('la base est la branche locale que désigne origin/HEAD, sinon main', async (t) => {
  const { repo } = repository(t)
  assert.equal(await defaultBase(repo), 'main')
  git(repo, 'branch', '-m', 'trunk')
  assert.equal(await defaultBase(repo), 'trunk')
  git(repo, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD')
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
  assert.equal(await defaultBase(repo), 'trunk')
  git(repo, 'branch', '-m', 'elsewhere')
  assert.equal(await defaultBase(repo), 'origin/trunk')
})

test('non commité, non suivi, commité non fusionné, en conflit', async (t) => {
  const { repo, trees } = repository(t)

  const dirty = addTree(repo, trees, 'feat/dirty')
  write(dirty, 'src/app.ts', 'export const app = 2\n')
  let result = await assess(repo, dirty)
  assert.equal(result.state, 'dirty')
  assert.deepEqual([result.modified, result.untracked, result.ahead], [1, 0, 0])
  assert.ok(result.lastEditAt !== null)

  const untracked = addTree(repo, trees, 'feat/untracked')
  write(untracked, 'notes.md', 'todo\n')
  result = await assess(repo, untracked)
  assert.equal(result.state, 'dirty')
  assert.deepEqual([result.modified, result.untracked], [0, 1])

  const unmerged = addTree(repo, trees, 'feat/unmerged')
  write(unmerged, 'src/feature.ts', 'export const feature = true\n')
  commitAll(unmerged, 'feature')
  result = await assess(repo, unmerged)
  assert.equal(result.state, 'unmerged')
  assert.deepEqual([result.ahead, result.behind, result.conflicts], [1, 0, false])
  assert.ok(result.lastCommitAt !== null)

  // La base avance sur la même ligne : la fusion coincerait.
  write(repo, 'src/app.ts', 'export const app = 3\n')
  commitAll(repo, 'main moves')
  const conflicting = addTree(repo, trees, 'feat/conflict')
  git(conflicting, 'reset', '--hard', 'main~1')
  write(conflicting, 'src/app.ts', 'export const app = 4\n')
  commitAll(conflicting, 'conflicting')
  result = await assess(repo, conflicting)
  assert.equal(result.state, 'unmerged')
  assert.deepEqual([result.ahead, result.behind, result.conflicts], [1, 1, true])

  // Même chose sans commit : une modification locale sur une ligne que la base a changée.
  const stale = addTree(repo, trees, 'feat/stale')
  git(stale, 'reset', '--hard', 'main~1')
  write(stale, 'src/app.ts', 'export const app = 5\n')
  result = await assess(repo, stale)
  assert.deepEqual([result.state, result.conflicts, result.behind], ['dirty', true, 1])
})

test('fusionné par merge, par squash et par cherry-pick', async (t) => {
  const { repo, trees } = repository(t)

  const merged = addTree(repo, trees, 'feat/merged')
  write(merged, 'src/a.ts', 'a\n')
  commitAll(merged, 'a')
  git(repo, 'merge', '--no-ff', 'feat/merged', '-m', 'merge a')
  let result = await assess(repo, merged)
  assert.equal(result.state, 'merged')
  assert.equal(result.ahead, 0)

  const squashed = addTree(repo, trees, 'feat/squashed')
  write(squashed, 'src/b.ts', 'b\n')
  commitAll(squashed, 'b1')
  write(squashed, 'src/b.ts', 'b2\n')
  commitAll(squashed, 'b2')
  git(repo, 'merge', '--squash', 'feat/squashed')
  git(repo, 'commit', '-m', 'squash b')
  result = await assess(repo, squashed)
  assert.equal(result.state, 'merged')
  // L'ancestralité dirait « deux commits à fusionner » : c'est le piège évité.
  assert.equal(result.ahead, 2)

  const picked = addTree(repo, trees, 'feat/picked')
  write(picked, 'src/c.ts', 'c\n')
  const hash = commitAll(picked, 'c')
  // La base avance d'abord : sinon le cherry-pick recrée le même commit à l'identique.
  write(repo, 'README.md', 'base 2\n')
  commitAll(repo, 'main moves')
  git(repo, 'cherry-pick', hash)
  result = await assess(repo, picked)
  assert.equal(result.state, 'merged')
  assert.equal(result.ahead, 1)

  // Fusionné mais du travail a repris par-dessus : il redevient un chantier.
  write(picked, 'src/c.ts', 'c2\n')
  result = await assess(repo, picked)
  assert.equal(result.state, 'dirty')
})

test('du non commité et du non suivi que la base a déjà ne comptent pas', async (t) => {
  const { repo, trees } = repository(t)

  const tree = addTree(repo, trees, 'feat/copied')
  write(tree, 'src/app.ts', 'export const app = 2\n')
  write(tree, 'src/new.ts', 'new\n')
  // Le même contenu arrive dans la base par un autre chemin (copie à la main).
  write(repo, 'src/app.ts', 'export const app = 2\n')
  write(repo, 'src/new.ts', 'new\n')
  commitAll(repo, 'same content on main')

  const result = await assess(repo, tree)
  assert.equal(result.state, 'merged')
  assert.deepEqual([result.modified, result.untracked, result.behind], [1, 1, 1])

  // Un fichier non suivi de plus, inconnu de la base : de nouveau à garder.
  write(tree, 'src/other.ts', 'other\n')
  assert.equal((await assess(repo, tree)).state, 'dirty')
})

test('git antérieur à 2.40 : le non commité se juge par le stash entier, sans jamais conclure à tort', async (t) => {
  const { repo, trees } = repository(t)
  const legacy = { legacyGit: true }

  // Rien de commité, le non commité est déjà dans la base : fusionné.
  const copied = addTree(repo, trees, 'feat/copied')
  write(copied, 'src/app.ts', 'export const app = 2\n')
  write(repo, 'src/app.ts', 'export const app = 2\n')
  commitAll(repo, 'same content on main')
  assert.equal((await assess(repo, copied, legacy)).state, 'merged')

  // Du travail que la base n'a pas : à garder.
  write(copied, 'src/app.ts', 'export const app = 3\n')
  assert.equal((await assess(repo, copied, legacy)).state, 'dirty')

  // Commits fusionnés par squash, puis du non commité que la base a aussi : fusionné.
  const squashed = addTree(repo, trees, 'feat/squashed')
  write(squashed, 'src/s.ts', 's\n')
  commitAll(squashed, 's')
  write(squashed, 'README.md', 'base 2\n')
  git(repo, 'merge', '--squash', 'feat/squashed')
  write(repo, 'README.md', 'base 2\n')
  commitAll(repo, 'squash s with the readme')
  assert.equal((await assess(repo, squashed, legacy)).state, 'merged')
  assert.equal((await assess(repo, squashed)).state, 'merged', 'le chemin moderne dit pareil')

  // Commits pas encore fusionnés : le non commité ne se juge plus et compte comme à
  // garder, même déjà dans la base. C'est la limite de ce chemin, dans le sens prudent.
  const pending = addTree(repo, trees, 'feat/pending')
  // Parti d'avant le commit qui a apporté « base 2 » à la base.
  git(pending, 'reset', '-q', '--hard', 'main~1')
  write(pending, 'src/p.ts', 'p\n')
  commitAll(pending, 'p')
  write(pending, 'README.md', 'base 2\n')
  assert.equal((await assess(repo, pending, legacy)).state, 'dirty')
  assert.equal((await assess(repo, pending)).state, 'unmerged', 'le chemin moderne sait que la modification est déjà dans la base')
})

test('introuvable : dossier disparu, entrée prunable', async (t) => {
  const { repo, trees } = repository(t)
  const gone = addTree(repo, trees, 'feat/gone')
  rmSync(gone, { recursive: true, force: true })
  const entry = (await listWorktrees(repo)).find((e) => e.path === gone)
  assert.ok(entry?.prunable)
  assert.equal((await assessWorktree(repo, 'main', entry)).state, 'missing')
  assert.equal((await assessWorktree(repo, 'main', { path: join(trees, 'nowhere'), head: null, prunable: false })).state, 'missing')
})

test('la liste de git : arbre principal en tête, branche et HEAD détachée', async (t) => {
  const { repo, trees } = repository(t)
  addTree(repo, trees, 'feat/one')
  const detached = join(trees, 'detached')
  git(repo, 'worktree', 'add', '--detach', detached, 'main')
  const list = await listWorktrees(repo)
  assert.equal(list[0]?.path, repo)
  assert.equal(list[0]?.main, true)
  assert.equal(list[0]?.branch, 'main')
  assert.equal(list.find((e) => e.path === detached)?.branch, null)
  assert.equal(list.find((e) => e.path.endsWith('feat__one'))?.branch, 'feat/one')
  assert.deepEqual(await listWorktrees(trees), [])
})

test('les chemins révélés par un événement : éditions hors cwd, dossiers cités par Bash', () => {
  assert.deepEqual(touchedPaths({ type: 'file.edited', toolCallId: 't', path: 'src/a.ts', action: 'modified' }), [])
  assert.deepEqual(
    touchedPaths({ type: 'file.edited', toolCallId: 't', path: '/home/u/projects/x-feature/src/a.ts', action: 'modified' }),
    ['/home/u/projects/x-feature/src/a.ts'],
  )
  const bash = (command: string) =>
    touchedPaths({ type: 'tool.started', toolCallId: 't', name: 'Bash', input: { command }, parentToolCallId: null })
  assert.deepEqual(bash('cd /home/u/projects/x-feature && pnpm test'), ['/home/u/projects/x-feature'])
  assert.deepEqual(bash('git -C /home/u/projects/x-feature/ status'), ['/home/u/projects/x-feature'])
  assert.deepEqual(bash('git worktree add -b feat/x /home/u/projects/x-feature main'), ['/home/u/projects/x-feature'])
  assert.deepEqual(bash("cd '/home/u/my dir'; ls"), ['/home/u/my dir'])
  assert.deepEqual(bash('cd apps/web && ls /usr/bin'), [])
  assert.deepEqual(touchedPaths({ type: 'tool.started', toolCallId: 't', name: 'Read', input: { file_path: '/etc/hosts' }, parentToolCallId: null }), [])
})

test('le service réconcilie git et la base, et rattache les sessions', async (t) => {
  const { repo, trees } = repository(t)
  const dir = mkdtempSync(join(tmpdir(), 'sillage-worktree-db-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())

  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  const project = { id: 'project', name: 'project', workspacePath: repo, ownerId: 'owner', visibility: 'private' as const, createdAt: 1 }
  db.insert(projects).values(project).run()
  const projectRow = db.select().from(projects).where(sqlEq(projects.id, 'project')).get()!

  // Connu de Sillage, avec une session rattachée par son cwd.
  const known = addTree(repo, trees, 'feat/known')
  db.insert(worktrees).values({ id: 'wt-known', projectId: 'project', name: 'feat/known', path: known, baseRef: 'HEAD', createdBy: 'owner', createdAt: 1 }).run()
  // Externe, créé au shell, où une session notée à la racine a écrit.
  const external = addTree(repo, trees, 'feat/external')
  // Fantôme : en base, sans dossier ni entrée git.
  db.insert(worktrees).values({ id: 'wt-ghost', projectId: 'project', name: 'feat/ghost', path: join(trees, 'ghost'), baseRef: 'HEAD', createdBy: 'owner', createdAt: 1 }).run()

  const conversation = (id: string, worktreeId: string | null) => ({
    id, projectId: 'project', userId: 'owner', title: id, agent: 'claude' as const, config: '{}', status: 'idle' as const,
    worktreeId, createdAt: 1, updatedAt: 1,
  })
  db.insert(conversations).values([conversation('c-direct', 'wt-known'), conversation('c-root', null), conversation('c-both', 'wt-known')]).run()

  const log = new EventLog(db)
  const service = new WorktreeStatusService(db, log)
  // Le journal alimente le rattachement « a écrit dans », y compris par une commande.
  log.append('c-root', { type: 'file.edited', toolCallId: 't1', path: join(external, 'src/x.ts'), action: 'created' })
  log.append('c-both', { type: 'tool.started', toolCallId: 't2', name: 'Bash', input: { command: `cd ${external} && ls` }, parentToolCallId: null })
  log.append('c-root', { type: 'file.edited', toolCallId: 't3', path: join(external, 'src/x.ts'), action: 'modified' })
  assert.equal(db.select().from(conversationPaths).all().length, 2)

  // Le rattrapage des commandes déjà journalisées ne tourne qu'une fois : une commande
  // insérée après coup n'est reprise qu'au premier passage.
  db.delete(conversationPaths).run()
  assert.equal(backfillCommandPaths(db), 1)
  assert.equal(db.select().from(conversationPaths).all().length, 1)
  assert.equal(backfillCommandPaths(db), 0)
  log.append('c-root', { type: 'file.edited', toolCallId: 't4', path: join(external, 'src/x.ts'), action: 'modified' })

  // Par lots d'une commande : le curseur passe d'une conversation à l'autre sans rien perdre.
  log.append('c-direct', { type: 'tool.started', toolCallId: 't5', name: 'Bash', input: { command: `git -C ${known} status` }, parentToolCallId: null })
  db.delete(conversationPaths).run()
  db.run(sql`DELETE FROM app_settings WHERE key = 'worktree_paths_backfill'`)
  assert.equal(backfillCommandPaths(db, 1), 2)
  assert.deepEqual(
    db.select({ id: conversationPaths.conversationId, path: conversationPaths.path }).from(conversationPaths).all()
      .map((row) => `${row.id}:${row.path}`).sort(),
    [`c-both:${external}`, `c-direct:${known}`],
  )
  log.append('c-root', { type: 'file.edited', toolCallId: 't6', path: join(external, 'src/x.ts'), action: 'modified' })

  const first = await service.get(projectRow)
  assert.equal(first.base, 'main')
  assert.equal(first.fresh, true)
  const byPath = new Map(first.worktrees.map((w) => [w.path, w]))
  assert.equal(byPath.size, 3)
  assert.ok(!byPath.has(repo), "l'arbre principal n'est pas un chantier")

  const knownTree = byPath.get(known)!
  assert.deepEqual([knownTree.id, knownTree.external, knownTree.state, knownTree.name], ['wt-known', false, 'merged', 'feat/known'])
  assert.deepEqual(knownTree.conversations.map((c) => c.id).sort(), ['c-both', 'c-direct'])
  assert.ok(knownTree.conversations.every((c) => c.link === 'worktree'))

  const externalTree = byPath.get(external)!
  assert.deepEqual([externalTree.id, externalTree.external, externalTree.branch], [null, true, 'feat/external'])
  assert.deepEqual(externalTree.conversations.map((c) => `${c.id}:${c.link}`).sort(), ['c-both:edited', 'c-root:edited'])

  const ghost = byPath.get(join(trees, 'ghost'))!
  assert.deepEqual([ghost.id, ghost.state, ghost.name, ghost.external], ['wt-ghost', 'missing', 'feat/ghost', false])
  assert.equal(first.worktrees[0]?.id, 'wt-ghost', "l'introuvable passe en tête")

  // Resservi du cache tant que rien ne l'invalide ; un tour terminé le périme, et la
  // liste périmée est rendue tout de suite pendant que la suivante se calcule.
  write(known, 'src/app.ts', 'changed\n')
  assert.equal((await service.get(projectRow)).worktrees.find((w) => w.id === 'wt-known')?.state, 'merged')
  log.append('c-direct', { type: 'turn.completed', costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 } as never)
  const stale = await service.get(projectRow)
  assert.equal(stale.fresh, false)
  await new Promise((done) => setTimeout(done, 300))
  const next = await service.get(projectRow)
  assert.equal(next.fresh, true)
  assert.equal(next.worktrees.find((w) => w.id === 'wt-known')?.state, 'dirty')
})

test('nettoyer : plan puis exécution, arbre connu et arbre externe, branche et sessions', async (t) => {
  const { repo, trees } = repository(t)
  const dir = mkdtempSync(join(tmpdir(), 'sillage-worktree-clean-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'project', workspacePath: repo, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  const projectRow = db.select().from(projects).where(sqlEq(projects.id, 'project')).get()!
  db.insert(cards).values({ id: 'card', projectId: 'project', number: 7, title: 'Squash it', description: '', column: 'in_progress', position: 1, createdBy: 'owner', createdAt: 1, updatedAt: 1 } as never).run()

  const known = addTree(repo, trees, 'feat/known')
  write(known, 'src/k.ts', 'k\n')
  commitAll(known, 'k')
  git(repo, 'merge', '--squash', 'feat/known')
  git(repo, 'commit', '-m', 'squash k')
  db.insert(worktrees).values({ id: 'wt-known', projectId: 'project', name: 'feat/known', path: known, baseRef: 'HEAD', createdBy: 'owner', createdAt: 1 }).run()
  db.insert(conversations).values([
    { id: 'c1', projectId: 'project', userId: 'owner', title: 'one', agent: 'claude', config: '{}', status: 'idle', worktreeId: 'wt-known', cardId: 'card', createdAt: 1, updatedAt: 1 },
    { id: 'c2', projectId: 'project', userId: 'owner', title: 'two', agent: 'claude', config: '{}', status: 'idle', worktreeId: 'wt-known', archivedAt: 1, createdAt: 1, updatedAt: 1 },
  ] as never).run()
  const external = addTree(repo, trees, 'feat/external')
  write(external, 'notes.md', 'keep?\n')

  const log = new EventLog(db)
  const status = new WorktreeStatusService(db, log)
  const closed: string[] = []
  const terminals = { underCwd: () => [] as string[], close: (id: string) => closed.push(id) } as unknown as TerminalManager
  const dropped: string[] = []
  const cleanup = new WorktreeCleanup(db, dir, status, terminals, async (id) => { dropped.push(id) })

  assert.equal(await cleanup.plan(projectRow, join(trees, 'nowhere')), null, 'un chemin hors du projet est refusé')
  assert.equal(await cleanup.plan(projectRow, repo), null, "l'arbre principal n'est pas un chantier")

  const plan = (await cleanup.plan(projectRow, known))!
  assert.deepEqual(
    [plan.state, plan.ahead, plan.branchDeletable, plan.conversations.map((c) => c.id), plan.card?.number],
    ['merged', 1, true, ['c1'], 7],
  )
  const result = (await cleanup.run(projectRow, { path: known, deleteBranch: true, archiveSessions: true, stopServices: true }))!
  assert.deepEqual([result.removed, result.branchDeleted, result.archived], [true, true, 1])
  assert.deepEqual(dropped, ['c1', 'c2'])
  assert.ok(!(await listWorktrees(repo)).some((e) => e.path === known))
  assert.ok(!git(repo, 'branch', '--list', 'feat/known'))
  assert.ok(db.select().from(worktrees).where(sqlEq(worktrees.id, 'wt-known')).get()?.removedAt)
  assert.ok(db.select().from(conversations).where(sqlEq(conversations.id, 'c1')).get()?.archivedAt)
  assert.ok(!(await status.get(projectRow)).worktrees.some((w) => w.path === known))

  // Un arbre externe, non commité : le plan le dit, et il se nettoie en gardant la branche.
  const external2 = (await cleanup.plan(projectRow, external))!
  assert.deepEqual([external2.state, external2.untracked, external2.conversations], ['dirty', 1, []])
  const kept = (await cleanup.run(projectRow, { path: external, deleteBranch: false, archiveSessions: true, stopServices: false }))!
  assert.deepEqual([kept.removed, kept.branchDeleted], [true, false])
  assert.equal(git(repo, 'branch', '--list', 'feat/external').trim(), 'feat/external')
  assert.ok(!existsSync(external))

  // Le dossier a déjà disparu : git garde l'entrée, le nettoyage la purge quand même.
  const gone = addTree(repo, trees, 'feat/gone')
  rmSync(gone, { recursive: true, force: true })
  const prunable = (await cleanup.run(projectRow, { path: gone, deleteBranch: true, archiveSessions: false, stopServices: false }))!
  assert.deepEqual([prunable.removed, prunable.branchDeleted], [true, true])
  assert.deepEqual((await listWorktrees(repo)).map((e) => e.path), [repo])
})
