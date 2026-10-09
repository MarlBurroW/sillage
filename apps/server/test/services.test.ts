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
import { foldProcesses, processIdentity, scanServiceProcesses, stopServiceProcess, type FoldableProcess } from '../src/services/processes.js'
import { isShellCommand, redactSecrets, summarizeCommand } from '../src/services/command-line.js'
import { executionLink, readProcessHost, type ProcessNode, type ProcessHost } from '../src/services/ownership.js'
import { authoredDescription, execStartArgv, executableName, originToken, parseShow, scanServiceApps } from '../src/services/apps.js'

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

test('ligne de commande : enrobage de Claude Code retiré, chemins réduits, secrets masqués, longueur bornée', () => {
  const home = '/home/alex'
  const wrapped = `source ${home}/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB 2>/dev/null || true && { \\builtin unalias -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'npm run dev -- --port 5173 && echo '"'"'ok'"'"'' && pwd -P >| /tmp/claude-1-cwd`
  assert.equal(summarizeCommand(['/usr/bin/zsh', '-c', wrapped], home), "npm run dev -- --port 5173 && echo 'ok'")
  assert.equal(summarizeCommand(['/usr/bin/zsh', '-c', `source x || true && eval 'node scripts/check.mjs 2>&1 | tail -6' < /dev/null && pwd -P >| /tmp/claude-1-cwd`], home), 'node scripts/check.mjs 2>&1 | tail -6', 'Variante de fond, avec entrée redirigée')
  assert.equal(summarizeCommand(['/bin/bash', '-lc', `cd ${home}/app && cargo run`], home), 'cd ~/app && cargo run')
  assert.equal(summarizeCommand([`${home}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome --type=renderer --headless`], home), 'chrome --type=renderer --headless', 'Titre réécrit : un seul argument, espaces compris')
  assert.equal(summarizeCommand([`${home}/.nvm/versions/node/v24.0.0/bin/node`, `${home}/.nvm/versions/node/v24.0.0/bin/npx`, 'vite', '--port', '5251'], home), 'node npx vite --port 5251')
  assert.equal(summarizeCommand([`${home}/.local/bin/claude`, '--resume=abc'], home), 'claude --resume=abc')
  assert.equal(summarizeCommand(['/usr/bin/python3', '-m', 'http.server', '8793'], home), 'python3 -m http.server 8793')
  assert.equal(summarizeCommand([]), null)
  assert.equal(summarizeCommand(['node', '-e', 'x'.repeat(400)])!.length, 160)
  assert.equal(isShellCommand(['/usr/bin/zsh', '-c', 'ls']), true)
  assert.equal(isShellCommand(['/usr/bin/zsh']), false)
  assert.equal(isShellCommand(['/usr/bin/node', '-c', 'ls']), false)
  assert.equal(redactSecrets('curl -H "Authorization: Bearer abc.def" https://user:pw@host/db --token=t1 API_KEY=k1 -d password=p1'),
    'curl -H "Authorization: Bearer …" https://user:…@host/db --token=… API_KEY=… -d password=…')
  assert.equal(redactSecrets('git log --oneline -5'), 'git log --oneline -5')
})

test('pliage : lanceurs, commandes avec leur descendance, outils MCP, orphelins', async (t) => {
  const dir = await directory(t)
  const origins = new ProcessOrigins(dir)
  const agent = origins.environment('project', 'conversation').SILLAGE_PROCESS_ORIGIN!
  const terminal = origins.environment('project', null).SILLAGE_PROCESS_ORIGIN!
  const make = (pid: number, parent: number, argv: string[], token = ''): FoldableProcess =>
    ({ pid, parent, name: argv[0]!, argv, environment: token ? `SILLAGE_PROCESS_ORIGIN=${token}\0` : '', cgroup: null, start: String(pid) })
  const nodes = new Map([
    make(100, 1, ['node', 'main.js']),
    make(110, 100, ['claude', '--resume'], agent),
    make(111, 110, ['node', '/srv/sillage-mcp.mjs'], agent),
    make(112, 110, ['zsh', '-c', 'npm run dev'], agent),
    make(113, 112, ['node', 'vite.js'], agent),
    make(114, 113, ['chrome'], agent), make(115, 113, ['chrome'], agent),
    make(120, 100, ['zsh'], terminal),
    make(121, 120, ['node', 'mcp-inspector.js'], terminal),
    make(130, 1, ['python3', '-m', 'http.server'], agent),
    make(131, 130, ['python3'], agent),
    make(140, 1, ['tmux']), make(141, 140, ['node'], agent),
  ].map((entry) => [entry.pid, entry]))
  const linked = new Set([110, 111, 112, 113, 114, 115, 120, 121, 130, 131])
  const folded = foldProcesses(nodes, linked, { pid: 100 }, origins)
  assert.deepEqual([...folded.keys()].sort((a, b) => a - b), [110, 111, 112, 120, 121, 130])
  assert.deepEqual(folded.get(110), { kind: 'launcher', launcherPid: null, members: [110] })
  assert.deepEqual(folded.get(111), { kind: 'helper', launcherPid: 110, members: [111] }, 'Sous un agent, un serveur MCP est un outil')
  assert.deepEqual(folded.get(112), { kind: 'command', launcherPid: 110, members: [112, 113, 114, 115] })
  assert.deepEqual(folded.get(121), { kind: 'command', launcherPid: 120, members: [121] }, 'Sous un terminal, tout est commande')
  assert.deepEqual(folded.get(130), { kind: 'detached', launcherPid: null, members: [130, 131] })
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
  assert.equal(service.kind, 'command')
  assert.equal(service.launcherPid, child.pid)
  assert.equal(service.processCount, 1)
  assert.match(service.command ?? '', /^node -e /)
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
  const launcher = snapshot.find((entry) => entry.pid === child.pid)!
  assert.equal(launcher.kind, 'launcher')
  assert.equal(stopServiceProcess(launcher, restored, host), false, 'Un lanceur se pilote depuis sa conversation')
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
  assert.equal(found.kind, 'command')
  assert.equal(found.canStop, true)
  const launcher = owned.find((entry) => entry.pid === tracked.child.pid)!
  assert.equal(launcher.kind, 'launcher')
  assert.equal(found.launcherPid, launcher.pid)
  assert.equal(launcher.canStop, false)
  assert.equal((await app.inject({ method: 'POST', url: `/api/services/${launcher.id}/stop`, headers: { 'x-test-user': 'owner' } })).statusCode, 409)
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

test('apps : lecture de systemctl show, jeton d’origine, exécutable sans arguments', () => {
  const [first, second] = parseShow('Id=sillage-app-a.service\nEnvironment=PATH=/bin SILLAGE_PROCESS_ORIGIN=124e227b-65ce-43d8-8be0-5030d10e4481\n\nId=sillage-app-b.service\nWorkingDirectory=!/home/x\n')
  assert.equal(first?.Id, 'sillage-app-a.service')
  assert.equal(originToken(first?.Environment ?? ''), '124e227b-65ce-43d8-8be0-5030d10e4481')
  assert.equal(originToken('PATH=/bin'), null)
  assert.equal(second?.WorkingDirectory, '!/home/x')
  assert.equal(executableName('{ path=/usr/bin/npm ; argv[]=/usr/bin/npm run dev --token=secret ; ignore_errors=no ; start_time=[n/a] }'), 'npm')
  assert.equal(executableName(''), null)
  assert.equal(summarizeCommand(execStartArgv('{ path=/usr/bin/npm ; argv[]=/usr/bin/npm run dev --token=secret ; ignore_errors=no ; start_time=[n/a] }')), 'npm run dev --token=…')
  assert.deepEqual(execStartArgv(''), [])
  assert.equal(authoredDescription('[systemd-run] /usr/bin/npm run dev --token=secret'), '', 'La description générée recopie les arguments')
  assert.equal(authoredDescription('Démo météo'), 'Démo météo')
})

test('apps : unité réelle, ports, origine, visibilité et arrêt par l’API', { skip: process.platform !== 'linux' }, async (t) => {
  const exec = promisify(execFile)
  try { await exec('systemctl', ['--user', 'show', '--property=Version']) }
  catch { t.skip('gestionnaire systemd utilisateur absent'); return }
  const dir = await directory(t)
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  for (const id of ['owner', 'other', 'admin']) db.insert(users).values({ id, username: id, displayName: id, passwordHash: '', isAdmin: id === 'admin', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'Private', workspacePath: dir, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  db.insert(conversations).values({ id: 'conversation', projectId: 'project', userId: 'owner', title: 'App source', agent: 'claude', config: '{}', status: 'idle', createdAt: 1, updatedAt: 1 }).run()
  const origins = processOrigins(dir)
  const token = origins.environment('project', 'conversation').SILLAGE_PROCESS_ORIGIN!
  const suffix = randomUUID().slice(0, 8)
  const tracked = `sillage-app-test-${suffix}.service`
  const orphan = `sillage-app-test-orphan-${suffix}.service`
  t.after(async () => {
    for (const unit of [tracked, orphan]) {
      await exec('systemctl', ['--user', 'stop', unit]).catch(() => {})
      await exec('systemctl', ['--user', 'reset-failed', unit]).catch(() => {})
    }
  })
  const listen = "require('node:net').createServer().listen(0, '127.0.0.1')"
  await exec('systemd-run', ['--user', '--collect', `--unit=${tracked}`, `--setenv=SILLAGE_PROCESS_ORIGIN=${token}`, `--working-directory=${dir}`, process.execPath, '-e', listen])
  await exec('systemd-run', ['--user', '--collect', `--unit=${orphan}`, process.execPath, '-e', 'setInterval(() => {}, 1000)'])

  // Le port n'est ouvert qu'une fois le processus lancé : quelques scans au plus.
  let app = (await scanServiceApps(origins)).find((entry) => entry.unit === tracked)
  for (let attempt = 0; attempt < 30 && !app?.ports.length; attempt++) {
    await delay(100)
    app = (await scanServiceApps(origins)).find((entry) => entry.unit === tracked)
  }
  assert.ok(app)
  assert.equal(app.state, 'active')
  assert.equal(app.ports.length, 1)
  assert.deepEqual(app.origin, { projectId: 'project', conversationId: 'conversation' })
  assert.equal(app.cwd, dir)
  assert.equal(app.transient, true)
  assert.equal(app.executable, 'node')
  assert.match(app.command ?? '', /^node -e /)
  assert.equal(app.description, '', 'Aucun argument ne sort par la description de systemd-run')
  assert.ok(app.startedAt && Math.abs(Date.now() - app.startedAt) < 10_000)
  assert.ok((app.memoryBytes ?? 0) > 0)

  const server = Fastify()
  server.addHook('preHandler', async (request) => {
    request.user = db.select().from(users).where(eq(users.id, String(request.headers['x-test-user']))).get()
  })
  registerErrorHandler(server)
  registerServiceRoutes(server, { db, config: { paths: { data: dir } } as Config })
  t.after(() => server.close())
  const apps = async (user: string) => {
    const response = await server.inject({ url: '/api/services', headers: { 'x-test-user': user } })
    assert.equal(response.statusCode, 200)
    return response.json<ServicesDto>().apps.filter((entry) => entry.unit.endsWith(`${suffix}.service`))
  }
  const act = (user: string, id: string, action: string) =>
    server.inject({ method: 'POST', url: `/api/services/apps/${encodeURIComponent(id)}/${action}`, headers: { 'x-test-user': user } })

  const owned = await apps('owner')
  assert.deepEqual(owned.map((entry) => entry.unit), [tracked], 'Le propriétaire voit son app, pas celle d’origine inconnue')
  assert.equal(owned[0]!.conversationTitle, 'App source')
  assert.equal(owned[0]!.canStop, true)
  assert.deepEqual(await apps('other'), [], 'Un projet privé ne se montre pas aux autres')
  const adminView = await apps('admin')
  assert.deepEqual(adminView.map((entry) => entry.unit), [orphan], 'L’admin ne voit pas le projet privé d’un autre')
  assert.equal(adminView[0]!.canStop, true, 'Sans origine, l’admin garde la main sur une sillage-app')

  assert.equal((await act('other', owned[0]!.id, 'stop')).statusCode, 404)
  assert.equal((await act('owner', owned[0]!.id, 'explode')).statusCode, 404)
  assert.equal((await act('owner', owned[0]!.id, 'reset')).statusCode, 409, 'Rien à retirer sur une app en marche')
  // Relancée, l'app change d'invocation : un clic sur l'ancienne liste ne la vise plus.
  assert.equal((await act('owner', owned[0]!.id, 'restart')).statusCode, 202)
  let restarted = (await apps('owner'))[0]
  for (let attempt = 0; attempt < 50 && restarted?.id === owned[0]!.id; attempt++) {
    await delay(100)
    restarted = (await apps('owner'))[0]
  }
  assert.ok(restarted && restarted.id !== owned[0]!.id)
  assert.equal((await act('owner', owned[0]!.id, 'stop')).statusCode, 404)
  assert.equal((await act('owner', restarted.id, 'stop')).statusCode, 202)
  assert.equal((await act('admin', adminView[0]!.id, 'stop')).statusCode, 202)
  // `--no-block` : l'arrêt suit la réponse ; une unité transitoire arrêtée disparaît.
  for (let attempt = 0; attempt < 50 && (await apps('admin')).length + (await apps('owner')).length > 0; attempt++) await delay(100)
  assert.deepEqual([...await apps('owner'), ...await apps('admin')], [])
  assert.equal((await act('owner', restarted.id, 'stop')).statusCode, 404)
})

