import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { credentialEnv } from '../src/git-credential/helper.js'
import { setCredentialHelper } from '../src/git.js'

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
