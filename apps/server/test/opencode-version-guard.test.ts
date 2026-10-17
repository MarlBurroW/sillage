import assert from 'node:assert/strict'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { OpencodeRunner } from '../src/agents/opencode/runner.js'
import { OpencodeUnsupportedVersionError, assertSupportedOpencode } from '../src/agents/opencode/version-guard.js'
import { context, fixture } from './opencode-support.js'

/** Fait annoncer au faux binaire la version voulue, sous la forme qu'emploie chaque ligne. */
async function announce(binary: string, line: string): Promise<void> {
  const source = await readFile(binary, 'utf8')
  // Seul le premier `console.log` du faux binaire répond à `--version`.
  const version = /console\.log\((['"])[^'"]*\1\)/
  assert.match(source, version)
  await writeFile(binary, source.replace(version, `console.log(${JSON.stringify(line)})`))
}

test('garde-fou : un opencode 2 est refusé avant le lancement, avec un code traduisible', async (t) => {
  const { binary, cwd } = await fixture(t)
  // Telle que la 2.0.32 la répond réellement.
  await announce(binary, 'opencode v2.0.32')

  const { ctx } = context({ cwd, binary })
  const runner = new OpencodeRunner(ctx)
  await assert.rejects(runner.start(), (err: unknown) => {
    assert.ok(err instanceof OpencodeUnsupportedVersionError)
    assert.equal(err.code, 'opencode_unsupported_version')
    assert.equal(err.statusCode, 409)
    assert.deepEqual(err.params, { version: '2.0.32' })
    assert.match(err.message, /OpenCode 2\.0\.32 is not supported/)
    return true
  })
  // Refusé avant `opencode serve` : le faux serveur n'a rien écrit.
  await assert.rejects(access(join(cwd, 'launch.json')))
})

test('garde-fou : la 1.x passe, et un binaire remplacé est relu', async (t) => {
  const { binary } = await fixture(t)
  await announce(binary, '1.19.3')
  await assertSupportedOpencode(binary)

  // Une mise à jour remplace le binaire en place : le cache ne doit pas laisser passer
  // la nouvelle majeure sur la foi de l'ancienne sonde.
  await announce(binary, 'opencode v2.0.32')
  await assert.rejects(assertSupportedOpencode(binary), OpencodeUnsupportedVersionError)
})

test('garde-fou : une version illisible laisse passer', async (t) => {
  const { binary } = await fixture(t)
  await announce(binary, 'nightly')
  await assertSupportedOpencode(binary)
})
