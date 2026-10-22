import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CliBinary } from '../src/agents/cli-binary.js'

/** CLIs installed while presence probes are cached must appear immediately after invalidation. Interface installation does this; otherwise 'Install' remained offered for a minute after success. */
test("un CLI installé après la sonde apparaît dès que la sonde est invalidée", async () => {
  const managed = mkdtempSync(join(tmpdir(), 'sillage-cli-'))
  const cli = new CliBinary('codex', 'sillage-test-absent-cli', true, managed)

  assert.equal((await cli.status()).found, false)

  mkdirSync(join(managed, 'bin'))
  const path = join(managed, 'bin', 'sillage-test-absent-cli')
  writeFileSync(path, '#!/bin/sh\necho codex-cli 9.9.9\n')
  chmodSync(path, 0o755)

  // Still cached: probes do not reread disk by themselves.
  assert.equal((await cli.status()).found, false)

  cli.invalidate()
  const after = await cli.describe()
  assert.equal(after.installed, true)
  assert.equal(after.managed, true)
  assert.equal(after.version, '9.9.9')
})
