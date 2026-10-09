import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { ProcessOrigins } from '../../src/services/origins.ts'
import { readProcessHost } from '../../src/services/ownership.ts'
import { scanServiceProcesses, stopServiceProcess } from '../../src/services/processes.ts'
const host = await readProcessHost()
assert.equal(host.stopsWithService, true)
const data = await mkdtemp(join(tmpdir(), 'sillage-group-check-'))
try {
  const origins = new ProcessOrigins(data)
  const child = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    process.send({ pid: worker.pid }, () => { worker.unref(); process.exit(0) });
  `], { env: { ...process.env, ...origins.environment('test', 'test') }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const exited = once(child, 'exit')
  const [{ pid }] = await once(child, 'message')
  await exited
  const service = (await scanServiceProcesses(origins)).find((entry) => entry.pid === pid)
  assert.ok(service)
  assert.equal(service.kind, 'detached')
  assert.equal(service.stopsWithSillage, true)
  assert.equal(stopServiceProcess(service, origins, host), true)
  await delay(100)
  assert.equal((await scanServiceProcesses(origins)).some((entry) => entry.pid === pid), false)
  console.log('OK : orphelin réel rattaché au service systemd, dépendance et arrêt vérifiés.')
} finally { await rm(data, { recursive: true, force: true }) }
