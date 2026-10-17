import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readCommits } from '../src/git.js'
import { layoutGitGraph } from '../../web/src/lib/git-graph.js'

test('Le graphe relie les fusions et conserve les rails à travers les pages', () => {
  const commits = [
    { hash: 'merge', parents: ['main', 'feature'] },
    { hash: 'main', parents: ['root'] },
    { hash: 'feature', parents: ['root'] },
    { hash: 'root', parents: [] },
  ]
  const full = layoutGitGraph(commits)
  assert.equal(full.width, 2)
  assert.deepEqual(layoutGitGraph(commits.slice(0, 2)).rows, full.rows.slice(0, 2))
  assert.equal(full.rows[0]!.outgoing.length, 2)
  assert.notEqual(full.rows[1]!.lane, full.rows[2]!.lane)
  // Chaque segment sortant arrive exactement sur le rail de la ligne suivante.
  full.rows.slice(0, -1).forEach((row, index) => {
    const exits = new Map(row.outgoing.map((edge) => [edge.to, edge.color]))
    const entrances = new Map(full.rows[index + 1]!.incoming.map((edge) => [edge.from, edge.color]))
    assert.deepEqual(exits, entrances)
  })
  assert.equal(full.rows[3]!.outgoing.length, 0)
})

test('Le graphe accepte racines indépendantes et fusions à trois parents', () => {
  const graph = layoutGitGraph([
    { hash: 'm', parents: ['a', 'b', 'c'] },
    { hash: 'other', parents: [] },
    { hash: 'a', parents: ['r'] },
    { hash: 'b', parents: ['r'] },
    { hash: 'c', parents: ['r'] },
    { hash: 'r', parents: [] },
  ])
  assert.equal(graph.rows[0]!.outgoing.length, 3)
  assert.equal(graph.rows[1]!.lane, 3)
  assert.equal(graph.rows[5]!.outgoing.length, 0)
})

test('Historique réel : branches divergentes, parents, pagination et HEAD détachée', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sillage-graph-'))
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    git('init', '-b', 'main')
    git('config', 'user.name', 'Graph test')
    git('config', 'user.email', 'graph@example.test')
    assert.deepEqual(await readCommits(cwd, 30, 0, true), { commits: [], hasMore: false })
    git('commit', '--allow-empty', '-m', 'root')
    const root = git('rev-parse', 'HEAD')
    git('checkout', '-b', 'feature')
    git('commit', '--allow-empty', '-m', 'feature')
    const feature = git('rev-parse', 'HEAD')
    git('checkout', 'main')
    git('commit', '--allow-empty', '-m', 'main')
    assert.equal((await readCommits(cwd, 30, 0))!.commits.length, 2)
    const all = (await readCommits(cwd, 30, 0, true))!
    assert.equal(all.commits.length, 3)
    assert.deepEqual(all.commits.find((commit) => commit.hash === feature)!.parents, [root])
    const page = (await readCommits(cwd, 1, 0, true))!
    assert.equal(page.hasMore, true)
    assert.deepEqual(page.commits, all.commits.slice(0, 1))
    git('merge', '--no-ff', 'feature', '-m', 'merge')
    assert.equal((await readCommits(cwd, 30, 0, true))!.commits[0]!.parents.length, 2)
    git('checkout', '--detach')
    git('commit', '--allow-empty', '-m', 'detached')
    assert.equal((await readCommits(cwd, 30, 0, true))!.commits[0]!.subject, 'detached')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
