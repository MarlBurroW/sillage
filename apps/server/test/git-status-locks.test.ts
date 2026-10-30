import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readFileStates, readGitStatus } from '../src/git.js'

// A plain `git status` rewrites the index after a file's timestamp changes, taking `index.lock`
// while an agent may be committing in the same repository.
test('status reads leave the index untouched', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'sillage-git-locks-'))
  t.after(() => rm(repo, { recursive: true, force: true }))
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo })
  await writeFile(join(repo, 'a.txt'), 'a\n')
  git('init', '-q')
  git('add', 'a.txt')
  git('commit', '-qm', 'init')

  const index = join(repo, '.git/index')
  const past = new Date(Date.now() - 60_000)
  await utimes(index, past, past)
  // Same content, new timestamp: git must refresh its stat cache to see the file is unchanged.
  await utimes(join(repo, 'a.txt'), new Date(), new Date())
  const before = (await stat(index)).mtimeMs

  assert.equal((await readFileStates(repo))?.size, 0)
  assert.equal((await readGitStatus(repo))?.isDirty, false)
  assert.equal((await stat(index)).mtimeMs, before)
})

// The explorer reloads a changed directory together with its ancestors: one status serves them.
test('concurrent status reads share one run', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'sillage-git-shared-'))
  t.after(() => rm(repo, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  await writeFile(join(repo, 'new.txt'), 'x\n')

  const first = readFileStates(repo)
  assert.equal(readFileStates(repo), first)
  assert.equal((await first)?.get('new.txt'), 'untracked')
  // Settled runs are not reused: the next change must be seen.
  await writeFile(join(repo, 'later.txt'), 'y\n')
  assert.equal((await readFileStates(repo))?.get('later.txt'), 'untracked')
})
