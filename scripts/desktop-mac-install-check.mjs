import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Exercise rollback using real directories and injected mv failures, without macOS
// or a running app. Never discard the only surviving copy after a failed restore.
const source = await readFile(new URL('../apps/desktop/src/mac-updater.ts', import.meta.url), 'utf8')
const script = /const INSTALL_SCRIPT = `([\s\S]*?)`/.exec(source)?.[1]
assert.ok(script)
const scratch = await mkdtemp(join(tmpdir(), 'sillage-mac-install-check-'))
try {
  const installer = join(scratch, 'install.sh')
  await writeFile(installer, script)
  const check = spawnSync('shellcheck', [installer], { encoding: 'utf8' })
  assert.equal(check.status, 0, check.stdout + check.stderr)
  const bin = join(scratch, 'bin')
  await mkdir(bin)
  const mv = `#!/bin/sh
count=0
if [ -f "$TEST_MOVES" ]; then count=$(cat "$TEST_MOVES"); fi
count=$((count + 1))
printf '%s' "$count" > "$TEST_MOVES"
case ",$TEST_FAIL," in *,$count,*) echo 'Injected rename failure' >&2; exit 1 ;; esac
exec /bin/mv "$@"
`
  await writeFile(join(bin, 'mv'), mv, { mode: 0o755 })
  assert.equal(spawnSync('shellcheck', [join(bin, 'mv')]).status, 0)
  const deadPid = spawnSync('/bin/true').pid
  for (const scenario of ['success', 'backup-fails', 'install-fails', 'restore-fails', 'existing-backup']) {
    const dir = join(scratch, scenario)
    const app = join(dir, 'Sillage.app')
    const staged = join(dir, 'staged.app')
    await mkdir(app, { recursive: true })
    await mkdir(staged)
    await writeFile(join(app, 'version'), 'old')
    await writeFile(join(staged, 'version'), 'new')
    if (scenario === 'existing-backup') {
      await mkdir(`${app}.previous`)
      await writeFile(join(`${app}.previous`, 'version'), 'previous')
    }
    const result = join(dir, 'result')
    const run = spawnSync('/bin/sh', [installer, String(deadPid), app, staged, '0', result], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_MOVES: join(dir, 'moves'),
        TEST_FAIL: { 'backup-fails': '1', 'install-fails': '2', 'restore-fails': '2,3' }[scenario] ?? '' },
      encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stderr)
    const verdict = (await readFile(result, 'utf8')).trim()
    if (scenario === 'success') {
      assert.equal(verdict, 'ok')
      assert.equal(await readFile(join(app, 'version'), 'utf8'), 'new')
      assert.equal(existsSync(`${app}.previous`), false)
    } else if (scenario === 'restore-fails') {
      assert.match(verdict, /restore failed/)
      assert.equal(await readFile(join(`${app}.previous`, 'version'), 'utf8'), 'old')
    } else {
      assert.notEqual(verdict, 'ok')
      assert.equal(await readFile(join(app, 'version'), 'utf8'), 'old')
      if (scenario === 'existing-backup') assert.equal(await readFile(join(`${app}.previous`, 'version'), 'utf8'), 'previous')
    }
    console.log(`${scenario}: passed`)
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}
