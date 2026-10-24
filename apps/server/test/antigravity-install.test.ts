import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zipSync, strToU8 } from 'fflate'
import { ANTIGRAVITY_DISTRIBUTION } from '../src/agents/antigravity/distribution.js'
import { installAntigravity } from '../src/agents/antigravity/install.js'

test('Native installation verifies checksums, rejects traversal and keeps the previous release on failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sillage-google-install-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const key = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'x64' ? 'x86_64' : 'aarch64'}` as keyof typeof ANTIGRAVITY_DISTRIBUTION
  const release = ANTIGRAVITY_DISTRIBUTION[key]
  const originalHash = release.sha256
  t.after(() => Object.assign(release, { sha256: originalHash }))
  let archive = zipSync({ 'agy_acp_server.par': strToU8('executable'), 'localharness_external': strToU8('companion') })
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(archive)))
  await assert.rejects(installAntigravity(root, '1.4.3', () => {}), /checksum/)
  Object.assign(release, { sha256: createHash('sha256').update(archive).digest('hex') })
  await installAntigravity(root, '1.4.3', () => {})
  assert.equal(await readFile(join(root, 'antigravity/1.4.3/localharness_external'), 'utf8'), 'companion')
  archive = zipSync({ '../escape': strToU8('bad') })
  Object.assign(release, { sha256: createHash('sha256').update(archive).digest('hex') })
  await assert.rejects(installAntigravity(root, '1.4.3', () => {}), /Unsafe archive/)
  assert.equal(await readFile(join(root, 'antigravity/1.4.3/agy_acp_server.par'), 'utf8'), 'executable')
  assert.deepEqual(await readdir(join(root, 'antigravity')), ['1.4.3'])
})
