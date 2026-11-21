import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/** The release's pinned versions come from pnpm-lock.yaml, as checked out on every runner. */
const root = fileURLToPath(new URL('../../../', import.meta.url))
const script = new URL('../../../scripts/runtime-package.mjs', import.meta.url).href
const { lockedServerVersions } = (await import(script)) as { lockedServerVersions(root: string): Record<string, string> }

test('server versions read from the lockfile are the same with Windows line endings', async (t) => {
  const locked = lockedServerVersions(root)
  assert.ok(Object.keys(locked).length > 10)
  assert.match(locked.fastify ?? '', /^\d+\.\d+\.\d+$/)
  // Git checks the lockfile out with CRLF on the Windows runner, which once stopped the Desktop build.
  const dir = await mkdtemp(join(tmpdir(), 'sillage-runtime-lock-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const lock = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8')
  await writeFile(join(dir, 'pnpm-lock.yaml'), lock.replace(/\r?\n/g, '\r\n'))
  assert.deepEqual(lockedServerVersions(dir), locked)
})
