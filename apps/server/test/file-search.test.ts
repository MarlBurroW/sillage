import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
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

test('symlinks show as what they lead to inside the workspace, and as links otherwise', async (t) => {
  const root = await directory(t)
  const outside = await directory(t)
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/a.ts'), 'x')
  await writeFile(join(root, 'AGENTS.md'), '# Agents')
  await symlink('AGENTS.md', join(root, 'CLAUDE.md'))
  await symlink('src', join(root, 'linked-src'))
  await symlink(outside, join(root, 'escape'))
  await symlink('missing.txt', join(root, 'dangling'))

  const { entries } = await listDirectory(root, '')
  const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]))
  assert.deepEqual(byName['CLAUDE.md'], { name: 'CLAUDE.md', path: 'CLAUDE.md', isDirectory: false, symlink: 'inside' })
  assert.deepEqual(byName['linked-src'], { name: 'linked-src', path: 'linked-src', isDirectory: true, symlink: 'inside' })
  assert.equal(byName.escape?.symlink, 'outside')
  assert.equal(byName.dangling?.symlink, 'outside')
  // A link leading inside expands like its target.
  assert.deepEqual((await listDirectory(root, 'linked-src')).entries.map((entry) => entry.path), ['linked-src/a.ts'])
})

test('content search finds lines in a repository, ignored files excluded, case smart', async (t) => {
  const { searchContent } = await import('../src/search/search-content.js')
  const repo = await repository(t)
  await writeFile(join(repo, 'src/lib/forecast.ts'), 'export const a = 1\nfetchForecast(city)\n')
  await writeFile(join(repo, 'src/lib/untracked.ts'), 'const x = fetchforecast()\n')
  await writeFile(join(repo, 'node_modules/weather/forecast.js'), 'fetchForecast()\n')
  await writeFile(join(repo, 'src/lib/long.ts'), `${'x'.repeat(500)}fetchForecast${'y'.repeat(500)}\n`)

  const loose = await searchContent(repo, 'fetchforecast')
  const files = Object.fromEntries(loose.files.map((file) => [file.path, file.matches]))
  assert.deepEqual(Object.keys(files).sort(), ['src/lib/forecast.ts', 'src/lib/long.ts', 'src/lib/untracked.ts'])
  assert.deepEqual(files['src/lib/forecast.ts'], [{ line: 2, column: 1, text: 'fetchForecast(city)', from: 0, length: 13 }])
  // Long lines are cut around the match, which stays highlighted at the right place.
  const [long] = files['src/lib/long.ts'] ?? []
  assert.equal(long?.column, 501)
  assert.equal(long?.text.slice(long.from, long.from + long.length), 'fetchForecast')
  assert.ok((long?.text.length ?? 0) < 260)

  // A capital makes the query exact.
  assert.deepEqual((await searchContent(repo, 'fetchForecast')).files.map((file) => file.path).sort(), ['src/lib/forecast.ts', 'src/lib/long.ts'])
})

test('content search scans plain folders and stops at its limits', async (t) => {
  const { searchContent } = await import('../src/search/search-content.js')
  const root = await directory(t)
  await writeFile(join(root, 'many.txt'), Array.from({ length: 50 }, (_, index) => `needle ${index}`).join('\n'))
  await writeFile(join(root, 'binary.bin'), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0, 1]))

  const result = await searchContent(root, 'needle')
  assert.deepEqual(result.files.map((file) => file.path), ['many.txt'])
  assert.equal(result.files[0]?.matches.length, 20)
  assert.equal(result.files[0]?.matches[19]?.line, 20)
})
