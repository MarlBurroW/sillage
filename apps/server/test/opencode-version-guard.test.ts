import assert from 'node:assert/strict'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { OpencodeRunner } from '../src/agents/opencode/runner.js'
import { OpencodeUnsupportedVersionError, assertSupportedOpencode, opencodeGeneration } from '../src/agents/opencode/version-guard.js'
import { context, fixture } from './opencode-support.js'

/** Makes fake binaries announce requested versions in each CLI's format. */
async function announce(binary: string, line: string): Promise<void> {
  const source = await readFile(binary, 'utf8')
  // Only the fake binary's first `console.log` answers `--version`.
  const version = /console\.log\((['"])[^'"]*\1\)/
  assert.match(source, version)
  await writeFile(binary, source.replace(version, `console.log(${JSON.stringify(line)})`))
}

test('garde-fou : un opencode 3 est refusé avant le lancement, avec un code traduisible', async (t) => {
  const { binary, cwd } = await fixture(t)
  // 2.x response format (2.0.32, 2.4.1), assumed kept by the next major.
  await announce(binary, 'opencode v3.0.0')

  const { ctx } = context({ cwd, binary })
  const runner = new OpencodeRunner(ctx)
  await assert.rejects(runner.start(), (err: unknown) => {
    assert.ok(err instanceof OpencodeUnsupportedVersionError)
    assert.equal(err.code, 'opencode_unsupported_version')
    assert.equal(err.statusCode, 409)
    assert.deepEqual(err.params, { version: '3.0.0' })
    assert.match(err.message, /OpenCode 3\.0\.0 is not supported/)
    return true
  })
  // Rejected before `opencode serve`: fake servers wrote nothing.
  await assert.rejects(access(join(cwd, 'launch.json')))
})

test('garde-fou : 1.x et 2.x passent avec leur génération, et un binaire remplacé est relu', async (t) => {
  const { binary } = await fixture(t)
  await announce(binary, '1.19.3')
  await assertSupportedOpencode(binary)
  assert.equal(await opencodeGeneration(binary), 1)

  // Updates replace binaries in place: caches must not keep the old major's answer.
  await announce(binary, 'opencode v2.4.1')
  await assertSupportedOpencode(binary)
  assert.equal(await opencodeGeneration(binary), 2)
  await announce(binary, 'opencode v3.0.0')
  await assert.rejects(assertSupportedOpencode(binary), OpencodeUnsupportedVersionError)
})

test('garde-fou : une version illisible laisse passer et parle la 1.x', async (t) => {
  const { binary } = await fixture(t)
  await announce(binary, 'nightly')
  await assertSupportedOpencode(binary)
  assert.equal(await opencodeGeneration(binary), 1)
})
