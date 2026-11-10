import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { Config } from '../src/config.js'
import { TerminalManager } from '../src/terminals/terminal-manager.js'

// POSIX command: Windows gets this through the desktop launch check, which times the stop
// of the packaged server with a terminal open.
test('l’arrêt ne rend la main qu’une fois les shells terminés', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-terminal-shutdown-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const config = { paths: { data: join(dir, 'data') }, limits: { ptyIdleTimeoutMin: 5 } } as unknown as Config
  const terminals = new TerminalManager(config)

  const pidFile = join(dir, 'pid')
  terminals.open('project', dir, { command: `echo $$ > '${pidFile}'; exec sleep 30`, title: 'sleep', actionId: null })
  for (let attempt = 0; attempt < 100 && !(existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim()); attempt++) await delay(50)
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  assert.ok(Number.isInteger(pid) && pid > 0, 'the command did not start')
  process.kill(pid, 0)

  await terminals.shutdown()
  // The server exits right after: on Windows, exiting before this point hangs the exit.
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the shell outlived the shutdown')
})
