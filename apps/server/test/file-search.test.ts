import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { forgetListings, searchTree, searchWorkspaceFiles } from '../src/search/search-files.js'
import { listDirectory } from '../src/workspace.js'

async function directory(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-file-search-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function repository(t: TestContext): Promise<string> {
  const repo = await directory(t)
  execFileSync('git', ['init', '-q'], { cwd: repo })
  await mkdir(join(repo, 'src/lib'), { recursive: true })
  await mkdir(join(repo, 'node_modules/weather'), { recursive: true })
  await writeFile(join(repo, '.gitignore'), 'node_modules/\n.env\n')
  await writeFile(join(repo, 'src/lib/forecast-cache.ts'), 'x')
  await writeFile(join(repo, 'src/lib/forecast.ts'), 'x')
  await writeFile(join(repo, 'node_modules/weather/forecast.js'), 'x')
  await writeFile(join(repo, '.env'), 'TOKEN=x')
  return repo
}

test('a tree level is sorted naturally before being cut, and reports its size', async (t) => {
  const root = await directory(t)
  await mkdir(join(root, 'zdir'))
  for (let index = 1; index <= 1002; index += 1) await writeFile(join(root, `f${index}`), '')

  const { entries, total } = await listDirectory(root, '')
  assert.equal(total, 1003)
  assert.equal(entries.length, 1000)
  // Directories first, then numbers by value: what is cut is the end of the list.
  assert.deepEqual(entries.slice(0, 4).map((entry) => entry.name), ['zdir', 'f1', 'f2', 'f3'])
  assert.equal(entries.at(-1)?.name, 'f999')
})

test('explorer search ranks like the palette and offers ignored files outside ignored folders', async (t) => {
  const repo = await repository(t)

  const forecast = await searchTree(repo, 'forecast')
  assert.deepEqual(forecast.entries.map((entry) => entry.path), ['src/lib/forecast.ts', 'src/lib/forecast-cache.ts'])
  assert.equal(forecast.truncated, false)
  // Initials of the filename, as in the palette.
  assert.equal((await searchTree(repo, 'fcache')).entries[0]?.path, 'src/lib/forecast-cache.ts')
  assert.deepEqual((await searchTree(repo, '.env')).entries.map((entry) => entry.path), ['.env'])
})

test('mentions keep ignored files out, and listings follow explorer changes', async (t) => {
  const repo = await repository(t)

  assert.deepEqual((await searchWorkspaceFiles(repo, 'env', { limit: 30 })).paths, [])
  const all = await searchWorkspaceFiles(repo, '', { limit: 30 })
  assert.deepEqual(all.paths, ['.gitignore', 'src/lib/forecast.ts', 'src/lib/forecast-cache.ts'])

  await writeFile(join(repo, 'src/lib/radar.ts'), 'x')
  forgetListings(repo)
  assert.deepEqual((await searchTree(repo, 'radar')).entries.map((entry) => entry.path), ['src/lib/radar.ts'])
})

test('a file created outside the explorer shows up after a short pause', async (t) => {
  const repo = await repository(t)
  assert.deepEqual((await searchTree(repo, 'radar')).entries, [])
  await writeFile(join(repo, 'src/lib/radar.ts'), 'x')
  await new Promise((resolve) => setTimeout(resolve, 2_100))
  assert.deepEqual((await searchTree(repo, 'radar')).entries.map((entry) => entry.path), ['src/lib/radar.ts'])
})
