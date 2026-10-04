import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { eq } from 'drizzle-orm'
import { librarySkills, projects, skillSources } from '@sillage/db'
import type { LibrarySkillDto } from '@sillage/protocol'
import { skillLibraryLaunchOptions } from '../src/agents/claude/skill-library.js'
import { compatNotes } from '../src/skill-library/compat.js'
import { parseSkillMarkdown, updateSkillMarkdown } from '../src/skill-library/frontmatter.js'
import { contentHash, listFiles } from '../src/skill-library/store.js'
import { createSkill, harness, http } from './skill-library-support.js'

const create = createSkill

test('un skill créé est un plugin Claude et une racine Codex, sans rien à moitié écrit', (t) => {
  const { library, root, changes } = harness(t)
  const skill = create(library)

  const dir = join(root, 'global/sillage/skills/deploy')
  // Pas de manifeste : Claude prend le nom du dossier, et Codex préfixerait sinon chaque
  // skill du nom du plugin.
  assert.ok(!existsSync(join(root, 'global/sillage/.claude-plugin')))
  assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), '---\nname: deploy\ndescription: Use when deploying.\n---\n\nRun it.')
  assert.deepEqual(listFiles(join(root, '.staging')), [], 'la zone de transit est vidée')
  assert.equal(skill.description, 'Use when deploying.')
  assert.equal(skill.problem, null)
  assert.deepEqual(changes, [null])

  const roots = library.layout.rootsFor('p1')
  assert.deepEqual(roots, [join(root, 'global/sillage'), join(root, 'projects/p1/projet')])
  // Une portée vide existe quand même, `skills/` compris : sans lui, un skill ajouté
  // en cours de session ne serait jamais vu par Claude.
  assert.ok(existsSync(join(root, 'projects/p1/projet/skills')))
})

test('un nom ne vaut qu’une fois sur ce qu’une conversation voit', (t) => {
  const { library } = harness(t)
  create(library, { scope: 'project', projectId: 'p1', name: 'lint' })

  // Un projet voisin peut avoir son homonyme ; le global, non, il serait visible de p1.
  assert.doesNotThrow(() => create(library, { scope: 'project', projectId: 'p2', name: 'lint' }))
  assert.throws(() => create(library, { name: 'lint' }), { code: 'skill_name_taken' })

  create(library, { name: 'deploy' })
  assert.throws(() => create(library, { scope: 'project', projectId: 'p2', name: 'deploy' }), { code: 'skill_name_taken' })
})

test('un dossier déposé à la main n’est pas écrasé', (t) => {
  const { library, root } = harness(t)
  library.layout.ensureScope('global', null)
  mkdirSync(join(root, 'global/sillage/skills/deploy'))
  assert.throws(() => create(library), { code: 'skill_directory_exists' })
})

test('renommer, désactiver et changer de portée déplacent le dossier et gardent le frontmatter', (t) => {
  const { library, root, changes } = harness(t)
  const skill = create(library)
  const path = join(root, 'global/sillage/skills/deploy/SKILL.md')
  writeFileSync(path, '---\nname: deploy\n# à garder\nallowed-tools: Bash\ndescription: Use when deploying.\n---\n\nRun it.')

  let row = library.row(skill.id)
  let updated = library.update(row, { name: 'ship', description: 'Use when shipping.' })
  const shipped = readFileSync(join(root, 'global/sillage/skills/ship/SKILL.md'), 'utf8')
  assert.equal(shipped, '---\nname: ship\n# à garder\nallowed-tools: Bash\ndescription: Use when shipping.\n---\n\nRun it.')
  assert.ok(!existsSync(join(root, 'global/sillage/skills/deploy')))
  assert.equal(updated.problem, null)

  row = library.row(skill.id)
  library.update(row, { enabled: false })
  assert.ok(!existsSync(join(root, 'global/sillage/skills/ship')))
  assert.ok(existsSync(join(root, 'disabled', skill.id, 'SKILL.md')))
  assert.equal(library.list(null)[0]!.enabled, false)

  row = library.row(skill.id)
  changes.length = 0
  updated = library.update(row, { enabled: true, scope: 'project', projectId: 'p1' })
  assert.ok(existsSync(join(root, 'projects/p1/projet/skills/ship/SKILL.md')))
  assert.equal(updated.scope, 'project')
  assert.deepEqual(changes, [null, 'p1'], 'les sessions de départ et d’arrivée rechargent')
  assert.deepEqual(library.list(null), [])
  assert.equal(library.list('p1').length, 1)
})

test('un refus ne laisse pas un skill réécrit à son ancienne place', (t) => {
  const { library, root } = harness(t)
  const skill = create(library)
  create(library, { name: 'ship' })
  assert.throws(() => library.update(library.row(skill.id), { name: 'ship', body: 'Changed.' }), { code: 'skill_name_taken' })
  assert.match(readFileSync(join(root, 'global/sillage/skills/deploy/SKILL.md'), 'utf8'), /Run it\.$/)
})

test('le disque fait foi : dossier disparu, fichier illisible, nom divergent', (t) => {
  const { library, root } = harness(t)
  const skill = create(library)
  const path = join(root, 'global/sillage/skills/deploy/SKILL.md')

  writeFileSync(path, 'pas de frontmatter')
  assert.equal(library.list(null)[0]!.problem, 'skill_unreadable')
  writeFileSync(path, '---\nname: autre\ndescription: x\n---\n')
  assert.equal(library.list(null)[0]!.problem, 'skill_name_mismatch')
  rmSync(join(root, 'global/sillage/skills/deploy'), { recursive: true })
  assert.equal(library.list(null)[0]!.problem, 'skill_missing')
  assert.throws(() => library.update(library.row(skill.id), { body: 'x' }), { code: 'skill_missing' })
  // Supprimer reste possible, c'est la sortie d'un skill dont le dossier a disparu.
  library.remove(library.row(skill.id))
  assert.deepEqual(library.list(null), [])
})

test('un skill installé se sait modifié localement', (t) => {
  const { library, root, db } = harness(t)
  const skill = create(library)
  const dir = join(root, 'global/sillage/skills/deploy')
  db.insert(skillSources).values({ id: 'src', name: 'src', url: 'https://example.invalid/x.git', createdAt: 1, updatedAt: 1 }).run()
  db.update(librarySkills)
    .set({ sourceId: 'src', sourcePath: 'skills/deploy', sourceCommit: 'abc', installedHash: contentHash(dir, listFiles(dir)) })
    .where(eq(librarySkills.id, skill.id))
    .run()

  let listed = library.list(null)[0]!
  assert.deepEqual(listed.origin, { sourceId: 'src', path: 'skills/deploy', commit: 'abc' })
  assert.equal(listed.locallyModified, false)
  writeFileSync(join(dir, 'notes.md'), 'ajout')
  listed = library.list(null)[0]!
  assert.equal(listed.locallyModified, true)
})

test('supprimer un projet efface ses dossiers, désactivés compris', (t) => {
  const { library, root, db } = harness(t)
  const active = create(library, { scope: 'project', projectId: 'p1', name: 'one' })
  const disabled = create(library, { scope: 'project', projectId: 'p1', name: 'two' })
  library.update(library.row(disabled.id), { enabled: false })
  library.removeProject('p1')
  db.delete(projects).where(eq(projects.id, 'p1')).run()

  assert.ok(!existsSync(join(root, 'projects/p1')))
  assert.ok(!existsSync(join(root, 'disabled', disabled.id)))
  assert.equal(db.select().from(librarySkills).where(eq(librarySkills.id, active.id)).get(), undefined)
})

test('les liens symboliques ne sont pas listés', (t) => {
  const { library, root, dir } = harness(t)
  create(library)
  writeFileSync(join(dir, 'outside.txt'), 'secret')
  symlinkSync(join(dir, 'outside.txt'), join(root, 'global/sillage/skills/deploy/link.txt'))
  assert.deepEqual(library.detail(library.row(library.list(null)[0]!.id)).files, ['SKILL.md'])
})

test('frontmatter : description pliée relue, réécriture stable', () => {
  const text = '---\nname: x\ndescription: >-\n  Use when\n  folding.\nmetadata:\n  short-description: X\n---\nBody\n'
  const parsed = parseSkillMarkdown(text)
  assert.equal(parsed.data.description, 'Use when folding.')
  assert.equal(parsed.body, 'Body\n')
  const once = updateSkillMarkdown(text, { body: 'New' })
  assert.equal(updateSkillMarkdown(once, {}), once, 'relire puis réécrire ne change rien')
  assert.deepEqual(parseSkillMarkdown(once).data.metadata, { 'short-description': 'X' })
  assert.throws(() => parseSkillMarkdown('---\n- a\n- b\n---\n'), /mapping/)
})

test('compatibilité : ce que Codex fera autrement', () => {
  assert.deepEqual(compatNotes({ 'argument-hint': '<x>' }, '', []), [{ code: 'codex_no_arguments', field: null }])
  assert.deepEqual(compatNotes({}, 'Echo $ARGUMENTS', []), [{ code: 'codex_no_arguments', field: null }])
  assert.deepEqual(compatNotes({}, 'Costs $5', []), [{ code: 'codex_no_arguments', field: null }])
  assert.deepEqual(compatNotes({ 'allowed-tools': 'Bash' }, '', []), [{ code: 'claude_only_field', field: 'allowed-tools' }])
  assert.deepEqual(compatNotes({}, '', ['SKILL.md', 'scripts/run.sh']), [{ code: 'runs_scripts', field: null }])
  assert.deepEqual(compatNotes({ name: 'x', description: 'y' }, 'Plain.', ['SKILL.md', 'references/a.md']), [])
})

test('options Claude : plugins sans MCP, dossiers autorisés, écriture refusée', () => {
  const options = skillLibraryLaunchOptions(['/data/skill-library/global', '/data/skill-library/projects/p1'])
  assert.deepEqual(options.plugins, [
    { type: 'local', path: '/data/skill-library/global', skipMcpDiscovery: true },
    { type: 'local', path: '/data/skill-library/projects/p1', skipMcpDiscovery: true },
  ])
  assert.deepEqual(options.additionalDirectories, ['/data/skill-library/global', '/data/skill-library/projects/p1'])
  assert.deepEqual(options.deny.slice(0, 2), ['Edit(//data/skill-library/global/**)', 'Write(//data/skill-library/global/**)'])
  assert.deepEqual(skillLibraryLaunchOptions([]), { plugins: [], additionalDirectories: [], deny: [] })
})

test('routes : admins pour le global, propriétaire pour un projet, invisibles pour les autres', async (t) => {
  const { call } = await http(t)
  const body = { scope: 'global', projectId: null, name: 'deploy', description: 'Use when deploying.' }

  assert.equal((await call('owner', 'POST', '/api/skill-library', body)).statusCode, 403)
  const created = await call('admin', 'POST', '/api/skill-library', body)
  assert.equal(created.statusCode, 201)
  const global = created.json() as LibrarySkillDto

  const projectBody = { scope: 'project', projectId: 'p1', name: 'lint', description: 'Use when linting.' }
  assert.equal((await call('member', 'POST', '/api/skill-library', projectBody)).statusCode, 403)
  const own = (await call('owner', 'POST', '/api/skill-library', projectBody)).json() as LibrarySkillDto
  const hidden = (await call('owner', 'POST', '/api/skill-library', { ...projectBody, projectId: 'secret' })).json() as LibrarySkillDto

  // Un projet partagé se lit par ses membres, un projet privé n'existe pas pour eux.
  const listed = (await call('member', 'GET', '/api/skill-library?projectId=p1')).json() as { skills: LibrarySkillDto[]; enabled: boolean }
  assert.deepEqual(listed.skills.map((skill) => skill.name), ['deploy', 'lint'])
  assert.equal(listed.enabled, true)
  assert.equal((await call('member', 'GET', '/api/skill-library?projectId=secret')).statusCode, 404)
  assert.equal((await call('member', 'GET', `/api/skill-library/${hidden.id}`)).statusCode, 404)
  assert.equal((await call('member', 'GET', `/api/skill-library/${own.id}`)).statusCode, 200)

  // Passer un skill de projet en global demande aussi le droit d'écrire le global.
  const promote = { scope: 'global', projectId: null }
  assert.equal((await call('owner', 'PATCH', `/api/skill-library/${own.id}`, promote)).statusCode, 403)
  assert.equal((await call('admin', 'PATCH', `/api/skill-library/${own.id}`, promote)).statusCode, 403)
  assert.equal((await call('member', 'DELETE', `/api/skill-library/${global.id}`)).statusCode, 403)
  assert.equal((await call('admin', 'DELETE', `/api/skill-library/${global.id}`)).statusCode, 204)

  // Les champs de portée vont par deux, et un nom invalide est refusé avant le disque.
  assert.equal((await call('owner', 'PATCH', `/api/skill-library/${own.id}`, { scope: 'global' })).statusCode, 400)
  assert.equal((await call('admin', 'POST', '/api/skill-library', { ...body, name: '../evil' })).statusCode, 400)
})
