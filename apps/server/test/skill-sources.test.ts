import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { skillSources, type Db } from '@sillage/db'
import type {
  LibrarySkillDto,
  LibrarySkillListDto,
  LibrarySkillUpdateDto,
  SkillSourceCatalogDto,
  SkillSourceDto,
  SourceSkillPreviewDto,
} from '@sillage/protocol'
import { normalizeSourceUrl } from '../src/skill-library/sources.js'
import { http } from './skill-library-support.js'

/** Un dépôt git jetable, qu'on fait évoluer à la main comme le ferait son auteur. */
function repository(dir: string) {
  const root = join(dir, 'upstream')
  mkdirSync(root, { recursive: true })
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd: root, stdio: 'pipe' })
      .toString()
      .trim()
  const write = (path: string, content: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: Use for ${name}.\n---\n\n${body}\n`
  git('init', '-q', '-b', 'main')
  write('README.md', '# Skills')
  write('skills/alpha/SKILL.md', skill('alpha', 'Version 1.'))
  write('skills/alpha/scripts/run.sh', 'echo alpha')
  write('skills/beta/SKILL.md', skill('beta', 'Beta 1.'))
  write('skills/.hidden/ghost/SKILL.md', skill('ghost', 'Hidden.'))
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  const commit = (message: string) => {
    git('add', '-A')
    git('commit', '-q', '-m', message)
    return git('rev-parse', 'HEAD')
  }
  return { root, write, skill, commit, head: () => git('rev-parse', 'HEAD') }
}

/** Une source vers un dépôt local, posée en base : l'API refuse les chemins locaux. */
function localSource(db: Db, id: string, url: string, subpath: string | null) {
  db.insert(skillSources)
    .values({ id, name: id, url, subpath, ref: null, builtin: false, enabled: true, createdAt: 1, updatedAt: 1 })
    .run()
}

test('URL de source : owner/repo pour GitHub, formes git usuelles, chemins locaux refusés', () => {
  assert.deepEqual(normalizeSourceUrl('anthropics/skills'), { url: 'https://github.com/anthropics/skills.git', name: 'anthropics/skills' })
  assert.deepEqual(normalizeSourceUrl('git@gitlab.example.com:team/skills.git'), { url: 'git@gitlab.example.com:team/skills.git', name: 'team/skills' })
  assert.equal(normalizeSourceUrl('https://github.com/openai/skills.git?tab=readme').url, 'https://github.com/openai/skills.git')
  assert.throws(() => normalizeSourceUrl('/etc'), { code: 'skill_source_url_invalid' })
  assert.throws(() => normalizeSourceUrl('file:///etc'), { code: 'skill_source_url_invalid' })
})

test('sources : déclarées par un admin, sans doublon, préconfigurées par la migration', async (t) => {
  const { call } = await http(t)
  const listed = (await call('member', 'GET', '/api/skill-sources')).json() as { sources: SkillSourceDto[] }
  assert.deepEqual(listed.sources.map((source) => [source.name, source.subpath, source.builtin]), [
    ['anthropics/skills', 'skills', true],
    ['openai/skills', 'skills/.curated', true],
  ])
  assert.equal((await call('member', 'POST', '/api/skill-sources', { url: 'team/skills' })).statusCode, 403)
  const created = await call('admin', 'POST', '/api/skill-sources', { url: 'team/skills' })
  assert.equal(created.statusCode, 201)
  assert.equal((created.json() as SkillSourceDto).url, 'https://github.com/team/skills.git')
  const duplicate = await call('admin', 'POST', '/api/skill-sources', { url: 'https://github.com/Team/skills' })
  assert.equal(duplicate.json().error.code, 'skill_source_exists')
})

test('rafraîchir, parcourir, relire, installer : la provenance suit', async (t) => {
  const { call, db, dir, root } = await http(t)
  const upstream = repository(dir)
  localSource(db, 'local', upstream.root, 'skills')

  assert.equal((await call('member', 'POST', '/api/skill-sources/local/refresh')).statusCode, 403)
  const refreshed = (await call('admin', 'POST', '/api/skill-sources/local/refresh')).json() as SkillSourceDto
  assert.equal(refreshed.lastCommit, upstream.head())
  assert.equal(refreshed.skillCount, 2, 'le dossier caché est ignoré')

  const catalog = (await call('member', 'GET', '/api/skill-sources/local/catalog')).json() as SkillSourceCatalogDto
  assert.deepEqual(catalog.skills.map((skill) => [skill.path, skill.name, skill.scripts]), [
    ['skills/alpha', 'alpha', true],
    ['skills/beta', 'beta', false],
  ])
  const preview = (await call('member', 'GET', '/api/skill-sources/local/preview?path=skills/alpha')).json() as SourceSkillPreviewDto
  assert.match(preview.main, /Version 1\./)
  assert.deepEqual(preview.files, ['SKILL.md', 'scripts/run.sh'])

  // Installer : qui peut écrire dans la portée visée.
  const target = { path: 'skills/alpha', scope: 'project', projectId: 'p1' }
  assert.equal((await call('member', 'POST', '/api/skill-sources/local/install', target)).statusCode, 403)
  const installed = (await call('owner', 'POST', '/api/skill-sources/local/install', target)).json() as LibrarySkillDto
  assert.deepEqual(installed.origin, { sourceId: 'local', sourceName: 'local', path: 'skills/alpha', commit: upstream.head() })
  assert.equal(installed.updateAvailable, false)
  assert.equal(installed.locallyModified, false)
  assert.equal(readFileSync(join(root, 'projects/p1/projet/skills/alpha/scripts/run.sh'), 'utf8'), 'echo alpha')

  const after = (await call('member', 'GET', '/api/skill-sources/local/catalog')).json() as SkillSourceCatalogDto
  assert.deepEqual(after.skills[0]!.installed.map((entry) => [entry.name, entry.scope, entry.updateAvailable]), [['alpha', 'project', false]])
})

test('mise à jour : signalée au rafraîchissement, montrée en diff, appliquée sans perdre le nom', async (t) => {
  const { call, db, dir, root } = await http(t)
  const upstream = repository(dir)
  localSource(db, 'local', upstream.root, 'skills')
  await call('admin', 'POST', '/api/skill-sources/local/refresh')

  // Renommé à l'installation : pas de mise à jour fantôme pour autant.
  const renamed = (await call('admin', 'POST', '/api/skill-sources/local/install', { path: 'skills/beta', scope: 'global', name: 'gamma' })).json() as LibrarySkillDto
  assert.equal(renamed.name, 'gamma')
  assert.equal(renamed.updateAvailable, false)
  assert.equal(renamed.locallyModified, false)

  upstream.write('skills/beta/SKILL.md', upstream.skill('beta', 'Beta 2, with more care.'))
  upstream.write('skills/beta/references/notes.md', 'notes')
  const second = upstream.commit('beta 2')
  await call('admin', 'POST', '/api/skill-sources/local/refresh')

  const listed = (await call('admin', 'GET', '/api/skill-library')).json() as LibrarySkillListDto
  assert.equal(listed.skills.find((skill) => skill.name === 'gamma')!.updateAvailable, true)

  const pending = (await call('member', 'GET', `/api/skill-library/${renamed.id}/update`)).json() as LibrarySkillUpdateDto
  assert.equal(pending.toCommit, second)
  assert.match(pending.patch, /^diff --git a\/SKILL\.md b\/SKILL\.md$/m, 'chemins relatifs au skill')
  assert.match(pending.patch, /^-Beta 1\.$/m)
  assert.match(pending.patch, /^\+Beta 2, with more care\.$/m)
  assert.match(pending.patch, /^\+\+\+ b\/references\/notes\.md$/m)
  assert.doesNotMatch(pending.patch, /name: beta/, 'le nom de la bibliothèque est gardé')

  assert.equal((await call('member', 'POST', `/api/skill-library/${renamed.id}/update`)).statusCode, 403)
  const applied = (await call('admin', 'POST', `/api/skill-library/${renamed.id}/update`)).json() as LibrarySkillDto
  assert.equal(applied.updateAvailable, false)
  assert.equal(applied.origin!.commit, second)
  const main = readFileSync(join(root, 'global/sillage/skills/gamma/SKILL.md'), 'utf8')
  assert.match(main, /^---\nname: gamma\n/)
  assert.match(main, /Beta 2, with more care\./)
  assert.ok(existsSync(join(root, 'global/sillage/skills/gamma/references/notes.md')))
})

test('modification locale : signalée, puis écrasée par la mise à jour', async (t) => {
  const { call, db, dir, library } = await http(t)
  const upstream = repository(dir)
  localSource(db, 'local', upstream.root, 'skills')
  await call('admin', 'POST', '/api/skill-sources/local/refresh')
  const installed = (await call('admin', 'POST', '/api/skill-sources/local/install', { path: 'skills/alpha', scope: 'global' })).json() as LibrarySkillDto

  library.writeFile(library.row(installed.id), 'notes.md', 'mine')
  let current = library.list(null).find((skill) => skill.id === installed.id)!
  assert.deepEqual([current.locallyModified, current.updateAvailable], [true, false])

  upstream.write('skills/alpha/SKILL.md', upstream.skill('alpha', 'Version 2.'))
  upstream.commit('alpha 2')
  await call('admin', 'POST', '/api/skill-sources/local/refresh')
  current = library.list(null).find((skill) => skill.id === installed.id)!
  assert.deepEqual([current.locallyModified, current.updateAvailable], [true, true])

  const pending = (await call('admin', 'GET', `/api/skill-library/${installed.id}/update`)).json() as LibrarySkillUpdateDto
  assert.match(pending.patch, /^--- a\/notes\.md$/m, 'la modification locale apparaît comme ce qui sera perdu')
  await call('admin', 'POST', `/api/skill-library/${installed.id}/update`)
  current = library.list(null).find((skill) => skill.id === installed.id)!
  assert.deepEqual([current.locallyModified, current.updateAvailable], [false, false])
})

test('un dépôt qui est lui-même un skill, sans emporter son .git', async (t) => {
  const { call, db, dir, root } = await http(t)
  const solo = join(dir, 'solo')
  mkdirSync(solo)
  writeFileSync(join(solo, 'SKILL.md'), '---\nname: solo\ndescription: Use alone.\n---\n\nSolo.\n')
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'init', '-q'], { cwd: solo })
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: solo })
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'solo'], { cwd: solo })
  localSource(db, 'solo', solo, null)
  await call('admin', 'POST', '/api/skill-sources/solo/refresh')

  const catalog = (await call('admin', 'GET', '/api/skill-sources/solo/catalog')).json() as SkillSourceCatalogDto
  assert.deepEqual(catalog.skills.map((skill) => [skill.path, skill.name]), [['', 'solo']])
  assert.equal((await call('admin', 'POST', '/api/skill-sources/solo/install', { path: '', scope: 'global' })).statusCode, 201)
  assert.ok(existsSync(join(root, 'global/sillage/skills/solo/SKILL.md')))
  assert.ok(!existsSync(join(root, 'global/sillage/skills/solo/.git')))
})

test('rafraîchissement raté : erreur gardée sur la source, catalogue précédent intact', async (t) => {
  const { call, db, dir } = await http(t)
  localSource(db, 'gone', join(dir, 'nowhere'), null)
  const failed = await call('admin', 'POST', '/api/skill-sources/gone/refresh')
  assert.equal(failed.json().error.code, 'skill_source_fetch_failed')
  const listed = (await call('admin', 'GET', '/api/skill-sources')).json() as { sources: SkillSourceDto[] }
  const gone = listed.sources.find((source) => source.id === 'gone')!
  assert.ok(gone.lastError)
  assert.equal(gone.lastCommit, null)

  // Changer de dossier rend le catalogue caduc : il ne doit plus rien proposer.
  const upstream = repository(dir)
  localSource(db, 'local', upstream.root, 'skills')
  await call('admin', 'POST', '/api/skill-sources/local/refresh')
  const moved = (await call('admin', 'PATCH', '/api/skill-sources/local', { subpath: 'skills/alpha' })).json() as SkillSourceDto
  assert.deepEqual([moved.lastCommit, moved.skillCount], [null, null])
  await call('admin', 'POST', '/api/skill-sources/local/refresh')
  const narrowed = (await call('admin', 'GET', '/api/skill-sources/local/catalog')).json() as SkillSourceCatalogDto
  assert.deepEqual(narrowed.skills.map((skill) => skill.path), ['skills/alpha'])
})
