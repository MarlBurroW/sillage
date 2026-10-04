import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { strToU8, unzipSync, zipSync } from 'fflate'
import type { LibrarySkillDetailDto, LibrarySkillDto, LibrarySkillFileDto, LocalSkillListDto } from '@sillage/protocol'
import { readSkillArchive } from '../src/skill-library/archive.js'
import { scanLocalSkills } from '../src/skill-library/local-scan.js'
import { createSkill, harness, http } from './skill-library-support.js'

const SKILL = '---\nname: pdf\ndescription: Use when reading PDFs.\n---\n\nRead it.\n'

test('archive : racine ou dossier unique, déchets ignorés, évasion refusée', () => {
  const flat = readSkillArchive(zipSync({ 'SKILL.md': strToU8(SKILL), 'scripts/run.sh': strToU8('echo') }))
  assert.deepEqual([...flat.keys()].sort(), ['SKILL.md', 'scripts/run.sh'])

  const nested = readSkillArchive(zipSync({
    'pdf/SKILL.md': strToU8(SKILL),
    'pdf/references/a.md': strToU8('a'),
    '__MACOSX/pdf/._SKILL.md': strToU8('junk'),
    'pdf/.DS_Store': strToU8('junk'),
  }))
  assert.deepEqual([...nested.keys()].sort(), ['SKILL.md', 'references/a.md'])

  assert.throws(() => readSkillArchive(zipSync({ 'SKILL.md': strToU8(SKILL), '../evil.sh': strToU8('rm') })), { code: 'skill_file_path_invalid' })
  assert.throws(() => readSkillArchive(zipSync({ 'a/SKILL.md': strToU8(SKILL), 'b/x': strToU8('') })), { code: 'skill_archive_no_skill' })
  assert.throws(() => readSkillArchive(zipSync({ 'README.md': strToU8('') })), { code: 'skill_archive_no_skill' })
  assert.throws(() => readSkillArchive(strToU8('pas un zip')), { code: 'skill_archive_invalid' })
})

test('fichiers annexes : texte édité, binaire décrit, SKILL.md et évasions refusés', async (t) => {
  const { call, upload, library, root } = await http(t)
  const skill = createSkill(library)
  const base = `/api/skill-library/${skill.id}`

  assert.equal((await call('admin', 'PUT', `${base}/files/references/guide.md`, { content: '# Guide' })).statusCode, 204)
  const read = (await call('member', 'GET', `${base}/files/references/guide.md`)).json() as LibrarySkillFileDto
  assert.deepEqual(read, { path: 'references/guide.md', size: 7, content: '# Guide' })

  assert.equal((await upload('admin', `${base}/upload?path=assets/logo.png`, 'logo.png', new Uint8Array([137, 80, 0, 1]))).statusCode, 204)
  const binary = (await call('admin', 'GET', `${base}/files/assets/logo.png`)).json() as LibrarySkillFileDto
  assert.deepEqual(binary, { path: 'assets/logo.png', size: 4, content: null })

  const detail = (await call('admin', 'GET', base)).json() as LibrarySkillDetailDto
  assert.deepEqual(detail.files, ['SKILL.md', 'assets/logo.png', 'references/guide.md'])
  assert.deepEqual(detail.compat, [])

  // SKILL.md s'édite par les champs, qui gardent le nom du dossier.
  const reserved = await call('admin', 'PUT', `${base}/files/SKILL.md`, { content: 'x' })
  assert.equal(reserved.json().error.code, 'skill_file_reserved')
  for (const evil of ['..%2F..%2Fevil.txt', 'a/..%2F..%2F..%2Fevil.txt', '%2Fetc%2Fevil']) {
    const response = await call('admin', 'PUT', `${base}/files/${evil}`, { content: 'x' })
    assert.equal(response.statusCode, 400, evil)
  }
  assert.ok(!existsSync(join(root, 'evil.txt')) && !existsSync(join(root, 'global/evil.txt')))
  assert.equal((await call('member', 'PUT', `${base}/files/notes.md`, { content: 'x' })).statusCode, 403)

  assert.equal((await call('admin', 'DELETE', `${base}/files/references/guide.md`)).statusCode, 204)
  assert.ok(!existsSync(join(root, 'global/sillage/skills/deploy/references')), 'le dossier vidé part avec')
  assert.equal((await call('admin', 'DELETE', `${base}/files/references/guide.md`)).statusCode, 404)
})

test('export puis import : le même dossier, sous un nom libre, frontmatter réécrit', async (t) => {
  const { call, upload, library, root } = await http(t)
  const skill = createSkill(library)
  library.writeFile(library.row(skill.id), 'scripts/run.sh', 'echo hi')

  const exported = await call('member', 'GET', `/api/skill-library/${skill.id}/export`)
  assert.equal(exported.headers['content-type'], 'application/zip')
  assert.match(String(exported.headers['content-disposition']), /deploy\.zip/)
  const archive = new Uint8Array(exported.rawPayload)
  assert.deepEqual(Object.keys(unzipSync(archive)).sort(), ['deploy/SKILL.md', 'deploy/scripts/run.sh'])

  // Même nom : refusé. Sous un autre nom, dans un projet : accepté par son propriétaire.
  assert.equal((await upload('admin', '/api/skill-library/import?scope=global', 'deploy.zip', archive)).statusCode, 409)
  const imported = await upload('owner', '/api/skill-library/import?scope=project&projectId=p1&name=ship', 'deploy.zip', archive)
  assert.equal(imported.statusCode, 201)
  const copy = imported.json() as LibrarySkillDto
  assert.equal(copy.name, 'ship')
  assert.deepEqual(copy.compat, [{ code: 'runs_scripts', field: null }])
  const main = readFileSync(join(root, 'projects/p1/projet/skills/ship/SKILL.md'), 'utf8')
  assert.match(main, /^---\nname: ship\ndescription: Use when deploying\.\n---/)
  assert.equal(readFileSync(join(root, 'projects/p1/projet/skills/ship/scripts/run.sh'), 'utf8'), 'echo hi')

  assert.equal((await upload('member', '/api/skill-library/import?scope=project&projectId=p1&name=other', 'x.zip', archive)).statusCode, 403)
  const broken = await upload('admin', '/api/skill-library/import?scope=global&name=x', 'x.zip', zipSync({ 'a.md': strToU8('') }))
  assert.equal(broken.json().error.code, 'skill_archive_no_skill')
  const nameless = zipSync({ 'SKILL.md': strToU8('---\nname: Bad Name\ndescription: x\n---\n') })
  assert.equal((await upload('admin', '/api/skill-library/import?scope=global', 'x.zip', nameless)).json().error.code, 'skill_name_invalid')
})

test('dupliquer : droits sur la destination, provenance laissée derrière', async (t) => {
  const { call, library } = await http(t)
  const skill = createSkill(library)
  const target = { scope: 'project', projectId: 'p1', name: 'deploy-local' }
  assert.equal((await call('member', 'POST', `/api/skill-library/${skill.id}/duplicate`, target)).statusCode, 403)
  const response = await call('owner', 'POST', `/api/skill-library/${skill.id}/duplicate`, target)
  assert.equal(response.statusCode, 201)
  assert.equal((response.json() as LibrarySkillDto).origin, null)
  assert.deepEqual(library.list('p1').map((entry) => entry.name), ['deploy', 'deploy-local'])
})

/** Une machine fictive : dossiers de l'utilisateur et dépôt du projet. */
function machine(dir: string) {
  const write = (path: string, content: string) => {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  const skill = (name: string, description = `Use for ${name}.`) => `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`
  write('home/.claude/skills/review/SKILL.md', skill('review'))
  write('home/.claude/skills/review/notes.md', 'notes')
  write('home/.claude/skills/synced/remote/SKILL.md', skill('remote'))
  write('home/.agents/skills/Bad Name/SKILL.md', skill('Bad Name'))
  write('home/.codex/skills/.system/bundled/SKILL.md', skill('bundled'))
  write('elsewhere/linked/SKILL.md', skill('linked'))
  symlinkSync(join(dir, 'elsewhere/linked'), join(dir, 'home/.claude/skills/linked'))
  write('workspace/.claude/skills/repo-only/SKILL.md', skill('repo-only'))
  write('workspace/.agents/skills/broken/SKILL.md', 'pas de frontmatter')
}

test('scan de la machine : skills de chaque CLI, sans ceux qu’ils gèrent eux-mêmes', (t) => {
  const { dir } = harness(t)
  machine(dir)
  const found = scanLocalSkills({ home: join(dir, 'home'), codexHome: null, workspace: join(dir, 'workspace') })
  assert.deepEqual(
    found.map((skill) => [skill.origin, skill.name, skill.problem]),
    [
      ['agents-repo', 'broken', 'skill_unreadable'],
      ['agents-user', 'Bad Name', 'skill_name_invalid'],
      ['claude-repo', 'repo-only', null],
      ['claude-user', 'linked', null],
      ['claude-user', 'review', null],
    ],
  )
  // Le lien est suivi : c'est le dossier réel qui sert de clé.
  assert.equal(found.find((skill) => skill.name === 'linked')!.path, join(dir, 'elsewhere/linked'))
})

test('reprise : admin pour la machine, membres pour le dépôt, rien hors du scan', async (t) => {
  const { call, dir, root } = await http(t)
  machine(dir)
  const previousHome = process.env.HOME
  process.env.HOME = join(dir, 'home')
  t.after(() => { process.env.HOME = previousHome })

  const admin = (await call('admin', 'GET', '/api/skill-library/local')).json() as LocalSkillListDto
  assert.ok(admin.skills.some((skill) => skill.name === 'review'))
  const member = (await call('member', 'GET', '/api/skill-library/local?projectId=p1')).json() as LocalSkillListDto
  assert.deepEqual(member.skills.map((skill) => skill.name).sort(), ['broken', 'repo-only'])
  assert.equal((await call('member', 'GET', '/api/skill-library/local?projectId=secret')).statusCode, 404)

  // Un chemin que le scan n'a pas proposé n'est pas copié, même par un admin.
  const outside = await call('admin', 'POST', '/api/skill-library/adopt', { scope: 'global', projectId: null, path: join(dir, 'elsewhere') })
  assert.equal(outside.statusCode, 404)
  const review = admin.skills.find((skill) => skill.name === 'review')!
  const adopted = await call('admin', 'POST', '/api/skill-library/adopt', { scope: 'global', projectId: null, path: review.path })
  assert.equal(adopted.statusCode, 201)
  assert.equal(readFileSync(join(root, 'global/sillage/skills/review/notes.md'), 'utf8'), 'notes')
  assert.ok(existsSync(review.path), 'l’original reste en place')

  // Un nom invalide se reprend sous un nom choisi.
  const bad = admin.skills.find((skill) => skill.problem === 'skill_name_invalid')!
  assert.equal((await call('admin', 'POST', '/api/skill-library/adopt', { scope: 'global', projectId: null, path: bad.path })).statusCode, 400)
  assert.equal((await call('admin', 'POST', '/api/skill-library/adopt', { scope: 'global', projectId: null, path: bad.path, name: 'good-name' })).statusCode, 201)

  // Le dépôt se reprend dans son projet, par son propriétaire.
  const repo = member.skills.find((skill) => skill.name === 'repo-only')!
  assert.equal((await call('member', 'POST', '/api/skill-library/adopt', { scope: 'project', projectId: 'p1', path: repo.path })).statusCode, 403)
  assert.equal((await call('owner', 'POST', '/api/skill-library/adopt', { scope: 'project', projectId: 'p1', path: repo.path })).statusCode, 201)
})
