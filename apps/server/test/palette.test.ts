import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { cards, conversations, openDatabase, projects, runMigrations, users, worktrees } from '@sillage/db'
import {
  fuzzyMatch,
  fuzzyTokens,
  matchFields,
  type PaletteCatalogDto,
  type PaletteFilesDto,
} from '@sillage/protocol'
import type { Config } from '../src/config.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerPaletteRoutes } from '../src/http/routes/palette.js'
import { SkillLibrary } from '../src/skill-library/store.js'

/** Un mot de saisie contre un texte, positions rendues en lettres pour se lire. */
function picked(text: string, query: string, mode?: 'fuzzy' | 'words' | 'strict'): string | null {
  const [token = ''] = fuzzyTokens(query)
  const match = fuzzyMatch(text, token, { mode })
  return match ? match.positions.map((index) => text[index]).join('') : null
}

test('correspondance floue : lettres dans l’ordre, débuts de mot et bosses du camelCase', () => {
  assert.equal(picked('CommandPalette.tsx', 'cmdpal'), 'CmdPal')
  assert.equal(picked('CommandPalette.tsx', 'cp'), 'CP')
  assert.equal(picked('config.ts', 'cfg'), 'cfg')
  // L'alignement optimal retient la bosse de « Palette », pas le premier « p » venu.
  assert.equal(picked('apps/web/CommandPalette.tsx', 'palette'), 'Palette')
  // Casse et accents ne comptent pas, et les positions désignent le texte affiché.
  assert.equal(picked('Réglages du projet', 'reglage'), 'Réglage')
})

test('correspondance floue : les lettres piochées une par mot sont du bruit', () => {
  assert.equal(picked('ApprovalsReviewer.ts', 'power'), null)
  assert.equal(picked('InAppBrowserRequirements.ts', 'power'), null)
  assert.equal(picked('Rate-limit the places endpoint', 'mcp'), null)
  // Une lettre seule doit ouvrir un mot.
  assert.equal(picked('Release notes', 's'), null)
  assert.equal(picked('Refactor settings', 's'), 's')
})

test('correspondance floue : les modes phrase et strict', () => {
  // Une phrase accepte des initiales, pas un saut au milieu d'un mot.
  assert.equal(picked('Add offline caching for forecasts', 'aocf', 'words'), 'Aocf')
  assert.equal(picked('Add offline caching for forecasts', 'cache', 'words'), null)
  assert.equal(picked('Add offline caching for forecasts', 'cach', 'words'), 'cach')
  // Strict : un seul morceau, de préférence en début de mot.
  assert.equal(picked('Atlas API', 'api', 'strict'), 'API')
  assert.equal(picked('Clean Architecture Checker', 'cache', 'strict'), null)
})

test('plusieurs mots, chacun dans le champ où il vaut le plus, dans n’importe quel ordre', () => {
  const fields = [
    { text: 'Add offline caching for forecasts', weight: 1, mode: 'words' as const },
    { text: 'Nimbus', weight: 0.35, mode: 'strict' as const },
  ]
  const match = matchFields(fields, fuzzyTokens('cach nimbus'))
  assert.ok(match)
  assert.deepEqual(match.matched, [true, true])
  assert.equal(matchFields(fields, fuzzyTokens('cach atlas')), null)
  // La barre oblique sépare comme une espace : dossier d'un côté, nom de l'autre.
  assert.deepEqual(fuzzyTokens(' web/pal  x '), ['web', 'pal', 'x'])
})

/**
 * Trois projets sur le disque : deux au propriétaire, dont un archivé, et un privé d'un
 * autre compte. Le premier est un dépôt git avec un worktree, le deuxième un simple dossier.
 */
function harness(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-palette-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())

  const files = (root: string, paths: string[]) => {
    for (const path of paths) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), '')
    }
  }
  const nimbus = join(dir, 'nimbus')
  files(nimbus, ['src/lib/forecast.ts', 'src/components/ForecastCard.tsx', 'README.md', 'dist/forecast.js'])
  writeFileSync(join(nimbus, '.gitignore'), 'dist/\n')
  execFileSync('git', ['init', '-q'], { cwd: nimbus })
  const worktree = join(dir, 'nimbus-offline')
  files(worktree, ['src/lib/forecast.ts', 'src/lib/forecast-cache.ts'])
  const atlas = join(dir, 'atlas')
  files(atlas, ['README.md', 'src/forecast-proxy.ts'])
  const secret = join(dir, 'secret')
  files(secret, ['forecast-secret.ts'])
  const archived = join(dir, 'archived')
  files(archived, ['forecast-old.ts'])

  const user = (id: string) => ({ id, username: id, displayName: id, passwordHash: '', isAdmin: false, createdAt: 1 })
  db.insert(users).values([user('owner'), user('stranger')]).run()
  const project = (id: string, name: string, workspacePath: string, ownerId = 'owner', archivedAt: number | null = null) =>
    ({ id, name, workspacePath, ownerId, visibility: 'private' as const, archivedAt, createdAt: 1 })
  db.insert(projects).values([
    project('nimbus', 'Nimbus', nimbus),
    project('atlas', 'Atlas API', atlas),
    project('secret', 'Secret', secret, 'stranger'),
    project('archived', 'Archived', archived, 'owner', 2),
  ]).run()
  db.insert(worktrees).values({
    id: 'offline', projectId: 'nimbus', name: 'offline', path: worktree, baseRef: 'main', createdBy: 'owner', createdAt: 1,
  }).run()
  db.insert(conversations).values([
    { id: 'main', projectId: 'nimbus', userId: 'owner', title: 'Main', agent: 'claude', config: '{}', status: 'idle', createdAt: 1, updatedAt: 1 },
    { id: 'offline', projectId: 'nimbus', worktreeId: 'offline', userId: 'owner', title: 'Offline', agent: 'claude', config: '{}', status: 'idle', createdAt: 1, updatedAt: 1 },
  ]).run()
  const card = (id: string, projectId: string, number: number, title: string) =>
    ({ id, projectId, number, title, description: 'Ne se cherche pas.', column: 'todo' as const, position: number, createdBy: 'owner', createdAt: 1, updatedAt: 1 })
  db.insert(cards).values([
    card('c1', 'nimbus', 1, 'Offline mode'),
    card('c2', 'secret', 1, 'Secret plan'),
    card('c3', 'archived', 1, 'Old plan'),
  ]).run()

  const library = new SkillLibrary(db, join(dir, 'library'))
  const skill = (scope: 'global' | 'project', projectId: string | null, name: string) =>
    library.create({ scope, projectId, name, description: `Use ${name}.`, body: '' }, 'owner')
  skill('global', null, 'release-notes')
  skill('project', 'nimbus', 'forecast-debugging')
  skill('project', 'secret', 'secret-skill')

  const app = Fastify()
  app.addHook('preHandler', async (request) => {
    request.user = db.select().from(users).where(eq(users.id, 'owner')).get()
  })
  registerErrorHandler(app)
  registerPaletteRoutes(app, { db, config: {} as Config }, library)
  t.after(() => app.close())
  return { app }
}

test('catalogue : cartes et skills des projets visibles et non archivés', async (t) => {
  const { app } = harness(t)
  const response = await app.inject({ url: '/api/palette/catalog' })
  assert.equal(response.statusCode, 200, response.body)
  const catalog = response.json<PaletteCatalogDto>()

  assert.deepEqual(catalog.cards.map((card) => `${card.projectId}#${card.number} ${card.title}`), ['nimbus#1 Offline mode'])
  assert.deepEqual(
    catalog.skills.map((skill) => `${skill.projectId ?? 'global'}:${skill.name}:${skill.description}`).sort(),
    ['global:release-notes:Use release-notes.', 'nimbus:forecast-debugging:Use forecast-debugging.'],
  )
})

test('fichiers : tous les projets visibles, nom flou, dossier d’un seul tenant', async (t) => {
  const { app } = harness(t)
  const search = async (q: string, conversationId?: string) => {
    const query = new URLSearchParams({ q })
    if (conversationId) query.set('conversationId', conversationId)
    const response = await app.inject({ url: `/api/palette/files?${query}` })
    assert.equal(response.statusCode, 200, response.body)
    return Object.fromEntries(response.json<PaletteFilesDto>().projects.map((group) => [group.projectId, group.paths]))
  }

  // Ni le projet privé d'un autre compte, ni l'archivé, ni ce que git ignore.
  assert.deepEqual(await search('forecast'), {
    nimbus: ['src/lib/forecast.ts', 'src/components/ForecastCard.tsx'],
    atlas: ['src/forecast-proxy.ts'],
  })
  // Le nom du projet restreint sans lister tout le projet à lui seul.
  assert.deepEqual(await search('nimbus card'), { nimbus: ['src/components/ForecastCard.tsx'] })
  assert.deepEqual(await search('nimbus'), {})
  // Une barre oblique sépare le dossier du nom.
  assert.deepEqual(await search('lib/fore'), { nimbus: ['src/lib/forecast.ts'] })
  // Depuis une conversation en worktree, son projet se cherche dans le worktree.
  assert.deepEqual((await search('forecast', 'offline')).nimbus, ['src/lib/forecast.ts', 'src/lib/forecast-cache.ts'])
  assert.deepEqual((await search('forecast', 'main')).nimbus, ['src/lib/forecast.ts', 'src/components/ForecastCard.tsx'])
})
