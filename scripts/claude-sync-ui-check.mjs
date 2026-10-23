import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { conversations, openDatabase, projects, runMigrations, users } from '../packages/db/src/index.ts'
import { DEFAULT_CLAUDE_CONFIG } from '../packages/protocol/src/agent-config.ts'
import { createSession } from '../apps/server/src/auth/sessions.ts'
import { EventLog } from '../apps/server/src/events/event-log.ts'
import { transcriptPath, translateTranscript } from '../apps/server/src/agents/claude/transcript.ts'

// Production builds and synthetic external CLI writes; never start an actual CLI.
const root = fileURLToPath(new URL('../', import.meta.url))
const scratch = await mkdtemp(join(tmpdir(), 'sillage-claude-sync-ui-'))
const browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
try {
  for (const profile of ['server', 'desktop']) {
    const data = join(scratch, profile)
    await mkdir(data)
    process.env.CLAUDE_CONFIG_DIR = join(data, 'claude')
    const { db, sqlite } = openDatabase(join(data, 'sillage.db'))
    runMigrations(db, join(root, 'packages/db/migrations'))
    db.insert(users).values({ id: 'u', username: 'u', displayName: 'Audit', passwordHash: '', isAdmin: true, createdAt: 1 }).run()
    db.insert(projects).values({ id: 'p', name: 'Sync audit', workspacePath: data, ownerId: 'u', visibility: 'private', createdAt: 1 }).run()
    db.insert(conversations).values({ id: 'c', projectId: 'p', userId: 'u', title: 'External CLI history', agent: 'claude', agentSessionId: 'native', config: JSON.stringify(DEFAULT_CLAUDE_CONFIG), status: 'idle', createdAt: 1, updatedAt: 1 }).run()
    const initial = { type: 'user', uuid: 'initial', timestamp: new Date(1000).toISOString(), message: { content: 'Initial message' } }
    new EventLog(db).appendBatch('c', translateTranscript([initial], data).events, 'claude-transcript@1')
    const transcript = transcriptPath(data, 'native')
    await mkdir(dirname(transcript), { recursive: true })
    await writeFile(transcript, JSON.stringify(initial) + '\n')
    const session = await createSession(db, 'u', 'ui-check')
    const config = join(data, 'config.toml')
    await writeFile(config, ['claude', 'codex', 'opencode', 'grok'].map((agent) => `[agents.${agent}]\nenabled = false\n`).join('\n'))
    const socket = createServer().listen(0, '127.0.0.1')
    await once(socket, 'listening')
    const port = socket.address().port
    await new Promise((resolve) => socket.close(resolve))
    const server = spawn(process.execPath, [join(root, 'apps/server/dist/main.js')], {
      cwd: join(root, 'apps/server'),
      env: { ...process.env, NODE_ENV: 'production', SILLAGE_PROFILE: profile, SILLAGE_HANDSHAKE_FD: '3', SILLAGE_DATA_DIR: data, SILLAGE_CONFIG: config, SILLAGE_PORT: String(port), SILLAGE_HOST: '127.0.0.1', SILLAGE_WEB_ROOT: join(root, 'apps/web/dist') },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    })
    let diagnostic = '', handshake = ''
    for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-4000) })
    server.stdio[3].on('data', (chunk) => { handshake += chunk })
    const base = `http://127.0.0.1:${port}`
    try {
      let ready = false
      for (let i = 0; i < 150; i++) {
        if (server.exitCode !== null) throw new Error(diagnostic)
        if (await fetch(`${base}/api/health`).then((response) => response.ok).catch(() => false)) { ready = true; break }
        await delay(100)
      }
      assert.ok(ready, diagnostic)
      assert.equal((await fetch(`${base}/api/system/instance`).then((response) => response.json())).profile, profile)
      const token = profile === 'desktop' ? JSON.parse(handshake.trim()).session : session.token
      for (const width of [1440, 390]) {
        const content = `External response ${profile} ${width}`
        const entry = { type: 'assistant', uuid: `${profile}-${width}`, timestamp: new Date().toISOString(), message: { id: `${profile}-${width}`, content: [{ type: 'text', text: content }] } }
        await appendFile(transcript, JSON.stringify(entry) + '\n')
        const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
        await context.addCookies([{ name: 'sillage_session', value: token, url: base }])
        await context.addInitScript(() => localStorage.setItem('sillage.locale', 'en'))
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', (error) => errors.push(error.message))
        await page.goto(`${base}/p/p/c/c`)
        await page.locator('.sg-conversation-width.opacity-100').waitFor()
        await page.getByText(content, { exact: true }).waitFor()
        const before = db.select().from(conversations).get().lastSeq
        const repeated = await context.request.post(`${base}/api/conversations/c/claude-sync`)
        assert.equal(repeated.status(), 200)
        assert.deepEqual(await repeated.json(), { imported: 0 })
        await page.reload()
        await page.getByText(content, { exact: true }).waitFor()
        assert.equal(db.select().from(conversations).get().lastSeq, before)
        assert.deepEqual(errors, [])
        await context.close()
        console.log(`OK: external Claude sync, stable reload and checkpoint (${profile}, ${width}px).`)
      }
    } finally {
      if (profile === 'desktop') server.stdin.end()
      else server.kill('SIGTERM')
      if (server.exitCode === null) await Promise.race([once(server, 'exit'), delay(10000).then(() => { if (server.exitCode === null) server.kill('SIGKILL') })])
      sqlite.close()
    }
  }
} finally {
  await browser.close()
  await rm(scratch, { recursive: true, force: true })
}
