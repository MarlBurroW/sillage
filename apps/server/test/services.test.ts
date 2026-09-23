import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { openDatabase, runMigrations, users, projects, conversations, worktrees } from '@sillage/db'
import type { ServiceDto, ServicesDto } from '@sillage/protocol'
import type { Config } from '../src/config.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerServiceRoutes } from '../src/http/routes/services.js'
import { ProcessOrigins, processOrigins } from '../src/services/origins.js'
import { processIdentity, scanServiceProcesses, stopServiceProcess } from '../src/services/processes.js'
import { executionLink, readProcessHost, type ProcessNode, type ProcessHost } from '../src/services/ownership.js'

async function directory(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-services-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function server(t: TestContext, cwd: string, environment: Record<string, string> = {}, options: { orphan?: boolean; noPort?: boolean; clearEnv?: boolean } = {}) {
  const program = options.noPort
    ? "setInterval(() => {}, 1000); process.send({ port: null })"
    : "const net = require('node:net'); const server = net.createServer(); server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }))"
  // Un porteur comme le CLI, puis sa commande : les deux ont des rôles distincts.
  const child = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const worker = spawn(process.execPath, ['-e', ${JSON.stringify(program)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: ${options.clearEnv ? '{}' : 'process.env'} });
    worker.on('message', (message) => {
      process.send({ ...message, pid: worker.pid }, () => {
        if (${!!options.orphan}) { worker.disconnect(); worker.unref(); process.exit(0); }
      });
    });
    worker.on('exit', (_, signal) => { process.send({ signal }, () => process.exit(0)); });
    process.on('SIGTERM', () => worker.kill());
  `], { cwd, env: { PATH: process.env.PATH, ...environment }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const exited = once(child, 'exit')
  const [message] = await once(child, 'message') as [{ port: number | null; pid: number }]
  const identity = processIdentity(await readFile(`/proc/${message.pid}/stat`, 'utf8'))
  t.after(async () => {
    try {
      const current = processIdentity(await readFile(`/proc/${message.pid}/stat`, 'utf8'))
      if (identity.start === current.start) process.kill(message.pid, 'SIGTERM')
    } catch { /* Déjà arrêté par le test. */ }
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
  })
  if (options.orphan) await exited
  return { child, pid: message.pid, port: message.port, exited }
}

test('identité /proc : noms avec espaces et parenthèses', () => {
  const fields = ['S', '42', ...Array.from({ length: 17 }, () => '0'), '123456']
  assert.deepEqual(processIdentity(`55 (a ) tricky name) ${fields.join(' ')}`), { parent: 42, start: '123456' })
})

test('parenté et cgroups : tmux exclu, orphelin pris en charge, autres unités autonomes', () => {
  const group = '/user.slice/user@1001.service/app.slice/sillage.service'
  const host: ProcessHost = { pid: 100, cgroup: group, stopsWithService: true }
  const make = (pid: number, parent: number, name = 'node', cgroup = group): ProcessNode => ({ pid, parent, name, cgroup, start: String(pid) })
  const nodes = new Map([
    make(100, 1), make(110, 100, 'codex'), make(120, 110),
    make(130, 110, 'tmux'), make(140, 130, 'zsh'), make(150, 140),
    make(160, 1), make(170, 1, 'node', '/user.slice/independent.service'),
    make(180, 110, 'node', '/user.slice/independent.service'),
  ].map((entry) => [entry.pid, entry]))
  assert.equal(executionLink(100, nodes, host), null)
  assert.equal(executionLink(120, nodes, host), 'descendant')
  for (const pid of [130, 140, 150, 170, 180]) assert.equal(executionLink(pid, nodes, host), null)
  assert.equal(executionLink(160, nodes, host), 'service-group')
  assert.equal(executionLink(160, nodes, { ...host, stopsWithService: false }), null)
  assert.equal(executionLink(160, nodes, { ...host, cgroup: null, stopsWithService: false }), null)
  nodes.set(50, make(50, 1, 'systemd', '/user.slice/user@1001.service/init.scope'))
  nodes.set(160, make(160, 50))
  assert.equal(executionLink(160, nodes, host), 'service-group', 'Un subreaper systemd ne change pas le cgroup du processus orphelin')
})

test('parenté réelle, commandes sans port, origine héritée et refus des processus autonomes', { skip: process.platform !== 'linux' }, async (t) => {
  const dir = await directory(t)
  const origins = new ProcessOrigins(dir)
  const environment = origins.environment('project', 'conversation')
  const worker = await server(t, dir, environment)
  const { child, pid, port } = worker
  const noPort = await server(t, dir, environment, { noPort: true, clearEnv: true })
  const independent = await server(t, dir, environment, { orphan: true })
  const host = await readProcessHost()
  const restored = new ProcessOrigins(dir)
  const service = (await scanServiceProcesses(restored)).find((entry) => entry.pid === pid)!
  assert.ok(service)
  assert.deepEqual(service.ports, [port])
  assert.deepEqual(service.origin, { projectId: 'project', conversationId: 'conversation' })
  assert.ok(service.memoryBytes > 0)
  assert.ok(Math.abs(Date.now() - service.startedAt) < 10_000)
  assert.equal(stopServiceProcess({ ...service, id: `${service.id}0` }, restored, host), false)
  assert.equal(stopServiceProcess({ ...service, origin: null }, restored, host), false)
  assert.equal(stopServiceProcess({ ...service, pid: process.pid }, restored, host), false)
  const snapshot = await scanServiceProcesses(restored)
  assert.deepEqual(snapshot.find((entry) => entry.pid === noPort.pid)?.ports, [])
  assert.deepEqual(snapshot.find((entry) => entry.pid === noPort.pid)?.origin, service.origin, 'L’origine peut remonter au parent quand une commande nettoie son environnement')
  assert.equal(snapshot.some((entry) => entry.pid === independent.pid), false)
  assert.equal(service.parentPid, child.pid)
  const signal = once(child, 'message')
  assert.equal(stopServiceProcess(service, restored, host), true)
  assert.deepEqual((await signal)[0], { signal: 'SIGTERM' })
  await worker.exited
  assert.equal((await scanServiceProcesses(restored)).some((entry) => entry.pid === pid), false)
})

test('un vrai serveur tmux ne suffit pas à rattacher ses tâches, même avec le marqueur Sillage', { skip: process.platform !== 'linux' }, async (t) => {
  const exec = promisify(execFile)
  try { await exec('tmux', ['-V']) } catch { t.skip('tmux absent'); return }
  const dir = await mkdtemp(join(tmpdir(), 'sillage-services-'))
  const origins = new ProcessOrigins(dir)
  const socket = join(dir, 'tmux.sock')
  const pidFile = join(dir, 'worker.pid')
  const script = join(dir, 'worker.cjs')
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`)
  t.after(async () => {
    // Conserver le socket jusqu'à kill-server : les hooks after tournent dans
    // l'ordre d'enregistrement, pas en pile comme les destructeurs.
    await exec('tmux', ['-S', socket, 'kill-server']).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  })
  await exec('tmux', ['-S', socket, '-f', '/dev/null', 'new-session', '-d', process.execPath, script], {
    cwd: dir, env: { PATH: process.env.PATH, ...origins.environment('project', 'conversation') },
  })
  let pid = 0
  for (let attempt = 0; attempt < 50 && !pid; attempt++) {
    pid = Number(await readFile(pidFile, 'utf8').catch(() => ''))
    if (!pid) await delay(20)
  }
  assert.ok(pid)
  assert.ok(origins.resolve(await readFile(`/proc/${pid}/environ`, 'utf8')))
  assert.equal((await scanServiceProcesses(origins)).some((entry) => entry.pid === pid), false)
})

test('orphelin réel : cgroup systemd et arrêt malgré un subreaper non dumpable', { skip: process.platform !== 'linux' }, async (t) => {
  const exec = promisify(execFile)
  try { await exec('systemctl', ['--user', 'show', '--property=Version']) }
  catch { t.skip('gestionnaire systemd utilisateur absent'); return }
  const unit = `sillage-process-test-${randomUUID()}`
  t.after(async () => { await exec('systemctl', ['--user', 'stop', unit]).catch(() => {}) })
  const result = await exec('systemd-run', [
    '--user', '--wait', '--pipe', '--collect', `--unit=${unit}`,
    `--property=WorkingDirectory=${fileURLToPath(new URL('../', import.meta.url))}`,
    '--property=KillMode=control-group', process.execPath, '--import', 'tsx',
    fileURLToPath(new URL('./fixtures/services-orphan.mts', import.meta.url)),
  ], { timeout: 15000 })
  assert.match(result.stdout, /OK : orphelin réel/)
})

test('API : aucune attribution par dossier, visibilité privée, arrêt autorisé et disparu', { skip: process.platform !== 'linux' }, async (t) => {
  const dir = await directory(t)
  const workspace = join(dir, 'workspace')
  const worktree = join(dir, 'worktree')
  const nearWorkspace = `${workspace}-other`
  await Promise.all([workspace, worktree, nearWorkspace].map((entry) => mkdir(entry)))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  for (const id of ['owner', 'other', 'admin']) db.insert(users).values({ id, username: id, displayName: id, passwordHash: '', isAdmin: id === 'admin', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'Private', workspacePath: workspace, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  db.insert(worktrees).values({ id: 'worktree', projectId: 'project', name: 'Branch', path: worktree, baseRef: 'main', createdBy: 'owner', createdAt: 1 }).run()
  db.insert(conversations).values({ id: 'conversation', projectId: 'project', userId: 'owner', title: 'Service source', agent: 'codex', config: '{}', status: 'idle', createdAt: 1, updatedAt: 1 }).run()
  const origins = processOrigins(dir)
  const tracked = await server(t, workspace, origins.environment('project', 'conversation'))
  const old = await server(t, worktree)
  const unrelated = await server(t, workspace, origins.environment('project', 'conversation'), { orphan: true })
  const app = Fastify()
  app.addHook('preHandler', async (request) => {
    request.user = db.select().from(users).where(eq(users.id, String(request.headers['x-test-user']))).get()
  })
  registerErrorHandler(app)
  registerServiceRoutes(app, { db, config: { paths: { data: dir } } as Config })
  t.after(() => app.close())
  const list = async (user: string): Promise<ServiceDto[]> => {
    const response = await app.inject({ url: '/api/services', headers: { 'x-test-user': user } })
    assert.equal(response.statusCode, 200)
    return response.json<ServicesDto>().services
  }
  assert.equal((await app.inject('/api/services')).statusCode, 401)
  const owned = await list('owner')
  const found = owned.find((entry) => entry.pid === tracked.pid)!
  assert.equal(owned.some((entry) => entry.pid === old.pid), false)
  const unassigned = (await list('admin')).find((entry) => entry.pid === old.pid)!
  assert.equal(unassigned.projectId, null)
  assert.equal(unassigned.canStop, false)
  assert.equal(found.conversationTitle, 'Service source')
  assert.equal(found.canStop, true)
  assert.equal(owned.some((entry) => entry.pid === unrelated.pid), false)
  for (const user of ['other', 'admin']) {
    assert.equal((await list(user)).some((entry) => entry.pid === tracked.pid), false)
    assert.equal((await app.inject({ method: 'POST', url: `/api/services/${found.id}/stop`, headers: { 'x-test-user': user } })).statusCode, 404)
  }
  assert.equal((await app.inject({ method: 'POST', url: `/api/services/${unassigned.id}/stop`, headers: { 'x-test-user': 'admin' } })).statusCode, 409)
  db.update(projects).set({ visibility: 'shared' }).where(eq(projects.id, 'project')).run()
  assert.equal((await list('other')).some((entry) => entry.pid === tracked.pid), true)
  const exited = once(tracked.child, 'exit')
  assert.equal((await app.inject({ method: 'POST', url: `/api/services/${found.id}/stop`, headers: { 'x-test-user': 'other' } })).statusCode, 202)
  await exited
  assert.equal((await app.inject({ method: 'POST', url: `/api/services/${found.id}/stop`, headers: { 'x-test-user': 'owner' } })).statusCode, 404)
})
