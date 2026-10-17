import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { openDatabase, runMigrations, users } from '@sillage/db'
import {
  credentialEnv,
  credentialHelperCommand,
  credentialLauncherPath,
  credentialLauncherScript,
  installCredentialLauncher,
} from '../src/git-credential/helper.js'
import { splitQuotedWords, upgradeCredentialHelpers, upgradeHelperList } from '../src/git-credential/migrate.js'
import { GitCredentialStore } from '../src/git-credentials/store.js'
import { setCredentialHelper } from '../src/git.js'
import { loadOrCreateKey } from '../src/secrets/cipher.js'

/** Un helper qui répond toujours le même identifiant, comme le ferait un trousseau. */
const answering = (user: string) => `!f() { echo username=${user}; echo password=secret; }; f`

/** L'identifiant que git retient pour github.com, helpers consultés dans leur ordre. */
function filledUser(cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  const out = execFileSync('git', ['credential', 'fill'], {
    cwd,
    env: { ...process.env, ...env },
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  return /^username=(.*)$/m.exec(out)?.[1]
}

test("le helper de Sillage passe devant ceux de la configuration globale, osxkeychain compris", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-credential-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  // Ce que le git de macOS pose dans sa configuration système : un helper qui répond le
  // premier dès qu'il connaît l'hôte.
  const globalConfig = join(dir, 'gitconfig')
  execFileSync('git', ['config', '--file', globalConfig, 'credential.helper', answering('keychain')])
  const outside: NodeJS.ProcessEnv = { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }

  const repo = join(dir, 'repo')
  execFileSync('git', ['init', '-q', repo])
  assert.equal(filledUser(repo, outside), 'keychain')

  // Le dépôt cloné : configuration locale, relue par tout git lancé ensuite. Écrite deux
  // fois, comme un second clone au même endroit, sans empiler les valeurs.
  await setCredentialHelper(repo, answering('sillage'))
  await setCredentialHelper(repo, answering('sillage'))
  assert.equal(filledUser(repo, outside), 'sillage')
  const local = execFileSync('git', ['config', '--local', '--get-all', 'credential.helper'], { cwd: repo, encoding: 'utf8' })
  assert.deepEqual(local.replace(/\n$/, '').split('\n'), ['', answering('sillage')])

  // Le clone : le dépôt n'existe pas encore, le helper passe par l'environnement.
  const bare = join(dir, 'bare')
  execFileSync('git', ['init', '-q', bare])
  const env = { ...credentialEnv({ data: dir, database: join(dir, 'sillage.db') } as never, 'owner'), GIT_CONFIG_VALUE_1: answering('sillage') }
  assert.equal(filledUser(bare, { ...outside, ...env }), 'sillage')
})

/** Une instance de test : base migrée, clé, et un propriétaire avec un jeton pour github.com. */
function instance(dir: string) {
  const paths = { data: join(dir, 'data'), database: join(dir, 'data', 'sillage.db') }
  mkdirSync(paths.data, { recursive: true })
  const { db, sqlite } = openDatabase(paths.database)
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  new GitCredentialStore(db, loadOrCreateKey(paths.data)).put('owner', 'github.com', 'x-access-token', 'ghp_test')
  sqlite.close()
  return paths
}

const isolated: NodeJS.ProcessEnv = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }

function localHelpers(repo: string): string[] {
  const raw = execFileSync('git', ['config', '--local', '-z', '--get-all', 'credential.helper'], { cwd: repo, encoding: 'utf8' })
  return raw.split('\0').slice(0, -1)
}

test('le dépôt cloné ne référence que le lanceur, qui répond avec le jeton de la base', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-credential-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const paths = instance(dir)

  const command = credentialHelperCommand(paths, 'owner')
  const launcher = credentialLauncherPath(paths)
  assert.equal(command, `!'${launcher}' '--owner' 'owner'`)
  // Rien de ce qui change d'une version à l'autre ne doit finir dans le `.git/config`.
  assert.ok(!command.includes(process.execPath))
  assert.ok(!command.includes('.mjs'))
  assert.equal(statSync(launcher).mode & 0o111, 0o111)

  const repo = join(dir, 'repo')
  execFileSync('git', ['init', '-q', repo])
  await setCredentialHelper(repo, command)
  assert.deepEqual(localHelpers(repo), ['', command])

  const out = execFileSync('git', ['credential', 'fill'], {
    cwd: repo,
    env: { ...process.env, ...isolated },
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  assert.match(out, /^username=x-access-token$/m)
  assert.match(out, /^password=ghp_test$/m)
})

test('le lanceur réécrit suit le Node et la release du serveur qui démarre', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-credential-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const paths = { data: dir, database: join(dir, 'sillage.db') }
  const launcher = installCredentialLauncher(paths)

  // Ce qu'a laissé une version supprimée depuis : le lanceur le dit en une ligne, sans
  // trace de Node, et le prochain démarrage le répare.
  writeFileSync(launcher, credentialLauncherScript(paths, process.execPath, join(dir, 'releases/v0.5.0/gone.mjs')), { mode: 0o755 })
  const broken = spawnSync(launcher, ['--owner', 'owner', 'get'], { input: '', encoding: 'utf8' })
  assert.equal(broken.status, 1)
  assert.match(broken.stderr, /redémarrez Sillage/)
  assert.doesNotMatch(broken.stderr, /Cannot find module/)

  // Le démarrage suivant le réécrit sur le Node et le `.mjs` de ce serveur.
  assert.equal(installCredentialLauncher(paths), launcher)
  const script = readFileSync(launcher, 'utf8')
  assert.ok(script.includes(`node='${process.execPath}'`))
  assert.doesNotMatch(script, /gone\.mjs/)
  // `erase` ne demande rien à la base : il prouve que Node et le `.mjs` se lancent.
  assert.equal(spawnSync(launcher, ['--owner', 'owner', 'erase'], { input: '' }).status, 0)
})

test("la remise à niveau ne réécrit que les anciennes entrées de cette instance, ordre et valeur vide compris", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-credential-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const paths = instance(dir)
  const legacy = (database: string, owner: string) =>
    `!'/old/node' '/old/app/releases/v0.5.0/server/git-credential/sillage-git-credential.mjs' '--db' '${database}' '--key' '/old/secret.key' '--owner' '${owner}'`
  const mine = legacy(paths.database, 'owner')
  const otherInstance = legacy('/elsewhere/sillage.db', 'owner')
  const user = 'store --file ~/.my-credentials'
  const current = credentialHelperCommand(paths, 'owner')

  // Avant 0fd5b4e : l'entrée seule, sans valeur vide devant.
  assert.deepEqual(upgradeHelperList([mine], paths), ['', current])
  // Depuis : la valeur vide reste en tête, l'entrée est remplacée à sa place.
  assert.deepEqual(upgradeHelperList(['', mine], paths), ['', current])
  // Les helpers de l'utilisateur, et ceux d'une autre instance, ne bougent pas.
  assert.deepEqual(upgradeHelperList([user, '', mine, otherInstance], paths), [user, '', current, otherInstance])
  // Déjà à jour, ou rien de Sillage : rien à écrire.
  assert.equal(upgradeHelperList(['', current], paths), null)
  assert.equal(upgradeHelperList([user, otherInstance], paths), null)
  // Deux anciennes entrées du même propriétaire n'en font plus qu'une.
  assert.deepEqual(upgradeHelperList(['', mine, mine], paths), ['', current])

  // Sur de vrais dépôts : réécrit une fois, puis plus rien.
  const repo = join(dir, 'repo')
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['config', '--local', '--add', 'credential.helper', user], { cwd: repo })
  execFileSync('git', ['config', '--local', '--add', 'credential.helper', mine], { cwd: repo })
  const untouched = join(dir, 'untouched')
  execFileSync('git', ['init', '-q', untouched])
  execFileSync('git', ['config', '--local', '--add', 'credential.helper', otherInstance], { cwd: untouched })

  const workspaces = [repo, join(repo), untouched, join(dir, 'not-a-repo')]
  assert.deepEqual(await upgradeCredentialHelpers(workspaces, paths), [repo])
  assert.deepEqual(localHelpers(repo), [user, '', current])
  assert.deepEqual(localHelpers(untouched), [otherInstance])
  assert.deepEqual(await upgradeCredentialHelpers(workspaces, paths), [])

  const out = execFileSync('git', ['credential', 'fill'], {
    cwd: repo,
    env: { ...process.env, ...isolated },
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  assert.match(out, /^password=ghp_test$/m)
})

test('les mots cités par Sillage se relisent, apostrophes comprises', () => {
  assert.deepEqual(splitQuotedWords(`'/a b/node' '--owner' 'it'\\''s'`), ['/a b/node', '--owner', "it's"])
  assert.equal(splitQuotedWords(`'non fermé`), null)
})
