#!/usr/bin/env node
// Deterministic fake OpenCode 2 `opencode serve` (2.4.1 shapes): no models, networking or database.
import { appendFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createServer } from 'node:http'

if (process.argv.includes('--version')) {
  console.log('opencode v2.4.1')
  process.exit(0)
}

// Beside the script rather than cwd, like the 1.x fixture.
const here = dirname(process.argv[1])
writeFileSync(join(here, 'launch.json'), JSON.stringify({
  config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}'),
  disableProjectConfig: process.env.OPENCODE_DISABLE_PROJECT_CONFIG ?? null,
  pid: process.pid,
}))

// 2.x reads OPENCODE_PASSWORD only.
const expected = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString('base64')}`
const streams = new Set()
let nextEvent = 1

const emit = (event) => {
  const frame = `id: evt_${nextEvent}\nevent: message\ndata: ${JSON.stringify({ id: `evt_${nextEvent++}`, created: Date.now(), ...event })}\n\n`
  for (const stream of streams) stream.write(frame)
}

// `ses_spent` was used before Sillage resumes it: its running total is not this run's spending.
const session = (id) => ({
  id, projectID: 'global', model: { id: 'small', providerID: 'fixture', variant: 'default' }, cost: id === 'ses_spent' ? 2 : 0,
  tokens: { input: id === 'ses_spent' ? 5000 : 0, output: id === 'ses_spent' ? 300 : 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
  location: { directory: process.cwd() },
})

/** A session begun outside Sillage, with stored history in 2.4.1 shapes (oldest first). */
const NATIVE = 'ses_native'
const nativeHistory = [
  { id: 'msg_01', type: 'user', time: { created: 1 }, text: 'Fix the typo in a.txt' },
  { id: 'msg_02', type: 'model-switched', time: { created: 2 } },
  { id: 'msg_03', type: 'assistant', time: { created: 3, completed: 9 }, agent: 'build', model: { id: 'small', providerID: 'fixture' },
    cost: 0.25, tokens: { input: 50, output: 10, reasoning: 2, cache: { read: 100, write: 0 } },
    content: [
      { type: 'reasoning', text: 'Look at the file' },
      { type: 'tool', id: 'call_e', name: 'edit', time: { created: 4, ran: 4, completed: 6 },
        state: { status: 'completed', input: { path: '/w/a.txt', oldString: 'teh', newString: 'the' }, content: [{ type: 'text', text: 'Edited a.txt' }],
          metadata: { files: [{ file: 'a.txt', patch: '@@ -1 +1 @@\n-teh\n+the\n', status: 'modified' }] } } },
      { type: 'tool', id: 'call_q', name: 'question', time: { created: 7 }, state: { status: 'completed', input: {}, content: [{ type: 'text', text: 'answered' }] } },
      { type: 'text', text: 'Fixed.' },
    ] },
  { id: 'msg_04', type: 'idle', time: { created: 10 }, outcome: 'succeeded' },
  { id: 'msg_05', type: 'shell', time: { created: 11, completed: 12 }, shellID: 'sh_x', command: 'ls', status: 'exited', exit: 0, output: { output: 'a.txt\n', cursor: 6, size: 6, truncated: false } },
  { id: 'msg_06', type: 'compaction', time: { created: 13 }, status: 'completed', reason: 'manual', summary: 'S' },
  { id: 'msg_07', type: 'synthetic', time: { created: 14 }, text: '<background-result kind="subagent">r</background-result>' },
  { id: 'msg_08', type: 'assistant', time: { created: 15 }, agent: 'build', model: { id: 'small', providerID: 'fixture' },
    content: [{ type: 'tool', id: 'call_b', name: 'shell', time: { created: 15, ran: 15, completed: 16 }, state: { status: 'error', input: { command: 'false' }, error: { type: 'ShellError', message: 'exit 1' } } }] },
  { id: 'msg_09', type: 'idle', time: { created: 17 }, outcome: 'interrupted' },
]

/** Captured shell output, set by scenarios: `{ "sh_1": "…" }`. */
let shells = {}

/** Messages returned by `GET /api/session/:id/message`, newest first like the real server. */
let messages = ['msg_4', 'msg_3', 'msg_2', 'msg_1'].map((id) => ({ id, type: 'assistant', time: { created: 1 } }))

/** A session longer than the default page and than one page of 200 (`msg_001` … `msg_250`), newest first. */
const longHistory = Array.from({ length: 250 }, (_, i) => ({ id: `msg_${String(250 - i).padStart(3, '0')}`, type: 'assistant', time: { created: 1 } }))

/**
 * Pages like 2.4.2: 50 messages newest first unless `order`/`limit` say otherwise, the cursor
 * carrying its own order and refused alongside one.
 */
function paged(newestFirst, query) {
  const cursor = query.has('cursor') ? JSON.parse(Buffer.from(query.get('cursor'), 'base64url').toString()) : null
  const order = cursor?.order ?? query.get('order') ?? 'desc'
  const list = order === 'asc' ? [...newestFirst].reverse() : newestFirst
  const offset = cursor?.offset ?? 0
  const end = offset + Number(query.get('limit') ?? 50)
  const next = end < list.length ? Buffer.from(JSON.stringify({ order, offset: end })).toString('base64url') : null
  return { data: list.slice(offset, end), cursor: { next } }
}

const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}
const located = (data) => ({ location: { directory: process.cwd() }, data })

const server = createServer((request, response) => {
  if (request.headers.authorization !== expected) return json(response, 401, { _tag: 'UnauthorizedError', message: 'Authentication required' })

  const { pathname } = new URL(request.url, 'http://fixture')
  if (request.method === 'GET' && pathname === '/api/event') {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    streams.add(response)
    request.on('close', () => streams.delete(response))
    emit({ type: 'server.connected', data: {} })
    return
  }

  let raw = ''
  request.on('data', (chunk) => { raw += chunk })
  request.on('end', () => {
    const body = raw ? JSON.parse(raw) : null
    appendFileSync(join(here, 'http.jsonl'), `${JSON.stringify({ method: request.method, path: pathname, body })}\n`)
    const route = `${request.method} ${pathname}`

    if (route === 'POST /api/session') return json(response, 200, { data: session('ses_root') })
    if (route === 'GET /api/model') {
      return json(response, 200, located([
        { id: 'small', modelID: 'small', providerID: 'fixture', name: 'Small', enabled: true, status: 'active',
          variants: [{ id: 'default' }, { id: 'low' }, { id: 'high' }], limit: { context: 1000, output: 100 } },
        { id: 'old', modelID: 'old', providerID: 'fixture', name: 'Old', enabled: true, status: 'deprecated', variants: [], limit: { context: 10, output: 1 } },
        { id: 'claude', modelID: 'claude', providerID: 'github-copilot', name: 'Claude', enabled: true, status: 'active', variants: [], limit: { context: 2000, output: 100 } },
        { id: 'auto', modelID: 'auto', providerID: 'github-copilot', name: 'Auto', enabled: true, status: 'active', variants: [], limit: { context: 2000, output: 100 } },
      ]))
    }
    if (route === 'GET /api/model/default') return json(response, 200, located(null))
    if (route === 'GET /api/provider') {
      return json(response, 200, located([{ id: 'fixture', name: 'Fixture Cloud' }, { id: 'github-copilot', name: 'GitHub Copilot' }]))
    }
    if (route === 'GET /api/session') {
      const query = new URL(request.url, 'http://fixture').searchParams
      const root = { ...session(NATIVE), title: 'Native work', time: { created: 1, updated: 17 } }
      // OpenCode titles sessions after their first answer: a fresh one has none yet.
      const untitled = { ...session('ses_untitled'), time: { created: 1, updated: 18 } }
      return json(response, 200, { data: query.get('directory') === process.cwd() ? [untitled, root] : [], cursor: {} })
    }
    if (route === 'GET /api/agent') {
      return json(response, 200, located([
        { id: 'build', name: 'Build', mode: 'primary', hidden: false, description: 'Default agent', permissions: [] },
        { id: 'title', name: 'Title', mode: 'primary', hidden: true, permissions: [] },
        { id: 'general', name: 'General', mode: 'subagent', hidden: false, description: 'General work', permissions: [] },
      ]))
    }
    if (route === 'GET /api/mcp') {
      return json(response, 200, located([{ name: 'declared', status: { status: 'connected' } }, { name: 'stray', status: { status: 'failed', error: 'boom' } }]))
    }
    if (route === 'GET /api/command') return json(response, 200, located([{ name: 'review', description: 'review changes' }]))
    if (route === 'GET /api/skill') {
      return json(response, 200, located([{ id: 'lib-skill', name: 'Library skill', description: 'From the library', path: '/lib/skills/lib-skill/SKILL.md', content: '' }]))
    }
    const shell = /^\/api\/shell\/([^/]+)\/output$/.exec(pathname)
    if (shell && request.method === 'GET') {
      const all = shells[shell[1]]
      if (all === undefined) return json(response, 404, { _tag: 'ShellNotFoundError', message: 'Shell not found' })
      const query = new URL(request.url, 'http://fixture').searchParams
      const cursor = Number(query.get('cursor') ?? 0)
      const limit = query.has('limit') ? Number(query.get('limit')) : Infinity
      const output = all.slice(cursor, cursor + limit)
      return json(response, 200, located({ output, cursor: cursor + output.length, size: all.length, truncated: false }))
    }
    if (route === 'GET /api/session/active') return json(response, 200, { data: {} })
    if (route === 'POST /api/location/reload') return json(response, 200, true)

    const match = /^\/api\/session\/([^/]+)(?:\/(.+))?$/.exec(pathname)
    if (match) {
      const [, id, action] = match
      if (request.method === 'GET' && !action) {
        return id === 'ses_missing' ? json(response, 404, { _tag: 'SessionNotFoundError', message: 'Session not found' }) : json(response, 200, { data: session(id) })
      }
      if (request.method === 'GET' && action === 'message') {
        if (id === 'ses_untitled') return json(response, 200, { data: [{ id: 'msg_u', type: 'user', time: { created: 1 }, text: '  Draft the release notes  ' }], cursor: {} })
        const query = new URL(request.url, 'http://fixture').searchParams
        if (query.has('cursor') && query.has('order')) return json(response, 400, { _tag: 'InvalidCursorError', message: 'Cursor cannot be combined with order' })
        if (id !== NATIVE) return json(response, 200, paged(id === 'ses_long' ? longHistory : messages, query))
        // Two pages, to exercise the cursor. Like 2.4.1, a cursor carries its own order.
        return query.get('cursor') === 'page2'
          ? json(response, 200, { data: nativeHistory.slice(5), cursor: { next: null } })
          : json(response, 200, { data: nativeHistory.slice(0, 5), cursor: { next: 'page2' } })
      }
      if (action === 'fork') return json(response, 200, { data: session('ses_fork') })
      if (action === 'interrupt') {
        emit({ type: 'session.execution.interrupted', data: { sessionID: id, reason: 'user' } })
        return json(response, 200, { interrupted: true })
      }
      if (action === 'prompt' || action === 'command') {
        // Scenarios travel in message text: `fixture:{"events":[…]}`, on its first line since
        // Sillage appends attachment paths after it.
        const text = body.text ?? ''
        const scenario = text.startsWith('fixture:') ? JSON.parse(text.slice(8).split('\n')[0]) : {}
        if (scenario.messages) messages = scenario.messages
        if (scenario.shells) shells = { ...shells, ...scenario.shells }
        if (scenario.fail) return json(response, 400, { _tag: 'InvalidRequestError', message: scenario.fail })
        json(response, 200, { data: { id: 'msg_user', sessionID: id, type: 'user' } })
        for (const event of scenario.events ?? []) emit(event)
        return
      }
    }

    // Model, agent, instructions, permission and form answers.
    response.writeHead(204).end()
  })
})

const port = Number(process.argv[process.argv.indexOf('--port') + 1])
server.listen(port, '127.0.0.1', () => {
  // 2.x announces itself this way (probed 2.4.1).
  console.log(`server listening on http://127.0.0.1:${server.address().port}`)
})
process.on('SIGTERM', () => process.exit(0))
