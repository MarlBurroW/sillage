import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { InstanceLockError, acquireInstanceLock } from '../src/instance/lock.js'

/** One server per database: a second one must stop before touching it, and a crash must not leave the database locked. */

async function databasePath(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-instance-lock-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return join(dir, 'data', 'sillage.db')
}

/** Another process holding the lock, as a second daemon would. */
async function holder(t: TestContext, database: string, holdMs: number) {
  const lockModule = fileURLToPath(new URL('../src/instance/lock.ts', import.meta.url))
  const script = `const { acquireInstanceLock } = await import(${JSON.stringify(lockModule)});
    await acquireInstanceLock(${JSON.stringify(database)}, { role: 'daemon', version: 'other', waitMs: 0 });
    console.log('locked');
    setTimeout(() => process.exit(0), ${holdMs});`
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  let out = ''
  child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
  for (let i = 0; i < 400 && !out.includes('locked'); i++) await new Promise((resolve) => setTimeout(resolve, 25))
  assert.match(out, /locked/)
  return child
}

test('a second holder is refused with who holds the database, and gets it once released', async (t) => {
  const database = await databasePath(t)
  const first = await acquireInstanceLock(database, { role: 'daemon', version: '1.0.0', waitMs: 0 })
  await assert.rejects(acquireInstanceLock(database, { role: 'migrate', version: '1.0.0', waitMs: 0 }), (err: unknown) => {
    assert.ok(err instanceof InstanceLockError)
    assert.equal(err.holder?.pid, process.pid)
    assert.match(err.message, /Another Sillage server already uses this database/)
    return true
  })
  first.release()
  const second = await acquireInstanceLock(database, { role: 'daemon', version: '1.0.0', waitMs: 0 })
  second.release()
})

test('the lock holds across processes and the system frees it when its holder is killed', async (t) => {
  const database = await databasePath(t)
  const child = await holder(t, database, 60_000)
  await assert.rejects(acquireInstanceLock(database, { role: 'daemon', version: '1.0.0', waitMs: 0 }), InstanceLockError)

  // A crash cannot leave the database locked: no stale file to clean by hand.
  child.kill('SIGKILL')
  await once(child, 'exit')
  const lock = await acquireInstanceLock(database, { role: 'daemon', version: '1.0.0', waitMs: 2000 })
  lock.release()
})

test('a restart waits for the previous server to finish shutting down', async (t) => {
  const database = await databasePath(t)
  await holder(t, database, 600)
  const started = Date.now()
  const lock = await acquireInstanceLock(database, { role: 'daemon', version: '1.0.0', waitMs: 10_000 })
  assert.ok(Date.now() - started >= 300, 'it waited for the holder to exit')
  lock.release()
})
