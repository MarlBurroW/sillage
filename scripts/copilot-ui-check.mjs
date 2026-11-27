import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// GitHub Copilot journeys on both editions, against the fixture agent: defaults, adoption of a
// native session, a scripted conversation (tools, sub-agent, question, permission, schedules,
// compaction), fork, transfers both ways, the consumption color and the phone layout.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-ui-check-'))
const processes = []
let browser

async function freePort() {
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return port
}

function run(args, cwd, env, stdio = 'pipe') {
  const child = spawn(process.execPath, args, { cwd, env, stdio })
  processes.push(child)
  child.diagnostics = ''
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => { child.diagnostics = (child.diagnostics + chunk).slice(-6000) })
  }
  return child
}

async function ready(url, child) {
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(child.diagnostics)
    if (await fetch(url).then((response) => response.ok).catch(() => false)) return
    await delay(100)
  }
  throw new Error(`Server did not start: ${child.diagnostics}`)
}

const fixture = (scenario) => 'fixture:' + JSON.stringify(scenario)
const chunk = (text, messageId, agentId) => ({ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, ...(messageId ? { messageId } : {}), ...(agentId ? { _meta: { 'github.com/copilot': { agentId } } } : {}) } })
const announce = (...requests) => ({ event: { type: 'assistant.message', data: { content: '', toolRequests: requests } } })
const PERMISSION_OPTIONS = [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' }, { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' }]
const CHILD = { 'github.com/copilot': { agentId: 'agent-1' } }
const FLAVOR = { type: 'object', properties: { flavor: { type: 'string', title: 'Flavor', enum: ['vanilla', 'mint'], enumNames: ['Vanilla', 'Fresh mint'] } } }

// The wire shapes of a real turn: a thought, a read, a sub-agent with its own read, a failing
// command, a to-do list, then the reply. Copilot's own "Info:" line must not show as a reply.
const WORK = [
  { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Looking at the note' }, messageId: 'think-1' } },
  announce({ toolCallId: 'read', name: 'view', arguments: {} }),
  { update: { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Viewing note.txt', kind: 'read', status: 'pending', rawInput: { path: 'note.txt' } } },
  { update: { sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed', rawOutput: { content: 'hello\n' } } },
  announce({ toolCallId: 'task', name: 'task', arguments: {} }),
  { update: { sessionUpdate: 'tool_call', toolCallId: 'task', title: 'Scout the notes', kind: 'other', status: 'pending', rawInput: { name: 'scout', description: 'Scout the notes', agent_type: 'explore', mode: 'sync', prompt: 'Read them.' } } },
  { event: { type: 'assistant.turn_start', data: { turnId: '0', parentToolCallId: 'task' } }, agentId: 'agent-1' },
  { update: { sessionUpdate: 'tool_call', toolCallId: 'child-read', title: 'Viewing other.txt', kind: 'read', status: 'pending', rawInput: { path: 'other.txt' }, _meta: CHILD } },
  { update: { sessionUpdate: 'tool_call_update', toolCallId: 'child-read', status: 'completed', rawOutput: { content: 'other\n' }, _meta: CHILD } },
  chunk('Scout report from the sub-agent.', 'sub-1', 'agent-1'),
  { update: { sessionUpdate: 'tool_call_update', toolCallId: 'task', status: 'completed', rawOutput: { content: 'Scout report from the sub-agent.' } } },
  announce({ toolCallId: 'fail', name: 'bash', arguments: {} }),
  { update: { sessionUpdate: 'tool_call', toolCallId: 'fail', title: 'npm test', kind: 'execute', status: 'pending', rawInput: { command: 'npm test', description: 'Run the failing tests' } } },
  { update: { sessionUpdate: 'tool_call_update', toolCallId: 'fail', status: 'completed', rawOutput: { content: 'boom\n<shellId: 0 completed with exit code 1>', contents: [{ type: 'shell_exit', shellId: '0', exitCode: 1 }] } } },
  { update: { sessionUpdate: 'plan', entries: [{ content: 'Read the notes', priority: 'medium', status: 'completed' }, { content: 'Fix the tests', priority: 'medium', status: 'in_progress' }] } },
  { event: { type: 'session.info', data: { infoType: 'file_created', message: '/tmp/never-shown.txt' } } },
  chunk('Info: /tmp/never-shown.txt'),
  { update: { sessionUpdate: 'usage_update', used: 15000, size: 128000 } },
  chunk('Native Copilot response', 'reply-1'),
]

try {
  const binary = join(data, 'copilot.mjs')
  await copyFile(join(serverDir, 'test/fixtures/copilot-agent.mjs'), binary)
  await chmod(binary, 0o700)
  const config = join(data, 'config.toml')
  // Claude stays enabled: a transfer to a disabled CLI is refused, and the one below only creates a conversation.
  await writeFile(config, ['codex', 'opencode', 'grok', 'antigravity'].map((agent) => `[agents.${agent}]\nenabled = false\n`).join('') + `[agents.copilot]\nbinary = "${binary}"\n`)
  browser = await chromium.launch({ chromiumSandbox: true })
  const errors = []
  for (const profile of ['server', 'desktop']) {
    const port = await freePort()
    const env = { ...process.env, NODE_ENV: 'development', SILLAGE_PORT: String(port), SILLAGE_HOST: '127.0.0.1', SILLAGE_PROFILE: profile, SILLAGE_CONFIG: config, SILLAGE_DATA_DIR: join(data, profile), SILLAGE_WEB_ROOT: join(webDir, 'dist'), ...(profile === 'desktop' ? { SILLAGE_HANDSHAKE_FD: '3' } : {}) }
    const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env, profile === 'desktop' ? ['pipe', 'pipe', 'pipe', 'pipe'] : 'pipe')
    const handshake = profile === 'desktop' ? new Promise((resolve, reject) => {
      let buffer = ''
      server.stdio[3].on('data', (chunk) => { buffer += chunk; if (buffer.includes('\n')) resolve(JSON.parse(buffer.split('\n')[0])) })
      server.once('exit', () => reject(new Error(server.diagnostics)))
    }) : null
    const base = `http://127.0.0.1:${port}`
    await ready(base + '/api/health', server)
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'fr-FR', serviceWorkers: 'block' })
    await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
    if (handshake) {
      const result = await handshake
      await context.addCookies([{ name: 'sillage_session', value: result.session, url: base }])
    } else {
      const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
      const [code] = await once(seed, 'exit')
      assert.equal(code, 0, seed.diagnostics)
      assert.ok((await context.request.post(base + '/api/auth/login', { data: { username: 'alex', password: 'sillage-demo' } })).ok())
    }
    const json = async (response) => { assert.ok(response.ok(), await response.text()); return response.json() }
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    page.on('pageerror', (error) => errors.push(error.message))
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
    // Complete the tour through its API to focus this check on the integration.
    await context.request.patch(base + '/api/me/settings', { data: { onboarding: { completedAt: Date.now(), pending: false } } })

    // 1. The CLI is offered with the catalog its session reports, and no account choice without extra accounts.
    const agents = await json(await context.request.get(base + '/api/agents'))
    const copilot = agents.agents.find((entry) => entry.agent === 'copilot')
    assert.equal(copilot.installed, true, JSON.stringify(copilot))
    assert.equal(copilot.version, '1.0.116')
    const models = await json(await context.request.get(base + '/api/agents/copilot/models'))
    assert.deepEqual(models.models.map((model) => model.value), ['auto', 'gpt-test'])
    await page.goto(base + '/settings/cli')
    if (page.url().endsWith('/bienvenue')) {
      await page.getByRole('button', { name: 'Passer la visite' }).click()
      await page.goto(base + '/settings/cli')
    }
    await page.getByRole('radio', { name: /GitHub Copilot/ }).click()
    await page.getByRole('combobox', { name: 'Modèle', exact: true }).click()
    await page.getByRole('option', { name: /Auto/ }).first().waitFor()
    await page.getByRole('option', { name: /GPT Test/ }).click()
    await delay(500)
    const settings = await json(await context.request.get(base + '/api/me/settings'))
    assert.equal(settings.agentDefaults.copilot.model, 'gpt-test')
    assert.equal(await page.getByRole('combobox', { name: 'Compte', exact: true }).count(), 0, 'No account choice before an extra Copilot account exists')
    await page.screenshot({ path: `/var/tmp/sillage-copilot-${profile}-defaults.png` })

    let project
    if (profile === 'server') {
      project = (await json(await context.request.get(base + '/api/projects'))).find((entry) => entry.name === 'Nimbus')
    } else {
      const workspacePath = join(data, 'desktop-workspace')
      await mkdir(workspacePath, { recursive: true })
      project = await json(await context.request.post(base + '/api/projects', { data: { name: 'Bureau', workspacePath, visibility: 'private' } }))
    }
    const agentConfig = { agent: 'copilot', model: 'gpt-test', reasoningEffort: 'medium', autoTier: '', mode: 'agent', allowAll: 'off', additionalDirectories: [], mcpServers: [], sillageMcp: false, skillLibrary: false }

    // 2. Adopt a session started in a terminal, through the draft's own import control.
    const listed = await json(await context.request.get(base + `/api/projects/${project.id}/copilot-sessions`))
    assert.deepEqual(listed.sessions.map((session) => session.title), ['Fix the login form', 'Older work'], 'Sessions of another directory are not offered')
    await page.goto(base + `/p/${project.id}/c/new?agent=copilot`)
    await page.getByText(/reprendre une session.*Copilot/).click()
    await page.getByRole('button', { name: /Fix the login form/ }).click()
    await page.getByText('Second answer', { exact: true }).first().waitFor()
    await page.getByText('Earlier question', { exact: true }).first().waitFor()
    assert.equal(await page.getByRole('button', { name: 'Compacter le contexte' }).count(), 1, 'Copilot compacts through /compact')
    assert.equal((await json(await context.request.get(base + `/api/projects/${project.id}/copilot-sessions`))).sessions.length, 1, 'An adopted session is no longer offered')
    await delay(400) // Let the conversation's reveal animation settle for the screenshot.
    await page.screenshot({ path: `/var/tmp/sillage-copilot-${profile}-import.png` })

    // 3. A scripted turn with the shapes of the real binary.
    const conversation = await json(await context.request.post(base + `/api/projects/${project.id}/conversations`, { data: { agent: 'copilot', config: agentConfig, title: 'Copilot integration check', firstMessage: { clientMessageId: randomUUID(), text: fixture({ steps: WORK, usage: { inputTokens: 1200, outputTokens: 40, cachedReadTokens: 400 } }) } } }))
    await page.goto(base + `/p/${project.id}/c/${conversation.id}`)
    await page.getByText('Native Copilot response', { exact: true }).first().waitFor()
    await page.getByText('Scout the notes').first().waitFor()
    await page.getByText('Run the failing tests').first().waitFor()
    // The prompt above quotes the line; as a reply it would stand alone.
    assert.equal(await page.getByText('Info: /tmp/never-shown.txt', { exact: true }).count(), 0, "Copilot's own information line is not a reply")
    const first = await json(await context.request.get(base + `/api/conversations/${conversation.id}`))
    await page.screenshot({ path: `/var/tmp/sillage-copilot-${profile}-conversation.png` })

    // 4. `ask_user` is a question card; its answer goes back as the value Copilot listed.
    const send = async (text) => assert.ok((await context.request.post(base + `/api/conversations/${conversation.id}/messages`, { data: { clientMessageId: randomUUID(), text } })).ok())
    await send(fixture({ steps: [
      announce({ toolCallId: 'ask', name: 'ask_user', arguments: {} }),
      { update: { sessionUpdate: 'tool_call', toolCallId: 'ask', title: 'ask_user', kind: 'other', status: 'pending', rawInput: { message: 'Which flavor?', requestedSchema: FLAVOR } } },
      { elicit: { message: 'Which flavor?', requestedSchema: FLAVOR, toolCallId: 'ask' } },
      { update: { sessionUpdate: 'tool_call_update', toolCallId: 'ask', status: 'completed', rawOutput: { content: 'User responded: flavor=mint' } } },
      chunk('Mint it is.', 'reply-2'),
    ] }))
    await page.getByText('Which flavor?', { exact: true }).first().waitFor()
    await page.locator('button[aria-pressed]', { hasText: 'Fresh mint' }).click()
    await page.screenshot({ path: `/var/tmp/sillage-copilot-${profile}-question.png` })
    await page.getByRole('button', { name: 'Envoyer', exact: true }).click()
    await page.getByText('Mint it is.', { exact: true }).first().waitFor()
    const rpc = async () => (await readFile(join(data, 'rpc.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.deepEqual((await rpc()).filter((entry) => 'elicited' in entry).at(-1).elicited, { action: 'accept', content: { flavor: 'mint' } })

    // 5. A permission: Sillage's own buttons, answered with the matching Copilot option.
    await send(fixture({ steps: [
      announce({ toolCallId: 'new', name: 'create', arguments: {} }),
      { update: { sessionUpdate: 'tool_call', toolCallId: 'new', title: 'Creating draft.md', kind: 'edit', status: 'pending', rawInput: { path: join(project.workspacePath, 'draft.md'), file_text: 'A draft\n' }, content: [{ type: 'diff', path: join(project.workspacePath, 'draft.md'), oldText: '', newText: 'A draft\n' }] } },
      { permission: { toolCall: { toolCallId: 'new', title: 'Create file', kind: 'edit', status: 'pending', rawInput: { fileName: join(project.workspacePath, 'draft.md'), diff: '+A draft' } }, options: PERMISSION_OPTIONS } },
      { update: { sessionUpdate: 'tool_call_update', toolCallId: 'new', status: 'completed', content: [{ type: 'diff', path: join(project.workspacePath, 'draft.md'), oldText: '', newText: 'A draft\n' }], rawOutput: { content: 'Created file draft.md with 8 characters' } } },
      chunk('File created.', 'reply-3'),
    ] }))
    await page.getByRole('button', { name: 'Autoriser', exact: true }).click()
    await page.getByText('File created.', { exact: true }).first().waitFor()
    assert.deepEqual((await rpc()).filter((entry) => 'answer' in entry).at(-1).answer, { outcome: { outcome: 'selected', optionId: 'allow_once' } })

    // 5b. `/every` and `/after` are loops; the prompt a schedule sends opens its turn in the thread.
    await send(fixture({ steps: [
      { event: { type: 'session.schedule_created', data: { id: 1, intervalMs: 3_600_000, prompt: 'Check the build', recurring: true, origin: 'user' } } },
      { event: { type: 'session.schedule_created', data: { id: 2, intervalMs: 1_800_000, prompt: 'Say hello', recurring: false, origin: 'user' } } },
      chunk('Scheduled both.', 'reply-schedules'),
    ], after: [
      { wait: 4000 },
      { event: { type: 'user.message', data: { content: '[Scheduled prompt #2]\nSay hello', source: 'schedule-2', messageId: 'scheduled-2' } } },
      chunk('Hello from the schedule.', 'reply-scheduled'),
      { event: { type: 'session.schedule_cancelled', data: { id: 2 } } },
    ] }))
    await page.getByText('Scheduled both.', { exact: true }).first().waitFor()
    const loops = page.locator('[title*="une fois, dans 30m"]').filter({ hasText: '2 boucles' }).first()
    await loops.waitFor()
    assert.match(await loops.getAttribute('title'), /^1h · 0 réveil · aucun réveil pour le moment\nCheck the build/)
    await page.screenshot({ path: `/var/tmp/sillage-copilot-${profile}-loops.png` })
    await page.getByText('Hello from the schedule.', { exact: true }).first().waitFor()
    await page.getByText('[Scheduled prompt #2]', { exact: false }).first().waitFor()
    await page.locator('[title*="Check the build"]').filter({ hasText: '1 boucle' }).first().waitFor()

    // 6. Manual compaction goes through Copilot's slash command.
    await page.getByRole('button', { name: 'Compacter le contexte' }).click()
    for (let attempt = 0; attempt < 100 && !(await rpc()).some((entry) => entry.method === 'session/prompt' && entry.params.prompt[0].text === '/compact'); attempt++) await delay(100)
    assert.ok((await rpc()).some((entry) => entry.method === 'session/prompt' && entry.params.prompt[0].text === '/compact'), 'The compact button sends /compact')
    assert.equal(await page.getByText('Compacted conversation history').count(), 0, "Copilot's confirmation line is not a reply")

    // 7. Fork at the first turn: no native fork, the new session carries the conversation up to there.
    const fork = await json(await context.request.post(base + `/api/conversations/${conversation.id}/fork`, { data: { throughSeq: first.lastSeq } }))
    assert.equal(fork.forkedFromId, conversation.id)
    const history = await json(await context.request.get(base + `/api/conversations/${fork.id}/handoff`))
    assert.ok(history.text.includes('Native Copilot response'))
    assert.ok(!history.text.includes('Mint it is.'), 'Forks must stop at the selected turn')
    assert.ok(!history.text.includes('Scout report from the sub-agent.') || history.text.includes('Scout the notes'), "A sub-agent's words come back through its call, not as the main thread")
    assert.equal((await rpc()).some((entry) => entry.method === 'session/fork'), false)

    // 8. Transfers both ways.
    const transfer = await json(await context.request.post(base + `/api/conversations/${conversation.id}/handoff`, { data: { agent: 'claude', config: settings.agentDefaults.claude } }))
    assert.equal(transfer.handoffFromId, conversation.id)
    assert.ok((await json(await context.request.get(base + `/api/conversations/${transfer.id}/handoff`))).text.includes('Native Copilot response'))
    if (profile === 'server') {
      // The reverse transfer starts from a populated Claude history, without inference.
      const seeded = await json(await context.request.get(base + `/api/projects/${project.id}/conversations`))
      const claudeSource = seeded.find((entry) => entry.agent === 'claude' && entry.lastSeq > 2)
      assert.ok(claudeSource)
      const inbound = await json(await context.request.post(base + `/api/conversations/${claudeSource.id}/handoff`, { data: { agent: 'copilot', config: agentConfig } }))
      assert.equal(inbound.handoffFromId, claudeSource.id)
      assert.ok((await json(await context.request.get(base + `/api/conversations/${inbound.id}/handoff`))).text.length > 50)
    }

    // 9. Copilot has its own color in the consumption chart.
    await page.goto(base + '/consumption')
    await page.waitForLoadState('networkidle')
    const color = await page.evaluate(() => {
      const probe = document.createElement('span')
      probe.className = 'consumption-viz'
      document.body.append(probe)
      const value = getComputedStyle(probe).getPropertyValue('--series-copilot').trim()
      probe.remove()
      return value
    })
    assert.match(color, /^#[0-9a-f]{6}$/i, 'The consumption chart needs a color for Copilot')

    // 10. Phone.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(base + `/p/${project.id}/c/${conversation.id}`)
    await page.getByText('File created.', { exact: true }).first().waitFor()
    await delay(400)
    assert.ok(await fits(), 'The conversation must not overflow on a phone')
    await page.screenshot({ path: `/var/tmp/sillage-copilot-${profile}-phone-conversation.png` })
    await page.goto(base + '/settings/cli')
    await page.getByRole('radio', { name: /GitHub Copilot/ }).waitFor()
    assert.ok(await fits(), 'The defaults page must not overflow on a phone')
    await page.screenshot({ path: `/var/tmp/sillage-copilot-${profile}-phone-defaults.png` })
    await context.close()
    await rm(join(data, 'rpc.jsonl'), { force: true })
    console.log(`OK: Copilot ${profile}: defaults, import, tools and sub-agent, question, permission, schedules, compaction, fork, transfers, phone layout`)
  }
  assert.deepEqual(errors, [])
} finally {
  await browser?.close()
  await Promise.all(processes.map(async (child) => {
    if (child.exitCode !== null) return
    const stopped = once(child, 'exit')
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    await stopped
    clearTimeout(timer)
  }))
  await rm(data, { recursive: true, force: true })
}
